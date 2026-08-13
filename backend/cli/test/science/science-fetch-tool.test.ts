import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ScienceFetchTool, ScienceListDbsTool } from "../../src/tool/science"
import { Instance } from "../../src/project/instance"
import { SessionFilesystem } from "../../src/session/filesystem"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"
import { executionSession } from "../fixture/fixture"

const ctx = (sessionID: string) => ({
  sessionID,
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
})

const realFetch = globalThis.fetch
let dir = ""
let workspace = ""

function stub(body: string, status = 200, headers?: Record<string, string>) {
  globalThis.fetch = (async () => new Response(body, { status, headers })) as unknown as typeof fetch
}

beforeEach(async () => {
  clearCache()
  resetRateLimits()
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sciencefetch-"))
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await fs.rm(dir, { recursive: true, force: true })
})

async function run(args: { db: string; id: string; format?: string }) {
  return Instance.provide({
    directory: dir,
    fn: async () => {
      const session = await executionSession()
      workspace = await SessionFilesystem.workspace(session.id)
      const tool = await ScienceFetchTool.init()
      return tool.execute(args, ctx(session.id))
    },
  })
}

describe("science_fetch record path", () => {
  test("a small record renders inline and writes nothing", async () => {
    stub(JSON.stringify({ pref_name: "ASPIRIN", molecule_type: "Small molecule" }))
    const out = await run({ db: "chembl", id: "CHEMBL25" })
    expect(out.output).toContain("ASPIRIN")
    expect(out.metadata.disposition).toBe("inline")
    await expect(fs.stat(path.join(workspace, ".openscience/fetch"))).rejects.toThrow()
  })

  test("a record over the cap spills to disk and reports the path", async () => {
    stub(JSON.stringify({ blob: "x".repeat(80_000) }))
    const out = await run({ db: "chembl", id: "CHEMBL25" })
    expect(out.metadata.disposition).toBe("spill")
    expect(out.metadata.path).toBe("science-chembl-CHEMBL25.json")
    const written = await fs.readFile(path.join(workspace, "science-chembl-CHEMBL25.json"), "utf8")
    expect(written.length).toBeGreaterThan(80_000)
    expect(out.output).toContain("science-chembl-CHEMBL25.json")
    await expect(fs.stat(path.join(dir, ".openscience/fetch"))).rejects.toThrow()
  })

  test("output is never double-truncated", async () => {
    stub(JSON.stringify({ blob: "x".repeat(80_000) }))
    const out = await run({ db: "chembl", id: "CHEMBL25" })
    // Tool.define skips Truncate.output only when metadata.truncated is set.
    expect(out.metadata.truncated).toBeDefined()
  })
})

describe("science_fetch degradation", () => {
  test("an unknown db lists what is available and does not throw", async () => {
    const out = await run({ db: "nope", id: "x" })
    expect(out.metadata.error).toBe("unknown_db")
    expect(out.output).toContain("uniprot")
  })

  test("a found:false sentinel is a clean miss, not an error", async () => {
    stub(JSON.stringify({ found: false }))
    const out = await run({ db: "depmap", id: "nothing-matches-this" })
    expect(out.metadata.count).toBe(0)
    expect(out.metadata.error).toBeUndefined()
  })

  test("a 429 is reported as rate_limited and never thrown", async () => {
    // Retry-After: 0 collapses http.ts's exponential backoff so this test
    // doesn't spend several real seconds sleeping through retries — matches
    // the stub in test/science/science-tool.test.ts:90.
    stub("rate limited", 429, { "Retry-After": "0" })
    const out = await run({ db: "chembl", id: "CHEMBL25" })
    expect(out.metadata.error).toBe("rate_limited")
    expect(out.output).toMatch(/retry/i)
  })

  test("requesting a format from a records-only connector is actionable", async () => {
    const out = await run({ db: "chembl", id: "CHEMBL25", format: "sdf" })
    expect(out.metadata.error).toBe("unsupported_format")
    expect(out.output).toMatch(/records only/i)
  })
})

describe("science_fetch format path", () => {
  test("a supplied format always spills and reports its own path", async () => {
    stub("data_6LU7\nloop_\n")
    const out = await run({ db: "rcsb-pdb", id: "6LU7", format: "cif" })
    expect(out.metadata.disposition).toBe("spill")
    expect(out.metadata.path).toBe("science-rcsb-pdb-6LU7.cif")
    const written = await fs.readFile(path.join(workspace, "science-rcsb-pdb-6LU7.cif"), "utf8")
    expect(written).toBe("data_6LU7\nloop_\n")
  })
})

describe("science_list_dbs reports formats", () => {
  test("a records-only connector shows no formats suffix", async () => {
    const out = await Instance.provide({
      directory: dir,
      fn: async () => (await ScienceListDbsTool.init()).execute({ domain: "chemistry" }, ctx("test")),
    })
    const row = out.output.split("\n").find((l) => l.includes("chembl"))
    expect(row).toBeDefined()
    expect(row).not.toContain("· formats:")
  })

  test("the catalog projection preserves the formats key", async () => {
    const { registry } = await import("../../src/science/connectors")
    const entry = registry.catalog().find((e) => e.id === "rcsb-pdb")
    expect(entry).toBeDefined()
    expect("formats" in entry!).toBe(true)
  })
})
