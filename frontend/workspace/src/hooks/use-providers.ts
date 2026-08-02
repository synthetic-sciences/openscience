import { useGlobalSync } from "@/context/global-sync"
import { createMemo } from "solid-js"
import { currentDirectory, currentProjectID } from "@/utils/base64"

// Provider-agnostic ordering: lead with the mainstream BYOK/OAuth providers.
// `synsci` (the managed Atlas provider) stays selectable but is not forced to the front — the
// OSS client is BYOK-first and must not privilege the managed provider by default.
export const popularProviders = [
  "anthropic",
  "openai",
  "google",
  "github-copilot",
  "xai",
  "deepseek",
  "moonshotai",
  "zai",
  "meta",
  "openrouter",
  "vercel",
  "synsci",
]

export function useProviders() {
  const globalSync = useGlobalSync()
  const providers = createMemo(() => {
    const directory = currentDirectory()
    if (!directory) return globalSync.data.provider
    const [projectStore] = globalSync.child(directory, { projectID: currentProjectID() })
    // The catalog belongs to the install; a project only ever narrows it. When
    // this project's own load did not land — its bootstrap failed, or the
    // server rejected the scope because two checkouts share one project
    // identity — fall back to the install catalog rather than reporting that
    // the user has no credentials at all. Showing "no keys" to someone who has
    // keys is the worse failure.
    if (!projectStore.provider.all.length) return globalSync.data.provider
    return projectStore.provider
  })
  const connected = createMemo(() => providers().all.filter((p) => providers().connected.includes(p.id)))
  const paid = createMemo(() =>
    connected().filter((p) => p.id !== "synsci" || Object.values(p.models).find((m) => m.cost?.input)),
  )
  const popular = createMemo(() => providers().all.filter((p) => popularProviders.includes(p.id)))
  return {
    all: createMemo(() => providers().all),
    default: createMemo(() => providers().default),
    popular,
    connected,
    paid,
  }
}
