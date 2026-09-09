import z from "zod"

const prefixes = {
  session: "ses",
  message: "msg",
  permission: "per",
  user: "usr",
  part: "prt",
  pty: "pty",
} as const

const LENGTH = 26
let lastTimestamp = 0
let counter = 0

type Prefix = keyof typeof prefixes
export namespace Identifier {
  export function schema(prefix: Prefix) {
    return z.string().startsWith(prefixes[prefix])
  }

  export function ascending(prefix: Prefix, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: Prefix, given?: string) {
    return generateID(prefix, true, given)
  }

  /**
   * An ascending id that sorts after `highest`. The 48-bit time prefix wraps
   * every ~795 days (last on 2026-08-14), so a fresh id can sort before the
   * ids of a session that predates the wrap. The server bumps its ids past the
   * session's highest for exactly this reason; an optimistic id must do the
   * same, or the server answers with a different id and the optimistic
   * message lingers at the top of the transcript.
   */
  export function after(prefix: Prefix, highest: string | undefined) {
    const natural = create(prefix, false)
    if (!highest || natural > highest) return natural
    const bumped = ((BigInt("0x" + highest.slice(4, 16)) + 1n) & 0xffffffffffffn).toString(16).padStart(12, "0")
    return prefixes[prefix] + "_" + bumped + natural.slice(16)
  }
}

function generateID(prefix: Prefix, descending: boolean, given?: string): string {
  if (!given) {
    return create(prefix, descending)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }

  return given
}

function create(prefix: Prefix, descending: boolean, timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }

  counter += 1

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  if (descending) {
    now = ~now
  }

  const timeBytes = new Uint8Array(6)
  for (let i = 0; i < 6; i += 1) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  return prefixes[prefix] + "_" + bytesToHex(timeBytes) + randomBase62(LENGTH - 12)
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }
  return hex
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = getRandomBytes(length)
  let result = ""
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i] % 62]
  }
  return result
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined

  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes)
    return bytes
  }

  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256)
  }

  return bytes
}
