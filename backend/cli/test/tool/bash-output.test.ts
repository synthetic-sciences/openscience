import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BashOutput } from "../../src/tool/bash-output"
import { OpenScience } from "../../src/openscience"

async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-bash-output-"))
  const file = path.join(dir, "tool_output")
  return {
    file,
    opened: 0,
    open() {
      this.opened++
      return Bun.file(file).writer()
    },
    async text() {
      return Bun.file(file).text()
    },
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

const identity = (text: string) => text
const pem = (edge: string) => `-----${edge} PRIVATE KEY-----`

describe("BashOutput.Capture", () => {
  test("keeps small output in memory without touching the disk", async () => {
    await using sink = await scratch()
    const capture = new BashOutput.Capture({ redact: identity, maxBytes: 1024, maxLines: 50, open: () => sink.open() })
    capture.write("hello\n")
    capture.write(Buffer.from("world\n"))
    const summary = await capture.end()
    expect(summary).toMatchObject({ preview: "hello\nworld\n", truncated: false, bytes: 12, lines: 2 })
    expect(sink.opened).toBe(0)
  })

  test("streams the full redacted output to the owned file once the preview overflows", async () => {
    await using sink = await scratch()
    const redact = (text: string) => text.replaceAll("sk-secret1234", "[REDACTED]")
    const capture = new BashOutput.Capture({ redact, maxBytes: 10 * 1024, maxLines: 100, open: () => sink.open() })
    const lines = 5_000
    for (let i = 1; i <= lines; i++) capture.write(`line ${i} token=sk-secret1234\n`)
    const summary = await capture.end()

    expect(summary.truncated).toBe(true)
    expect(summary.lines).toBe(lines)
    expect(summary.removed).toEqual({ count: lines - 99, unit: "lines" })
    expect(summary.preview.split("\n")).toHaveLength(100)
    expect(summary.preview).not.toContain("sk-secret1234")
    expect(sink.opened).toBe(1)
    const saved = await sink.text()
    expect(saved.split("\n")).toHaveLength(lines + 1)
    expect(saved.startsWith("line 1 token=[REDACTED]\n")).toBe(true)
    expect(saved.endsWith(`line ${lines} token=[REDACTED]\n`)).toBe(true)
    expect(saved).not.toContain("sk-secret1234")
  })

  test("reports bytes when a byte limit is hit before the line limit", async () => {
    await using sink = await scratch()
    const capture = new BashOutput.Capture({ redact: identity, maxBytes: 100, maxLines: 1000, open: () => sink.open() })
    capture.write("a".repeat(60) + "\n")
    capture.write("b".repeat(60) + "\n")
    capture.write("c".repeat(60) + "\n")
    const summary = await capture.end()
    expect(summary.preview).toBe("a".repeat(60) + "\n")
    expect(summary.removed).toEqual({ count: 122, unit: "bytes" })
    expect(await sink.text()).toHaveLength(183)
  })

  test("redacts a registered secret that arrives split across chunks", async () => {
    await using sink = await scratch()
    const [head, tail] = ["sk-liveABCD", "EFGHIJKLMNOP"]
    const secret = head + tail
    const capture = new BashOutput.Capture({
      redact: OpenScience.redactSecrets,
      maxBytes: 4096,
      maxLines: 100,
      open: () => sink.open(),
    })
    capture.write(`export OPENAI_API_KEY=${head}`)
    capture.write(`${tail}\nnext line\n`)
    const summary = await capture.end()
    expect(summary.preview).not.toContain(secret)
    expect(summary.preview).toContain("[REDACTED]")
    expect(summary.preview).toContain("next line")
  })

  test("holds an open PEM block until its end marker so the body never escapes redaction", async () => {
    await using sink = await scratch()
    const capture = new BashOutput.Capture({
      redact: OpenScience.redactSecrets,
      maxBytes: 8192,
      maxLines: 200,
      open: () => sink.open(),
    })
    // Fixture body is deliberately not key-shaped; the pattern keys on the markers.
    const marker = (edge: string) => `-----${edge} PRIVATE KEY-----`
    capture.write(`before\n${marker("BEGIN")}\nABCDEF\n`)
    capture.write("GHIJKL\n")
    capture.write(`${marker("END")}\nafter\n`)
    const summary = await capture.end()
    expect(summary.preview).toBe("before\n[REDACTED]\nafter\n")
  })

  test("does not let a command without newlines grow the pending buffer without bound", async () => {
    await using sink = await scratch()
    const capture = new BashOutput.Capture({
      redact: identity,
      maxBytes: 1024,
      maxLines: 10,
      open: () => sink.open(),
    })
    const chunk = "x".repeat(16 * 1024)
    for (let i = 0; i < 16; i++) capture.write(chunk)
    const summary = await capture.end()
    expect(summary.preview).toContain("[REDACTED: oversized output line]")
    expect(summary.bytes).toBeLessThan(1024)
    expect(sink.opened).toBe(0)
  })

  test("an oversized incomplete line cannot leak a split quoted secret", async () => {
    await using sink = await scratch()
    const capture = new BashOutput.Capture({
      redact: OpenScience.redactSecrets,
      maxBytes: 1024,
      maxLines: 10,
      open: () => sink.open(),
    })
    capture.write("x".repeat(BashOutput.HOLD_LIMIT) + ' password="sensitive first ')
    capture.write('second half"\nnext line\n')
    const summary = await capture.end()
    expect(summary.preview).toBe("[REDACTED: oversized output line]\nnext line\n")
  })

  test("oversized PEM bodies remain redacted across a split END marker", async () => {
    await using sink = await scratch()
    const capture = new BashOutput.Capture({
      redact: OpenScience.redactSecrets,
      maxBytes: 1024,
      maxLines: 10,
      open: () => sink.open(),
    })
    capture.write(`before\n${pem("BEGIN")}\n`)
    for (let i = 0; i < 100; i++) capture.write("sensitive".repeat(100) + "\n")
    capture.write("-----EN")
    capture.write("D PRIVATE KEY-----\nafter\n")
    const summary = await capture.end()
    expect(summary.preview).toBe("before\n[REDACTED]\nafter\n")
  })

  test("a provenance head never exposes a private key cut at the preview limit", async () => {
    const capture = new BashOutput.Capture({
      redact: OpenScience.redactSecrets,
      maxBytes: 2000,
      maxLines: 2000,
      previewOnly: true,
      open: () => {
        throw new Error("must not open")
      },
    })
    capture.write(`before\n${pem("BEGIN")}\n` + "body".repeat(1000) + "\n")
    capture.write(`${pem("END")}\nafter\n`)
    await capture.end()
    expect(capture.current()).toBe("before\n[REDACTED]\nafter\n")
  })

  test("bounded memory and linear time for a large noisy stream", async () => {
    await using sink = await scratch()
    let redactions = 0
    let redactedBytes = 0
    const redact = (text: string) => {
      redactions++
      redactedBytes += text.length
      return text
    }
    const capture = new BashOutput.Capture({
      redact,
      maxBytes: 50 * 1024,
      maxLines: 2000,
      open: () => sink.open(),
    })
    const chunk = "0123456789abcdef".repeat(256) + "\n" // 4 KiB lines
    const chunks = 8 * 1024 // 32 MiB total
    const heap = process.memoryUsage().heapUsed
    for (let i = 0; i < chunks; i++) capture.write(chunk)
    const grown = process.memoryUsage().heapUsed - heap
    const summary = await capture.end()

    expect(summary.bytes).toBe(chunk.length * chunks)
    // Each byte is redacted exactly once: no rescans of the accumulated history.
    expect(redactedBytes).toBe(chunk.length * chunks)
    expect(redactions).toBe(chunks)
    // The capture retains the preview and a bounded pending run, not the stream.
    expect(capture.current().length).toBeLessThanOrEqual(50 * 1024)
    expect(grown).toBeLessThan(8 * 1024 * 1024)
    expect((await fs.stat(sink.file)).size).toBe(chunk.length * chunks)
  })
})
