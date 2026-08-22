import { resolveArtifactPath } from "@/artifacts/context"

const clean = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "") || "/"

function normalize(value: string) {
  const input = clean(value)
  const drive = /^[A-Za-z]:\//.exec(input)?.[0]
  const prefix = drive ?? (input.startsWith("/") ? "/" : "")
  const body = drive ? input.slice(drive.length) : prefix ? input.slice(1) : input
  const parts: string[] = []
  for (const part of body.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") parts.pop()
      else if (!prefix) parts.push(part)
      continue
    }
    parts.push(part)
  }
  return `${prefix}${parts.join("/")}` || (prefix ? prefix : ".")
}

/** True when an artifact belongs to this connected project root rather than another session grant. */
export function projectContains(directory: string, file: string) {
  const root = normalize(directory)
  const target = normalize(resolveArtifactPath(directory, file))
  const windows = /^[A-Za-z]:\//.test(root) || /^[A-Za-z]:\//.test(target)
  const base = windows ? root.toLowerCase() : root
  const path = windows ? target.toLowerCase() : target
  return path === base || path.startsWith(base === "/" ? base : `${base}/`)
}

/** Build a session-authorized project-file query, with an optional path for collection endpoints. */
export function projectFileQuery(input: { directory: string; path?: string; sessionID?: string }) {
  return {
    ...(input.path ? { path: resolveArtifactPath(input.directory, input.path) } : {}),
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
  }
}

/** Build a raw-file query whose path remains project-relative in meaning even when a session grant is present. */
export function rawFileQuery(input: {
  directory: string
  path: string
  sessionID?: string
  maxBytes?: number
  inline?: boolean
}) {
  return {
    ...projectFileQuery(input),
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    ...(input.inline !== undefined ? { inline: input.inline ? "true" : "false" } : {}),
  }
}
