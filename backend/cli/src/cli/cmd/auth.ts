import { Auth } from "../../auth"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { ModelsDev } from "../../provider/models"
import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { managedApiBase } from "../../endpoints"
import { Plugin } from "../../plugin"
import { Instance } from "../../project/instance"
import { OpenScience } from "../../openscience"
import { Log } from "../../util/log"
import { runLocalModelSetup } from "./local"
import type { Hooks } from "@synsci/plugin"

const log = Log.create({ service: "cmd.logout" })

type PluginAuth = NonNullable<Hooks["auth"]>

/**
 * Handle plugin-based authentication flow.
 * Returns true if auth was handled, false if it should fall through to default handling.
 */
async function handlePluginAuth(
  plugin: { auth: PluginAuth },
  provider: string,
  options?: { filterMethods?: (method: PluginAuth["methods"][number]) => boolean },
): Promise<boolean> {
  const candidates = options?.filterMethods
    ? plugin.auth.methods
        .map((m, i) => ({ method: m, originalIndex: i }))
        .filter((x) => options.filterMethods!(x.method))
    : plugin.auth.methods.map((m, i) => ({ method: m, originalIndex: i }))

  if (candidates.length === 0) return false

  let index = candidates[0].originalIndex
  if (candidates.length > 1) {
    // Non-interactive shell (CI/piped): can't render a select, and a browser
    // loopback flow won't work either — auto-pick a device-code method if one is
    // offered so headless sign-in isn't a dead end.
    if (!process.stdin.isTTY) {
      const device = candidates.find((x) => /device/i.test(x.method.label))
      index = (device ?? candidates[0]).originalIndex
    } else {
      const method = await prompts.select({
        message: "Login method",
        options: candidates.map((x) => ({
          label: x.method.label,
          value: x.originalIndex.toString(),
        })),
      })
      if (prompts.isCancel(method)) throw new UI.CancelledError()
      index = parseInt(method)
    }
  }
  const method = plugin.auth.methods[index]

  // Handle prompts for all auth types
  await Bun.sleep(10)
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.condition && !prompt.condition(inputs)) {
        continue
      }
      if (prompt.type === "select") {
        const value = await prompts.select({
          message: prompt.message,
          options: prompt.options,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      } else {
        const value = await prompts.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
          validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      }
    }
  }

  if (method.type === "oauth") {
    let authorize: Awaited<ReturnType<typeof method.authorize>>
    try {
      authorize = await method.authorize(inputs)
    } catch (e) {
      // e.g. the OAuth listener port is in use — surface a clean line, not a stack.
      prompts.log.error(e instanceof Error ? e.message : "Couldn't start sign-in.")
      prompts.outro("Not signed in")
      return true
    }

    if (authorize.url) {
      prompts.log.info("Go to: " + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        prompts.log.info(authorize.instructions)
      }
      const spinner = prompts.spinner()
      spinner.start("Waiting for authorization...")
      try {
        const result = await authorize.callback()
        if (result.type === "failed") {
          spinner.stop("Sign-in wasn't completed", 1)
          prompts.log.info("Declined, timed out, or cancelled. Retry with `openscience keys signin`.")
        } else if (result.type === "success") {
          const saveProvider = result.provider ?? provider
          if ("refresh" in result) {
            const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
            await Auth.set(saveProvider, {
              type: "oauth",
              refresh,
              access,
              expires,
              ...extraFields,
            })
          }
          if ("key" in result) {
            await Auth.set(saveProvider, {
              type: "api",
              key: result.key,
            })
          }
          spinner.stop("Login successful")
        }
      } catch (e) {
        // A thrown callback (denied consent, CSRF, timeout, network) must not
        // leave the spinner spinning or bubble a raw stack to the user.
        spinner.stop("Sign-in failed", 1)
        prompts.log.error(e instanceof Error ? e.message : "Unknown error")
      }
    }

    if (authorize.method === "code") {
      const code = await prompts.text({
        message: "Paste the authorization code here: ",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(code)) throw new UI.CancelledError()
      const result = await authorize.callback(code)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await Auth.set(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await Auth.set(saveProvider, {
            type: "api",
            key: result.key,
          })
        }
        prompts.log.success("Login successful")
      }
    }

    prompts.outro("Done")
    return true
  }

  if (method.type === "api") {
    if (method.authorize) {
      const result = await method.authorize(inputs)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        await Auth.set(saveProvider, {
          type: "api",
          key: result.key,
        })
        prompts.log.success("Login successful")
      }
      prompts.outro("Done")
      return true
    }
  }

  return false
}

export const KeysCommand = cmd({
  command: "keys",
  aliases: ["auth"],
  describe: "manage your own provider API keys (BYOK)",
  builder: (yargs) =>
    yargs
      .command(AuthLoginCommand)
      .command(AuthCodexCommand)
      .command(AuthLogoutCommand)
      .command(AuthListCommand)
      .demandCommand(),
  async handler() {},
})

export const AuthListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers",
  async handler() {
    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    prompts.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = Object.entries(await Auth.all())
    const database = await ModelsDev.get()

    for (const [providerID, result] of results) {
      const name = database[providerID]?.name || providerID
      prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    prompts.outro(`${results.length} credentials`)

    // Environment variables section
    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      prompts.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        prompts.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      prompts.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  },
})

export const AuthLoginCommand = cmd({
  command: ["add [url]", "login [url]"],
  describe: "add a provider API key (BYOK)",
  builder: (yargs) =>
    yargs.positional("url", {
      describe: "openscience auth provider",
      type: "string",
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Add credential")
        if (args.url) {
          const wellknown = await fetch(`${args.url}/.well-known/openscience`).then((x) => x.json() as any)
          prompts.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
          const proc = Bun.spawn({
            cmd: wellknown.auth.command,
            stdout: "pipe",
          })
          const exit = await proc.exited
          if (exit !== 0) {
            prompts.log.error("Failed")
            prompts.outro("Done")
            return
          }
          const token = await new Response(proc.stdout).text()
          await Auth.set(args.url, {
            type: "wellknown",
            key: wellknown.auth.env,
            token: token.trim(),
          })
          prompts.log.success("Logged into " + args.url)
          prompts.outro("Done")
          return
        }
        await ModelsDev.refresh().catch(() => {})

        const config = await Config.get()

        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const providers = await ModelsDev.get().then((x) => {
          const filtered: Record<string, (typeof x)[string]> = {}
          for (const [key, value] of Object.entries(x)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }
          return filtered
        })

        const priority: Record<string, number> = {
          synsci: 0,
          anthropic: 1,
          "github-copilot": 2,
          openai: 3,
          google: 4,
          openrouter: 5,
          vercel: 6,
        }
        let provider = await prompts.autocomplete({
          message: "Select provider",
          maxItems: 8,
          options: [
            // Codex is its own synthesized provider (openai-codex), so it isn't in
            // the models.dev list — surface it explicitly at the top so signing in
            // with a ChatGPT subscription is a first-class, discoverable choice.
            {
              value: "openai-codex",
              label: "Sign in with ChatGPT (Codex)",
              hint: "use your ChatGPT Plus/Pro/Business subscription — no API key",
            },
            // Local models aren't in the models.dev catalog — surface them at the
            // top so pointing OpenScience at Ollama / LM Studio / any local
            // OpenAI-compatible endpoint is a first-class, discoverable choice.
            {
              value: "local",
              label: "Local model (Ollama / LM Studio / OpenAI-compatible)",
              hint: "an endpoint on your machine — free, offline, no API key",
            },
            ...pipe(
              providers,
              values(),
              sortBy(
                (x) => priority[x.id] ?? 99,
                (x) => x.name ?? x.id,
              ),
              map((x) => ({
                label: x.name,
                value: x.id,
                hint: {
                  synsci: "Atlas — recommended",
                  anthropic: "Claude Max or API key",
                  openai: "ChatGPT subscription (Codex) or an API key",
                }[x.id],
              })),
            ),
            {
              value: "other",
              label: "Other",
            },
          ],
        })

        if (prompts.isCancel(provider)) throw new UI.CancelledError()

        // Local endpoint (Ollama / LM Studio / OpenAI-compatible): runs the local
        // setup wizard, which writes a provider config block (not an auth key).
        if (provider === "local") {
          await runLocalModelSetup({ intro: false })
          return
        }

        // Selecting the OpenAI provider offers two distinct auth styles: a
        // ChatGPT subscription (Codex OAuth, no API key) or an OpenAI Platform
        // API key. Present the choice explicitly instead of only pinning Codex
        // at the top of the list — users who look under "OpenAI" still find it.
        if (provider === "openai") {
          const style = await prompts.select({
            message: "How do you want to authenticate OpenAI?",
            options: [
              {
                value: "chatgpt",
                label: "ChatGPT subscription (Codex)",
                hint: "Plus/Pro/Business — sign in, no API key",
              },
              { value: "apikey", label: "OpenAI Platform API key", hint: "sk-… from platform.openai.com" },
            ],
          })
          if (prompts.isCancel(style)) throw new UI.CancelledError()
          if (style === "chatgpt") {
            await runCodexAuthFlow()
            return
          }
          // style === "apikey" → fall through to the API-key password prompt.
        }

        const plugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider))
        if (plugin && plugin.auth) {
          const handled = await handlePluginAuth({ auth: plugin.auth }, provider)
          if (handled) return
        }

        if (provider === "other") {
          provider = await prompts.text({
            message: "Enter provider id",
            validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
          })
          if (prompts.isCancel(provider)) throw new UI.CancelledError()
          provider = provider.replace(/^@ai-sdk\//, "")
          if (prompts.isCancel(provider)) throw new UI.CancelledError()

          // Check if a plugin provides auth for this custom provider
          const customPlugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider))
          if (customPlugin && customPlugin.auth) {
            const handled = await handlePluginAuth({ auth: customPlugin.auth }, provider)
            if (handled) return
          }

          prompts.log.warn(
            `This only stores a credential for ${provider} - you will need to configure it in openscience.json, check the docs for examples.`,
          )
        }

        if (provider === "amazon-bedrock") {
          prompts.log.info(
            "Amazon Bedrock authentication priority:\n" +
              "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
              "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
              "Configure via openscience.json options (profile, region, endpoint) or\n" +
              "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
          )
        }

        if (provider === "synsci") {
          prompts.log.info("Create an API key at https://app.syntheticsciences.ai/cli")
        }

        if (provider === "vercel") {
          prompts.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
        }

        if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
          prompts.log.info(
            "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://syntheticsciences.ai/docs/providers/#cloudflare-ai-gateway",
          )
        }

        const key = await prompts.password({
          message: "Enter your API key",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(key)) throw new UI.CancelledError()
        await Auth.set(provider, {
          type: "api",
          key,
        })

        prompts.outro("Done")
      },
    })
  },
})

/** Probe Atlas backend for whether the user's Codex OAuth is registered.
 *  Returns null when no Atlas session exists (caller treats it as unknown).
 *  Returns true|false when the backend gave a definitive answer.
 *
 *  The CLI's local Auth.get("openai-codex") and the Atlas backend can
 *  diverge — disconnecting Codex from the web UI doesn't notify the CLI.
 *  We check both before showing the "Already signed in" prompt so the
 *  flow stays robust under that drift. */
async function backendHasCodex(): Promise<boolean | null> {
  const session = await OpenScience.getSession?.()
  const thkToken = session?.api_key
  if (!thkToken) return null
  const thesisBase = managedApiBase()
  try {
    const res = await fetch(`${thesisBase}/api/keys/openai-codex/status`, {
      headers: { Authorization: `Bearer ${thkToken}` },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { connected?: boolean }
    return !!body.connected
  } catch {
    return null
  }
}

/** Run the Codex (ChatGPT subscription) OAuth flow. Shared by `keys signin` and
 *  the ChatGPT branch of `keys add` so both reach the exact same flow. Returns
 *  true when the flow ran, false when the codex auth plugin is unavailable. */
async function runCodexAuthFlow(): Promise<boolean> {
  const plugin = await Plugin.list().then((x) => x.find((p) => p.auth?.provider === "openai-codex"))
  if (!plugin || !plugin.auth) {
    prompts.log.error("Codex auth plugin not available")
    return false
  }
  await handlePluginAuth({ auth: plugin.auth }, "openai-codex", {
    filterMethods: (m) => m.type === "oauth",
  })
  return true
}

export const AuthCodexCommand = cmd({
  command: ["signin", "codex"],
  describe: "sign in with ChatGPT / Codex (Plus/Pro/Business subscription)",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Sign in with ChatGPT")

        const existing = await Auth.get("openai-codex")
        if (existing?.type === "oauth") {
          // Local has tokens. Check the backend before assuming "already
          // signed in" — the user may have disconnected from the web UI
          // (which only clears the backend, not local CLI state).
          const backend = await backendHasCodex()

          if (backend === false) {
            // Backend says disconnected (user clicked Disconnect on the
            // web). Honor that: wipe the stale local credential and fall
            // through to a fresh OAuth flow. The user expects logging out
            // from the web to clear their CLI session too.
            await Auth.remove("openai-codex")
            prompts.log.info("Codex was disconnected on the web — starting a fresh login.")
            // fall through to the OAuth flow below
          } else {
            // backend === true (or null/unknown — treat as connected).
            // Ask if the user wants a fresh OAuth despite already being
            // signed in.
            const again = await prompts.confirm({
              message: "Already signed in to Codex. Sign in again?",
              initialValue: false,
            })
            if (prompts.isCancel(again) || !again) {
              prompts.outro("Done")
              return
            }
          }
        }
        const handled = await runCodexAuthFlow()
        if (!handled) prompts.outro("Done")
      },
    })
  },
})

/** Best-effort server-side disconnect of the Codex credential, mirroring
 *  pushTokensToBackend's POST. Runs BEFORE the local removal so the thk_ key can
 *  still authenticate the call. Never throws — the local Auth.remove is what
 *  actually signs the CLI out. */
async function disconnectCodexBackend(): Promise<void> {
  const session = await OpenScience.getSession?.()
  const thkToken = session?.api_key
  if (!thkToken) return
  try {
    await fetch(`${managedApiBase()}/api/keys/openai-codex`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${thkToken}` },
    })
  } catch {
    /* best-effort — local removal below is the source of truth */
  }
}

/** `openscience connect [codex]` — sign in with a ChatGPT (Codex) subscription.
 *  The connect/disconnect verb pair is Codex's; Atlas uses login/logout. */
export const ConnectCommand = cmd({
  command: "connect [service]",
  describe: "connect a ChatGPT subscription (Codex) — sign in with ChatGPT",
  builder: (yargs) =>
    yargs.positional("service", {
      type: "string",
      choices: ["codex"] as const,
      default: "codex",
      describe: "service to connect (only `codex` today)",
    }),
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Connect ChatGPT (Codex)")
        const handled = await runCodexAuthFlow()
        if (!handled) prompts.outro("Done")
      },
    })
  },
})

/** `openscience disconnect [codex]` — sign out of ChatGPT (Codex): clears the
 *  local OAuth credential and best-effort revokes it server-side. */
export const DisconnectCommand = cmd({
  command: "disconnect [service]",
  describe: "disconnect your ChatGPT subscription (Codex)",
  builder: (yargs) =>
    yargs.positional("service", {
      type: "string",
      choices: ["codex"] as const,
      default: "codex",
      describe: "service to disconnect (only `codex` today)",
    }),
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Disconnect ChatGPT (Codex)")

        const existing = await Auth.get("openai-codex")
        const backend = await backendHasCodex()
        if (!existing && backend !== true) {
          prompts.log.warn("ChatGPT (Codex) isn't connected.")
          prompts.outro("Done")
          return
        }

        // Revoke server-side while the thk_ key can still authenticate, then
        // drop the local credential (the part that actually signs the CLI out).
        await disconnectCodexBackend()
        await Auth.remove("openai-codex")
        prompts.log.success("Disconnected ChatGPT (Codex)")
        prompts.outro("Done")
      },
    })
  },
})

export const AuthLogoutCommand = cmd({
  command: ["remove", "rm", "logout"],
  describe: "remove a saved provider key",
  async handler() {
    UI.empty()
    const credentials = await Auth.all().then((x) => Object.entries(x))
    prompts.intro("Remove credential")
    if (credentials.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    const database = await ModelsDev.get()
    const providerID = await prompts.select({
      message: "Select provider",
      options: credentials.map(([key, value]) => ({
        label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    if (prompts.isCancel(providerID)) throw new UI.CancelledError()
    await Auth.remove(providerID)
    // Removing Codex must also revoke it on the Atlas backend and re-sync so
    // the provider list drops openai-codex/* immediately — otherwise the CLI
    // and backend drift (local removed, backend still connected).
    if (providerID === "openai-codex") {
      await revokeCodexOnBackend()
      await OpenScience.syncServices?.().catch(() => {})
    }
    prompts.outro("Logout successful")
  },
})

async function revokeCodexOnBackend(): Promise<void> {
  const thesisBase = managedApiBase()
  const session = await OpenScience.getSession?.()
  const thkToken = session?.api_key
  if (!thkToken) {
    log.warn("no atlas session; skipping backend codex revoke")
    return
  }
  try {
    const res = await fetch(`${thesisBase}/api/keys/openai-codex`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${thkToken}` },
    })
    if (!res.ok && res.status !== 404) {
      log.warn("backend codex revoke failed", { status: res.status })
    }
  } catch (e) {
    log.warn("backend codex revoke errored", { error: String(e) })
  }
}
