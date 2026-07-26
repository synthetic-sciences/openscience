import { toast } from "@/atlas/Toast"
import { resolveServerRoute } from "@/config/server-url"

/** Verify a typed folder path through the selected OpenScience server. */
export async function validateDirectoryPath(server: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(resolveServerRoute("/api/resolve-folder/validate", server, window.location.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })
    const data = (await res.json()) as { ok?: boolean; absolute?: string; error?: string }
    if (res.ok && data.ok && data.absolute) return data.absolute
    toast.error("folder not available", data.error ?? "path could not be opened")
  } catch (error) {
    toast.error("folder not available", error instanceof Error ? error.message : "path could not be opened")
  }
  return null
}
