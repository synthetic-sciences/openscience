import type { ChildProcess } from "node:child_process"
import z from "zod"

export const CommandStatus = z.object({
  id: z.string(),
  projectID: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  callID: z.string().optional(),
  description: z.string(),
  command: z.string(),
  state: z.literal("running"),
  process_id: z.number().int(),
  started_at: z.number().int(),
  resources: z
    .object({
      cpu_percent: z.number(),
      memory_bytes: z.number().int(),
    })
    .partial()
    .optional(),
})
export type CommandStatus = z.infer<typeof CommandStatus>

type Entry = CommandStatus & {
  process: ChildProcess
  stop: () => Promise<void>
}

const entries = new Map<string, Entry>()

export namespace CommandRuntime {
  export function start(
    input: Omit<CommandStatus, "id" | "state" | "process_id" | "started_at" | "resources">,
    process: ChildProcess,
    stop: () => Promise<void>,
  ) {
    if (!process.pid) throw new Error("Shell command started without a process id")
    const value: Entry = {
      ...input,
      id: `command-${crypto.randomUUID()}`,
      state: "running",
      process_id: process.pid,
      started_at: Date.now(),
      process,
      stop,
    }
    entries.set(value.id, value)
    return value
  }

  export function finish(id: string) {
    entries.delete(id)
  }

  export function list(projectID: string, sessionID?: string): CommandStatus[] {
    return [...entries.values()]
      .filter((value) => value.projectID === projectID && (!sessionID || value.sessionID === sessionID))
      .map(({ process: _process, stop: _stop, ...value }) => value)
      .toSorted((a, b) => b.started_at - a.started_at)
  }

  export function owned(id: string, projectID: string, sessionID: string) {
    const value = entries.get(id)
    if (!value || value.projectID !== projectID || value.sessionID !== sessionID) return
    return value
  }

  export async function stop(id: string, projectID: string, sessionID: string) {
    const value = owned(id, projectID, sessionID)
    if (!value) return false
    await value.stop()
    return true
  }
}
