import { GlobalBus } from "@/bus/global"

export type FilesystemGlobalEvent = { directory?: string; payload: unknown }

const handlers = new Set<(event: FilesystemGlobalEvent) => void>()
const dispatch = (event: FilesystemGlobalEvent) => {
  for (const handler of [...handlers]) handler(event)
}

/**
 * Fan global filesystem-authority changes into live project instances through
 * one EventEmitter listener. A workspace may legitimately keep more than ten
 * projects alive, so attaching one listener per project produces Node's leak
 * warning even when every instance eventually disposes correctly.
 */
export function subscribeFilesystemEvents(handler: (event: FilesystemGlobalEvent) => void) {
  handlers.add(handler)
  if (handlers.size === 1) GlobalBus.on("event", dispatch)
  return () => {
    handlers.delete(handler)
    if (handlers.size === 0) GlobalBus.off("event", dispatch)
  }
}
