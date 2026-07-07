import * as prompts from "@clack/prompts"
import path from "path"
import { cmd } from "./cmd/cmd"
import { UI } from "./ui"
import { OpenScience } from "../openscience"
import { Auth } from "../auth"
import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import { Global } from "../global"
import { openUrl } from "../util/open-url"
import { runAtlasLogin } from "./cmd/connect"
import { AuthLoginCommand } from "./cmd/auth"
import { runLocalModelSetup } from "./cmd/local"

const PLAN_URL = process.env.SYNSC_AUTH_URL?.replace(/\/+$/, "") || "https://app.syntheticsciences.ai/cli"
const MARKER = path.join(Global.Path.state, "onboarded")

/** Provider env vars that count as "already configured" so we never nag a
 *  user who exported a key in their shell. Deliberately not exhaustive — a
 *  false negative just re-offers setup, which is harmless. */
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "CEREBRAS_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
]

function hasProviderEnv(): boolean {
  return PROVIDER_ENV_KEYS.some((k) => !!process.env[k])
}

/** True once the user has any usable way to run a model: a managed Atlas
 *  session, a saved BYOK key, a provider env var, or an explicit default
 *  model in config. Used to decide whether to auto-launch onboarding and
 *  whether to warn about a missing model. */
export async function isConfigured(): Promise<boolean> {
  if (await OpenScience.isAuthenticated()) return true
  if (hasProviderEnv()) return true
  try {
    if (Object.keys(await Auth.all()).length > 0) return true
  } catch {}
  try {
    const config = await Config.get()
    if (config.model) return true
  } catch {}
  return false
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
  if (await isOnboarded()) return false
  if (await isConfigured()) return false
  return true
}

async function onboardManaged(): Promise<void> {
  const existing = await OpenScience.getSession()
  if (existing) {
    prompts.log.success("Already connected to your Atlas account.")
    await OpenScience.syncServices().catch(() => {})
  } else {
    const ok = await runAtlasLogin({})
    if (!ok) {
      prompts.log.warn("Skipped Atlas sign-in. Run `openscience login` anytime to connect.")
      return
    }
  }

  const mode = await OpenScience.getBillingMode().catch(() => null)
  const balance = mode?.balance_usd ?? (await OpenScience.getBalance().catch(() => null)) ?? 0
  prompts.log.info(`Atlas wallet: $${balance.toFixed(2)}`)

  if (balance <= 0) {
    const add = await prompts.confirm({
      message: "Add funds now so you can use managed models?",
      initialValue: true,
    })
    if (!prompts.isCancel(add) && add) {
      prompts.log.info(`Opening ${PLAN_URL} …`)
      prompts.log.message("Top up in the Plan tab, then come back here — your balance updates automatically.")
      openUrl(PLAN_URL)
    } else {
      prompts.log.info(`No problem — top up anytime with \`openscience wallet\` or at ${PLAN_URL}.`)
    }
  }
  prompts.log.info(
    "Managed models are metered from your wallet. Switch to your own keys anytime with `openscience keys add`.",
  )
}

async function onboardByok(): Promise<void> {
  prompts.log.info(
    "Bring your own key or sign in with a subscription (ChatGPT/Codex, Claude Max) — pick next. Both stay on this machine and are free.",
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
  prompts.log.info("No problem — start right away with the free demo models.")
  prompts.log.message(
    "When you're ready:\n" +
      "  openscience login       connect Atlas managed models (prepaid wallet)\n" +
      "  openscience keys add    add your own provider key (always free)\n" +
      "  openscience local add   use a local model (Ollama / LM Studio / OpenAI-compatible)",
  )
}

async function offerAtlasCli(): Promise<void> {
  if (Bun.which("atlas")) return
  const yes = await prompts.confirm({
    message: "Install the Atlas CLI companion? (research graph — maps, runs, library)",
    initialValue: false,
  })
  if (prompts.isCancel(yes) || !yes) return

  if (!Bun.which("npm")) {
    prompts.log.info("Install it later with: npm i -g @synsci/atlas@latest")
    return
  }
  const spin = prompts.spinner()
  spin.start("Installing @synsci/atlas…")
  try {
    const proc = Bun.spawn(["npm", "install", "-g", "@synsci/atlas@latest"], { stdout: "ignore", stderr: "pipe" })
    const code = await proc.exited
    if (code === 0) {
      spin.stop("Atlas CLI installed — it shares your session, so it's already signed in.")
    } else {
      spin.stop("Couldn't install automatically. Run: npm i -g @synsci/atlas@latest", 1)
    }
  } catch {
    spin.stop("Couldn't install automatically. Run: npm i -g @synsci/atlas@latest", 1)
  }
}

/** The first-run setup wizard. Managed-first, but bring-your-own-key and
 *  "not now" stay one keystroke away — OpenScience never requires an account. */
export async function runOnboarding(opts?: { force?: boolean }): Promise<void> {
  prompts.intro(opts?.force ? "OpenScience setup" : "Welcome to OpenScience")

  const choice = await prompts.select({
    message: "How do you want to power the models?",
    initialValue: "managed",
    options: [
      { value: "managed", label: "Atlas managed", hint: "★ recommended · prepaid wallet · zero setup" },
      { value: "byok", label: "Your own keys", hint: "Anthropic · OpenAI · Google · 100+ providers · always free" },
      {
        value: "local",
        label: "Local models",
        hint: "Ollama · LM Studio · OpenAI-compatible endpoint · free, offline",
      },
      { value: "skip", label: "Not now", hint: "free demo models now, set up anytime" },
    ],
  })
  if (prompts.isCancel(choice)) {
    prompts.cancel("Setup cancelled — run `openscience init` whenever you're ready.")
    await markOnboarded()
    return
  }

  if (choice === "managed") await onboardManaged()
  else if (choice === "byok") await onboardByok()
  else if (choice === "local") await onboardLocal()
  else onboardSkip()

  await offerAtlasCli()
  await markOnboarded()
  prompts.outro("You're all set.")
}

export const InitCommand = cmd({
  command: ["init", "onboard"],
  describe: "set up OpenScience — models, keys, and Atlas",
  async handler() {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    await runOnboarding({ force: true })
  },
})

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "check what's configured and what's missing",
  async handler() {
    UI.empty()
    prompts.intro("openscience doctor")

    const session = await OpenScience.getSession()
    if (session) {
      prompts.log.success("Atlas account: connected")
      const mode = await OpenScience.getBillingMode().catch(() => null)
      if (mode) {
        const suffix = mode.managed_supported ? "" : " (managed not provisioned)"
        prompts.log.info(`Wallet: $${mode.balance_usd.toFixed(2)}${suffix}`)
      }
    } else {
      prompts.log.info("Atlas account: not connected  (run `openscience login`)")
    }

    try {
      const keys = Object.keys(await Auth.all())
      if (keys.length) prompts.log.success(`Provider keys: ${keys.join(", ")}`)
      else prompts.log.info("Provider keys: none  (run `openscience keys add`)")
    } catch {}

    const envKeys = PROVIDER_ENV_KEYS.filter((k) => !!process.env[k])
    if (envKeys.length) prompts.log.info(`Environment keys: ${envKeys.join(", ")}`)

    try {
      const config = await Config.get()
      const locals = Object.entries(config.provider ?? {}).filter(([, p]) =>
        Provider.isLocalBaseURL(p?.options?.baseURL ?? p?.api),
      )
      if (locals.length) {
        prompts.log.success(`Local models: ${locals.map(([id]) => id).join(", ")}  (run \`openscience local list\`)`)
      }
      prompts.log.info(`Default model: ${config.model ?? "auto (chosen from available providers)"}`)
    } catch {}

    if (!(await isConfigured())) {
      prompts.log.warn(
        "No model source configured — free demo models will be used. Run `openscience init` to set one up.",
      )
    }
    prompts.outro("Done")
  },
})
