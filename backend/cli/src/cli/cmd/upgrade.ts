import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade openscience to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod

    let target: string
    try {
      target = args.target ? args.target.replace(/^v/, "") : await Installation.latest(method)
    } catch {
      prompts.log.warn("Could not check for updates")
      prompts.outro("Done")
      return
    }

    if (Installation.VERSION === target) {
      prompts.log.warn(`openscience upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }
    if (method === "unknown") {
      prompts.log.info("Manual or dev install detected, skipping upgrade")
      prompts.outro("Done")
      return
    }
    prompts.log.info("Using method: " + method)

    prompts.log.info(`From ${Installation.VERSION} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.data.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Please run the terminal as Administrator and try again")
        } else {
          prompts.log.error(err.data.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
