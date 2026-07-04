import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"

// Provider-agnostic ordering: lead with the mainstream BYOK/OAuth providers.
// `synsci` (the managed Atlas provider) stays selectable but is not forced to the front — the
// OSS client is BYOK-first and must not privilege the managed provider by default.
export const popularProviders = ["anthropic", "openai", "google", "github-copilot", "openrouter", "vercel", "synsci"]

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const currentDirectory = createMemo(() => decode64(params.dir) ?? "")
  const providers = createMemo(() => {
    if (currentDirectory()) {
      const [projectStore] = globalSync.child(currentDirectory())
      return projectStore.provider
    }
    return globalSync.data.provider
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
