import z from "zod"
import { MessageV2 } from "../session/message-v2"
import { PermissionNext } from "../permission/next"

/**
 * The `openscience run --format json` stdout contract: one JSON object per
 * line, each tagged with the root session id. The first five shapes predate
 * this schema and stay byte-compatible; `user`, `reasoning`, `permission`, and
 * `done` are additive. Harness adapters (tooling/harbor) parse exactly these.
 */
export namespace RunEvents {
  const Base = z.object({
    timestamp: z.number(),
    sessionID: z.string(),
    /** Present on events from a delegated child session: the session that dispatched it. */
    parentID: z.string().optional(),
  })

  export const ToolUse = Base.extend({ type: z.literal("tool_use"), part: MessageV2.ToolPart })
  export const StepStart = Base.extend({ type: z.literal("step_start"), part: MessageV2.StepStartPart })
  export const StepFinish = Base.extend({ type: z.literal("step_finish"), part: MessageV2.StepFinishPart })
  export const Text = Base.extend({ type: z.literal("text"), part: MessageV2.TextPart })
  /** A session error as published by the server: a named error with a data record. */
  export const Error = Base.extend({
    type: z.literal("error"),
    error: z.object({ name: z.string(), data: z.record(z.string(), z.unknown()) }),
  })

  export const UserPart = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("file"), url: z.string(), filename: z.string().optional(), mime: z.string() }),
  ])
  /** Echo of the prompt, emitted before the session starts. */
  export const User = Base.extend({
    type: z.literal("user"),
    parts: UserPart.array(),
    command: z.string().optional(),
  })
  export type User = z.infer<typeof User>

  /** One event per finished reasoning part. */
  export const Reasoning = Base.extend({ type: z.literal("reasoning"), part: MessageV2.ReasoningPart })

  /** The reply `run` gave to a permission request (root session or a descendant). */
  export const Permission = Base.extend({
    type: z.literal("permission"),
    request: PermissionNext.Request.pick({ id: true, sessionID: true, permission: true, patterns: true }),
    reply: PermissionNext.Reply,
  })
  export type Permission = z.infer<typeof Permission>

  /** A question the run answered on the model's behalf with the recommended option. */
  export const Question = Base.extend({
    type: z.literal("question"),
    request: z.object({ id: z.string(), sessionID: z.string() }),
    answers: z.array(z.array(z.string())),
  })
  export type Question = z.infer<typeof Question>

  export const Status = z.enum(["completed", "error", "rejected"])
  export type Status = z.infer<typeof Status>

  export const Tokens = MessageV2.StepFinishPart.shape.tokens
  export type Tokens = z.infer<typeof Tokens>

  /** One delegated child's identity and usage, rolled into `done`. */
  export const Child = z.object({
    sessionID: z.string(),
    parentID: z.string(),
    agent: z.string().optional(),
    model: z.string().optional(),
    tokens: Tokens,
    cost: z.number(),
  })
  export type Child = z.infer<typeof Child>

  /** Terminal event: status, the process exit code, usage summed over every
   * root step, and every child session's usage beside it. */
  export const Done = Base.extend({
    type: z.literal("done"),
    status: Status,
    exitCode: z.number().int(),
    tokens: Tokens,
    cost: z.number(),
    children: z.array(Child).default([]),
  })

  export const Event = z.discriminatedUnion("type", [
    ToolUse,
    StepStart,
    StepFinish,
    Text,
    Error,
    User,
    Reasoning,
    Permission,
    Question,
    Done,
  ])
  export type Event = z.infer<typeof Event>

  /** Exit codes of `openscience run`. */
  export const ExitCode = {
    completed: 0,
    /** The session reported an error (provider, tool, or agent failure). */
    error: 1,
    /** Usage or configuration error: unknown model or command, no provider, missing message. */
    usage: 2,
    /** Stopped by a rejected permission or question. */
    rejected: 3,
  } as const

  export function tokens(): Tokens {
    return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  }

  export function add(total: Tokens, step: Tokens): Tokens {
    return {
      input: total.input + step.input,
      output: total.output + step.output,
      reasoning: total.reasoning + step.reasoning,
      cache: { read: total.cache.read + step.cache.read, write: total.cache.write + step.cache.write },
    }
  }
}
