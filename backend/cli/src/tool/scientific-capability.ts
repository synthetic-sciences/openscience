import z from "zod"
import { CapabilityRegistry } from "@/science/capability/registry"
import { CapabilityPlanInput } from "@/science/capability/schema"
import { Tool } from "./tool"

const ACTIONS = ["list", "describe", "plan"] as const
type Action = (typeof ACTIONS)[number]

const actionParameters = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("describe"),
      id: z.string().trim().min(1),
    })
    .strict(),
  CapabilityPlanInput.extend({
    action: z.literal("plan"),
    id: z.string().trim().min(1),
  }).strict(),
])

/**
 * Keep one object-rooted discovery contract instead of advertising every
 * package or workflow as another model tool. Runtime validation retains the
 * action-specific requirements.
 */
export const ScientificCapabilityParameters = z
  .object({
    action: z.enum(ACTIONS),
    id: z.string().trim().min(1).optional(),
    name: CapabilityPlanInput.shape.name.optional(),
    purpose: CapabilityPlanInput.shape.purpose.optional(),
    command: CapabilityPlanInput.shape.command.optional(),
    target: CapabilityPlanInput.shape.target.optional(),
    cwd: CapabilityPlanInput.shape.cwd,
    resources: CapabilityPlanInput.shape.resources,
    artifacts: CapabilityPlanInput.shape.artifacts,
    uploads: CapabilityPlanInput.shape.uploads,
    packages: CapabilityPlanInput.shape.packages,
    secret_refs: CapabilityPlanInput.shape.secret_refs,
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsed = actionParameters.safeParse(value)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
    }
  })

type Metadata = {
  scientific_capability: {
    action: Action
    id?: string
    status?: "verified" | "experimental" | "blocked"
    dispatched: false
  }
}

const output = (value: unknown) => JSON.stringify(value, null, 2)

export const ScientificCapabilityTool = Tool.define<typeof ScientificCapabilityParameters, Metadata>(
  "scientific_capability",
  {
    description: [
      "Discover the small, versioned scientific capability catalog and compile one capability into a compute_job proposal.",
      "Use list when the capability id is unknown; describe or plan directly when it is known. verified means release-validated; experimental means available but still task-reviewed; blocked means required runtime assets are not configured.",
      "plan only returns validated compute_job input. It never dispatches compute, installs packages, grants file access, reveals secrets, or approves spending. Call compute_job separately with the returned input.",
    ].join(" "),
    parameters: ScientificCapabilityParameters,
    async execute(args) {
      if (args.action === "list") {
        return {
          title: "Scientific capabilities",
          output: output({
            capabilities: CapabilityRegistry.list(),
            status_meaning: {
              verified: "Release-validated end to end.",
              experimental: "Available through the declared route; validate the actual workflow outputs.",
              blocked: "Not runnable until the manifest blocker is resolved.",
            },
          }),
          metadata: { scientific_capability: { action: args.action, dispatched: false } },
        }
      }

      if (!args.id) throw new Error(`${args.action} requires a scientific capability id`)
      if (args.action === "describe") {
        const capability = await CapabilityRegistry.describe(args.id)
        if (!capability) throw new Error(`Unknown scientific capability: ${args.id}. Call list first.`)
        return {
          title: `Capability: ${capability.name}`,
          output: output(capability),
          metadata: {
            scientific_capability: {
              action: args.action,
              id: capability.id,
              status: capability.status,
              dispatched: false,
            },
          },
        }
      }

      const planInput = CapabilityPlanInput.parse({
        name: args.name,
        purpose: args.purpose,
        command: args.command,
        target: args.target,
        cwd: args.cwd,
        resources: args.resources,
        artifacts: args.artifacts,
        uploads: args.uploads,
        packages: args.packages,
        secret_refs: args.secret_refs,
      })
      const proposal = await CapabilityRegistry.plan(args.id, planInput)
      return {
        title: `Capability plan: ${proposal.capability.id}`,
        output: output({
          ...proposal,
          next: "Review the proposal, then call compute_job with the returned input to preview it. Use action=start only after approval.",
        }),
        metadata: {
          scientific_capability: {
            action: args.action,
            id: proposal.capability.id,
            status: proposal.capability.status,
            dispatched: false,
          },
        },
      }
    },
  },
)
