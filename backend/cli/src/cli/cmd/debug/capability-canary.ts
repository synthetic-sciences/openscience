import { EOL } from "node:os"
import { Agent } from "@/agent/agent"
import { CapabilityRegistry } from "@/science/capability/registry"
import {
  createScientificCapabilityCanaryContext,
  createScientificCapabilityCanaryTool,
  runScientificCapabilityCanary,
} from "@/science/capability/canary"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

export const CapabilityCanaryCommand = cmd({
  command: "capability-canary [id]",
  describe: "run exact scientific capability release canaries",
  builder: (yargs) =>
    yargs
      .positional("id", {
        type: "string",
        description: "Capability id; omit only with --all",
      })
      .option("all", {
        type: "boolean",
        default: false,
        description: "Run every packaged capability supported by the selected target",
      })
      .option("target", {
        type: "string",
        choices: ["local", "modal"] as const,
        default: "local" as const,
        description: "Execution backend",
      })
      .option("timeout", {
        type: "number",
        default: 900,
        description: "Per-capability timeout in seconds",
      })
      .option("acknowledge-remote-cost", {
        type: "boolean",
        default: false,
        description: "Required for Modal canaries because they may incur provider charges",
      })
      .check((args) => {
        if (!args.all && !args.id) throw new Error("Provide a capability id or use --all")
        if (args.all && args.id) throw new Error("Use either a capability id or --all, not both")
        if (!Number.isInteger(args.timeout) || Number(args.timeout) < 1 || Number(args.timeout) > 3_600) {
          throw new Error("--timeout must be an integer from 1 to 3600 seconds")
        }
        if (args.target === "modal" && !args.acknowledgeRemoteCost) {
          throw new Error("Modal canaries require --acknowledge-remote-cost")
        }
        return true
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const target = args.target as "local" | "modal"
      const selected = args.all
        ? CapabilityRegistry.listDetailed()
            .filter((item) => item.runtime?.targets.includes(target))
            .map((item) => item.id)
        : [String(args.id)]
      if (!selected.length) throw new Error(`No packaged capabilities support ${target}`)

      const agent = await Agent.get("research")
      if (!agent) throw new Error("The research agent is unavailable")
      const tool = await createScientificCapabilityCanaryTool({ agent })
      const results = []
      for (const id of selected) {
        const ctx = await createScientificCapabilityCanaryContext(agent)
        results.push(
          await runScientificCapabilityCanary({
            tool,
            ctx,
            id,
            target,
            timeoutSeconds: Number(args.timeout),
          }),
        )
      }
      process.stdout.write(JSON.stringify({ schema_version: 1, target, results }, null, 2) + EOL)
    })
  },
})
