export type DirectoryPickerOptions = {
  title?: string
  multiple?: boolean
  serverUrl?: string
}

type DirectoryPickerResponse = {
  paths?: unknown
  unsupported?: boolean
  message?: string
  error?: string
}

type DirectoryPickerRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class NativeDirectoryPickerUnavailable extends Error {}

export async function openNativeDirectoryPicker(
  options: DirectoryPickerOptions = {},
  request: DirectoryPickerRequest = fetch,
): Promise<string | string[] | null> {
  const base = options.serverUrl?.trim() || window.location.origin
  const url = new URL("/api/resolve-folder/dialog", base)
  if (options.title?.trim()) url.searchParams.set("title", options.title.trim())
  if (options.multiple) url.searchParams.set("multiple", "true")

  const response = await request(url, { headers: { Accept: "application/json" } })
  const body = (await response.json().catch(() => ({}))) as DirectoryPickerResponse
  if (response.status === 499 || body.error === "cancelled") return null
  if (response.status === 501 || body.unsupported) {
    throw new NativeDirectoryPickerUnavailable(body.message || "Native folder selection is unavailable.")
  }
  if (!response.ok) throw new Error(body.error || body.message || `Folder selection failed (${response.status}).`)

  const paths = Array.isArray(body.paths)
    ? body.paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
    : []
  if (paths.length === 0) return null
  return options.multiple ? paths : paths[0]!
}
