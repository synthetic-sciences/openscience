import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { OpenScience } from "../../openscience"

const PLAN_URL = process.env.SYNSC_AUTH_URL?.replace(/\/+$/, "") || "https://app.syntheticsciences.ai/cli"

export const WalletCommand = cmd({
  command: ["wallet", "billing"],
  describe: "Atlas wallet — balance, top up, and key routing",
  builder: (yargs) => yargs.command(BillingShowCommand).command(BillingTopupCommand).demandCommand(),
  async handler() {},
})

const BillingShowCommand = cmd({
  command: ["show", "$0"],
  describe: "show CLI wallet balance and key routing",
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
    prompts.log.info(`CLI wallet  : $${mode.balance_usd.toFixed(2)}`)
    prompts.log.info("Key routing : per-provider (auto). BYOK key if set, else Atlas managed (debits wallet).")
    if (!mode.managed_supported) {
      prompts.log.warn(
        "Atlas managed fallback is not provisioned on this deployment — set a BYOK key for each provider.",
      )
    }
    prompts.log.info("Manage plans + top up at " + PLAN_URL + " (Plan tab).")
    prompts.outro("Done")
  },
})

const BillingTopupCommand = cmd({
  command: "topup",
  describe: "open the web Plan tab to top up CLI wallet credits",
  async handler() {
    UI.empty()
    prompts.intro("openscience billing")
    prompts.log.info(`Open: ${PLAN_URL}`)
    prompts.log.info("CLI wallet top-ups: $50 or $200, one-time or recurring monthly.")
    prompts.log.info("BYOK works on every plan — bring your own provider keys at any tier.")
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
