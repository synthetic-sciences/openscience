import { resolveServerRoute } from "@/config/server-url"

export type NativePickerOptions = {
  title?: string
  multiple?: boolean
  server?: string
}

type NativePickerResult = {
  paths?: unknown
  error?: unknown
  unsupported?: unknown
}

export async function openNativePicker(
  kind: "folder" | "file",
  options: NativePickerOptions = {},
  request: typeof fetch = fetch,
): Promise<string | string[] | null | undefined> {
  const route = options.server
    ? resolveServerRoute("/api/resolve-folder/dialog", options.server, window.location.origin)
    : "/api/resolve-folder/dialog"
  const response = await request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, title: options.title, multiple: options.multiple ?? false }),
  })

  if (response.status === 501) return undefined

  const result = (await response.json().catch(() => ({}))) as NativePickerResult
  if (result.error === "cancelled") return null
  if (!response.ok)
    throw new Error(typeof result.error === "string" ? result.error : `Picker failed (${response.status})`)

  const paths = Array.isArray(result.paths)
    ? result.paths.filter((value): value is string => typeof value === "string")
    : []
  if (paths.length === 0) return null
  if (options.multiple) return paths
  return paths[0]
}
