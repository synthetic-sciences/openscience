import * as prompts from "@clack/prompts"
import { OpenScience } from "../../openscience"
import { MANAGED_API_BASE } from "../../endpoints"
import { openUrl } from "../../util/open-url"
import { UI } from "../ui"
import { cmd } from "./cmd"

function headless() {
  if (!process.stdout.isTTY) return true
  if (process.env.CI) return true
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

async function withKey(key: string) {
  const spinner = prompts.spinner()
  spinner.start("Validating key...")
  return OpenScience.loginWithKey(key)
    .then(() => {
      spinner.stop("Authenticated")
      const sync = OpenScience.credentialSyncStatus()
      if (sync.state === "error") prompts.log.warn(sync.error ?? "Run openscience sync to retry workspace credentials.")
      return true
    })
    .catch((error) => {
      spinner.stop("Login failed", 1)
      prompts.log.error(error instanceof Error ? error.message : "Unknown error")
      return false
    })
}

async function withBrowser() {
  return OpenScience.browserLogin({
    onApprovalUrl(url) {
      prompts.log.info("Opening your browser to approve this device...")
      prompts.log.message(url)
      openUrl(url)
    },
  })
    .then(() => {
      prompts.log.success("Authenticated")
      const sync = OpenScience.credentialSyncStatus()
      if (sync.state === "error") prompts.log.warn(sync.error ?? "Run openscience sync to retry workspace credentials.")
      return true
    })
    .catch((error) => {
      const reason = error instanceof Error ? error.message : "Unknown error"
      prompts.log.warn(`Browser login didn't complete: ${reason}`)
      return false
    })
}

async function manual() {
  prompts.log.info("Finish login from any device with a browser:")
  prompts.log.message(`1. Open ${OpenScience.authPageUrl()} and sign in\n2. Create an OpenScience API key and copy it`)

  if (!process.stdin.isTTY) {
    prompts.log.error("No interactive terminal. Re-run with `--key ...` or set SYNSC_CLI_KEY.")
    return false
  }

  const key = await prompts.password({ message: "Paste your OpenScience API key" })
  if (!prompts.isCancel(key)) return withKey(key)
  prompts.cancel("Cancelled")
  return false
}

/** Shared Ace sign-in used by the top-level login command and onboarding. */
export async function runAtlasLogin(args: { key?: string; browser?: boolean } = {}) {
  const key = args.key || process.env.SYNSC_CLI_KEY || process.env.SYNSC_API_KEY
  if (key) return withKey(key)
  const session = await OpenScience.getSession()
  if (session && args.browser !== true) {
    const result = await OpenScience.syncCredentials({ force: true })
    if (result.state === "error") prompts.log.warn(result.error ?? "Workspace credentials could not sync.")
    if (!(await OpenScience.getSession())) return manual()
    prompts.log.success(`Already authenticated (backend: ${MANAGED_API_BASE})`)
    return true
  }
  if (args.browser !== false && !headless() && (await withBrowser())) return true
  return manual()
}

export const LoginCommand = cmd({
  command: "login",
  describe: "log in to your Synthetic Sciences account for Ace and Wallet credits",
  builder: (yargs) =>
    yargs
      .option("key", {
        type: "string",
        describe: "paste an OpenScience API key directly (for headless or CI machines)",
      })
      .option("browser", {
        type: "boolean",
        default: true,
        describe: "open a browser to log in; pass --no-browser on headless machines",
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("OpenScience Ace")
    const ok = await runAtlasLogin({ key: args.key, browser: args.browser })
    prompts.outro(ok ? "Done" : "Not signed in")
  },
})

export const SyncCommand = cmd({
  command: "sync",
  describe: "refresh credentials from the workspace connected to this device",
  async handler() {
    const result = await OpenScience.syncCredentials({ force: true })
    if (result.state === "ready") prompts.log.success("Workspace credentials synced. Local credentials take priority.")
    else {
      prompts.log.error(result.error ?? "Sign in with openscience login first.")
      process.exitCode = 1
    }
  },
})

export const LogoutCommand = cmd({
  command: "logout",
  describe: "log out of your Synthetic Sciences account",
  async handler() {
    UI.empty()
    prompts.intro("OpenScience Ace")

    const session = await OpenScience.getSession()
    if (!session) {
      prompts.log.warn("Not signed in to Synthetic Sciences.")
      prompts.log.info("To remove a provider account instead, use `openscience disconnect` or `openscience keys rm`.")
      prompts.outro("Done")
      return
    }

    const revoked = await OpenScience.revokeCurrentDevice()
    await OpenScience.clearSession()
    prompts.log.success("Signed out of Synthetic Sciences")
    if (!revoked) {
      prompts.log.info("This device could not be revoked remotely. You can remove it from your account settings.")
    }
    prompts.outro("Done")
  },
})

export const StatusCommand = cmd({
  command: ["status", "whoami"],
  describe: "show your Ace account, model access, and purchased Wallet balance",
  async handler() {
    UI.empty()
    prompts.intro("OpenScience Ace")

    const session = await OpenScience.getSession()
    if (!session) {
      prompts.log.warn("Not connected to Synthetic Sciences")
      prompts.log.info("Run `openscience login` for Ace, or connect your own provider account.")
      prompts.outro("Done")
      return
    }

    prompts.log.success("Connected")
    prompts.log.info(`Backend: ${MANAGED_API_BASE}`)
    if (session.user_id) prompts.log.info(`User: ${session.user_id}`)
    if (session.device_name) prompts.log.info(`Device: ${session.device_name}`)

    const creditsRequest = OpenScience.getCredits().catch(() => null)
    const [profile, mode, credits, transactions] = await Promise.all([
      OpenScience.getProfile().catch(() => null),
      OpenScience.getBillingMode(undefined, creditsRequest).catch(() => null),
      creditsRequest,
      OpenScience.getTransactions(5).catch(() => null),
    ])
    if (profile?.display_name) prompts.log.info(`Name: ${profile.display_name}`)
    if (profile?.email) prompts.log.info(`Email: ${profile.email}`)
    if (!profile) prompts.log.warn("Saved locally; account status is currently unavailable.")

    if (credits) {
      const spent =
        credits.lifetimeSpentCents === null ? "" : ` (spent $${(credits.lifetimeSpentCents / 100).toFixed(2)} lifetime)`
      prompts.log.info(`Purchased Wallet: $${credits.balanceUsd.toFixed(2)}${spent}`)
    }
    if (mode) {
      prompts.log.info(`Model access: ${mode.mode === "managed" ? "Managed (Ace)" : "BYOK / Subscription"}`)
      if (mode.mode === "managed" && !mode.managed_supported) prompts.log.warn("Managed inference is unavailable.")
      if (mode.mode === "managed" && mode.managed_supported && !mode.managed_unlocked) {
        prompts.log.warn("Ace needs to be enabled before managed inference can run.")
      }
    }
    if (transactions?.length) {
      const latest = transactions[0].description.slice(0, 64)
      prompts.log.info(
        `Recent Wallet activity: ${transactions.length} ${transactions.length === 1 ? "entry" : "entries"}${latest ? ` — ${latest}` : ""}`,
      )
    }
    prompts.outro("Done")
  },
})

export const DevicesCommand = cmd({
  command: "devices",
  describe: "list devices signed in to your Synthetic Sciences account",
  async handler() {
    UI.empty()
    prompts.intro("OpenScience Ace")

    if (!(await OpenScience.getSession())) {
      prompts.log.warn("Not connected")
      prompts.log.info("Run `openscience login` to authenticate")
      prompts.outro("Done")
      return
    }

    const devices = await OpenScience.listDevices()
    if (!devices) {
      prompts.log.error("Failed to list devices")
      prompts.outro("Done")
      return
    }
    if (!devices.length) {
      prompts.log.info("No active devices")
      prompts.outro("Done")
      return
    }
    for (const device of devices) {
      const last = device.last_used_at ? new Date(device.last_used_at).toLocaleString() : "never"
      prompts.log.info(`${device.name}  [${device.key_prefix}…]  last used: ${last}`)
    }
    prompts.log.info("Revoke devices from your Synthetic Sciences account settings.")
    prompts.outro("Done")
  },
})
