import z from "zod"
import { ProviderCli } from "@/compute/provider-cli"
import { Tool } from "./tool"

const statusOperations = new Set<ProviderCli.Operation>(["resource_status", "job_status"])

export const ProviderComputeParameters = z
  .object({
    provider: z
      .enum(ProviderCli.PROVIDERS)
      .describe("Configured compute provider whose saved credential should be used."),
    operation: z
      .enum(ProviderCli.OPERATIONS)
      .describe("Reviewed read-only account, inventory, list, or status operation."),
    resource_id: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .optional()
      .describe("Provider resource id. Required only by resource_status or job_status."),
  })
  .strict()
  .superRefine((value, ctx) => {
    const needsID = statusOperations.has(value.operation)
    if (needsID && !value.resource_id) {
      ctx.addIssue({ code: "custom", path: ["resource_id"], message: `${value.operation} requires resource_id` })
    }
    if (!needsID && value.resource_id !== undefined) {
      ctx.addIssue({ code: "custom", path: ["resource_id"], message: `${value.operation} does not accept resource_id` })
    }
  })

type Broker = Pick<typeof ProviderCli, "preview" | "execute">

type Metadata = {
  provider_compute: {
    provider: ProviderCli.Provider
    operation: ProviderCli.Operation
    command: string
    read_only: true
    ok?: boolean
  }
}

export function createProviderComputeTool(broker: Broker = ProviderCli) {
  return Tool.define<typeof ProviderComputeParameters, Metadata>("provider_compute", {
    description: [
      "Read live compute account, inventory, job, or resource status through OpenScience's host broker.",
      "Use this tool when a TensorPool, Lambda, Prime Intellect, Vast.ai, or RunPod skill needs the credential saved in Customize > Compute.",
      "The host selects a pinned trusted executable and exact reviewed argv, keeps the credential out of Bash and the model, and returns redacted output.",
      "This boundary is read-only: it cannot create, start, stop, resize, submit, or delete anything. Unsupported provider/operation pairs fail closed.",
    ].join(" "),
    parameters: ProviderComputeParameters,
    async execute(input, ctx) {
      const preview = broker.preview(input.provider, input.operation, input.resource_id)
      const pattern = [preview.provider, preview.operation, input.resource_id].filter(Boolean).join(":")
      const metadata: Metadata = {
        provider_compute: {
          provider: preview.provider,
          operation: preview.operation,
          command: preview.command,
          read_only: true,
        },
      }
      ctx.metadata({ title: `Review ${preview.provider} read: ${preview.operation}`, metadata })
      await ctx.ask({
        permission: "provider_compute",
        patterns: [pattern],
        always: [statusOperations.has(preview.operation) ? `${preview.provider}:${preview.operation}:*` : pattern],
        metadata: {
          ...metadata,
          network: { host: new URL(preview.docs).host },
        },
      })
      const result = await broker.execute(input.provider, input.operation, input.resource_id, { signal: ctx.abort })
      const completed: Metadata = {
        provider_compute: {
          ...metadata.provider_compute,
          command: result.command,
          ok: result.ok,
        },
      }
      ctx.metadata({
        title: result.ok ? `${preview.provider}: ${preview.operation}` : `${preview.provider} read failed`,
        metadata: completed,
      })
      return {
        title: result.ok ? `${preview.provider}: ${preview.operation}` : `${preview.provider} read failed`,
        metadata: completed,
        output: JSON.stringify(
          {
            ok: result.ok,
            provider: result.provider,
            operation: result.operation,
            command: result.command,
            checked_at: result.checked_at,
            ...(result.ok ? { result: result.output || null } : { error: result.error ?? "Provider read failed" }),
          },
          null,
          2,
        ),
      }
    },
  })
}

export const ProviderComputeTool = createProviderComputeTool()
