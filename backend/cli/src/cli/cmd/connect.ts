import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { OpenScience, API_BASE } from "../../openscience"
import { openUrl } from "../../util/open-url"

/** Best-effort detection of environments where opening a browser and
 *  binding a loopback callback won't work (CI, SSH without a display,
 *  non-TTY pipelines). When true we skip straight to the paste flow. */
function isHeadless(): boolean {
  if (!process.stdout.isTTY) return true
  if (process.env.CI) return true
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true
  return false
}

async function syncAndReport() {
  const result = await OpenScience.syncServices()
  if (result) {
    const noun = result.credentials === 1 ? "credential" : "credentials"
    prompts.log.success(`Synced ${result.credentials} ${noun} from connected services`)
    return
  }
  // syncServices() returns null on every failure and clears the session when
  // the backend rejected the key. Never leave "authenticated" looking healthy
  // while every request silently fails — say what happened and against which host.
  if (!(await OpenScience.getSession())) {
    prompts.log.warn(`${API_BASE} rejected your saved key. Run \`openscience login\` to re-authenticate.`)
    return
  }
  prompts.log.warn(
    `Could not sync services from ${API_BASE} — the backend may be unreachable or your plan inactive. Provider keys/config were not updated.`,
  )
}

/** Validate + persist a pasted/CI-supplied thk_ key. */
async function finishWithKey(key: string): Promise<boolean> {
  const spinner = prompts.spinner()
  spinner.start("Validating key...")
  try {
    await OpenScience.loginWithKey(key)
    spinner.stop("Authenticated")
  } catch (e) {
    spinner.stop("Login failed", 1)
    prompts.log.error(e instanceof Error ? e.message : "Unknown error")
    return false
  }
  await syncAndReport()
  return true
}

/** Loopback browser login. Returns false (without throwing) so the caller
 *  can fall back to manual paste if it doesn't complete. */
async function tryBrowserLogin(): Promise<boolean> {
  let opened = false
  try {
    await OpenScience.browserLogin({
      onApprovalUrl(url) {
        prompts.log.info("Opening your browser to approve this device...")
        prompts.log.message(url)
        openUrl(url)
        opened = true
      },
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Unknown error"
    prompts.log.warn(opened ? `Browser login didn't complete: ${reason}` : `Couldn't start browser login: ${reason}`)
    return false
  }
  prompts.log.success("Authenticated")
  await syncAndReport()
  return true
}

/** Headless fallback: point the user at the dashboard, then accept a
 *  pasted thk_ key. */
async function manualKeyLogin(): Promise<boolean> {
  prompts.log.info("Finish login from any device with a browser:")
  prompts.log.message(
    `1. Open ${OpenScience.authPageUrl()} and sign in\n` + `2. Create a CLI API key (starts with thk_) and copy it`,
  )

  if (!process.stdin.isTTY) {
    prompts.log.error("No interactive terminal. Re-run with `--key thk_...` or set SYNSC_CLI_KEY.")
    return false
  }

  const pasted = await prompts.password({ message: "Paste your thk_ API key" })
  if (prompts.isCancel(pasted)) {
    prompts.cancel("Cancelled")
    return false
  }

  return await finishWithKey(pasted)
}

/** Core Atlas sign-in, shared by `openscience login` and the setup wizard.
 *  Returns true if the CLI is authenticated when it finishes. Carries no
 *  intro/outro framing so callers own the surrounding UI. */
export async function runAtlasLogin(args: { key?: string; browser?: boolean } = {}): Promise<boolean> {
  const existing = await OpenScience.getSession()
  if (existing) {
    // "authenticated" only means a key is saved locally. Name the backend so
    // that, if requests then fail, the user can see WHICH host they point at.
    prompts.log.success(`Already authenticated (backend: ${API_BASE})`)
    await syncAndReport()
    return true
  }

  // Non-interactive / CI: a key from --key or env short-circuits the flow.
  const provided = args.key || process.env.SYNSC_CLI_KEY || process.env.SYNSC_API_KEY
  if (provided) return await finishWithKey(provided)

  // Interactive with a usable browser → loopback login (zero typing).
  if (args.browser !== false && !isHeadless()) {
    if (await tryBrowserLogin()) return true
    // Browser flow failed/timed out — fall through to manual paste.
  }

  return await manualKeyLogin()
}

export const LoginCommand = cmd({
  command: "login",
  describe: "log in to your Atlas account (managed models, wallet, sync)",
  builder: (yargs) =>
    yargs
      .option("key", {
        type: "string",
        describe: "paste a thk_ API key directly (for headless / CI machines)",
      })
      .option("browser", {
        type: "boolean",
        default: true,
        describe: "open a browser to log in; pass --no-browser on headless machines",
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("OpenScience")
    const ok = await runAtlasLogin({ key: args.key as string | undefined, browser: args.browser as boolean })
    prompts.outro(ok ? "Done" : "Not signed in")
  },
})

export const LogoutCommand = cmd({
  command: "logout",
  describe: "log out of your Atlas account",
  async handler() {
    UI.empty()
    prompts.intro("OpenScience")

    const session = await OpenScience.getSession()
    if (!session) {
      prompts.log.warn("Not signed in to Atlas.")
      prompts.log.info("To remove a saved provider key instead, use `openscience keys rm`.")
      prompts.outro("Done")
      return
    }

    // Revoke this device's key server-side while it can still authenticate
    // the call, then clear every local credential artifact.
    const revoked = await OpenScience.revokeCurrentDevice()
    await OpenScience.clearSession()
    prompts.log.success("Signed out of Atlas")
    if (!revoked) {
      prompts.log.info(
        "Could not revoke this device's key server-side — remove it from the Devices tab at app.syntheticsciences.ai if needed",
      )
    }
    prompts.outro("Done")
  },
})

export const StatusCommand = cmd({
  command: ["status", "whoami"],
  describe: "show Atlas connection, account, and wallet",
  async handler() {
    UI.empty()
    prompts.intro("OpenScience")

    const session = await OpenScience.getSession()
    if (!session) {
      prompts.log.warn("Not connected to Atlas")
      prompts.log.info("Run `openscience login` to connect, or `openscience keys add` to use your own key.")
      prompts.outro("Done")
      return
    }

    prompts.log.success("Connected")
    prompts.log.info(`Backend: ${API_BASE}`)
    if (session.user_id) prompts.log.info(`User: ${session.user_id}`)
    if (session.device_name) prompts.log.info(`Device: ${session.device_name}`)

    const result = await OpenScience.syncServices()
    if (result) {
      if (result.user.email) prompts.log.info(`Email: ${result.user.email}`)
      const noun = result.credentials === 1 ? "credential" : "credentials"
      prompts.log.info(`Services: ${result.credentials} ${noun} synced`)
      if (result.user.subscription_status) {
        prompts.log.info(`Subscription: ${result.user.subscription_status}`)
      }
    } else if (!(await OpenScience.getSession())) {
      prompts.log.warn(`${API_BASE} rejected your saved key. Run \`openscience login\` to re-authenticate.`)
    } else {
      prompts.log.warn(
        `Could not reach ${API_BASE} to verify services — the saved session is untested against the backend.`,
      )
    }

    // Unified Atlas surface (WS7 A1): wallet + lifetime spend, recent usage,
    // managed-compute availability, and the bundled `atlas` companion version —
    // one answer to "what's my Atlas state?". Every probe degrades to silence.
    const [mode, credits, txns] = await Promise.all([
      OpenScience.getBillingMode().catch(() => null),
      OpenScience.getCredits().catch(() => null),
      OpenScience.getTransactions(5).catch(() => null),
    ])
    const balanceUsd = credits?.balanceUsd ?? mode?.balance_usd
    if (balanceUsd !== undefined) {
      const spent = credits ? ` (spent $${(credits.lifetimeSpentCents / 100).toFixed(2)} lifetime)` : ""
      prompts.log.info(`Wallet: $${balanceUsd.toFixed(2)}${spent}`)
    }
    if (mode) {
      prompts.log.info(`Managed compute: ${mode.managed_supported ? "available" : "unavailable"}`)
      prompts.log.info("Routing: per-provider (auto) — your key if set, else Atlas managed (debits wallet).")
    }
    if (txns && txns.length > 0) {
      const noun = txns.length === 1 ? "charge" : "charges"
      prompts.log.info(`Recent usage: ${txns.length} ${noun} — latest ${txns[0].description.slice(0, 64)}`)
    }
    const atlasVer = await OpenScience.atlasCliVersion()
    if (atlasVer) {
      const drift = atlasVer.startsWith("0.13.") ? "" : " (expected ^0.13.2 — run `npm i -g @synsci/atlas@latest`)"
      prompts.log.info(`atlas companion: v${atlasVer}${drift}`)
    }

    prompts.outro("Done")
  },
})

export const SyncCommand = cmd({
  command: "sync",
  describe: "sync service credentials from your Atlas account",
  async handler() {
    UI.empty()
    prompts.intro("OpenScience")

    const session = await OpenScience.getSession()
    if (!session) {
      prompts.log.warn("Not connected")
      prompts.log.info("Run `openscience login` to authenticate")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Syncing services...")

    const result = await OpenScience.syncServices()
    if (result) {
      const noun = result.credentials === 1 ? "credential" : "credentials"
      spinner.stop(`Synced ${result.credentials} ${noun}`)
    } else {
      spinner.stop(`Sync failed (backend: ${API_BASE})`, 1)
    }

    prompts.outro("Done")
  },
})

export const DevicesCommand = cmd({
  command: "devices",
  describe: "list authenticated devices",
  async handler() {
    UI.empty()
    prompts.intro("OpenScience")

    const session = await OpenScience.getSession()
    if (!session) {
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
    if (devices.length === 0) {
      prompts.log.info("No active devices")
      prompts.outro("Done")
      return
    }
    for (const d of devices) {
      const lastUsed = d.last_used_at ? new Date(d.last_used_at).toLocaleString() : "never"
      prompts.log.info(`${d.name}  [${d.key_prefix}…]  last used: ${lastUsed}`)
    }
    prompts.log.info("Revoke a device from the Devices tab in your CLI page on app.syntheticsciences.ai")
    prompts.outro("Done")
  },
})

// Atlas is `login` / `logout` (+ `status` / `sync` / `devices`), all top-level.
// The `connect` / `disconnect` verbs now belong to Codex (see cli/cmd/auth.ts):
// `connect` signs in with ChatGPT, `disconnect` signs out. Keeping the two
// account types on distinct verb pairs removes the old ambiguity where
// `connect login` and `login` both meant the Atlas account.
