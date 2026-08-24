import type { ContextTab, WorkTab } from "@/atlas/store/ui"

const HIDDEN_PUBLIC_CONTEXTS = new Set<ContextTab>(["canvas", "trace"])

export function publicContextAvailable(context: ContextTab) {
  return !HIDDEN_PUBLIC_CONTEXTS.has(context)
}

export function sanitizePublicContexts(store: {
  context: () => ContextTab
  workTabs: () => WorkTab[]
  openContext: (context: ContextTab) => void
  closeContext: () => void
  closeWorkTab: (id?: string) => void
}) {
  for (const tab of store.workTabs()) {
    if (tab.kind === "view" && !publicContextAvailable(tab.context)) store.closeWorkTab(tab.id)
  }
  if (publicContextAvailable(store.context())) return
  store.openContext("files")
  store.closeContext()
}
