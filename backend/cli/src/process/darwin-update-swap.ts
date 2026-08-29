import { lstat } from "node:fs/promises"
import path from "node:path"
import { SafeDirectoryIO } from "../file/safe-directory-io"
import { SafeTrashIO } from "../file/safe-trash-io"

export const DARWIN_UPDATE_SWAP_ARG = "--desktop-update-swap"

function validIdentity(entry: unknown): entry is SafeDirectoryIO.Entry {
  return Boolean(
    Number.isSafeInteger((entry as SafeDirectoryIO.Entry | undefined)?.dev) &&
      (entry as SafeDirectoryIO.Entry).dev >= 0 &&
      Number.isSafeInteger((entry as SafeDirectoryIO.Entry | undefined)?.ino) &&
      (entry as SafeDirectoryIO.Entry).ino > 0 &&
      ["file", "directory"].includes((entry as SafeDirectoryIO.Entry | undefined)?.type ?? ""),
  )
}

function decode(value: string) {
  if (value.length > 16_384) throw new Error("Desktop update exchange payload is too large")
  const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  if (payload.action === "remove") {
    if (typeof payload.target !== "string" || !path.isAbsolute(payload.target)) {
      throw new Error("Invalid desktop update removal target")
    }
    if (path.normalize(payload.target) !== payload.target) {
      throw new Error("Desktop update removal target must be normalized")
    }
    const name = path.basename(payload.target)
    if (
      name !== "OpenScience.app" &&
      !/^OpenScience\.incoming-[0-9a-f]{16}\.app$/.test(name) &&
      !/^(?:pending|install)-[A-Za-z0-9_-]{6,64}$/.test(name)
    ) {
      throw new Error("Desktop update removal target is outside the updater-owned namespace")
    }
    if (!validIdentity(payload.target_identity)) {
      throw new Error("Desktop update removal identity is invalid")
    }
    return {
      action: "remove" as const,
      target: payload.target as string,
      target_identity: payload.target_identity as SafeDirectoryIO.Entry,
    }
  }
  if (payload.action !== "swap" && payload.action !== "move") {
    throw new Error("Invalid desktop update exchange action")
  }
  for (const key of ["target", "incoming"] as const) {
    if (typeof payload[key] !== "string" || !path.isAbsolute(payload[key])) {
      throw new Error(`Invalid desktop update exchange ${key}`)
    }
    if (path.normalize(payload[key]) !== payload[key] || !payload[key].endsWith(".app")) {
      throw new Error(`Desktop update exchange ${key} must be a normalized application path`)
    }
  }
  if (path.basename(payload.target) !== "OpenScience.app") {
    throw new Error("Desktop update exchange target must be OpenScience.app")
  }
  if (!/^OpenScience\.incoming-[0-9a-f]{16}\.app$/.test(path.basename(payload.incoming))) {
    throw new Error("Desktop update exchange incoming path is invalid")
  }
  if (path.dirname(payload.target) !== path.dirname(payload.incoming)) {
    throw new Error("Desktop update exchange entries must be siblings")
  }
  const identities =
    payload.action === "swap" ? (["target_identity", "incoming_identity"] as const) : (["incoming_identity"] as const)
  for (const key of identities) {
    const entry = payload[key]
    if (!validIdentity(entry) || entry.type !== "directory") {
      throw new Error(`Desktop update exchange ${key} is invalid`)
    }
  }
  return {
    action: payload.action as "swap" | "move",
    target: payload.target as string,
    incoming: payload.incoming as string,
    target_identity: payload.target_identity as SafeDirectoryIO.Entry | undefined,
    incoming_identity: payload.incoming_identity as SafeDirectoryIO.Entry,
  }
}

export namespace DarwinUpdateSwap {
  export async function run(value: string) {
    if (process.platform !== "darwin") throw new Error("Atomic desktop update exchange requires macOS")
    const payload = decode(value)
    if (payload.action === "remove") {
      const removed = await SafeTrashIO.remove(payload.target, {
        dev: payload.target_identity.dev,
        ino: payload.target_identity.ino,
        size: 0,
        mode: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        kind: payload.target_identity.type,
      })
      if (!removed) throw new Error("The approved desktop update cleanup target is missing")
      return 0
    }
    if (payload.action === "move") {
      const incomingStats = await lstat(payload.incoming)
      if (!incomingStats.isDirectory() || incomingStats.isSymbolicLink()) {
        throw new Error("Atomic desktop update install accepts only a real application directory")
      }
      await SafeDirectoryIO.moveNoReplace(payload.incoming, payload.target, payload.incoming_identity)
      return 0
    }
    const [targetStats, incomingStats] = await Promise.all([lstat(payload.target), lstat(payload.incoming)])
    if (
      !targetStats.isDirectory() ||
      targetStats.isSymbolicLink() ||
      !incomingStats.isDirectory() ||
      incomingStats.isSymbolicLink()
    ) {
      throw new Error("Atomic desktop update exchange accepts only real application directories")
    }
    await SafeDirectoryIO.swapEntries(
      payload.target,
      payload.incoming,
      payload.target_identity!,
      payload.incoming_identity,
    )
    return 0
  }
}
