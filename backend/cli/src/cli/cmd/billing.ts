import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { OpenScience } from "../../openscience"

const BILLING_URL = process.env.SYNSC_AUTH_URL?.replace(/\/+$/, "") || "https://app.syntheticsciences.ai/billing"

export const WalletCommand = cmd({
  command: ["wallet", "billing"],
  describe: "Wallet — balance, top up, and model access",
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

    const [mode, credits] = await Promise.all([OpenScience.getBillingMode(), OpenScience.getCredits()])
    if (!mode) {
      prompts.log.error("Couldn't fetch billing state. Check your connection or visit " + BILLING_URL)
      prompts.outro("Done")
      return
    }
    prompts.log.info(credits ? `Wallet      : $${credits.balanceUsd.toFixed(2)}` : "Wallet      : unavailable")
    prompts.log.info("Model access: choose BYOK / Subscription or Managed in web Settings.")
    if (!mode.managed_supported) {
      prompts.log.warn(
        "Credit-backed routes are not provisioned on this deployment — connect a provider account instead.",
      )
    } else if (!mode.managed_unlocked) {
      prompts.log.info("Managed access is off. Enable Ace in Billing or use remaining purchased Wallet credit.")
    }
    prompts.log.info("Review wallet, auto-reload, and usage at " + BILLING_URL + ".")
    prompts.outro("Done")
  },
})

const BillingTopupCommand = cmd({
  command: "topup",
  describe: "open web billing to add wallet credits",
  async handler() {
    UI.empty()
    prompts.intro("openscience billing")
    prompts.log.info(`Open: ${BILLING_URL}`)
    prompts.log.info("20 credits add $20 to your wallet; the processing fee is shown separately at checkout.")
    prompts.log.info(
      "Auto-reload adds 20 credits below a 2-credit purchased balance; turn it on or off anytime in Billing.",
    )
    prompts.log.info("Provider accounts and local models remain available and never draw down your wallet.")
    // Open the URL using execFile (no shell) so BILLING_URL can't be
    // interpreted as a shell expression. BILLING_URL itself is either an
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
      if (opener) execFile(opener, [BILLING_URL])
    } catch {}
    prompts.outro("Done")
  },
})
