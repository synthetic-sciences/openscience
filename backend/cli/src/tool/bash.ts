import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { OpenScience } from "@/openscience"
import { Sandbox } from "@/sandbox/sandbox"
import { SessionFilesystem } from "@/session/filesystem"
import { Filesystem } from "@/util/filesystem"
import { Provenance } from "@/science/provenance/store"
import { ProvenanceEnvelope } from "@/science/provenance/envelope"
import { ExecutionAuthority } from "@/project/execution"
import { CommandRuntime } from "@/science/command/registry"
import { AuthoritySignal } from "@/project/authority-signal"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENSCIENCE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 0

export const log = Log.create({ service: "bash-tool" })

const clip = (value: string, max = 2000) => (value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value)

/** Record a provenance run node for a completed shell command (mirrors the
 *  kernel registry's provenance helper, but for the shell). Command and
 *  captured streams are redacted before recording. */
async function provenance(input: {
  sessionID: string
  messageID: string
  callID?: string
  command: string
  cwd: string
  exit: number | null
  stdout: string
  stderr: string
  startedAt: number
  completedAt: number
}) {
  const command = OpenScience.redactSecrets(input.command)
  const stdout = clip(OpenScience.redactSecrets(input.stdout))
  const stderr = clip(OpenScience.redactSecrets(input.stderr))
  const ok = input.exit === 0
  const envelope = ProvenanceEnvelope.create({
    kind: "local_compute",
    projectID: Instance.project.id,
    sessionID: input.sessionID,
    runID: `run-${crypto.randomUUID()}`,
    code: command,
    cwd: input.cwd,
    host: {
      platform: process.platform,
      arch: process.arch,
      runtimes: {
        bun: Bun.version,
        node: process.version,
      },
    },
    status: ok ? "succeeded" : "failed",
    outputs: [
      ProvenanceEnvelope.output({
        kind: "stream",
        label: "shell output",
        content: JSON.stringify({ stdout, stderr }),
        createdAt: input.completedAt,
      }),
    ],
    createdAt: input.startedAt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  })
  return Provenance.recordOwned(
    {
      projectID: Instance.project.id,
      directory: Instance.directory,
    },
    {
      kind: "run",
      label: command.slice(0, 140),
      tool: "bash",
      sessionID: input.sessionID,
      inputs: { command },
      status: ok ? "ok" : "error",
      provenance: envelope,
      meta: {
        messageID: input.messageID,
        callID: input.callID,
        exit: input.exit,
        cwd: input.cwd,
        stdout,
        stderr,
      },
    } as Parameters<typeof Provenance.record>[0],
  )
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", "the session workspace")
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe("The working directory to run the command in. Defaults to the session workspace.")
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const authority = await ExecutionAuthority.require({
        projectID: Instance.project.id,
        sessionID: ctx.sessionID,
        capability: "shell",
      })
      const writable = authority.writable
      const readable = new Set(authority.readable)
      const workspace = authority.workspace
      const requested = params.workdir || workspace
      const target = path.isAbsolute(requested) ? requested : path.resolve(workspace, requested)
      const cwd = (await Filesystem.canonical(target)) ?? path.resolve(target)
      const contained = (value: string) => writable.some((root) => Filesystem.contains(root, value))
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Map<string, SessionFilesystem.Access>()
      if (!contained(cwd)) directories.set(cwd, "write")
      const patterns = new Set<string>()
      const always = new Set<string>()

      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue
        const command: string[] = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
          ) {
            continue
          }
          command.push(child.text)
        }

        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(command[0])) {
          const operands = command
            .slice(1)
            .filter((arg) => !arg.startsWith("-") && !(command[0] === "chmod" && arg.startsWith("+")))
          for (const [index, arg] of operands.entries()) {
            const resolved = await $`realpath ${arg}`
              .cwd(cwd)
              .quiet()
              .nothrow()
              .text()
              .then((x) => x.trim())
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              // Git Bash on Windows returns Unix-style paths like /c/Users/...
              const normalized =
                process.platform === "win32" && resolved.match(/^\/[a-z]\//)
                  ? resolved.replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\")
                  : resolved
              if (!contained(normalized)) {
                const access =
                  command[0] === "cd" || command[0] === "cat" || (command[0] === "cp" && index < operands.length - 1)
                    ? "read"
                    : "write"
                const current = directories.get(normalized)
                if (!current || access === "write") directories.set(normalized, access)
              }
            }
          }
        }

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(command.join(" "))
          always.add(BashArity.prefix(command).join(" ") + "*")
        }
      }

      for (const [directory, access] of directories) {
        if (access === "write") {
          throw new Error(
            `External paths are read-only to shell commands: ${directory}. Use the write, edit, or apply_patch tool for brokered mutation.`,
          )
        }
        const parent = path.dirname(directory)
        const glob = path.join(parent, "*")
        await ctx.ask({
          permission: "external_directory",
          patterns: [glob],
          always: [glob],
          metadata: {
            filepath: directory,
            parentDir: parent,
            filesystem: {
              path: parent,
              access,
            },
          },
        })
        const authorized = await SessionFilesystem.authorize({
          sessionID: ctx.sessionID,
          path: directory,
          access,
        })
        readable.add(authorized.path)
      }
      const { existsSync, mkdirSync } = await import("fs")
      if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      // Seed the BYOK secret cache so redact() below masks the user's own
      // provider keys (auth.json + shell env), not just synced managed ones.
      await OpenScience.refreshByokSecrets(process.env).catch(() => {})

      // Permission callbacks may durably add the filesystem grant requested
      // above. Capture the post-prompt generation so that legitimate grant is
      // part of this launch while a later concurrent mutation still fails the
      // final check inside the authority lease.
      const prepared = await ExecutionAuthority.require({
        projectID: Instance.project.id,
        sessionID: ctx.sessionID,
        capability: "shell",
      })

      const started = Date.now()
      let exited = false
      let aborted = false
      const { proc, command, kill, sandbox, completion } = await AuthoritySignal.exclusive(async () => {
        const current = await ExecutionAuthority.require({
          projectID: Instance.project.id,
          sessionID: ctx.sessionID,
          capability: "shell",
        })
        if (current.generation !== prepared.generation) {
          throw new Error("Execution authority changed while the shell command was being prepared; retry it")
        }
        // Build the wrapper only after the final authority check, while trust
        // and filesystem mutations are excluded through durable registration.
        const sandbox = Sandbox.plan({
          command: params.command,
          shell,
          cwd,
          workspace: current.writable,
          readable: [...readable],
          unreadable: OpenScience.kernelSensitivePaths(),
          options: current.sandbox,
        })
        return OpenScience.withSubprocessEnv(process.env, async (env) => {
          let child: ReturnType<typeof spawn>
          const wrapped = await CommandRuntime.wrap({
            file: sandbox.file,
            args: sandbox.args ?? [],
            shell: sandbox.sandboxed ? false : sandbox.useShell,
          })
          try {
            child = spawn(wrapped.file, wrapped.args, {
              shell: wrapped.spawnShell,
              cwd,
              env,
              stdio: ["ignore", "pipe", "pipe"],
              detached: process.platform !== "win32",
            })
          } catch (error) {
            Sandbox.cleanup(sandbox)
            throw error
          }
          const completion = new Promise<void>((resolve, reject) => {
            child.once("exit", () => {
              exited = true
              resolve()
            })
            child.once("error", (error) => {
              exited = true
              reject(error)
            })
          })
          const stop = () => Shell.killTree(child, { exited: () => exited, detached: process.platform !== "win32" })
          try {
            const registered = await CommandRuntime.start(
              {
                projectID: Instance.project.id,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                ...(ctx.callID ? { callID: ctx.callID } : {}),
                description: params.description,
                command: params.command,
              },
              child,
              async () => {
                aborted = true
                await stop()
              },
              { authorityGeneration: current.generation, windowsRelease: wrapped.release },
            )
            const kill = async () => {
              await CommandRuntime.stop(registered.id, registered.projectID, registered.sessionID)
            }
            return { proc: child, command: registered, kill, sandbox, completion }
          } catch (error) {
            await stop()
            Sandbox.cleanup(sandbox)
            throw error
          }
        })
      })
      let output = ""

      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const redact = (text: string) => {
        try {
          return OpenScience.redactSecrets(text)
        } catch {
          return text
        }
      }

      const append = (chunk: Buffer) => {
        output += chunk.toString()
        const redacted = redact(output)
        ctx.metadata({
          metadata: {
            output:
              redacted.length > MAX_METADATA_LENGTH ? redacted.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : redacted,
            description: params.description,
          },
        })
      }

      const streams = { stdout: "", stderr: "" }
      const capture = (channel: keyof typeof streams) => (chunk: Buffer) => {
        streams[channel] += chunk.toString()
        append(chunk)
      }

      proc.stdout?.on("data", capture("stdout"))
      proc.stderr?.on("data", capture("stderr"))

      let timedOut = false

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer =
        timeout > 0
          ? setTimeout(() => {
              timedOut = true
              void kill()
            }, timeout + 100)
          : undefined

      await completion.finally(() => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        ctx.abort.removeEventListener("abort", abortHandler)
        CommandRuntime.finish(command.id)
        Sandbox.cleanup(sandbox)
      })

      const completed = Date.now()

      // The command spawned and ran to completion (or was killed) — record a
      // provenance run node so "what ran" is capturable for shell-produced
      // artifacts. Recording must never break the tool.
      const node = await provenance({
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        command: params.command,
        cwd,
        exit: proc.exitCode,
        stdout: streams.stdout,
        stderr: streams.stderr,
        startedAt: started,
        completedAt: completed,
      }).catch(() => undefined)

      const resultMetadata: string[] = []

      if (sandbox.warning) {
        resultMetadata.push(sandbox.warning)
      }

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      const redactedOutput = redact(output)
      const clipped =
        redactedOutput.length > MAX_METADATA_LENGTH
          ? redactedOutput.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
          : redactedOutput
      ctx.metadata({
        metadata: {
          output: clipped,
          description: params.description,
          provenanceID: node?.id,
        },
      })
      return {
        title: params.description,
        metadata: {
          output: clipped,
          exit: proc.exitCode,
          description: params.description,
          provenanceID: node?.id,
        },
        output: redactedOutput,
      }
    },
  }
})
