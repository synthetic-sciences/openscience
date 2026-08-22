import { afterEach, expect, spyOn, test } from "bun:test"
import { Network } from "../../src/settings/network"
import {
  DOWNLOAD_DISK_RESERVE_BYTES,
  MAX_RESPONSE_SIZE,
  WebFetchTool,
  normalizeDownloadOutputPath,
} from "../../src/tool/webfetch"
import type { Tool } from "../../src/tool/tool"
import { SessionFilesystem } from "../../src/session/filesystem"
import crypto from "node:crypto"
import type { StatsFs } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

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

afterEach(async () => {
  globalThis.fetch = realFetch
  await Network.set({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
})

test("webfetch schema teaches the root-download then sandboxed-move sequence", async () => {
  const webfetch = await WebFetchTool.init()
  const schema = z.toJSONSchema(webfetch.parameters) as {
    properties?: Record<string, { description?: string }>
  }
  const description = schema.properties?.output_path?.description
  expect(description).toContain("Absolute and folder paths are reduced")
  expect(description).toContain('output_path:"foo.pdf"')
  expect(description).toContain("only after success")
  expect(description).toContain(
    "mkdir -p -- 'papers' && test ! -e 'papers/foo.pdf' && mv -- 'foo.pdf' 'papers/foo.pdf'",
  )
  expect(schema.properties?.max_bytes).toBeUndefined()
  expect(schema.properties?.declared_size_bytes).toBeUndefined()
  expect(schema.properties?.declared_size_evidence_call_id).toBeUndefined()
})

test("webfetch reduces absolute, temp-directory, and nested destinations to safe root filenames", () => {
  expect(
    normalizeDownloadOutputPath({
      url: "https://example.com/archive.pdf",
      format: "text",
      output_path: "/tmp/papers/archive.pdf",
    }),
  ).toMatchObject({ output_path: "archive.pdf" })
  expect(
    normalizeDownloadOutputPath({
      url: "https://example.com/query?id=42",
      format: "text",
      output_path: "/tmp",
    }),
  ).toMatchObject({ output_path: expect.stringMatching(/^download-[a-f0-9]{12}\.txt$/) })
  expect(
    normalizeDownloadOutputPath({
      url: "https://example.com/archive.pdf",
      format: "text",
      output_path: "papers/archive.pdf",
    }),
  ).toMatchObject({ output_path: "archive.pdf" })
})

test("webfetch rejects empty or whitespace-padded download paths before permission or network access", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let fetches = 0
  let asks = 0
  globalThis.fetch = (async () => {
    fetches++
    return new Response("must not fetch")
  }) as unknown as typeof fetch

  const webfetch = await WebFetchTool.init()
  for (const output_path of ["", " ", " data.csv", "data.csv "]) {
    await expect(
      webfetch.execute(
        { url: "https://example.com/data", format: "text", output_path },
        context(async () => {
          asks++
        }),
      ),
    ).rejects.toThrow("invalid arguments")
  }
  expect(asks).toBe(0)
  expect(fetches).toBe(0)
})

test("webfetch rejects an output_path typo before permission or network access", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let fetches = 0
  let asks = 0
  globalThis.fetch = (async () => {
    fetches++
    return new Response("must not fetch")
  }) as unknown as typeof fetch

  const webfetch = await WebFetchTool.init()
  await expect(
    webfetch.execute(
      { url: "https://example.com/data", format: "text", outputPath: "data.csv" } as never,
      context(async () => {
        asks++
      }),
    ),
  ).rejects.toThrow("invalid arguments")
  expect(asks).toBe(0)
  expect(fetches).toBe(0)
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
      "Do not repeat the same text-mode request. For a data file, call Web fetch again with a root-only filename such as " +
      'output_path:"foo.pdf"',
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

test("webfetch accepts a contained root filename beginning with two dots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-dot-name-"))
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  const payload = new Uint8Array([1, 2, 3, 4])
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  globalThis.fetch = (async () =>
    new Response(payload, {
      headers: { "content-type": "application/octet-stream", "content-length": String(payload.byteLength) },
    })) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    await expect(
      webfetch.execute(
        { url: "https://example.com/data", format: "text", output_path: "..hidden.bin" },
        context(async () => {}),
      ),
    ).resolves.toMatchObject({ metadata: { download: { path: "..hidden.bin", bytes: payload.byteLength } } })
    expect(await fs.readFile(path.join(root, "..hidden.bin"))).toEqual(Buffer.from(payload))
  } finally {
    workspace.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("webfetch revocation wins before a streamed download is installed", async () => {
  await using project = await tmpdir({ git: true })
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      const session = await Session.create({ title: "revoked download" })
      const workspace = await SessionFilesystem.workspace(session.id)
      const grant = (await SessionFilesystem.list(session.id)).find((item) => item.source === "workspace")
      if (!grant) throw new Error("missing session workspace grant")
      await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
      const payload = new Uint8Array([1, 2, 3, 4])
      const body = { value: undefined as ReadableStreamDefaultController<Uint8Array> | undefined }
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body.value = controller
            },
          }),
          {
            headers: { "content-type": "application/octet-stream", "content-length": String(payload.byteLength) },
          },
        )) as unknown as typeof fetch

      const webfetch = await WebFetchTool.init()
      const pending = webfetch.execute(
        { url: "https://example.com/revoked", format: "text", output_path: "revoked.bin" },
        { ...context(async () => {}), sessionID: session.id },
      )
      try {
        await waitForStagedDownload(path.dirname(workspace))
        await SessionFilesystem.revoke(session.id, grant.id)
        body.value?.enqueue(payload)
        body.value?.close()
        await expect(pending).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect(await Bun.file(path.join(workspace, "revoked.bin")).exists()).toBeFalse()
      } finally {
        body.value?.error(new Error("test cleanup"))
        await pending.catch(() => undefined)
        await Session.remove(session.id)
      }
    },
  })
})

test("webfetch validates the normalized root target before permission or network access", async () => {
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
      webfetch.execute({ url: "https://example.com/data", format: "text", output_path: "/tmp/existing.bin" }, ctx),
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

test("webfetch uses live disk capacity and blocks a same-turn unchanged retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-declared-limit-"))
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  let safeCapacity = 8
  const statfs = spyOn(fs, "statfs").mockImplementation(
    (async () =>
      ({ bavail: DOWNLOAD_DISK_RESERVE_BYTES + safeCapacity, bsize: 1 }) as StatsFs) as unknown as typeof fs.statfs,
  )
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
    }
    const first = await captureError(
      webfetch.execute(
        input,
        context(async () => {}),
      ),
    )
    expect(first.message).toContain(
      "Download exceeds the current safe workspace capacity of 8 bytes (8 bytes); response size 9 bytes (9 bytes)",
    )
    expect(first.message).toContain("computed from live free disk minus the 512.0 MiB (536870912 bytes) host reserve")
    expect(cancelled).toBe(true)
    expect(await fs.readdir(root)).toEqual([])

    const history = failedToolHistory(input, first.message, "call_declared_oversize")
    const repeated = await captureError(
      webfetch.execute(
        input,
        context(async () => {}, history),
      ),
    )
    expect(repeated.message).toContain("already exceeded the live safe workspace capacity of 8 bytes")
    expect(repeated.message).toContain("stopped before permission or network access")
    expect(fetches).toBe(1)

    safeCapacity = 16
    const userTurn = {
      info: {
        id: "message_user_after_capacity",
        sessionID: "session_test",
        role: "user",
        time: { created: Date.now() + 1_000 },
        agent: "research",
        model: { providerID: "test", modelID: "test" },
      },
      parts: [
        {
          id: "part_user_after_capacity",
          sessionID: "session_test",
          messageID: "message_user_after_capacity",
          type: "text",
          text: "I freed disk; retry the same download.",
        },
      ],
    } as unknown as Tool.Context["messages"][number]
    const result = await webfetch.execute(
      // Retired fields from an older caller are accepted as unknown input but
      // stripped by schema normalization and cannot affect the disk policy.
      { ...input, max_bytes: 9, declared_size_bytes: 9 } as never,
      context(async () => {}, [...history, userTurn]),
    )
    expect(result.metadata).toMatchObject({ download: { bytes: 9 } })
    expect(await fs.readFile(path.join(root, "declared.bin"))).toEqual(Buffer.from(payload))
    expect(fetches).toBe(2)
  } finally {
    statfs.mockRestore()
    workspace.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("webfetch bounds unknown or understated streamed bytes by live safe disk capacity", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-chunk-limit-"))
  const root = path.join(base, "workspace")
  await fs.mkdir(root)
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  let safeCapacity = 6
  const statfs = spyOn(fs, "statfs").mockImplementation(
    (async () =>
      ({ bavail: DOWNLOAD_DISK_RESERVE_BYTES + safeCapacity, bsize: 1 }) as StatsFs) as unknown as typeof fs.statfs,
  )
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
      { headers: { "content-type": "application/octet-stream", "content-length": "4" } },
    )
  }) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    const input = {
      url: "https://example.com/chunked-large",
      format: "text" as const,
      output_path: "chunked.bin",
    }
    const first = await captureError(
      webfetch.execute(
        input,
        context(async () => {}),
      ),
    )
    expect(first.message).toContain("Download exceeds the current safe workspace capacity of 6 bytes (6 bytes)")
    expect(cancelled).toBe(true)
    expect(await fs.readdir(root)).toEqual([])
    expect(await fs.readdir(base)).toEqual(["workspace"])
    await expect(
      webfetch.execute(
        { ...input, max_bytes: 8, declared_size_bytes: 8 } as never,
        context(async () => {}, failedToolHistory(input, first.message, "call_chunked_oversize")),
      ),
    ).rejects.toThrow("already exceeded the live safe workspace capacity of 6 bytes")
    expect(fetches).toBe(1)

    safeCapacity = 8
    const history = failedToolHistory(input, first.message, "call_chunked_oversize")
    const userTurn = {
      info: {
        id: "message_user_after_chunked",
        sessionID: "session_test",
        role: "user",
        time: { created: Date.now() + 1_000 },
        agent: "research",
        model: { providerID: "test", modelID: "test" },
      },
      parts: [
        {
          id: "part_user_after_chunked",
          sessionID: "session_test",
          messageID: "message_user_after_chunked",
          type: "text",
          text: "Disk is available now; retry.",
        },
      ],
    } as unknown as Tool.Context["messages"][number]
    const recovered = await webfetch.execute(
      input,
      context(async () => {}, [...history, userTurn]),
    )
    expect(recovered.metadata).toMatchObject({ download: { bytes: 8 } })
    expect(fetches).toBe(2)
  } finally {
    statfs.mockRestore()
    workspace.mockRestore()
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("webfetch rechecks the host disk reserve before every streamed write", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-live-disk-race-"))
  const root = path.join(base, "workspace")
  await fs.mkdir(root)
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  let statfsCalls = 0
  const statfs = spyOn(fs, "statfs").mockImplementation((async () => {
    statfsCalls++
    // Initial preflight, response preflight, and the first write each see an
    // 8-byte budget. Before the second write, concurrent disk use leaves one
    // byte above the reserve; four bytes already staged makes the new total
    // transfer ceiling exactly five bytes.
    const safeBytes = statfsCalls < 4 ? 8 : 1
    return { bavail: DOWNLOAD_DISK_RESERVE_BYTES + safeBytes, bsize: 1 } as StatsFs
  }) as unknown as typeof fs.statfs)
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let chunks = 0
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks++ < 2) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]))
            return
          }
          controller.close()
        },
      }),
      { headers: { "content-type": "application/octet-stream" } },
    )) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    await expect(
      webfetch.execute(
        {
          url: "https://example.com/live-disk-race",
          format: "text",
          output_path: "race.bin",
        },
        context(async () => {}),
      ),
    ).rejects.toThrow(
      "Download exceeds the current safe workspace capacity of 5 bytes (5 bytes); response size 8 bytes (8 bytes)",
    )
    expect(statfsCalls).toBe(4)
    expect(await fs.readdir(root)).toEqual([])
    expect(await fs.readdir(base)).toEqual(["workspace"])
  } finally {
    statfs.mockRestore()
    workspace.mockRestore()
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("webfetch classifies storage exhaustion and stops its same-turn retry before network", async () => {
  for (const storageCode of ["ENOSPC", "EDQUOT"] as const) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), `webfetch-${storageCode.toLowerCase()}-`))
    const root = path.join(base, "workspace")
    await fs.mkdir(root)
    const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
    const statfs = spyOn(fs, "statfs").mockResolvedValue({
      bavail: DOWNLOAD_DISK_RESERVE_BYTES + 16,
      bsize: 1,
    } as StatsFs)
    await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
    const realOpen = fs.open
    const open = spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      const staged = args[0] as Parameters<typeof fs.open>[0]
      if (!String(staged).includes(".openscience-download-")) {
        return (realOpen as unknown as (...input: unknown[]) => Promise<fs.FileHandle>)(...args)
      }
      if (storageCode === "ENOSPC") {
        throw Object.assign(new Error(`mock ${storageCode}`), { code: storageCode })
      }
      await fs.writeFile(staged, new Uint8Array())
      return {
        write: async () => {
          throw Object.assign(new Error(`mock ${storageCode}`), { code: storageCode })
        },
        sync: async () => {},
        close: async () => {},
      } as unknown as fs.FileHandle
    }) as unknown as typeof fs.open)
    let fetches = 0
    let asks = 0
    let cancelled = false
    globalThis.fetch = (async () => {
      fetches++
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "application/octet-stream", "content-length": "4" } },
      )
    }) as unknown as typeof fetch

    try {
      const webfetch = await WebFetchTool.init()
      const input = {
        url: `https://example.com/${storageCode.toLowerCase()}`,
        format: "text" as const,
        output_path: `${storageCode.toLowerCase()}.bin`,
      }
      const first = await captureError(
        webfetch.execute(
          input,
          context(async () => {
            asks++
          }),
        ),
      )
      expect(first.message).toContain(`workspace storage returned ${storageCode}`)
      expect(first.message).toContain("current disk-derived workspace capacity is 16 bytes (16 bytes)")
      expect(cancelled).toBe(true)
      expect(await fs.readdir(root)).toEqual([])
      expect(await fs.readdir(base)).toEqual(["workspace"])

      await expect(
        webfetch.execute(
          input,
          context(
            async () => {
              asks++
            },
            failedToolHistory(input, first.message, `call_${storageCode.toLowerCase()}`),
          ),
        ),
      ).rejects.toThrow("already exceeded the live safe workspace capacity of 16 bytes")
      expect(fetches).toBe(1)
      expect(asks).toBe(1)
    } finally {
      open.mockRestore()
      statfs.mockRestore()
      workspace.mockRestore()
      await fs.rm(base, { recursive: true, force: true })
    }
  }
})

test("webfetch automatically accepts declared bytes within live capacity and ignores retired caps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-live-capacity-"))
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  const statfs = spyOn(fs, "statfs").mockResolvedValue({
    bavail: DOWNLOAD_DISK_RESERVE_BYTES + 16,
    bsize: 1,
  } as StatsFs)
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
  globalThis.fetch = (async () =>
    new Response(payload, {
      headers: { "content-type": "application/octet-stream", "content-length": String(payload.byteLength) },
    })) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    const result = await webfetch.execute(
      {
        url: "https://example.com/data",
        format: "text",
        output_path: "data.bin",
        max_bytes: 1,
        declared_size_bytes: 1,
        declared_size_evidence_call_id: "retired",
      } as never,
      context(async () => {}),
    )
    expect(result.metadata).toMatchObject({ download: { bytes: payload.byteLength } })
    expect(await fs.readFile(path.join(root, "data.bin"))).toEqual(Buffer.from(payload))
  } finally {
    statfs.mockRestore()
    workspace.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("webfetch download preserves a disk reserve before consuming the body", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webfetch-disk-reserve-"))
  const workspace = spyOn(SessionFilesystem, "workspace").mockResolvedValue(root)
  const statfs = spyOn(fs, "statfs").mockResolvedValue({ bavail: 1, bsize: 1 } as StatsFs)
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    return new Response("must not fetch")
  }) as unknown as typeof fetch

  try {
    const webfetch = await WebFetchTool.init()
    await expect(
      webfetch.execute(
        {
          url: "https://example.com/data",
          format: "text",
          output_path: "data.bin",
        },
        context(async () => {}),
      ),
    ).rejects.toThrow("current safe workspace capacity of 0 bytes (0 bytes)")
    expect(fetches).toBe(0)
    expect(await fs.readdir(root)).toEqual([])
  } finally {
    statfs.mockRestore()
    workspace.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})
