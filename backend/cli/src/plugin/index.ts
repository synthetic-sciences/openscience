import type { Hooks, PluginInput, Plugin as PluginInstance } from "@synsci/plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpenScienceClient } from "@synsci/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { Session } from "../session"
import { NamedError } from "@synsci/util/error"
import { CopilotAuthPlugin } from "./copilot"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  // Default plugins installed from npm at first run. Keep this list to packages
  // that actually resolve on the public registry: a package that 404s is retried
  // on EVERY startup (install() only short-circuits once a package is on disk, so
  // a never-installable one never caches), serialized under the bun-install lock,
  // which was the primary cause of the slow startup / "server unresponsive" report
  // in #138. First-party auth that ships in-binary lives in INTERNAL_PLUGINS below.
  const BUILTIN: string[] = []

  // A single plugin install must never wedge startup. bun add for a missing/slow
  // package can hang well past a reasonable wait; cap it so we log and move on.
  const INSTALL_TIMEOUT_MS = Number(process.env["OPENSCIENCE_PLUGIN_INSTALL_TIMEOUT_MS"]) || 30_000

  // Built-in plugins that are directly imported (not installed from npm)
  const INTERNAL_PLUGINS: PluginInstance[] = [CodexAuthPlugin, CopilotAuthPlugin]

  // Install a plugin package, but never wait longer than INSTALL_TIMEOUT_MS — a
  // hung `bun add` (unreachable registry, missing package) must not block plugin
  // init and, with it, the whole instance from becoming responsive.
  async function installWithTimeout(pkg: string, version: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        BunProc.install(pkg, version),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`plugin install timed out after ${INSTALL_TIMEOUT_MS}ms`)),
            INSTALL_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const state = Instance.state(async () => {
    const client = createOpenScienceClient({
      baseUrl: "http://openscience.internal",
      fetch: Server.internalFetch(),
    })
    const config = await Config.get()
    const hooks: Hooks[] = []
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      serverUrl: Server.url(),
      $: Bun.$,
    }

    for (const plugin of INTERNAL_PLUGINS) {
      log.info("loading internal plugin", { name: plugin.name })
      const init = await plugin(input)
      hooks.push(init)
    }

    const plugins = [...(config.plugin ?? [])]
    if (!Flag.OPENSCIENCE_DISABLE_DEFAULT_PLUGINS) {
      plugins.push(...BUILTIN)
    }

    for (let plugin of plugins) {
      // ignore old codex plugin since it is supported first party now
      if (
        ["openscience-openai-codex-auth", "openscience-copilot-auth", "synsci-openai-codex-auth", "synsci-copilot-auth"] // legacy config names still skipped
          .some((name) => plugin.includes(name))
      )
        continue
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
        plugin = await installWithTimeout(pkg, version).catch((err) => {
          if (!builtin) throw err

          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to install builtin plugin", {
            pkg,
            version,
            error: message,
          })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to install built-in plugin ${pkg}@${version}: ${message}`,
            }).toObject(),
          })

          return ""
        })
        if (!plugin) continue
      }
      const mod = await import(plugin)
      // Prevent duplicate initialization when plugins export the same function
      // as both a named export and default export (e.g., `export const X` and `export default X`).
      // Object.entries(mod) would return both entries pointing to the same function reference.
      const seen = new Set<PluginInstance>()
      for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
        if (seen.has(fn)) continue
        seen.add(fn)
        const init = await fn(input)
        hooks.push(init)
      }
    }

    return {
      hooks,
      input,
    }
  })

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output)
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.hooks)
  }

  export async function init() {
    const hooks = await state().then((x) => x.hooks)
    const config = await Config.get()
    for (const hook of hooks) {
      // @ts-expect-error this is because we haven't moved plugin to sdk v2
      await hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await state().then((x) => x.hooks)
      for (const hook of hooks) {
        hook["event"]?.({
          event: input,
        })
      }
    })
  }
}
