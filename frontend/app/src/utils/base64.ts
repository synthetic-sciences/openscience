import { base64Decode } from "@synsci/util/encode"

export function decode64(value: string | undefined) {
  if (value === undefined) return
  try {
    return base64Decode(value)
  } catch {
    return
  }
}

/**
 * The active project directory, derived from the URL. The router mounts routes
 * under "/:dir" where `dir` is base64(directory), so the first path segment is
 * the encoded directory. This works anywhere — including dialogs portaled to
 * document.body outside the per-session SDK provider (which is why panels can't
 * rely on `useSDK().directory`). Empty string on the home route.
 */
export function currentDirectory(): string {
  if (typeof window === "undefined") return ""
  const seg = window.location.pathname.split("/").filter(Boolean)[0]
  return decode64(seg) ?? ""
}
