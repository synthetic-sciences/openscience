import { afterEach, expect, spyOn, test } from "bun:test"
import { Network } from "../../src/settings/network"
import {
  DEFAULT_DOWNLOAD_MAX_BYTES,
  MAX_DOWNLOAD_MAX_BYTES,
  MAX_RESPONSE_SIZE,
  WebFetchTool,
} from "../../src/tool/webfetch"
import type { Tool } from "../../src/tool/tool"
import { SessionFilesystem } from "../../src/session/filesystem"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const realFetch = globalThis.fetch

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("Expected operation to fail")
}

async function waitForStagedDownload(parent: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const staged = (await fs.readdir(parent)).find((entry) => entry.startsWith(".openscience-download-"))
    if (staged) return path.join(parent, staged)
    await Bun.sleep(1)
  }
  throw new Error("Timed out waiting for the staged WebFetch download")
}

function context(ask: Tool.Context["ask"], messages: Tool.Context["messages"] = []): Tool.Context {
  return {
    sessionID: "session_test",
    messageID: "message_test",
    agent: "research",
    abort: new AbortController().signal,
    extra: {},
    messages,
    metadata: () => {},
    ask,
  }
}

function failedToolHistory(input: Record<string, unknown>, error: string, callID = "call_prior") {
  return [
    {
      info: { id: "message_prior", sessionID: "session_test", role: "assistant" },
      parts: [
        {
          id: "part_prior",
          sessionID: "session_test",
          messageID: "message_prior",
          type: "tool",
          tool: "webfetch",
          callID,
          state: { status: "error", input, error, time: { start: 1, end: 2 } },
        },
      ],
    },
  ] as unknown as Tool.Context["messages"]
}

function completedToolHistory(input: Record<string, unknown>, output: string, callID: string) {
  return [
    {
      info: { id: "message_evidence", sessionID: "session_test", role: "assistant" },
      parts: [
        {
          id: "part_evidence",
          sessionID: "session_test",
          messageID: "message_evidence",
          type: "tool",
          tool: "webfetch",
          callID,
          state: {
            status: "completed",
            input,
            output,
            title: "Metadata",
            metadata: {},
            time: { start: 3, end: 4 },
          },
        },
      ],
    },
  ] as unknown as Tool.Context["messages"]
}

afterEach(async () => {
  globalThis.fetch = realFetch
  await Network.set({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
})

test("webfetch asks before reaching a blocked host and fails closed on deny", async () => {
  await Network.set({ allowlistEnabled: true, enabled: [], custom: ["allowed.test"] })
  const webfetch = await WebFetchTool.init()

  const asked: Parameters<Tool.Context["ask"]>[0][] = []
  const ctx = context(async (input) => {
    asked.push(input)
    throw new Error("denied by user")
  })

  await expect(webfetch.execute({ url: "https://blocked.test", format: "markdown" }, ctx)).rejects.toThrow(
    "denied by user",
  )
  expect(asked).toHaveLength(1)
  expect(asked[0].permission).toBe("network")
  expect(asked[0].patterns).toEqual(["blocked.test"])
  expect(asked[0].always).toEqual(["blocked.test"])
})

test("Network.blocked and Network.allow round-trip the allow-list", async () => {
  await Network.set({ allowlistEnabled: true, enabled: [], custom: [] })
  expect(await Network.blocked("https://example.test/data")).toBe("example.test")

  await Network.allow("example.test")
  expect(await Network.blocked("https://example.test/data")).toBeUndefined()
  expect((await Network.get()).custom).toEqual(["example.test"])

  // Enforcement off: nothing is blocked, but invalid URLs still throw.
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  expect(await Network.blocked("https://other.test")).toBeUndefined()
  await expect(Network.blocked("not a url")).rejects.toThrow("Invalid network URL")
})

test("webfetch asks for every blocked redirect target before following it", async () => {
  await Network.set({ allowlistEnabled: true, enabled: [], custom: ["example.com"] })
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url === "https://example.com/start") {
      return new Response(null, { status: 302, headers: { Location: "https://example.org/result" } })
    }
    return new Response("result", { headers: { "content-type": "text/plain" } })
  }) as typeof fetch
  const asked: Parameters<Tool.Context["ask"]>[0][] = []
  const webfetch = await WebFetchTool.init()
  const result = await webfetch.execute(
    { url: "https://example.com/start", format: "markdown" },
    context(async (input) => {
      asked.push(input)
    }),
  )

  expect(result.output).toBe("result")
  expect(calls).toHaveLength(2)
  expect(asked.map((item) => item.permission)).toEqual(["webfetch", "network"])
  expect(asked[1]?.patterns).toEqual(["example.org"])
})

test("webfetch rejects declared oversized text with terminal pagination and download guidance", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  globalThis.fetch = (async () =>
    new Response("body must not be exposed", {
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_RESPONSE_SIZE + 1),
      },
    })) as unknown as typeof fetch

  const webfetch = await WebFetchTool.init()
  await expect(
    webfetch.execute(
      { url: "https://example.com/large.json", format: "text" },
      context(async () => {}),
    ),
  ).rejects.toThrow(
    "Response is too large for Web fetch (5.0 MiB, application/json); the text-response limit is 5.0 MiB. " +
      "Do not repeat the same text-mode request. For a data file, call Web fetch again with output_path set to a simple " +
      "workspace-root filename without directories",
  )
})

test("webfetch stops a repeated oversized body before network but permits pagination", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    if (fetches === 1) {
      return new Response("body must not be exposed", {
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_RESPONSE_SIZE + 1),
        },
      })
    }
    return new Response("page two", { headers: { "content-type": "text/plain" } })
  }) as unknown as typeof fetch

  const webfetch = await WebFetchTool.init()
  const url = "https://example.com/oversized-body"
  const first = await captureError(
    webfetch.execute(
      { url, format: "text" },
      context(async () => {}),
    ),
  )
  expect(first.message).toContain("Response is too large for Web fetch")
  expect(first.message).not.toContain("[openscience-")

  let asks = 0
  await expect(
    webfetch.execute(
      { url: `${url}#format-only`, format: "html" },
      context(async () => {
        asks++
      }),
    ),
  ).rejects.toThrow("already exceeded the WebFetch body-response limit")
  expect(fetches).toBe(1)
  expect(asks).toBe(0)

  await expect(
    webfetch.execute(
      { url: `${url}?page=2`, format: "text" },
      context(async () => {}),
    ),
  ).resolves.toMatchObject({ output: "page two" })
  expect(fetches).toBe(2)
})

test("webfetch bounds a chunked response while it is being read", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let cancelled = false
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(3 * 1024 * 1024))
        },
        cancel() {
          cancelled = true
        },
      }),
      { headers: { "content-type": "text/plain" } },
    )) as unknown as typeof fetch

  const webfetch = await WebFetchTool.init()
  await expect(
    webfetch.execute(
      { url: "https://example.com/chunked", format: "text" },
      context(async () => {}),
    ),
  ).rejects.toThrow("Response is too large for Web fetch (6.0 MiB, text/plain)")
  expect(cancelled).toBe(true)
})

test("webfetch refuses binary attachments instead of decoding them as UTF-8", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "4",
        "content-disposition": 'attachment; filename="masked.maf.gz"',
      },
    })) as unknown as typeof fetch

  const webfetch = await WebFetchTool.init()
  await expect(
    webfetch.execute(
      { url: "https://example.com/masked-maf", format: "text" },
      context(async () => {}),
    ),
  ).rejects.toThrow(
    'Web fetch is text-only; the response is a file (application/octet-stream, 4 bytes, attachment; filename="masked.maf.gz").',
  )
})

test("webfetch marks a 404 as terminal instead of inviting a blind retry", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    return new Response("missing", { status: 404 })
  }) as unknown as typeof fetch

  const webfetch = await WebFetchTool.init()
  const input = { url: "https://example.com/missing", format: "text" as const }
  const first = await captureError(
    webfetch.execute(
      input,
      context(async () => {}),
    ),
  )
  expect(first.message).toContain(
    "Do not retry the same URL; verify it with the service's listing or metadata endpoint.",
  )

  let asks = 0
  await expect(
    webfetch.execute(
      { url: "https://EXAMPLE.COM:443/missing#client-fragment", format: "markdown", timeout: 120 },
      context(
        async () => {
          asks++
        },
        failedToolHistory(input, first.message),
      ),
    ),
  ).rejects.toThrow("already received deterministic HTTP 404")
  expect(fetches).toBe(1)
  expect(asks).toBe(0)
})

test("webfetch explains that a 405 needs a documented non-GET request", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    return new Response("method not allowed", { status: 405 })
  }) as unknown as typeof fetch

  const webfetch = await WebFetchTool.init()
  const input = { url: "https://example.com/post-only", format: "text" as const }
  const first = await captureError(
    webfetch.execute(
      input,
      context(async () => {}),
    ),
  )
  expect(first.message).toContain(
    "Web fetch sends GET, but this endpoint does not accept GET. Do not retry the same URL with Web fetch; verify the documented HTTP method",
  )
  await expect(
    webfetch.execute(
      { url: "https://example.com:443/post-only#retry", format: "html" },
      context(async () => {}, failedToolHistory(input, first.message)),
    ),
  ).rejects.toThrow("already received deterministic HTTP 405")
  expect(fetches).toBe(1)
})

test("webfetch still permits a same-URL retry after a non-terminal server failure", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    return fetches === 1
      ? new Response("temporary", { status: 503 })
      : new Response("recovered", { headers: { "content-type": "text/plain" } })
  }) as unknown as typeof fetch

  const webfetch = await WebFetchTool.init()
  const input = { url: "https://example.com/transient", format: "text" as const }
  const first = await captureError(
    webfetch.execute(
      input,
      context(async () => {}),
    ),
  )
  expect(first.message).toContain("status code: 503")
  const result = await webfetch.execute(
    input,
    context(async () => {}, failedToolHistory(input, first.message, "call_transient")),
  )
  expect(result.output).toBe("recovered")
  expect(fetches).toBe(2)
})

test("webfetch streams a brokered binary download through a reauthorized redirect", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-download-"))
  const root = path.join(base, "workspace")
  await fs.mkdir(root)
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  await Network.set({ allowlistEnabled: true, enabled: [], custom: ["example.com"] })
  const payload = new TextEncoder().encode("chunk-one\nchunk-two\n")
  const calls: string[] = []
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url === "https://example.com/start") {
      return new Response(null, { status: 302, headers: { location: "https://example.org/archive" } })
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller
        },
      }),
      {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(payload.byteLength),
          "content-disposition": 'attachment; filename="source-data.bin"',
        },
      },
    )
  }) as unknown as typeof fetch
  const asked: Parameters<Tool.Context["ask"]>[0][] = []
  const webfetch = await WebFetchTool.init()
  let pending: ReturnType<typeof webfetch.execute> | undefined
  let released = false

  try {
    pending = webfetch.execute(
      {
        url: "https://example.com/start",
        format: "text",
        output_path: "data.bin",
      },
      context(async (input) => {
        asked.push(input)
      }),
    )

    const staged = await waitForStagedDownload(base)
    expect(path.dirname(staged)).toBe(base)
    expect(path.relative(root, staged).startsWith(".." + path.sep)).toBe(true)
    expect(await fs.readdir(root)).toEqual([])

    body?.enqueue(payload.subarray(0, 7))
    body?.enqueue(payload.subarray(7))
    body?.close()
    released = true
    const result = await pending

    expect(calls).toEqual(["https://example.com/start", "https://example.org/archive"])
    expect(asked.map((item) => item.permission)).toEqual(["webfetch", "network"])
    expect(asked[1]?.patterns).toEqual(["example.org"])
    expect(await fs.readFile(path.join(root, "data.bin"))).toEqual(Buffer.from(payload))
    expect(result.output).toContain("Downloaded through the authorized network broker")
    expect(result.metadata).toMatchObject({
      truncated: false,
      download: {
        url: "https://example.org/archive",
        path: "data.bin",
        filename: "data.bin",
        sourceFilename: "source-data.bin",
        bytes: payload.byteLength,
        sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        contentType: "application/octet-stream",
      },
    })
    expect(await fs.readdir(root)).toEqual(["data.bin"])
    expect(await fs.readdir(base)).toEqual(["workspace"])
  } finally {
    if (!released) body?.error(new Error("test cleanup"))
    await pending?.catch(() => {})
    workspace.mockRestore()
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("webfetch download rejects directories, traversal, and existing destinations before fetching", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-contained-"))
  await fs.writeFile(path.join(root, "existing.bin"), "keep")
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    return new Response("should not run")
  }) as unknown as typeof fetch
  const webfetch = await WebFetchTool.init()
  const ctx = context(async () => {})

  try {
    await expect(
      webfetch.execute({ url: "https://example.com/data", format: "text", output_path: "../outside.bin" }, ctx),
    ).rejects.toThrow("must be a filename at the root of this session's workspace, without directories")
    await expect(
      webfetch.execute({ url: "https://example.com/data", format: "text", output_path: "nested/file.bin" }, ctx),
    ).rejects.toThrow("must be a filename at the root of this session's workspace, without directories")
    await expect(
      webfetch.execute({ url: "https://example.com/data", format: "text", output_path: "existing.bin" }, ctx),
    ).rejects.toThrow("Refusing to overwrite")
    expect(fetches).toBe(0)
    expect(await fs.readFile(path.join(root, "existing.bin"), "utf8")).toBe("keep")
  } finally {
    workspace.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("webfetch download rejects publisher HTML interstitials masquerading as data files", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-html-interstitial-"))
  const root = path.join(base, "workspace")
  await fs.mkdir(root)
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  const html = "<!doctype html><html><body>Sign in to download source data</body></html>"
  globalThis.fetch = (async () =>
    new Response(html, {
      headers: {
        // Publishers sometimes copy the requested filename/MIME onto an auth
        // interstitial, so byte sniffing must override this claim.
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-length": String(Buffer.byteLength(html)),
      },
    })) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    await expect(
      webfetch.execute(
        { url: "https://example.com/source-data", format: "text", output_path: "source-data.xlsx" },
        context(async () => {}),
      ),
    ).rejects.toThrow("Downloaded response is HTML, not the requested .xlsx file")
    expect(await fs.readdir(root)).toEqual([])
    expect(await fs.readdir(base)).toEqual(["workspace"])
  } finally {
    workspace.mockRestore()
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("webfetch download rejects a direct final-component symlink escape before fetching", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-symlink-root-"))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-symlink-outside-"))
  const outsideFile = path.join(outside, "outside.bin")
  await fs.writeFile(outsideFile, "keep outside")
  await fs.symlink(outsideFile, path.join(root, "escape.bin"))
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    return new Response("should not run")
  }) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    await expect(
      webfetch.execute(
        { url: "https://example.com/data", format: "text", output_path: "escape.bin" },
        context(async () => {}),
      ),
    ).rejects.toThrow("must stay inside this session's workspace and name a file")
    expect(fetches).toBe(0)
    expect(await fs.readFile(outsideFile, "utf8")).toBe("keep outside")
  } finally {
    workspace.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test("webfetch download stops guessed cap escalation and permits one server-declared retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-declared-limit-"))
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let cancelled = false
  let fetches = 0
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
  globalThis.fetch = (async () => {
    fetches++
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(payload)
          controller.close()
        },
        cancel() {
          cancelled = true
        },
      }),
      {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "9",
        },
      },
    )
  }) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    const input = {
      url: "https://example.com/too-large",
      format: "text" as const,
      output_path: "declared.bin",
      max_bytes: 8,
    }
    const first = await captureError(
      webfetch.execute(
        input,
        context(async () => {}),
      ),
    )
    expect(first.message).toContain(
      "Download exceeds max_bytes (9 bytes > 8 bytes). No destination file was created. Choose a smaller source or explicitly set max_bytes once from the declared size",
    )
    expect(cancelled).toBe(true)
    expect(await fs.readdir(root)).toEqual([])

    const history = failedToolHistory(input, first.message, "call_declared_oversize")
    const guessed = await captureError(
      webfetch.execute(
        { ...input, output_path: "guessed.bin", max_bytes: 16 },
        context(async () => {}, history),
      ),
    )
    expect(guessed.message).toContain("another guessed max_bytes escalation was stopped before network access")
    expect(guessed.message).toContain("The server previously declared exactly 9 bytes")
    expect(guessed.message).toContain('output_path: "guessed.bin", declared_size_bytes: 9, and max_bytes: 9')
    await expect(
      webfetch.execute(
        { ...input, output_path: "invented.bin", max_bytes: 10, declared_size_bytes: 10 },
        context(async () => {}, history),
      ),
    ).rejects.toThrow("must exactly match the server Content-Length already recorded for this URL (9 bytes)")
    expect(fetches).toBe(1)

    const result = await webfetch.execute(
      { ...input, output_path: "declared.bin", max_bytes: 9, declared_size_bytes: 9 },
      context(async () => {}, history),
    )
    expect(result.metadata).toMatchObject({ download: { bytes: 9 } })
    expect(await fs.readFile(path.join(root, "declared.bin"))).toEqual(Buffer.from(payload))
    expect(fetches).toBe(2)
  } finally {
    workspace.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("webfetch download aborts a chunked body at max_bytes and removes the partial temp file", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-chunk-limit-"))
  const root = path.join(base, "workspace")
  await fs.mkdir(root)
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let cancelled = false
  let fetches = 0
  let chunks = 0
  globalThis.fetch = (async () => {
    fetches++
    if (fetches > 1) {
      return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
        headers: { "content-type": "application/octet-stream" },
      })
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks++ === 0 ? [1, 2, 3, 4] : [5, 6, 7, 8]
          controller.enqueue(new Uint8Array(next))
        },
        cancel() {
          cancelled = true
        },
      }),
      { headers: { "content-type": "application/octet-stream" } },
    )
  }) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    const input = {
      url: "https://example.com/chunked-large",
      format: "text" as const,
      output_path: "chunked.bin",
      max_bytes: 6,
    }
    const first = await captureError(
      webfetch.execute(
        input,
        context(async () => {}),
      ),
    )
    expect(first.message).toContain(
      "Download exceeds max_bytes (6 bytes). Partial data was discarded; use a metadata/listing endpoint to obtain the exact byte size for one evidence-backed retry, choose a smaller or paginated source, or use a different canonical download URL. Do not retry this URL with incrementally larger caps.",
    )
    expect(cancelled).toBe(true)
    expect(await fs.readdir(root)).toEqual([])
    expect(await fs.readdir(base)).toEqual(["workspace"])
    await expect(
      webfetch.execute(
        { ...input, max_bytes: 8, declared_size_bytes: 8 },
        context(async () => {}, failedToolHistory(input, first.message, "call_chunked_oversize")),
      ),
    ).rejects.toThrow("declared_size_bytes needs auditable evidence")
    expect(fetches).toBe(1)

    const evidenceCallID = "call_size_metadata"
    const history = [
      ...failedToolHistory(input, first.message, "call_chunked_oversize"),
      ...completedToolHistory(
        { url: "https://example.com/metadata", format: "text" },
        JSON.stringify({ download_url: input.url, size: 8 }),
        evidenceCallID,
      ),
    ]
    const recovered = await webfetch.execute(
      {
        ...input,
        max_bytes: 8,
        declared_size_bytes: 8,
        declared_size_evidence_call_id: evidenceCallID,
      },
      context(async () => {}, history),
    )
    expect(recovered.metadata).toMatchObject({ download: { bytes: 8 } })
    expect(fetches).toBe(2)
  } finally {
    workspace.mockRestore()
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("webfetch download uses a conservative default byte cap", async () => {
  expect(DEFAULT_DOWNLOAD_MAX_BYTES).toBe(256 * 1024 * 1024)
  expect(MAX_DOWNLOAD_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024)

  const webfetch = await WebFetchTool.init()
  await expect(
    webfetch.execute(
      {
        url: "https://example.com/data",
        format: "text",
        output_path: "data.bin",
        max_bytes: MAX_DOWNLOAD_MAX_BYTES + 1,
      },
      context(async () => {}),
    ),
  ).rejects.toThrow("invalid arguments")
})

test("webfetch download preserves a disk reserve before consuming the body", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-disk-reserve-"))
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  const statfs = spyOn(fs, "statfs").mockResolvedValue({ bavail: 1, bsize: 1 } as Awaited<ReturnType<typeof fs.statfs>>)
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let cancelled = false
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { headers: { "content-type": "application/octet-stream", "content-length": "4" } },
    )) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    await expect(
      webfetch.execute(
        {
          url: "https://example.com/data",
          format: "text",
          output_path: "data.bin",
          max_bytes: 8,
        },
        context(async () => {}),
      ),
    ).rejects.toThrow("Insufficient workspace disk for download")
    expect(cancelled).toBe(true)
    expect(await fs.readdir(root)).toEqual([])
  } finally {
    statfs.mockRestore()
    workspace.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})
