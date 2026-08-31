import { Uint8ArrayReader, ZipReader, type Entry } from "@zip.js/zip.js"
import { Network } from "@/settings/network"

const LIMIT = 25 * 1024 * 1024

export async function readBioNemoBody(response: Response, limit = LIMIT) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`NVIDIA response exceeds the ${limit}-byte capture limit`)
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const value = await reader.read()
      if (value.done) break
      total += value.value.byteLength
      if (total > limit) throw new Error(`NVIDIA response exceeds the ${limit}-byte capture limit`)
      chunks.push(value.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  // ZipReader expects ordinary Uint8Array.slice semantics, not Buffer's view.
  return new Uint8Array(Buffer.concat(chunks, total))
}

// NVCF redirects large results to a temporary download URL. Download without
// the NVIDIA token, pin public DNS addresses, and never follow another redirect.
// https://docs.api.nvidia.com/cloud-functions/reference/getfunctioninvocationresult
export async function downloadBioNemoResult(
  location: string | null,
  policy: Pick<Network.FetchPolicy, "resolveAddresses" | "transport"> = {},
) {
  const target = location ? URL.parse(location) : null
  if (!target || target.protocol !== "https:" || target.username || target.password || target.port || target.hash)
    throw new Error("NVIDIA large-result download requires an uncredentialed HTTPS URL")
  Network.canonicalDomain(target.hostname)
  const response = await Network.fetch(
    target.href,
    {
      method: "GET",
      headers: { accept: "application/json, application/zip, application/octet-stream" },
      credentials: "omit",
      signal: AbortSignal.timeout(2 * 60 * 1000),
    },
    {
      ...policy,
      // The NVIDIA response authorizes only this result URL, not a persistent
      // domain exception or arbitrary redirects to another destination.
      authorize: async (input) => {
        if (input.url !== target.href) throw new Error("NVIDIA result URL changed")
      },
      maxRedirects: 0,
      maxResponseBytes: LIMIT,
    },
  ).catch(() => {
    // Signed URLs are bearer credentials too; never persist transport errors
    // that may contain the URL/query string in the durable dispatch ledger.
    throw new Error("NVIDIA large-result download failed; retry this dispatch to obtain a fresh link")
  })
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`NVIDIA large-result download returned HTTP ${response.status}`)
  }
  return decodeBioNemoResult(await readBioNemoBody(response))
}

export async function decodeBioNemoResult(bytes: Uint8Array, limit = LIMIT) {
  if (bytes.byteLength > limit) throw new Error(`NVIDIA response exceeds the ${limit}-byte capture limit`)
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  // NVIDIA documents a .response JSON payload in its ZIP results. Also accept
  // a sole .json payload. Inspect in memory; no archive path reaches disk.
  // https://docs.api.nvidia.com/nim/reference/nvidia-streampetr-infer
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  const entries: Entry[] = []
  let total = 0
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= 64) throw new Error("NVIDIA result ZIP has too many entries")
      const parts = entry.filename.split("/")
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000
      if (
        !entry.filename ||
        /[\\:\0]/u.test(entry.filename) ||
        entry.filename.startsWith("/") ||
        parts.includes("..") ||
        parts.includes(".") ||
        mode === 0o120000
      )
        throw new Error("NVIDIA result ZIP contains an unsafe entry")
      if (entry.encrypted) throw new Error("NVIDIA result ZIP is encrypted")
      total += entry.uncompressedSize
      if (!Number.isSafeInteger(total) || total > limit)
        throw new Error(`NVIDIA result ZIP exceeds the ${limit}-byte capture limit`)
      entries.push(entry)
    }
    const payloads = entries.filter((entry) => !entry.directory && entry.filename.endsWith(".response"))
    const candidates = payloads.length
      ? payloads
      : entries.filter((entry) => !entry.directory && entry.filename.endsWith(".json"))
    if (candidates.length !== 1 || !candidates[0].getData)
      throw new Error("NVIDIA result ZIP must contain one JSON response payload")
    const chunks: Uint8Array[] = []
    let size = 0
    await candidates[0].getData(
      new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.byteLength
          if (size > limit) throw new Error(`NVIDIA result ZIP exceeds the ${limit}-byte capture limit`)
          chunks.push(chunk)
        },
      }),
      { checkSignature: true, useWebWorkers: false, signal: AbortSignal.timeout(30_000) },
    )
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))
  } finally {
    await reader.close()
  }
}
