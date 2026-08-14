import { Bus } from "../bus"
import { File } from "../file"
import { Log } from "../util/log"
import path from "path"
import z from "zod"

import * as Formatter from "./formatter"
import { Config } from "../config/config"
import { mergeDeep } from "remeda"
import { Instance } from "../project/instance"
import { OpenScience } from "@/openscience"
import { ProjectTrust } from "@/project/trust"
import { AuthoritySignal } from "@/project/authority-signal"
import { Sandbox } from "@/sandbox/sandbox"
import { CommandRuntime } from "@/science/command/registry"
import { Shell } from "@/shell/shell"
import { spawn } from "node:child_process"

export namespace Format {
  const log = Log.create({ service: "format" })

  export const Status = z
    .object({
      name: z.string(),
      extensions: z.string().array(),
      enabled: z.boolean(),
    })
    .meta({
      ref: "FormatterStatus",
    })
  export type Status = z.infer<typeof Status>

  const state = Instance.state(async () => {
    const enabled: Record<string, boolean> = {}
    const cfg = await Config.getExecution()

    const formatters: Record<string, Formatter.Info> = {}
    if (cfg.formatter === false) {
      log.info("all formatters are disabled")
      return {
        enabled,
        formatters,
      }
    }

    for (const item of Object.values(Formatter)) {
      formatters[item.name] = item
    }
    for (const [name, item] of Object.entries(cfg.formatter ?? {})) {
      if (item.disabled) {
        delete formatters[name]
        continue
      }
      const result: Formatter.Info = mergeDeep(formatters[name] ?? {}, {
        command: [],
        extensions: [],
        ...item,
      })

      if (result.command.length === 0) continue

      result.enabled = async () => true
      result.name = name
      formatters[name] = result
    }

    return {
      enabled,
      formatters,
    }
  })

  async function isEnabled(item: Formatter.Info) {
    const s = await state()
    const cached = s.enabled[item.name]
    if (cached !== undefined) return cached
    const status = await item.enabled().catch((error) => {
      if (ProjectTrust.DeniedError.isInstance(error)) return undefined
      throw error
    })
    if (status === undefined) return false
    s.enabled[item.name] = status
    return status
  }

  async function getFormatter(ext: string) {
    const formatters = await state().then((x) => x.formatters)
    const result = []
    for (const item of Object.values(formatters)) {
      log.info("checking", { name: item.name, ext })
      if (!item.extensions.includes(ext)) continue
      if (!(await isEnabled(item))) continue
      log.info("enabled", { name: item.name, ext })
      result.push(item)
    }
    return result
  }

  async function run(item: Formatter.Info, file: string): Promise<number> {
    const command = item.command.map((value) => value.replace("$FILE", file))
    const launched = await AuthoritySignal.exclusive(async () => {
      // Global binaries can still execute project-owned config, plugins, or
      // hooks merely by starting in the project root. Binary location is not a
      // safe trust boundary, so every formatter spawn requires project trust.
      await ProjectTrust.require(Instance.project, "project_formatter")
      const options = await Config.trustedSandbox()
      const sandbox = Sandbox.wrapArgv({
        file: command[0]!,
        args: command.slice(1),
        workspace: [Instance.directory, Instance.worktree],
        readable: [Instance.directory, Instance.worktree],
        unreadable: OpenScience.kernelSensitivePaths(),
        options,
      })
      const wrapped = await CommandRuntime.wrap({
        file: sandbox.file,
        args: sandbox.args,
      })
      const child = (() => {
        try {
          return spawn(wrapped.file, wrapped.args, {
            cwd: Instance.directory,
            env: { ...OpenScience.kernelEnv(process.env), ...item.environment },
            stdio: "ignore",
            detached: process.platform !== "win32",
          })
        } catch (error) {
          Sandbox.cleanup(sandbox)
          throw error
        }
      })()
      const exited = new Promise<number>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code) => resolve(code ?? 1))
      })
      const stop = () =>
        Shell.killTree(child, { exited: () => child.exitCode !== null, detached: process.platform !== "win32" })
      const registered = await CommandRuntime.start(
        {
          projectID: Instance.project.id,
          sessionID: "formatter",
          messageID: "formatter",
          description: `Format ${path.basename(file)}`,
          command: command.join(" "),
        },
        child,
        stop,
        { windowsRelease: wrapped.release },
      ).catch(async (error) => {
        if (child.exitCode === null && child.signalCode === null) await stop()
        Sandbox.cleanup(sandbox)
        throw error
      })
      return { exited, registered, sandbox }
    })
    return launched.exited.finally(() => {
      CommandRuntime.finish(launched.registered.id)
      Sandbox.cleanup(launched.sandbox)
    })
  }

  export async function status() {
    const s = await state()
    const result: Status[] = []
    for (const formatter of Object.values(s.formatters)) {
      const enabled = await isEnabled(formatter)
      result.push({
        name: formatter.name,
        extensions: formatter.extensions,
        enabled,
      })
    }
    return result
  }

  export function init() {
    log.info("init")
    Bus.subscribe(File.Event.Edited, async (payload) => {
      const file = payload.properties.file
      log.info("formatting", { file })
      const ext = path.extname(file)

      for (const item of await getFormatter(ext)) {
        log.info("running", { command: item.command })
        try {
          const exit = await run(item, file)
          if (exit !== 0)
            log.error("failed", {
              command: item.command,
              ...item.environment,
            })
        } catch (error) {
          log.error("failed to format file", {
            error,
            command: item.command,
            ...item.environment,
            file,
          })
        }
      }
    })
  }
}
