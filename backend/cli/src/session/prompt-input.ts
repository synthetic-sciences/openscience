import z from "zod"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"

export const RuntimePromptInput = z.object({
  sessionID: Identifier.schema("session"),
  messageID: Identifier.schema("message").optional(),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  agent: z.string().optional(),
  noReply: z.boolean().optional(),
  tools: z
    .record(z.string(), z.boolean())
    .optional()
    .describe("@deprecated tools and permissions have been merged, you can set permissions on the session itself now"),
  effort: MessageV2.ResearchEffort.optional(),
  /** Controls automatic Task-tool delegation for this turn. */
  delegation: z.boolean().optional(),
  delegationSettings: MessageV2.DelegationSettings.optional(),
  system: z.string().optional(),
  variant: z.string().optional(),
  tier: z.string().optional(),
  context: z.number().int().positive().optional(),
  parts: z.array(
    z.discriminatedUnion("type", [
      MessageV2.TextPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "RuntimeTextPartInput",
        }),
      MessageV2.FilePart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "RuntimeFilePartInput",
        }),
      MessageV2.AgentPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "RuntimeAgentPartInput",
        }),
      z
        .object({
          id: Identifier.schema("part").optional(),
          type: z.literal("conversation"),
          sourceSessionID: Identifier.schema("session"),
          throughMessageID: Identifier.schema("message").optional(),
          label: z.string().trim().min(1).max(160).optional(),
        })
        .strict()
        .meta({ ref: "RuntimeConversationPartInput" }),
      MessageV2.SubtaskPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "RuntimeSubtaskPartInput",
        }),
    ]),
  ),
})
// Public clients may supply ordinary text, files, agent mentions, and
// explicit subtasks, but cannot mark text as synthetic/ignored or attach
// runtime metadata. Internal command expansion uses RuntimePromptInput.
export const PromptInput = RuntimePromptInput.extend({
  parts: z.array(
    z.discriminatedUnion("type", [
      MessageV2.TextPart.omit({
        messageID: true,
        sessionID: true,
        synthetic: true,
        ignored: true,
        time: true,
        metadata: true,
      })
        .partial({ id: true })
        .strict()
        .meta({ ref: "TextPartInput" }),
      MessageV2.FilePart.omit({ messageID: true, sessionID: true })
        .partial({ id: true })
        .meta({ ref: "FilePartInput" }),
      MessageV2.AgentPart.omit({ messageID: true, sessionID: true })
        .partial({ id: true })
        .meta({ ref: "AgentPartInput" }),
      z
        .object({
          id: Identifier.schema("part").optional(),
          type: z.literal("conversation"),
          sourceSessionID: Identifier.schema("session"),
          throughMessageID: Identifier.schema("message").optional(),
          label: z.string().trim().min(1).max(160).optional(),
        })
        .strict()
        .meta({ ref: "ConversationPartInput" }),
      MessageV2.SubtaskPart.omit({ messageID: true, sessionID: true })
        .partial({ id: true })
        .meta({ ref: "SubtaskPartInput" }),
    ]),
  ),
})
