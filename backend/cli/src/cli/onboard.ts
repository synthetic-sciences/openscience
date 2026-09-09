import * as prompts from "@clack/prompts"
import path from "path"
import fs from "fs/promises"
import type { Argv } from "yargs"
import { cmd } from "./cmd/cmd"
import { UI } from "./ui"
import { Auth } from "../auth"
import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import { Sandbox } from "../sandbox/sandbox"
import { Global } from "../global"
import { runCodexAuthFlow } from "./cmd/auth"
import { runLocalModelSetup } from "./cmd/local"
import { Installation } from "../installation"
import { webVersion } from "../web/assets"
import { Instance } from "../project/instance"
import { BYOK_LLM_ENV_KEYS } from "../openscience/synced-env-policy"
import { OpenScience } from "../openscience"
import { runAtlasLogin } from "./cmd/connect"
import { openUrl } from "../util/open-url"
import { BILLING_URL } from "../endpoints"
import { ONBOARDING_VERSION, patchPreferences, readPreferences } from "../server/routes/settings/preferences"
import { readWallet } from "../server/routes/settings/wallet"
import { saveCredential } from "../server/routes/settings/credentials"

async function currentConfig() {
  return Instance.provide({ directory: process.cwd(), fn: () => Config.get() })
}

export async function isConfigured(): Promise<boolean> {
  if (await OpenScience.isAuthenticated()) return true
  const keys = await Auth.all().catch(() => ({}))
  if (Object.keys(keys).length) return true
  if (BYOK_LLM_ENV_KEYS.some((key) => !!process.env[key])) return true
  const config = await currentConfig().catch(() => undefined)
  return Object.values(config?.provider ?? {}).some((provider) =>
    Provider.isLocalBaseURL(provider?.options?.baseURL ?? provider?.api),
  )
}

/** How long the terminal waits for Ace to come on after the billing page opens. */
const ACE_WAIT_MS = 5 * 60_000
const ACE_POLL_MS = 4_000

const KEY_PROVIDERS = [
  { id: "anthropic", label: "Anthropic", placeholder: "sk-ant-…" },
  { id: "openai", label: "OpenAI", placeholder: "sk-…" },
  { id: "openrouter", label: "OpenRouter", placeholder: "sk-or-…" },
] as const

type Outcome = "completed" | "cancelled"

/**
 * The terminal first-run setup. Same four steps as the desktop card so a
 * person who installs with npx and one who installs the app meet the same
 * flow: account (required), Ace, own connections, done.
 */
export namespace Onboarding {
  /** Whether this install still has to see the current setup revision. */
  export async function pending(): Promise<boolean> {
    const preferences = await readPreferences().catch(() => undefined)
    return (preferences?.desktop_onboarding_version ?? 0) < ONBOARDING_VERSION
  }

  /** A wizard needs a person at a terminal; scripted, restarted, and CI runs skip it. */
  export function interactive(
    input: { isTTY: boolean; env: NodeJS.ProcessEnv } = {
      isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
      env: process.env,
    },
  ): boolean {
    if (!input.isTTY) return false
    if (input.env.CI) return false
    if (input.env.OPENSCIENCE_RESTARTED === "1") return false
    if (input.env.OPENSCIENCE_SKIP_ONBOARDING === "1") return false
    return true
  }

  export async function shouldRun(): Promise<boolean> {
    return interactive() && (await pending())
  }

  export async function run(opts: { force?: boolean } = {}): Promise<Outcome> {
    prompts.intro(opts.force ? "OpenScience setup" : "Welcome to OpenScience")
    prompts.log.message("Four short steps: account, Ace, your own connections, done.")

    if (!(await account())) return "cancelled"
    const aceOn = await ace()
    await connections(aceOn)
    await patchPreferences({ desktop_onboarding_version: ONBOARDING_VERSION, desktop_onboarding_step: "done" })
    prompts.outro("You're set. Create your first project in the workspace and send a message.")
    return "completed"
  }

  /** Step 1: an account is required; cancelling here ends setup. */
  async function account(): Promise<boolean> {
    if (await OpenScience.isAuthenticated()) {
      prompts.log.success("Signed in to Synthetic Sciences.")
      return true
    }
    prompts.log.step("Account · create your account or sign in")
    prompts.log.message(
      "Your workspace supplies model access, shared credentials, and the team wallet. OpenScience needs an account to continue.",
    )
    while (true) {
      const how = await prompts.select({
        message: "How do you want to sign in?",
        options: [
          {
            value: "browser",
            label: "Continue in the browser",
            hint: "sign up or sign in at app.syntheticsciences.ai",
          },
          { value: "key", label: "Paste a sign-in key", hint: "for machines without a browser" },
        ],
      })
      if (prompts.isCancel(how)) {
        prompts.cancel("Setup needs an account. Run `openscience` again to continue.")
        return false
      }
      const ok = await runAtlasLogin({ browser: how === "browser" })
      if (ok) return true
      prompts.log.warn("Sign-in did not complete. Try again.")
    }
  }

  /** Step 2: Ace is recommended and skippable. Returns whether it is on. */
  async function ace(): Promise<boolean> {
    prompts.log.step("Ace · managed models and research tools, pay as you go")
    const current = await readWallet(true, OpenScience, new AbortController().signal).catch(() => undefined)
    if (current?.aceEnabled) {
      prompts.log.success(`Ace is on${balance(current)}.`)
      return true
    }
    prompts.log.message(
      [
        "Ace unlocks, with no keys to manage:",
        "  • managed frontier models",
        "  • high-quality literature search through Firecrawl",
        "  • scientific schematics and image generation",
        "  • one team wallet for the workspace",
        "$0 to activate. Provider price plus a 5.5% funding fee, no subscription.",
      ].join("\n"),
    )
    const choice = await prompts.select({
      message: "Turn on Ace?",
      options: [
        { value: "on", label: "Turn on Ace", hint: "recommended · opens your billing page" },
        { value: "skip", label: "Skip for now", hint: "use your own keys; turn on later in Customize → Models" },
      ],
    })
    if (prompts.isCancel(choice) || choice === "skip") return false

    openUrl(BILLING_URL)
    prompts.log.info(`Finish in your browser: ${BILLING_URL}`)
    const spinner = prompts.spinner()
    spinner.start("Waiting for Ace…")
    const started = Date.now()
    while (Date.now() - started < ACE_WAIT_MS) {
      await Bun.sleep(ACE_POLL_MS)
      const wallet = await readWallet(false, OpenScience, new AbortController().signal).catch(() => undefined)
      if (!wallet?.aceEnabled) continue
      await OpenScience.setBillingMode("managed").catch(() => undefined)
      spinner.stop(`Ace is on${balance(wallet)}.`)
      return true
    }
    spinner.stop("Ace is not on yet.", 1)
    prompts.log.info("Finish in your browser whenever you like; the Models panel picks it up.")
    return false
  }

  /** Step 3: optional connections, repeated until the person continues. */
  async function connections(aceOn: boolean): Promise<void> {
    prompts.log.step("Connect your own models · optional")
    prompts.log.message(
      aceOn
        ? "Anything you connect here is used alongside Ace."
        : "Bring a ChatGPT subscription, provider keys, or a local model. You can also do this later in Customize → Models.",
    )
    const connected = new Set<string>()
    while (true) {
      const action = await prompts.select({
        message: "Add a connection",
        options: [
          { value: "continue", label: connected.size ? "Continue" : aceOn ? "Continue" : "Continue without a model" },
          {
            value: "openai-codex",
            label: "ChatGPT / Codex",
            hint: mark(connected, "openai-codex", "your ChatGPT subscription"),
          },
          ...KEY_PROVIDERS.map((item) => ({
            value: item.id,
            label: `${item.label} key`,
            hint: mark(connected, item.id, "API key"),
          })),
          {
            value: "firecrawl",
            label: "Firecrawl key",
            hint: mark(connected, "firecrawl", "your own literature search"),
          },
          {
            value: "local",
            label: "Local model",
            hint: mark(connected, "local", "Ollama · LM Studio · OpenAI-compatible"),
          },
        ],
      })
      if (prompts.isCancel(action) || action === "continue") return
      const done = await connect(action).catch((error: unknown) => {
        prompts.log.error(error instanceof Error ? error.message : String(error))
        return false
      })
      if (done) connected.add(action)
    }
  }

  async function connect(id: string): Promise<boolean> {
    if (id === "openai-codex") {
      return Instance.provide({ directory: process.cwd(), fn: () => runCodexAuthFlow() })
    }
    if (id === "local") {
      await runLocalModelSetup({ intro: false })
      return true
    }
    const provider = KEY_PROVIDERS.find((item) => item.id === id)
    const value = await prompts.password({
      message: provider ? `${provider.label} API key` : "Firecrawl API key",
    })
    if (prompts.isCancel(value)) return false
    const key = value.trim()
    if (!key) return false
    if (provider) {
      await Auth.set(provider.id, { type: "api", key })
      prompts.log.success(`${provider.label} key saved to this device.`)
      return true
    }
    await saveCredential("firecrawl", { api_key: key })
    prompts.log.success("Firecrawl key saved to this device.")
    return true
  }

  function mark(connected: Set<string>, id: string, hint: string) {
    return connected.has(id) ? "connected" : hint
  }

  function balance(wallet: { availableUsd?: number | null; balanceUsd: number | null }) {
    const value = wallet.availableUsd ?? wallet.balanceUsd
    return typeof value === "number" ? ` · $${value.toFixed(2)} available` : ""
  }
}

export const InitCommand = cmd({
  command: ["init", "onboard"],
  describe: "set up OpenScience: account, Ace, and your own connections",
  async handler() {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    await Onboarding.run({ force: true })
  },
})

/**
 * Measure the pre-2.0.2 data directory, and optionally remove it.
 *
 * The import copies rather than moves, deliberately: the previous root is the
 * only thing standing between a bad import and a user's history. The cost is
 * that it survives forever, silently, as a full duplicate — and because
 * nothing mentions it, the disk it holds is never reclaimed. So: name it,
 * measure it, and delete it only when asked.
 *
 * Removal is gated on the import having actually finished. While files are
 * still outstanding, that directory is the only copy of them.
 */
async function reportLegacyRoot(prune: boolean) {
  const legacy = Global.LegacyData
  if (!legacy) return
  const found = await measure(legacy)
  if (!found) return

  const size = found.bytes > 1024 * 1024 ? `${(found.bytes / 1024 / 1024).toFixed(0)} MB` : `${found.bytes} bytes`
  prompts.log.info(`Previous data directory: ${legacy} (${found.files} files, ${size})`)

  // The marker in the current data root is the only record that an import
  // actually ran, and that is what this has to be sure of before offering to
  // delete anything. Asking `DataMigration.migrated` instead answered a
  // different question: it is undefined whenever no import was attempted at
  // all — an explicit OPENSCIENCE_DATA_DIR, a settings ▸ Storage relocation
  // pointer, or an import that threw — and reading that as "nothing left to
  // do" would have offered to recursively delete a directory whose contents
  // were never copied anywhere.
  const record = await Bun.file(path.join(Global.Path.data, ".xdg-data-migration-v2.json"))
    .json()
    .then((value) => (value && typeof value === "object" ? (value as { pending?: unknown }) : undefined))
    .catch(() => undefined)
  const outstanding = Array.isArray(record?.pending) ? record.pending.length : 0

  if (Global.DataMigration.error) {
    prompts.log.warn(
      `The last import did not complete (${Global.DataMigration.error}), so this directory may still hold the ` +
        `only copy of some data. Leaving it alone.`,
    )
    return
  }
  if (!record) {
    prompts.log.warn(
      `Nothing has been imported out of it into ${Global.Path.data} — this data root was chosen explicitly ` +
        `(OPENSCIENCE_DATA_DIR or a storage location setting) rather than by the upgrade. Leaving it alone.`,
    )
    return
  }
  if (outstanding > 0) {
    prompts.log.warn(
      `${outstanding} file(s) have not been imported out of it yet, so it is still the only copy of those. ` +
        `Re-run once they are readable before removing it.`,
    )
    return
  }
  if (!prune) {
    prompts.log.info(`Everything importable has been copied into ${Global.Path.data}.`)
    prompts.log.info("Remove it with: openscience doctor --prune-legacy")
    return
  }
  // Refuse anything that is not plausibly the old data root, so a stray
  // OPENSCIENCE_DATA_DIR or a symlinked home cannot turn this into rm -rf.
  if (legacy === Global.Path.data || legacy === Global.Path.home || path.dirname(legacy) === legacy) {
    prompts.log.error(`Refusing to remove ${legacy}: it is the directory OpenScience is currently using.`)
    return
  }
  // Interactively, deleting a directory full of the user's history deserves a
  // second look. Non-interactively there is nobody to ask, and blocking on a
  // prompt nobody can answer would hang a scripted run forever — the flag was
  // typed on purpose, so let it stand as the answer.
  const confirmed = process.stdin.isTTY
    ? await prompts.confirm({ message: `Delete ${legacy} and its ${found.files} files?` })
    : true
  if (prompts.isCancel(confirmed) || !confirmed) {
    prompts.log.info("Left in place.")
    return
  }
  const failure = await fs
    .rm(legacy, { recursive: true, force: true })
    .then(() => undefined)
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  if (failure) prompts.log.error(`Could not remove ${legacy}: ${failure}`)
  if (!failure) prompts.log.success(`Removed ${legacy}, reclaiming ${size}.`)
}

async function measure(root: string) {
  const stack = [root]
  let files = 0
  let bytes = 0
  let seen = false
  while (stack.length) {
    const dir = stack.pop()
    if (!dir) continue
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined)
    if (!entries) continue
    seen = true
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      const stat = await fs.stat(full).catch(() => undefined)
      if (!stat) continue
      files += 1
      bytes += stat.size
    }
  }
  return seen ? { files, bytes } : undefined
}

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "check what's configured and what's missing",
  builder: (yargs: Argv) =>
    yargs.option("prune-legacy", {
      type: "boolean",
      describe: "delete the pre-2.0.2 data directory once its contents have been imported",
      default: false,
    }),
  async handler(args) {
    UI.empty()
    prompts.intro("openscience doctor")

    prompts.log.info(`Binary: ${process.execPath}`)
    prompts.log.info(`Version: ${Installation.VERSION}`)
    prompts.log.info(`Channel: ${Installation.CHANNEL}`)
    prompts.log.info(`Platform package: ${Installation.PLATFORM_PACKAGE}`)
    const web = await webVersion()
    const frontend = (() => {
      if (!web) return { level: "warn" as const, msg: "Frontend version: unavailable (web assets were not built)" }
      if (web.version !== Installation.VERSION || web.channel !== Installation.CHANNEL) {
        return {
          level: "warn" as const,
          msg: `Frontend version: ${web.version} (${web.channel}); expected ${Installation.VERSION} (${Installation.CHANNEL})`,
        }
      }
      return { level: "info" as const, msg: `Frontend version: ${web.version} (${web.channel})` }
    })()
    prompts.log[frontend.level](frontend.msg)
    prompts.log.info(`Config root: ${Global.Path.config}`)
    prompts.log.info(`Data root: ${Global.Path.data}`)
    prompts.log.info(`Cache root: ${Global.Path.cache}`)
    prompts.log.info(`State root: ${Global.Path.state}`)

    if (Global.DataMigration.migrated) {
      const done = Global.DataMigration.migrated
      // Each count is a distinct kind of import, so name them separately
      // rather than folding them into one "files" total that matches none of
      // them. `deferred` is the one a user can act on: those files are still
      // in the previous directory and the next launch will try again.
      prompts.log.success(
        `Legacy data imported into ~/.openscience and verified: ${done.files} file(s) copied, ` +
          `${done.merged} credential store(s) merged, ${done.artifacts} artifact record(s) restored, ` +
          `${done.skipped} already present. Existing OpenScience data was kept, and ${done.source} ` +
          `remains as a safety copy.`,
      )
      if (done.deferred > 0)
        prompts.log.warn(`${done.deferred} file(s) could not be read this run; the next launch will retry them.`)
    }
    if (Global.DataMigration.warning) {
      prompts.log.warn(Global.DataMigration.warning)
    }
    if (Global.DataMigration.error) {
      prompts.log.warn(
        `Data migration to ~/.openscience did not complete; OpenScience is using ${Global.DataMigration.path}. ${Global.DataMigration.error}`,
      )
    }

    if (Global.LegacyConflicts.length) {
      prompts.log.warn(
        `Legacy data directories are ignored because current directories exist: ${Global.LegacyConflicts.map((item) => item.legacy).join(", ")}. Merge or remove them.`,
      )
    }

    await reportLegacyRoot(args.pruneLegacy === true)

    try {
      const keys = Object.keys(await Auth.all())
      if (keys.length) prompts.log.success(`Provider keys: ${keys.join(", ")}`)
      else prompts.log.info("Provider keys: none  (run `openscience keys add`)")
    } catch {}

    const envKeys = BYOK_LLM_ENV_KEYS.filter((key) => !!process.env[key])
    if (envKeys.length) prompts.log.info(`Environment keys: ${envKeys.join(", ")}`)

    try {
      const config = await currentConfig()
      const locals = Object.entries(config.provider ?? {}).filter(([, p]) =>
        Provider.isLocalBaseURL(p?.options?.baseURL ?? p?.api),
      )
      if (locals.length) {
        prompts.log.success(`Local models: ${locals.map(([id]) => id).join(", ")}  (run \`openscience local list\`)`)
      }
      prompts.log.info(`Default model: ${config.model ?? "auto (chosen from available providers)"}`)

      const sandbox = Sandbox.describe()
      const sandboxOn = (await Config.trustedSandbox())?.enabled === true
      const sandboxLine = sandboxOn
        ? sandbox.available
          ? { level: "success" as const, msg: `Sandbox: on (${sandbox.backend})  (run \`openscience sandbox test\`)` }
          : { level: "warn" as const, msg: `Sandbox: on but no backend here — ${sandbox.reason}` }
        : {
            level: "info" as const,
            msg: sandbox.available
              ? `Sandbox: off  (${sandbox.backend} available — \`openscience sandbox enable\`)`
              : "Sandbox: off",
          }
      prompts.log[sandboxLine.level](sandboxLine.msg)
    } catch {}

    const modelSourceAvailable = await Instance.provide({
      directory: process.cwd(),
      fn: async () => Object.keys(await Provider.list()).length > 0,
    }).catch(() => false)
    if (!modelSourceAvailable) {
      prompts.log.warn("No model source configured — chat is unavailable. Run `openscience init` to connect one.")
    }
    prompts.outro("Done")
  },
})
