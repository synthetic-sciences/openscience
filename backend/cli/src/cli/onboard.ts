import * as prompts from "@clack/prompts"
import path from "path"
import fs from "fs/promises"
import type { Argv } from "yargs"
import { cmd } from "./cmd/cmd"
import { UI } from "./ui"
import { OpenScience } from "../openscience"
import { Auth } from "../auth"
import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import { Sandbox } from "../sandbox/sandbox"
import { Global } from "../global"
import { openUrl } from "../util/open-url"
import { runAtlasLogin } from "./cmd/connect"
import { AuthLoginCommand } from "./cmd/auth"
import { runLocalModelSetup } from "./cmd/local"
import { Installation } from "../installation"
import { webVersion } from "../web/assets"
import { Instance } from "../project/instance"
import { BILLING_URL } from "../endpoints"
import { BYOK_LLM_ENV_KEYS } from "../openscience/synced-env-policy"

const MARKER = path.join(Global.Path.state, "onboarded")

async function currentConfig() {
  return Instance.provide({ directory: process.cwd(), fn: () => Config.get() })
}

/** Authentication is the only first-run completion condition. Provider keys
 * and local models remain usable routes, but they do not replace the durable
 * Synthetic Sciences account that owns settings and trace consent. */
export async function isConfigured(): Promise<boolean> {
  return OpenScience.isAuthenticated()
}

async function isOnboarded(): Promise<boolean> {
  try {
    return await Bun.file(MARKER).exists()
  } catch {
    return false
  }
}

async function markOnboarded(): Promise<void> {
  try {
    await Bun.write(MARKER, new Date().toISOString() + "\n")
  } catch {}
}

/** Whether to auto-launch the first-run wizard from the default command.
 *  Gated on an interactive TTY plus "nothing configured yet"; suppressed in
 *  CI, when piped, once the marker is set, or via OPENSCIENCE_NO_ONBOARD=1. */
export async function needsOnboarding(): Promise<boolean> {
  if (process.env.OPENSCIENCE_NO_ONBOARD === "1") return false
  if (process.env.CI) return false
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  if (await isConfigured()) return false
  // Legacy releases could write this marker after choosing "Not now" while
  // still signed out. It must not bypass the account-first flow.
  if (await isOnboarded()) return true
  return true
}

async function onboardManaged(): Promise<void> {
  const existing = await OpenScience.getSession()
  if (existing) {
    prompts.log.success("Already connected to your Synthetic Sciences account.")
    await OpenScience.syncServices().catch(() => {})
  } else {
    const ok = await runAtlasLogin({})
    if (!ok) {
      prompts.log.warn("Sign-in did not finish. Run `openscience login` anytime to connect.")
      return
    }
  }

  const credits = await OpenScience.getCredits().catch(() => null)
  const balance = credits?.balanceUsd ?? null
  prompts.log.info(balance === null ? "Wallet: unavailable" : `Wallet: $${balance.toFixed(2)}`)

  if (balance !== null && balance <= 0) {
    const add = await prompts.confirm({
      message: "Add wallet credits now for pay-as-you-go models and enhanced search?",
      initialValue: true,
    })
    if (!prompts.isCancel(add) && add) {
      prompts.log.info(`Opening ${BILLING_URL} …`)
      prompts.log.message("Top up in Billing, then come back here — your balance updates automatically.")
      openUrl(BILLING_URL)
    } else {
      prompts.log.info(`No problem — top up anytime with \`openscience wallet\` or at ${BILLING_URL}.`)
    }
  }
  prompts.log.info(
    "Usage is pay as you go from your wallet. Switch to your own keys anytime with `openscience keys add`.",
  )
}

async function onboardByok(): Promise<void> {
  prompts.log.info(
    "Bring your own key or sign in with ChatGPT/Codex or Claude Max — pick next. " +
      "Saved model credentials use an owner-only local auth file, not the system keychain.",
  )
  // Reuse the proven provider picker + key/OAuth flow. It also handles
  // Claude Max / ChatGPT / Copilot sign-in via the provider auth plugins.
  await AuthLoginCommand.handler({} as never)
}

async function onboardLocal(): Promise<void> {
  prompts.log.info(
    "Point OpenScience at a local model server (Ollama, LM Studio, or any OpenAI-compatible endpoint). " +
      "It runs on your machine — free, offline, no API key.",
  )
  await runLocalModelSetup({ intro: false })
}

function onboardSkip(): void {
  prompts.log.info("No problem — you can explore projects and files without a model.")
  prompts.log.message(
    "Connect a model before using chat:\n" +
      "  openscience login       connect credit-backed models (pay as you go)\n" +
      "  openscience keys add    add a provider-billed account or key\n" +
      "  openscience local add   use a local model (Ollama / LM Studio / OpenAI-compatible)",
  )
}

/** The first-run setup wizard. Account connection comes first and persists as
 * a device credential; model billing and credential choices remain separate. */
export async function runOnboarding(opts?: { force?: boolean }): Promise<void> {
  prompts.intro(opts?.force ? "OpenScience setup" : "Welcome to OpenScience")

  if (!(await OpenScience.isAuthenticated())) {
    prompts.log.info("Connect a free Synthetic Sciences account once on this device.")
    const ok = await runAtlasLogin({})
    if (!ok) {
      prompts.cancel("Sign-in is required. Run `openscience login` when you're ready.")
      return
    }
  }

  const choice = await prompts.select({
    message: "How do you want to power the models?",
    initialValue: "managed",
    options: [
      { value: "managed", label: "Credits", hint: "★ recommended · pay as you go · zero setup" },
      { value: "byok", label: "Provider accounts", hint: "Anthropic · OpenAI · Google · billed by provider" },
      {
        value: "local",
        label: "Local models",
        hint: "Ollama · LM Studio · OpenAI-compatible endpoint · free, offline",
      },
      { value: "skip", label: "Set up models later", hint: "your account is already connected" },
    ],
  })
  if (prompts.isCancel(choice)) {
    prompts.cancel("Your account is connected. Run `openscience init` to finish model setup.")
    await markOnboarded()
    return
  }

  if (choice === "managed") await onboardManaged()
  else if (choice === "byok") await onboardByok()
  else if (choice === "local") await onboardLocal()
  else onboardSkip()

  await markOnboarded()
  prompts.outro("You're all set.")
}

export const InitCommand = cmd({
  command: ["init", "onboard"],
  describe: "set up OpenScience — models, accounts, and credits",
  async handler() {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    await runOnboarding({ force: true })
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

    const session = await OpenScience.getSession()
    if (session) {
      prompts.log.success("Synthetic Sciences account: connected")
      const [mode, credits] = await Promise.all([
        OpenScience.getBillingMode().catch(() => null),
        OpenScience.getCredits().catch(() => null),
      ])
      if (mode) {
        const suffix = mode.managed_unlocked ? "" : " (Managed off)"
        const amount = credits ? `$${credits.balanceUsd.toFixed(2)}` : "unavailable"
        prompts.log.info(`Wallet: ${amount}${suffix}`)
      }
    } else {
      prompts.log.info("Synthetic Sciences account: not connected  (run `openscience login`)")
    }

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

    const accountConnected = await isConfigured()
    const modelSourceAvailable = await Instance.provide({
      directory: process.cwd(),
      fn: async () => Object.keys(await Provider.list()).length > 0,
    }).catch(() => false)
    if (!accountConnected) {
      prompts.log.warn(
        "A Synthetic Sciences account is required before chat. Run `openscience login` once on this device.",
      )
    } else if (!modelSourceAvailable) {
      prompts.log.warn("No model source configured — chat is unavailable. Run `openscience init` to connect one.")
    }
    prompts.outro("Done")
  },
})
