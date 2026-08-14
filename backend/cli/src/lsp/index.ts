import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { LSPClient } from "./client"
import path from "path"
import { pathToFileURL } from "url"
import { LSPServer, spawnLSPChild, withLSPSandbox } from "./server"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"
import { OpenScience } from "@/openscience"
import { ProjectTrust } from "@/project/trust"
import { CredentialProcessLedger } from "@/credentials/process-ledger"

export namespace LSP {
  const log = Log.create({ service: "lsp" })

  async function completeProcess(id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await CredentialProcessLedger.complete(id)) return
      await Bun.sleep(20)
    }
    throw new Error(`Language-server process ${id} did not exit after completion`)
  }

  export const Event = {
    Updated: BusEvent.define("lsp.updated", z.object({})),
  }

  export const Range = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .meta({
      ref: "Range",
    })
  export type Range = z.infer<typeof Range>

  export const Symbol = z
    .object({
      name: z.string(),
      kind: z.number(),
      location: z.object({
        uri: z.string(),
        range: Range,
      }),
    })
    .meta({
      ref: "Symbol",
    })
  export type Symbol = z.infer<typeof Symbol>

  export const DocumentSymbol = z
    .object({
      name: z.string(),
      detail: z.string().optional(),
      kind: z.number(),
      range: Range,
      selectionRange: Range,
    })
    .meta({
      ref: "DocumentSymbol",
    })
  export type DocumentSymbol = z.infer<typeof DocumentSymbol>

  const filterExperimentalServers = (servers: Record<string, LSPServer.Info>) => {
    if (Flag.OPENSCIENCE_EXPERIMENTAL_LSP_TY) {
      // If experimental flag is enabled, disable pyright
      if (servers["pyright"]) {
        log.info("LSP server pyright is disabled because OPENSCIENCE_EXPERIMENTAL_LSP_TY is enabled")
        delete servers["pyright"]
      }
    } else {
      // If experimental flag is disabled, disable ty
      if (servers["ty"]) {
        delete servers["ty"]
      }
    }
  }

  const state = Instance.state(
    async () => {
      const clients: LSPClient.Info[] = []
      const servers: Record<string, LSPServer.Info> = {}
      const cfg = await Config.getExecution()

      if (cfg.lsp === false) {
        log.info("all LSPs are disabled")
        return {
          broken: new Set<string>(),
          servers,
          clients,
          spawning: new Map<string, Promise<LSPClient.Info | undefined>>(),
          processes: new Set<import("child_process").ChildProcessWithoutNullStreams>(),
          generation: 0,
          projectID: Instance.project.id,
        }
      }

      for (const server of Object.values(LSPServer)) {
        servers[server.id] = server
      }

      filterExperimentalServers(servers)

      for (const [name, item] of Object.entries(cfg.lsp ?? {})) {
        const existing = servers[name]
        if (item.disabled) {
          log.info(`LSP server ${name} is disabled`)
          delete servers[name]
          continue
        }
        const project = await Config.projectControls("lsp", name)
        servers[name] = {
          ...existing,
          id: name,
          configured: true,
          root: existing?.root ?? (async () => Instance.directory),
          extensions: item.extensions ?? existing?.extensions ?? [],
          spawn: async (root) => {
            // Language servers need runtime/toolchain discovery, not account,
            // provider, or cloud credentials. Explicit per-LSP config remains
            // available for servers that genuinely require custom variables.
            // Project/global config may use {env:SECRET}; pass only the
            // credential-free runtime subset needed for toolchain discovery.
            const env: Record<string, string> = OpenScience.kernelEnv({ ...process.env, ...item.env })
            const command = item.command[0]
            const target = path.isAbsolute(command)
              ? command
              : command.includes("/") || command.includes("\\")
                ? path.resolve(root, command)
                : Bun.which(command, { PATH: env.PATH })
            const local =
              target !== null && (Instance.containsPath(target) || (await Instance.containsCanonicalPath(target)))
            if (project || local) await ProjectTrust.require(Instance.project, "project_lsp")
            return {
              process: await spawnLSPChild(item.command[0], item.command.slice(1), {
                cwd: root,
                env,
              }),
              project: project || local,
              initialization: item.initialization,
            }
          },
        }
      }

      log.info("enabled LSP servers", {
        serverIds: Object.values(servers)
          .map((server) => server.id)
          .join(", "),
      })

      return {
        broken: new Set<string>(),
        servers,
        clients,
        spawning: new Map<string, Promise<LSPClient.Info | undefined>>(),
        processes: new Set<import("child_process").ChildProcessWithoutNullStreams>(),
        generation: 0,
        projectID: Instance.project.id,
      }
    },
    async (state) => {
      // Revoke while every registered leader is still alive. The durable
      // ledger snapshots the live PPID descendant closure here, including a
      // direct child that already moved into its own process group. Killing a
      // leader first would reparent that child and destroy the only safe link.
      await CredentialProcessLedger.revoke({ kind: "lsp", projectID: state.projectID })
      for (const process of state.processes) process.kill()
      state.processes.clear()
      const clients = state.clients.splice(0)
      const results = await Promise.allSettled(clients.map((client) => client.shutdown()))
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) log.warn("Language-server client cleanup failed after durable revocation", { failures })
    },
  )

  export async function init() {
    return state()
  }

  /** Stop every language server for the current project. A generation bump
   * also invalidates servers whose spawn/initialize handshake was in flight
   * when trust was revoked in this or another server process. */
  export async function dispose() {
    const current = await state()
    current.generation++
    current.spawning.clear()
    // Preserve live ancestry until durable revocation has captured and killed
    // direct setsid/start_new_session descendants.
    await CredentialProcessLedger.revoke({ kind: "lsp", projectID: current.projectID })
    const processes = [...current.processes]
    current.processes.clear()
    for (const process of processes) process.kill()
    const clients = current.clients.splice(0)
    const results = await Promise.allSettled(clients.map((client) => client.shutdown()))
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) log.warn("Language-server client cleanup failed after durable revocation", { failures })
  }

  export const Status = z
    .object({
      id: z.string(),
      name: z.string(),
      root: z.string(),
      status: z.union([z.literal("connected"), z.literal("error")]),
    })
    .meta({
      ref: "LSPStatus",
    })
  export type Status = z.infer<typeof Status>

  export async function status() {
    return state().then((x) => {
      const result: Status[] = []
      for (const client of x.clients) {
        result.push({
          id: client.serverID,
          name: x.servers[client.serverID].id,
          root: path.relative(Instance.directory, client.root),
          status: "connected",
        })
      }
      return result
    })
  }

  async function getClients(file: string) {
    const s = await state()
    const extension = path.parse(file).ext || file
    const result: LSPClient.Info[] = []

    async function active(client: LSPClient.Info) {
      try {
        await ProjectTrust.require(Instance.project, "project_lsp")
        return true
      } catch (error) {
        if (!ProjectTrust.DeniedError.isInstance(error)) throw error
        const index = s.clients.indexOf(client)
        if (index !== -1) s.clients.splice(index, 1)
        await client.shutdown()
        return false
      }
    }

    async function schedule(server: LSPServer.Info, root: string, key: string) {
      const generation = s.generation
      // Even a globally installed LSP can execute project-owned config,
      // plugins, hooks, or code merely by starting in the project root.
      // Binary location is therefore not a safe trust classifier.
      const policy = await Config.trustedSandbox()
      const handle = await ProjectTrust.require(Instance.project, "project_lsp")
        .then(() =>
          withLSPSandbox(
            {
              root,
              options: policy,
              readable: server.readable,
              allowArgumentReadDirectories: server.configured !== true,
              async register(process, windowsRelease) {
                if (!process.pid) throw new Error("Language server started without a process id")
                const id = `lsp-${crypto.randomUUID()}`
                const registered = await CredentialProcessLedger.register({
                  id,
                  kind: "lsp",
                  pid: process.pid,
                  detached: globalThis.process.platform !== "win32",
                  projectID: s.projectID,
                  windowsRelease,
                })
                if (!registered) {
                  throw new Error("Language server exited before durable process-group ownership was established")
                }
                s.processes.add(process)
                let completed = false
                return () => {
                  if (completed) return
                  completed = true
                  s.processes.delete(process)
                  void completeProcess(id).catch((error) =>
                    log.error("Failed to complete durable language-server ownership", { error, id }),
                  )
                }
              },
            },
            () => server.spawn(root),
          ),
        )
        .then((value) => {
          if (!value) s.broken.add(key)
          return value
        })
        .catch((err) => {
          if (ProjectTrust.DeniedError.isInstance(err)) {
            log.warn(`Project trust denied LSP server ${server.id}`, { error: err })
            return undefined
          }
          s.broken.add(key)
          log.error(`Failed to spawn LSP server ${server.id}`, { error: err })
          return undefined
        })

      if (!handle) return undefined
      handle.project = true
      if (generation !== s.generation) {
        handle.process.kill()
        return undefined
      }
      try {
        await ProjectTrust.require(Instance.project, "project_lsp")
      } catch (error) {
        handle.process.kill()
        if (ProjectTrust.DeniedError.isInstance(error)) return undefined
        throw error
      }
      log.info("spawned lsp server", { serverID: server.id })

      const client = await LSPClient.create({
        serverID: server.id,
        server: handle,
        root,
      }).catch((err) => {
        s.broken.add(key)
        handle.process.kill()
        log.error(`Failed to initialize LSP client ${server.id}`, { error: err })
        return undefined
      })

      if (!client) {
        handle.process.kill()
        return undefined
      }

      if (generation !== s.generation) {
        await client.shutdown()
        return undefined
      }
      if (!(await active(client))) return undefined

      const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
      if (existing) {
        handle.process.kill()
        return existing
      }

      s.clients.push(client)
      return client
    }

    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue

      const root = await server.root(file)
      if (!root) continue
      if (s.broken.has(root + server.id)) continue

      const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
      if (match) {
        if (!(await active(match))) continue
        result.push(match)
        continue
      }

      const inflight = s.spawning.get(root + server.id)
      if (inflight) {
        const client = await inflight
        if (!client) continue
        if (!(await active(client))) continue
        result.push(client)
        continue
      }

      const task = schedule(server, root, root + server.id)
      s.spawning.set(root + server.id, task)

      task.finally(() => {
        if (s.spawning.get(root + server.id) === task) {
          s.spawning.delete(root + server.id)
        }
      })

      const client = await task
      if (!client) continue

      result.push(client)
      Bus.publish(Event.Updated, {})
    }

    return result
  }

  export async function hasClients(file: string) {
    const s = await state()
    const extension = path.parse(file).ext || file
    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue
      const root = await server.root(file)
      if (!root) continue
      if (s.broken.has(root + server.id)) continue
      return true
    }
    return false
  }

  export async function touchFile(input: string, waitForDiagnostics?: boolean) {
    log.info("touching file", { file: input })
    const clients = await getClients(input)
    await Promise.all(
      clients.map(async (client) => {
        const wait = waitForDiagnostics ? client.waitForDiagnostics({ path: input }) : Promise.resolve()
        await client.notify.open({ path: input })
        return wait
      }),
    ).catch((err) => {
      log.error("failed to touch file", { err, file: input })
    })
  }

  export async function diagnostics() {
    const results: Record<string, LSPClient.Diagnostic[]> = {}
    for (const result of await runAll(async (client) => client.diagnostics)) {
      for (const [path, diagnostics] of result.entries()) {
        const arr = results[path] || []
        arr.push(...diagnostics)
        results[path] = arr
      }
    }
    return results
  }

  export async function hover(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) => {
      return client.connection
        .sendRequest("textDocument/hover", {
          textDocument: {
            uri: pathToFileURL(input.file).href,
          },
          position: {
            line: input.line,
            character: input.character,
          },
        })
        .catch(() => null)
    })
  }

  enum SymbolKind {
    File = 1,
    Module = 2,
    Namespace = 3,
    Package = 4,
    Class = 5,
    Method = 6,
    Property = 7,
    Field = 8,
    Constructor = 9,
    Enum = 10,
    Interface = 11,
    Function = 12,
    Variable = 13,
    Constant = 14,
    String = 15,
    Number = 16,
    Boolean = 17,
    Array = 18,
    Object = 19,
    Key = 20,
    Null = 21,
    EnumMember = 22,
    Struct = 23,
    Event = 24,
    Operator = 25,
    TypeParameter = 26,
  }

  const kinds = [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Interface,
    SymbolKind.Variable,
    SymbolKind.Constant,
    SymbolKind.Struct,
    SymbolKind.Enum,
  ]

  export async function workspaceSymbol(query: string) {
    return runAll((client) =>
      client.connection
        .sendRequest("workspace/symbol", {
          query,
        })
        .then((result: any) => result.filter((x: LSP.Symbol) => kinds.includes(x.kind)))
        .then((result: any) => result.slice(0, 10))
        .catch(() => []),
    ).then((result) => result.flat() as LSP.Symbol[])
  }

  export async function documentSymbol(uri: string) {
    const file = new URL(uri).pathname
    return run(file, (client) =>
      client.connection
        .sendRequest("textDocument/documentSymbol", {
          textDocument: {
            uri,
          },
        })
        .catch(() => []),
    )
      .then((result) => result.flat() as (LSP.DocumentSymbol | LSP.Symbol)[])
      .then((result) => result.filter(Boolean))
  }

  export async function definition(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/definition", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function references(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/references", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
          context: { includeDeclaration: true },
        })
        .catch(() => []),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function implementation(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/implementation", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function prepareCallHierarchy(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => []),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function incomingCalls(input: { file: string; line: number; character: number }) {
    return run(input.file, async (client) => {
      const items = (await client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[]
      if (!items?.length) return []
      return client.connection.sendRequest("callHierarchy/incomingCalls", { item: items[0] }).catch(() => [])
    }).then((result) => result.flat().filter(Boolean))
  }

  export async function outgoingCalls(input: { file: string; line: number; character: number }) {
    return run(input.file, async (client) => {
      const items = (await client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[]
      if (!items?.length) return []
      return client.connection.sendRequest("callHierarchy/outgoingCalls", { item: items[0] }).catch(() => [])
    }).then((result) => result.flat().filter(Boolean))
  }

  async function runAll<T>(input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const clients = await state().then((x) => x.clients)
    const tasks = clients.map((x) => input(x))
    return Promise.all(tasks)
  }

  async function run<T>(file: string, input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const clients = await getClients(file)
    const tasks = clients.map((x) => input(x))
    return Promise.all(tasks)
  }

  export namespace Diagnostic {
    export function pretty(diagnostic: LSPClient.Diagnostic) {
      const severityMap = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "HINT",
      }

      const severity = severityMap[diagnostic.severity || 1]
      const line = diagnostic.range.start.line + 1
      const col = diagnostic.range.start.character + 1

      return `${severity} [${line}:${col}] ${diagnostic.message}`
    }
  }
}
