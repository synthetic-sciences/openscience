import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { OpenScience } from "../../openscience"

const PLAN_URL = process.env.SYNSC_AUTH_URL?.replace(/\/+$/, "") || "https://app.syntheticsciences.ai/billing"

export const WalletCommand = cmd({
  command: ["wallet", "billing"],
  describe: "Credits — balance, top up, and key routing",
  builder: (yargs) => yargs.command(BillingShowCommand).command(BillingTopupCommand).demandCommand(),
  async handler() {},
})

const BillingShowCommand = cmd({
  command: ["show", "$0"],
  describe: "show credit balance and key routing",
  async handler() {
    UI.empty()
    prompts.intro("openscience billing")

    const session = await OpenScience.getSession()
    if (!session) {
      prompts.log.warn("Not authenticated. Run `openscience login` first.")
      prompts.outro("Done")
      return
    }

    const mode = await OpenScience.getBillingMode()
    if (!mode) {
      prompts.log.error("Couldn't fetch billing state. Check your connection or visit " + PLAN_URL)
      prompts.outro("Done")
      return
    }
    prompts.log.info(`Wallet      : ${mode.balance_usd.toFixed(2)} credits`)
    prompts.log.info("Key routing : direct BYOK, OAuth, and local routes stay direct. Ace models use OpenRouter.")
    if (!mode.managed_supported) {
      prompts.log.warn(
        "Gateway managed fallback is not provisioned on this deployment — set a BYOK key for each provider.",
      )
    }
    prompts.log.info("Add credits or manage auto-reload at " + PLAN_URL)
    prompts.outro("Done")
  },
})

const BillingTopupCommand = cmd({
  command: "topup",
  describe: "open web billing to add credits",
  async handler() {
    UI.empty()
    prompts.intro("openscience billing")
    prompts.log.info(`Open: ${PLAN_URL}`)
    prompts.log.info("Add 20 credits. Stripe processing is shown separately before payment.")
    prompts.log.info("Auto-reload adds 20 credits below 5 by default. You can turn it off at any time.")
    prompts.log.info("BYOK, OAuth, and local models remain direct and do not spend Wallet credits.")
    // Open the URL using execFile (no shell) so PLAN_URL can't be
    // interpreted as a shell expression. PLAN_URL itself is either an
    // operator-set env var or the hardcoded default above.
    try {
      const { execFile } = await import("child_process")
      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "linux"
            ? "xdg-open"
            : process.platform === "win32"
              ? "explorer"
              : null
      if (opener) execFile(opener, [PLAN_URL])
    } catch {}
    prompts.outro("Done")
  },
})
