import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  /** Identifies this invocation when the host executes a model tool call. */
  callID?: string
  agent: string
  /**
   * Current project directory for this session.
   * Prefer this over process.cwd() when resolving relative paths.
   */
  directory: string
  /**
   * Project worktree root for this session.
   * Useful for generating stable relative paths (e.g. path.relative(worktree, absPath)).
   */
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
  ask(input: AskInput): Promise<void>
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

/** A file reference. The host supplies its message, session, and part IDs. */
export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

/** Metadata must be JSON-serializable. File references do not save an artifact. */
export type ToolResult =
  | string
  | {
      output: string
      title?: string
      metadata?: Record<string, unknown>
      attachments?: ToolAttachment[]
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
