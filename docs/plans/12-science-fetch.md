# science_fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `Connector.fetch()` — implemented by all 42 connectors, called by nothing — as a `science_fetch` agent tool, so the agent can retrieve a record after finding it.

**Architecture:** A pure classification module decides what a fetch produced (record / file / miss / error) and whether it goes inline or spills to disk. A third tool in `src/tool/science.ts` routes through the connector registry and never learns individual database names. Seven connectors gain an optional `fetchFile()` for serving real files (pdb, cif, fasta, sdf).

**Tech Stack:** Bun, TypeScript, zod, `bun:test`. No new dependencies.

**Spec:** `docs/specs/science-fetch-design.md` (commit `85f0486`, branch `feat/science-fetch`).

## Global Constraints

- Style (from `AGENTS.md` / `CLAUDE.md`): prefer `const` over `let`, avoid `else`, single-word variable names, rely on type inference, no explicit annotations where inferable, **no `any`**, use Bun APIs (`Bun.write`, `Bun.file`).
- **No mocks.** Tests stub `globalThis.fetch` at the network boundary and exercise real connector code — the house pattern in `test/science/arxiv.test.ts`.
- No network access in `bun test`. Test command is `bun test --timeout 15000` from `backend/cli`.
- `"json"` is **never** a member of `Connector.formats`. Omitting `format` calls `fetch()` and yields a record; passing one calls `fetchFile()` and yields a file.
- Spill cap is **`Truncate.MAX_BYTES`** (`50 * 1024`), imported from `src/tool/truncation.ts`.
- Spill target is **`.openscience/fetch/<db>/<id>.<ext>`**, resolved against `Instance.directory`.
- Commit after every task. Never add a `Co-Authored-By` trailer or any AI attribution.

## Corrections to the spec

Three things the spec got wrong, discovered while reading the code. Implement what this plan says.

1. **Do not lift `MAX_BYTES` out of `read.ts`.** The spec says to. An exported twin already exists —
   `src/tool/truncation.ts:11` exports `MAX_BYTES = 50 * 1024` as `Truncate.MAX_BYTES`, already consumed
   cross-module by `src/tool/bash.ts:63`. Import that. `read.ts:16` keeps its private copy; changing it is
   out of scope and would touch an unrelated tool.
2. **`Tool.define` auto-truncates output.** `src/tool/tool.ts:71-73` runs `Truncate.output(...)` on every
   result **unless** `result.metadata.truncated !== undefined`. Because `science_fetch` does its own spilling,
   it MUST set `metadata.truncated` or the output gets spilled twice, to two different places.
3. **Rate limiting needs four files, not two.** The eutils host `eutils.ncbi.nlm.nih.gov` has _five_
   consumers, not four: `genomics/eutils.ts` (shared by `ncbi-gene`, `dbsnp`, `clinvar`), `literature/pubmed.ts`
   (its own `BASE` at line 13), and `omics/geo.ts` (its own `EUTILS` at line 15). Leaving `geo` unpaced
   undermines the pacing of the others against the same host.

## File Structure

**Create**

- `src/science/connectors/fetch-outcome.ts` — pure classification: sentinel detection, error classification, path sanitising, summarising, inline-vs-spill. No I/O. Lifted from the validated prototype.
- `test/science/fetch-outcome.test.ts` — unit tests for the above.
- `test/science/science-fetch-tool.test.ts` — end-to-end tool tests.
- `test/science/connector-fetch.test.ts` — registry-wide offline conformance.
- `script/record-fetch-fixtures.ts` — one-time live fixture recorder. Not run in CI.

**Modify**

- `src/science/connectors/types.ts` — add `formats?`, `fetchFile?`, `FetchedFile`.
- `src/tool/science.ts` — add `ScienceFetchTool`; `science_list_dbs` reports formats; extend `ScienceTools`.
- `src/science/connectors/proteins/{rcsb-pdb,pdbe,alphafold,uniprot}.ts` — add `formats` + `fetchFile`.
- `src/science/connectors/chemistry/pubchem.ts`, `genomics/ensembl.ts`, `pathways/kegg.ts` — same.
- `src/science/connectors/literature/semantic-scholar.ts`, `genomics/eutils.ts`, `literature/pubmed.ts`, `omics/geo.ts` — add `rateLimit`.

**Delete at the end**

- `src/science/connectors/PROTOTYPE-fetch-outcome.ts`, `PROTOTYPE-fetch-repl.ts`, and the `prototype:fetch` script in `package.json`.

---

### Task 1: Pure classification module

Lifts the prototype logic — already validated against all 42 live APIs — into real source with tests.

**Files:**

- Create: `backend/cli/src/science/connectors/fetch-outcome.ts`
- Test: `backend/cli/test/science/fetch-outcome.test.ts`
- Reference (do not modify): `backend/cli/src/science/connectors/PROTOTYPE-fetch-outcome.ts`

**Interfaces:**

- Consumes: `Truncate.MAX_BYTES` from `src/tool/truncation.ts`.
- Produces: `sentinelOf(payload): {kind:"miss"|"error", note:string} | null`, `classifyError(err): {retryable:boolean, message:string}`, `safeSegment(raw:string): string`, `filenameFor(db,id,format?): string`, `summarize(payload, format?): string`, `serialize(payload): string`, `formatBytes(n): string`, `outcomeFor({db,id,format?,payload,capBytes?}): FetchOutcome`, and the `FetchOutcome` union.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/science/fetch-outcome.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import {
  sentinelOf,
  classifyError,
  safeSegment,
  filenameFor,
  summarize,
  outcomeFor,
} from "../../src/science/connectors/fetch-outcome"

// The four "not found" conventions the 42 connectors actually use, confirmed by
// executing every fetch() against live APIs. Three are misses; {error} is a real
// failure (biogrid returns it when BIOGRID_ACCESS_KEY is unset).
describe("sentinelOf", () => {
  test("null is a miss", () => {
    expect(sentinelOf(null)?.kind).toBe("miss")
  })

  test("an empty object is a miss", () => {
    expect(sentinelOf({})?.kind).toBe("miss")
  })

  test("found:false is a miss", () => {
    expect(sentinelOf({ id: "E-MTAB-1", found: false })?.kind).toBe("miss")
  })

  test("an error string is an error, not a miss", () => {
    const out = sentinelOf({ id: "7157", error: "BioGRID access key required" })
    expect(out?.kind).toBe("error")
    expect(out?.note).toBe("BioGRID access key required")
  })

  test("a real record is not a sentinel", () => {
    expect(sentinelOf({ struct: { title: "Crystal structure" } })).toBeNull()
  })

  test("an empty array is a miss but a populated one is not", () => {
    expect(sentinelOf([])?.kind).toBe("miss")
    expect(sentinelOf([{ pdbUrl: "x" }])).toBeNull()
  })
})

describe("classifyError", () => {
  test("429 is retryable", () => {
    expect(classifyError(new Error("HTTP 429 for https://api.semanticscholar.org")).retryable).toBe(true)
  })

  test("404 is not retryable", () => {
    expect(classifyError(new Error("HTTP 404 for https://myvariant.info")).retryable).toBe(false)
  })
})

// Real ids from the connector set: crossref uses a DOI (slash), kegg uses
// "hsa:7157" (colon), myvariant uses HGVS (colon + angle bracket). Colons and
// backslashes are illegal on Windows, which this project ships binaries for.
describe("safeSegment", () => {
  test("strips slashes from a DOI", () => {
    expect(safeSegment("10.1038/nature12373")).toBe("10.1038_nature12373")
  })

  test("strips colons from a kegg id", () => {
    expect(safeSegment("hsa:7157")).toBe("hsa_7157")
  })

  test("strips angle brackets from an HGVS id", () => {
    expect(safeSegment("chr7:g.140453134A>T")).toBe("chr7_g.140453134A_T")
  })

  test("never returns an empty segment", () => {
    expect(safeSegment("///")).toBe("record")
  })
})

describe("filenameFor", () => {
  test("defaults to json under the db directory", () => {
    expect(filenameFor("crossref", "10.1038/nature12373")).toBe(".openscience/fetch/crossref/10.1038_nature12373.json")
  })

  test("uses the requested format as the extension", () => {
    expect(filenameFor("rcsb-pdb", "6LU7", "cif")).toBe(".openscience/fetch/rcsb-pdb/6LU7.cif")
  })
})

describe("summarize", () => {
  test("lists top-level keys for a record", () => {
    expect(summarize({ struct: {}, rcsb_entry_info: {} })).toBe("struct, rcsb_entry_info")
  })

  test("heads the content for a file", () => {
    expect(summarize("data_6LU7\nloop_\n_atom_site", "cif")).toBe("data_6LU7 loop_ _atom_site")
  })
})

describe("outcomeFor", () => {
  test("a small record goes inline", () => {
    const out = outcomeFor({ db: "chembl", id: "CHEMBL25", payload: { pref_name: "ASPIRIN" } })
    expect(out.kind).toBe("record")
    if (out.kind === "record") expect(out.disposition).toBe("inline")
  })

  test("a record over the cap spills", () => {
    const out = outcomeFor({ db: "mygene", id: "7157", payload: { blob: "x".repeat(60_000) } })
    expect(out.kind).toBe("record")
    if (out.kind === "record") expect(out.disposition).toBe("spill")
  })

  test("a file always spills regardless of size", () => {
    const out = outcomeFor({ db: "rcsb-pdb", id: "6LU7", format: "cif", payload: "tiny" })
    expect(out.kind).toBe("file")
    if (out.kind === "file") expect(out.filename).toBe(".openscience/fetch/rcsb-pdb/6LU7.cif")
  })

  test("a sentinel short-circuits before serialisation", () => {
    expect(outcomeFor({ db: "depmap", id: "CRISPR", payload: { found: false } }).kind).toBe("miss")
  })

  test("an error sentinel becomes an error outcome", () => {
    const out = outcomeFor({ db: "biogrid", id: "7157", payload: { id: "7157", error: "key required" } })
    expect(out.kind).toBe("error")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/cli && bun test test/science/fetch-outcome.test.ts
```

Expected: FAIL — `Cannot find module '../../src/science/connectors/fetch-outcome'`.

- [ ] **Step 3: Create the module**

Copy `src/science/connectors/PROTOTYPE-fetch-outcome.ts` to `src/science/connectors/fetch-outcome.ts`, then make exactly these changes:

1. Replace the whole `PROTOTYPE —` header comment with a normal module doc block.
2. Replace the `SPILL_CAP_BYTES` declaration with an import of the existing exported constant:

```ts
import { Truncate } from "../../tool/truncation"
```

and change every `input.capBytes ?? SPILL_CAP_BYTES` to `input.capBytes ?? Truncate.MAX_BYTES`, deleting the
local `SPILL_CAP_BYTES` const.

3. Rename the `miss` arm's type so the union reads:

```ts
export type FetchOutcome =
  | { kind: "record"; disposition: Disposition; bytes: number; body: string; filename: string; summary: string }
  | { kind: "file"; disposition: "spill"; bytes: number; body: string; filename: string; summary: string }
  | { kind: "miss"; note: string }
  | { kind: "error"; retryable: boolean; message: string }
```

Everything else — `sentinelOf`, `classifyError`, `safeSegment`, `filenameFor`, `summarize`, `serialize`,
`outcomeFor`, `formatBytes`, `EXT_FOR` — transfers verbatim. It was validated against all 42 live APIs.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend/cli && bun test test/science/fetch-outcome.test.ts
```

Expected: PASS, 20 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd backend/cli && bun run typecheck
git add src/science/connectors/fetch-outcome.ts test/science/fetch-outcome.test.ts
git commit -m "feat(science): add fetch outcome classification

Classifies what a connector fetch produced: record, file, clean miss, or
error, and whether a record goes inline or spills. Lifted from a prototype
validated against all 42 connectors' live APIs.

Sentinel handling is the load-bearing part: nine connectors signal 'not
found' with null, {}, or found:false rather than throwing, and conflating
those with failures renders an ordinary miss as an outage."
```

---

### Task 2: Connector interface — `formats` and `fetchFile`

**Files:**

- Modify: `backend/cli/src/science/connectors/types.ts:88-92`
- Test: `backend/cli/test/science/connector-contract.test.ts` (create)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `FetchedFile` interface; optional `Connector.formats?: string[]` and `Connector.fetchFile?(id: string, format: string, opts?: FetchOptions): Promise<FetchedFile>`.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/science/connector-contract.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { registry } from "../../src/science/connectors"

// Guards the invariant that makes science_fetch's routing safe: a connector
// either advertises file formats AND can serve them, or does neither.
describe("connector contract", () => {
  test("every connector has the required members", () => {
    for (const c of registry.all()) {
      expect(typeof c.id).toBe("string")
      expect(typeof c.search).toBe("function")
      expect(typeof c.fetch).toBe("function")
    }
  })

  test("formats and fetchFile are declared together or not at all", () => {
    for (const c of registry.all()) {
      expect(Boolean(c.formats?.length)).toBe(typeof c.fetchFile === "function")
    }
  })

  test("formats never contains json", () => {
    for (const c of registry.all()) {
      expect(c.formats ?? []).not.toContain("json")
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/cli && bun test test/science/connector-contract.test.ts
```

Expected: FAIL — TypeScript errors on `c.formats` and `c.fetchFile`, which do not exist on `Connector`.

- [ ] **Step 3: Add the interface members**

In `src/science/connectors/types.ts`, immediately before `export interface Connector {`, add:

```ts
/** A record retrieved as a file rather than a structured record. */
export interface FetchedFile {
  /** File contents. Text formats only — no binary support in this increment. */
  body: string
  /** MIME type as served, e.g. "chemical/x-cif". */
  contentType: string
  /** Extension-bearing suggested name, e.g. "6LU7.cif". */
  filename: string
}
```

Then inside `export interface Connector`, after the existing `fetch` declaration (types.ts:91), add:

```ts
  /**
   * FILE formats this connector can serve, e.g. ["pdb", "cif"]. Absent = records only.
   * Never includes "json" — omitting `format` is the record path via `fetch()`.
   */
  formats?: string[]
  /** Retrieve a record as a file in one of `formats`. Present iff `formats` is. */
  fetchFile?(id: string, format: string, opts?: FetchOptions): Promise<FetchedFile>
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend/cli && bun test test/science/connector-contract.test.ts && bun run typecheck
```

Expected: PASS, 3 tests. All 42 connectors currently declare neither member, so the paired-declaration test passes trivially — it becomes load-bearing in Tasks 5-7.

- [ ] **Step 5: Commit**

```bash
git add src/science/connectors/types.ts test/science/connector-contract.test.ts
git commit -m "feat(science): declare optional file-format members on Connector

Records and files have different contracts: a record is structured and may
render inline, a file is opaque and always spills. Splitting them makes the
spill policy structural rather than a threshold applied to opaque data."
```

---

### Task 3: The `science_fetch` tool (record path)

The record path only. Formats arrive in Tasks 5-7; until then a `format` argument reports that the connector serves records only.

**Files:**

- Modify: `backend/cli/src/tool/science.ts` (append tool, extend `ScienceTools` at :143 and `SCIENCE_TOOL_IDS` at :145)
- Test: `backend/cli/test/science/science-fetch-tool.test.ts` (create)

**Interfaces:**

- Consumes: `outcomeFor`, `formatBytes` from Task 1; `Connector.formats`/`fetchFile` from Task 2.
- Produces: `ScienceFetchTool`, exported and included in `ScienceTools`. No change to `src/tool/registry.ts` is needed — it spreads `...ScienceTools` at `registry.ts:132`.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/science/science-fetch-tool.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ScienceFetchTool } from "../../src/tool/science"
import { Instance } from "../../src/project/instance"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const realFetch = globalThis.fetch
let dir = ""

function stub(body: string, status = 200) {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch
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
      const tool = await ScienceFetchTool.init()
      return tool.execute(args, ctx)
    },
  })
}

describe("science_fetch record path", () => {
  test("a small record renders inline and writes nothing", async () => {
    stub(JSON.stringify({ pref_name: "ASPIRIN", molecule_type: "Small molecule" }))
    const out = await run({ db: "chembl", id: "CHEMBL25" })
    expect(out.output).toContain("ASPIRIN")
    expect(out.metadata.disposition).toBe("inline")
    await expect(fs.stat(path.join(dir, ".openscience/fetch"))).rejects.toThrow()
  })

  test("a record over the cap spills to disk and reports the path", async () => {
    stub(JSON.stringify({ blob: "x".repeat(80_000) }))
    const out = await run({ db: "chembl", id: "CHEMBL25" })
    expect(out.metadata.disposition).toBe("spill")
    expect(out.metadata.path).toBe(".openscience/fetch/chembl/CHEMBL25.json")
    const written = await fs.readFile(path.join(dir, ".openscience/fetch/chembl/CHEMBL25.json"), "utf8")
    expect(written.length).toBeGreaterThan(80_000)
    expect(out.output).toContain(".openscience/fetch/chembl/CHEMBL25.json")
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
    stub("rate limited", 429)
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/cli && bun test test/science/science-fetch-tool.test.ts
```

Expected: FAIL — `ScienceFetchTool` is not exported from `src/tool/science.ts`.

- [ ] **Step 3: Implement the tool**

At the top of `src/tool/science.ts`, extend the imports:

```ts
import fs from "fs/promises"
import path from "path"
import { Instance } from "../project/instance"
import { outcomeFor, formatBytes } from "../science/connectors/fetch-outcome"
```

Then append this tool before the `ScienceTools` export:

```ts
export const ScienceFetchTool = Tool.define("science_fetch", {
  description: [
    "Retrieve one record from a scientific database by id.",
    "Pass a `db` id (from `science_list_dbs`) and the record `id` returned by `science_search`.",
    "Small records are returned inline; large ones are written to a file whose path is reported.",
    "Pass `format` to retrieve a file (e.g. 'cif', 'fasta', 'sdf') instead of a record —",
    "`science_list_dbs` reports which formats each database supports.",
  ].join("\n"),
  parameters: z.object({
    db: z.string().describe("Database id (from science_list_dbs, e.g. 'rcsb-pdb', 'uniprot')"),
    id: z.string().describe("Record id within that database (e.g. '6LU7', 'P04637')"),
    format: z
      .string()
      .optional()
      .describe("Optional file format, e.g. 'cif' | 'pdb' | 'fasta' | 'sdf'. Omit for a structured record."),
  }),
  async execute(params, ctx) {
    const connector = registry.get(params.db)
    if (!connector) {
      const available = registry
        .catalog()
        .map((e) => e.id)
        .join(", ")
      return {
        title: "Unknown database",
        output: `No database "${params.db}". Available: ${available || "(none registered)"}. Use science_list_dbs.`,
        metadata: { error: "unknown_db", truncated: false } as Record<string, unknown>,
      }
    }

    const format = params.format?.trim().toLowerCase()
    if (format && !connector.formats?.includes(format)) {
      const supported = connector.formats?.length
        ? `Supported formats: ${connector.formats.join(", ")}.`
        : `${connector.name} serves records only — omit \`format\`.`
      return {
        title: `${connector.name}: unsupported format`,
        output: [`${connector.name} cannot serve "${format}".`, supported].join("\n"),
        metadata: { db: connector.id, error: "unsupported_format", truncated: false } as Record<string, unknown>,
      }
    }

    let payload: unknown
    try {
      payload =
        format && connector.fetchFile
          ? (await connector.fetchFile(params.id, format, { signal: ctx.abort })).body
          : await connector.fetch(params.id, { signal: ctx.abort })
    } catch (err) {
      if (ctx.abort.aborted) throw err
      const message = err instanceof Error ? err.message : String(err)
      const rateLimited = /\b(429|503|408)\b/.test(message) || /rate.?limit/i.test(message)
      const guidance = rateLimited
        ? `${connector.name} is rate limiting requests. Wait a few seconds, then retry.`
        : `${connector.name} returned an error: ${message}`
      return {
        title: `${connector.name} temporarily unavailable — ${rateLimited ? "rate limited, retry shortly" : "source error"}`,
        output: [`Could not retrieve "${params.id}".`, guidance].join("\n"),
        metadata: {
          db: connector.id,
          count: 0,
          error: rateLimited ? "rate_limited" : "source_error",
          message,
          truncated: false,
        } as Record<string, unknown>,
      }
    }

    const outcome = outcomeFor({ db: connector.id, id: params.id, format, payload })

    if (outcome.kind === "miss")
      return {
        title: `${connector.name}: no record for ${params.id}`,
        output: `${connector.name} has no record "${params.id}" (${outcome.note}).`,
        metadata: { db: connector.id, count: 0, truncated: false } as Record<string, unknown>,
      }

    if (outcome.kind === "error")
      return {
        title: `${connector.name}: ${outcome.message}`,
        output: `${connector.name} could not serve "${params.id}": ${outcome.message}`,
        metadata: { db: connector.id, count: 0, error: "source_error", truncated: false } as Record<string, unknown>,
      }

    if (outcome.disposition === "inline")
      return {
        title: `${connector.name}: ${params.id}`,
        output: outcome.body,
        metadata: {
          db: connector.id,
          count: 1,
          bytes: outcome.bytes,
          disposition: "inline",
          truncated: false,
        } as Record<string, unknown>,
      }

    const target = path.join(Instance.directory, outcome.filename)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await Bun.write(target, outcome.body)

    return {
      title: `${connector.name}: ${params.id} → ${outcome.filename}`,
      output: [
        `${connector.name} record "${params.id}" is ${formatBytes(outcome.bytes)} — written to disk rather than inlined.`,
        ``,
        `**path**: ${outcome.filename}`,
        `**summary**: ${outcome.summary}`,
        ``,
        `Read that path for the full content.`,
      ].join("\n"),
      metadata: {
        db: connector.id,
        count: 1,
        bytes: outcome.bytes,
        disposition: "spill",
        path: outcome.filename,
        truncated: false,
      } as Record<string, unknown>,
    }
  },
})
```

Finally update the two exports at the bottom of the file:

```ts
export const ScienceTools = [ScienceListDbsTool, ScienceSearchTool, ScienceFetchTool]

export const SCIENCE_TOOL_IDS = new Set(["science_list_dbs", "science_search", "science_fetch"])
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend/cli && bun test test/science/ && bun run typecheck
```

Expected: PASS — 7 new tool tests plus the existing science suite.

- [ ] **Step 5: Commit**

```bash
git add src/tool/science.ts test/science/science-fetch-tool.test.ts
git commit -m "feat(science): add science_fetch tool

All 42 connectors implemented fetch() and nothing called it, so the agent
could find a record and not retrieve it. Routes through the registry, so
the tool never learns individual database names and the tool count stays
flat as connectors grow.

Sets metadata.truncated because Tool.define otherwise runs Truncate.output
over a result this tool has already spilled itself."
```

---

### Task 4: `science_list_dbs` reports formats

Without this the model has no way to learn which formats exist and would guess.

**Files:**

- Modify: `backend/cli/src/tool/science.ts` (the `ScienceListDbsTool` rows at :49 and the registry `catalog()` at `src/science/connectors/types.ts:135-143`)
- Test: `backend/cli/test/science/science-fetch-tool.test.ts` (append)

**Interfaces:**

- Consumes: `Connector.formats` from Task 2.
- Produces: `CatalogEntry.formats?: string[]`; `science_list_dbs` output gains a `formats: …` suffix per database.

- [ ] **Step 1: Write the failing test**

Append to `test/science/science-fetch-tool.test.ts`:

```ts
import { ScienceListDbsTool } from "../../src/tool/science"

describe("science_list_dbs reports formats", () => {
  test("a records-only connector shows no formats suffix", async () => {
    const out = await Instance.provide({
      directory: dir,
      fn: async () => (await ScienceListDbsTool.init()).execute({ domain: "chemistry" }, ctx),
    })
    expect(out.output).toContain("chembl")
    expect(out.output).not.toContain("chembl** (ChEMBL) — formats:")
  })

  test("the catalog carries formats when a connector declares them", async () => {
    const { registry } = await import("../../src/science/connectors")
    const entry = registry.catalog().find((e) => e.id === "rcsb-pdb")
    expect(entry).toBeDefined()
    expect("formats" in entry!).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/cli && bun test test/science/science-fetch-tool.test.ts
```

Expected: FAIL — `"formats" in entry` is false; `catalog()` drops the field.

- [ ] **Step 3: Carry formats through the catalog and render them**

In `src/science/connectors/types.ts`, add to `CatalogEntry`:

```ts
  formats?: string[]
```

and change `ConnectorRegistry.catalog()` to include it:

```ts
  catalog(): CatalogEntry[] {
    return this.all().map(({ id, name, domain, description, homepage, formats }) => ({
      id,
      name,
      domain,
      description,
      homepage,
      formats,
    }))
  }
```

In `src/tool/science.ts`, change the row builder inside `ScienceListDbsTool` from:

```ts
const rows = list.map((e) => `- **${e.id}** (${e.name}) — ${e.description}`)
```

to:

```ts
const rows = list.map((e) => {
  const formats = e.formats?.length ? ` · formats: ${e.formats.join(", ")}` : ""
  return `- **${e.id}** (${e.name}) — ${e.description}${formats}`
})
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend/cli && bun test test/science/ && bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/science/connectors/types.ts src/tool/science.ts test/science/science-fetch-tool.test.ts
git commit -m "feat(science): report connector file formats in science_list_dbs

Without this the model has no way to discover which formats exist and
would guess at them."
```

---

### Task 5: `fetchFile` for rcsb-pdb and pdbe

The two simplest cases — both are plain URL swaps. RCSB serves coordinates from a **different host** than its JSON entry API.

**Files:**

- Modify: `backend/cli/src/science/connectors/proteins/rcsb-pdb.ts`, `proteins/pdbe.ts`
- Test: `backend/cli/test/science/connector-formats.test.ts` (create)

**Interfaces:**

- Consumes: `FetchedFile` from Task 2, `getText` from `../http`.
- Produces: `rcsbPdb.formats = ["pdb", "cif"]`, `pdbe.formats = ["cif"]`, both with `fetchFile`.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/science/connector-formats.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rcsbPdb } from "../../src/science/connectors/proteins/rcsb-pdb"
import { pdbe } from "../../src/science/connectors/proteins/pdbe"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"

const realFetch = globalThis.fetch

function stub(body: string): { url: () => string } {
  let seen = ""
  globalThis.fetch = (async (url: string) => {
    seen = String(url)
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
  return { url: () => seen }
}

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("rcsb-pdb fetchFile", () => {
  test("declares pdb and cif but never json", () => {
    expect(rcsbPdb.formats).toEqual(["pdb", "cif"])
    expect(rcsbPdb.formats).not.toContain("json")
  })

  test("cif comes from files.rcsb.org, not the JSON data API", async () => {
    const s = stub("data_6LU7\nloop_\n")
    const out = await rcsbPdb.fetchFile!("6LU7", "cif")
    expect(s.url()).toBe("https://files.rcsb.org/download/6LU7.cif")
    expect(out.filename).toBe("6LU7.cif")
    expect(out.body).toContain("data_6LU7")
  })

  test("pdb uses the .pdb extension on the same host", async () => {
    const s = stub("HEADER    VIRAL PROTEIN")
    await rcsbPdb.fetchFile!("6LU7", "pdb")
    expect(s.url()).toBe("https://files.rcsb.org/download/6LU7.pdb")
  })
})

describe("pdbe fetchFile", () => {
  test("declares cif only", () => {
    expect(pdbe.formats).toEqual(["cif"])
  })

  test("lowercases the id and hits the entry-files endpoint", async () => {
    const s = stub("data_6lu7\n")
    const out = await pdbe.fetchFile!("6LU7", "cif")
    expect(s.url()).toBe("https://www.ebi.ac.uk/pdbe/entry-files/download/6lu7.cif")
    expect(out.filename).toBe("6lu7.cif")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/cli && bun test test/science/connector-formats.test.ts
```

Expected: FAIL — `rcsbPdb.formats` is undefined and `fetchFile` is not a function.

- [ ] **Step 3: Implement both**

In `src/science/connectors/proteins/rcsb-pdb.ts`, change the http import to add `getText`:

```ts
import { getJSON, getText, orFallback } from "../http"
```

add the `FetchedFile` type to the types import:

```ts
import type { Connector, ConnectorHit, FetchedFile, FetchOptions, SearchOptions } from "../types"
```

add a constant next to `DATA_ENTRY`:

```ts
// Coordinates live on a different host from the JSON entry record.
const FILES = "https://files.rcsb.org/download"
```

and add these members to the `rcsbPdb` object, after `fetch`:

```ts
  formats: ["pdb", "cif"],

  async fetchFile(id, format, opts?: FetchOptions): Promise<FetchedFile> {
    const name = `${id.toUpperCase()}.${format}`
    const body = await getText(`${FILES}/${encodeURIComponent(name)}`, { signal: opts?.signal })
    return { body, contentType: format === "cif" ? "chemical/x-cif" : "chemical/x-pdb", filename: name }
  },
```

In `src/science/connectors/proteins/pdbe.ts`, add `getText` and `FetchedFile` to the imports the same way, then add after `fetch`:

```ts
  formats: ["cif"],

  async fetchFile(id, format, opts?: FetchOptions): Promise<FetchedFile> {
    const name = `${id.toLowerCase()}.${format}`
    const body = await getText(`https://www.ebi.ac.uk/pdbe/entry-files/download/${encodeURIComponent(name)}`, {
      signal: opts?.signal,
    })
    return { body, contentType: "chemical/x-cif", filename: name }
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend/cli && bun test test/science/ && bun run typecheck
```

Expected: PASS. The paired-declaration test from Task 2 now has real subjects.

- [ ] **Step 5: Commit**

```bash
git add src/science/connectors/proteins/rcsb-pdb.ts src/science/connectors/proteins/pdbe.ts test/science/connector-formats.test.ts
git commit -m "feat(science): serve structure files from rcsb-pdb and pdbe

RCSB coordinates come from files.rcsb.org, a different host from the JSON
entry API the connector already used."
```

---

### Task 6: `fetchFile` for alphafold

The case that justifies putting format resolution inside connectors: AlphaFold's file URLs are only discoverable **inside** the JSON response, so a pure `id → URL` function cannot express it. Its `fetch()` also resolves to an **array**, so the URL fields need `[0]`.

**Files:**

- Modify: `backend/cli/src/science/connectors/proteins/alphafold.ts`
- Test: `backend/cli/test/science/connector-formats.test.ts` (append)

**Interfaces:**

- Consumes: `FetchedFile` from Task 2; the existing module-private `Prediction` interface with its `pdbUrl`/`cifUrl` fields.
- Produces: `alphafold.formats = ["pdb", "cif"]` plus `fetchFile`.

- [ ] **Step 1: Write the failing test**

Append to `test/science/connector-formats.test.ts`:

```ts
import { alphafold } from "../../src/science/connectors/proteins/alphafold"

describe("alphafold fetchFile", () => {
  test("declares pdb and cif", () => {
    expect(alphafold.formats).toEqual(["pdb", "cif"])
  })

  test("reads the file URL out of the JSON response, then fetches it", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      // First call: the prediction API, which returns an ARRAY.
      if (urls.length === 1)
        return new Response(
          JSON.stringify([
            { entryId: "AF-P04637-F1", cifUrl: "https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v4.cif" },
          ]),
          { status: 200 },
        )
      return new Response("data_AF-P04637-F1\n", { status: 200 })
    }) as unknown as typeof fetch

    const out = await alphafold.fetchFile!("P04637", "cif")
    expect(urls[0]).toContain("alphafold.ebi.ac.uk/api/prediction/P04637")
    expect(urls[1]).toBe("https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v4.cif")
    expect(out.filename).toBe("AF-P04637-F1-model_v4.cif")
    expect(out.body).toContain("data_AF-P04637-F1")
  })

  test("a prediction without the requested URL is an actionable error", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ entryId: "AF-X-F1" }]), { status: 200 })) as unknown as typeof fetch
    await expect(alphafold.fetchFile!("P04637", "cif")).rejects.toThrow(/no cif/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/cli && bun test test/science/connector-formats.test.ts
```

Expected: FAIL — `alphafold.formats` is undefined.

- [ ] **Step 3: Implement it**

In `src/science/connectors/proteins/alphafold.ts`, extend the imports:

```ts
import type { Connector, ConnectorHit, FetchedFile, FetchOptions, SearchOptions } from "../types"
import { getJSON, getText } from "../http"
```

then add these members to the `alphafold` object, after `fetch`:

```ts
  formats: ["pdb", "cif"],

  // AlphaFold's file URLs are only discoverable inside the JSON record, so this
  // fetches the prediction first and follows the URL it carries. That is why
  // format resolution lives in the connector rather than an id -> URL map.
  async fetchFile(id, format, opts?: FetchOptions): Promise<FetchedFile> {
    const predictions = await predict(id, opts?.signal)
    const first = predictions[0]
    const url = format === "pdb" ? first?.pdbUrl : first?.cifUrl
    if (!url) throw new Error(`AlphaFold has no ${format} file for "${id}".`)
    const body = await getText(url, { signal: opts?.signal })
    return {
      body,
      contentType: format === "cif" ? "chemical/x-cif" : "chemical/x-pdb",
      filename: url.split("/").pop() ?? `${id}.${format}`,
    }
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend/cli && bun test test/science/ && bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/science/connectors/proteins/alphafold.ts test/science/connector-formats.test.ts
git commit -m "feat(science): serve predicted structures from alphafold

File URLs are only discoverable inside the JSON prediction record, and the
API returns an array, so the connector fetches the record first and follows
the URL it carries."
```

---

### Task 7: `fetchFile` for uniprot, pubchem, ensembl, kegg

Four different URL shapes: a query param, a path segment, a different path, and a path suffix.

**Files:**

- Modify: `backend/cli/src/science/connectors/proteins/uniprot.ts`, `chemistry/pubchem.ts`, `genomics/ensembl.ts`, `pathways/kegg.ts`
- Test: `backend/cli/test/science/connector-formats.test.ts` (append)

**Interfaces:**

- Consumes: `FetchedFile` from Task 2.
- Produces: `formats` + `fetchFile` on all four. `pubchem`, `ensembl`, and `kegg` currently use the short form `async fetch(id, opts)` and import neither `FetchOptions` nor (except kegg) `getText` — both imports must be added.

- [ ] **Step 1: Write the failing test**

Append to `test/science/connector-formats.test.ts`:

```ts
import { uniprot } from "../../src/science/connectors/proteins/uniprot"
import { pubchem } from "../../src/science/connectors/chemistry/pubchem"
import { ensembl } from "../../src/science/connectors/genomics/ensembl"
import { kegg } from "../../src/science/connectors/pathways/kegg"

describe("query-param, path-segment, path and suffix formats", () => {
  test("uniprot uses a format query param", async () => {
    const s = stub(">sp|P04637|P53_HUMAN\nMEEPQSDPSV\n")
    const out = await uniprot.fetchFile!("P04637", "fasta")
    expect(s.url()).toBe("https://rest.uniprot.org/uniprotkb/P04637?format=fasta")
    expect(out.filename).toBe("P04637.fasta")
    expect(uniprot.formats).toEqual(["fasta", "txt"])
  })

  test("pubchem uses an uppercase path segment", async () => {
    const s = stub("2244\n  -OEChem-\n")
    const out = await pubchem.fetchFile!("2244", "sdf")
    expect(s.url()).toBe("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/SDF")
    expect(out.filename).toBe("2244.sdf")
    expect(pubchem.formats).toEqual(["sdf"])
  })

  test("ensembl uses a different path with a fasta content-type", async () => {
    const s = stub(">ENSG00000141510\nACGT\n")
    const out = await ensembl.fetchFile!("ENSG00000141510", "fasta")
    expect(s.url()).toBe("https://rest.ensembl.org/sequence/id/ENSG00000141510?content-type=text/x-fasta")
    expect(out.filename).toBe("ENSG00000141510.fasta")
    expect(ensembl.formats).toEqual(["fasta"])
  })

  test("kegg uses an aaseq path suffix", async () => {
    const s = stub(">hsa:7157 TP53\nMEEPQSDPSV\n")
    const out = await kegg.fetchFile!("hsa:7157", "fasta")
    expect(s.url()).toBe("https://rest.kegg.jp/get/hsa%3A7157/aaseq")
    expect(out.filename).toBe("hsa_7157.fasta")
    expect(kegg.formats).toEqual(["fasta"])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/cli && bun test test/science/connector-formats.test.ts
```

Expected: FAIL — none of the four declares `formats`.

- [ ] **Step 3: Implement all four**

**`proteins/uniprot.ts`** — add `FetchedFile` to the types import, then after `fetch`:

```ts
  formats: ["fasta", "txt"],

  async fetchFile(id, format, opts?: FetchOptions): Promise<FetchedFile> {
    const body = await getText(
      `https://rest.uniprot.org/uniprotkb/${encodeURIComponent(id)}?format=${encodeURIComponent(format)}`,
      { signal: opts?.signal },
    )
    return { body, contentType: "text/plain", filename: `${id}.${format}` }
  },
```

**`chemistry/pubchem.ts`** — this file imports neither `FetchOptions` nor `getText`. Change both import lines to:

```ts
import type { Connector, ConnectorHit, FetchedFile, FetchOptions } from "../types"
import { getJSON, getText, orFallback } from "../http"
```

then after `fetch`:

```ts
  formats: ["sdf"],

  async fetchFile(id, format, opts?: FetchOptions): Promise<FetchedFile> {
    // PubChem takes the format as an UPPERCASE path segment, not a parameter.
    const body = await getText(`${BASE}/compound/cid/${encodeURIComponent(id)}/${format.toUpperCase()}`, {
      signal: opts?.signal,
    })
    return { body, contentType: "chemical/x-mdl-sdfile", filename: `${id}.${format}` }
  },
```

**`genomics/ensembl.ts`** — change both import lines to:

```ts
import type { Connector, ConnectorHit, FetchedFile, FetchOptions } from "../types"
import { getJSON, getText } from "../http"
```

then after `fetch`:

```ts
  formats: ["fasta"],

  async fetchFile(id, format, opts?: FetchOptions): Promise<FetchedFile> {
    const stable = id.trim()
    const body = await getText(`${REST}/sequence/id/${encodeURIComponent(stable)}?content-type=text/x-fasta`, {
      signal: opts?.signal,
    })
    return { body, contentType: "text/x-fasta", filename: `${stable}.${format}` }
  },
```

**`pathways/kegg.ts`** — change the types import to:

```ts
import type { Connector, ConnectorHit, FetchedFile, FetchOptions } from "../types"
```

then after `fetch`:

```ts
  formats: ["fasta"],

  async fetchFile(id, format, opts?: FetchOptions): Promise<FetchedFile> {
    // KEGG appends the representation as a path suffix; aaseq is amino-acid FASTA.
    const body = await getText(`${REST}/get/${encodeURIComponent(id)}/aaseq`, { signal: opts?.signal })
    return { body, contentType: "text/x-fasta", filename: `${id.replace(/:/g, "_")}.${format}` }
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend/cli && bun test test/science/ && bun run typecheck
```

Expected: PASS. All seven format-serving connectors now satisfy the paired-declaration invariant from Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/science/connectors/proteins/uniprot.ts src/science/connectors/chemistry/pubchem.ts src/science/connectors/genomics/ensembl.ts src/science/connectors/pathways/kegg.ts test/science/connector-formats.test.ts
git commit -m "feat(science): serve sequence and structure files from four more connectors

Four different URL shapes: uniprot takes a query param, pubchem an
uppercase path segment, ensembl a different path, kegg a path suffix.

uniprot is the clearest payoff — its default JSON record measured 1.42 MB
against roughly a kilobyte for the same record as FASTA."
```

---

### Task 8: Rate limits for the hosts that proved they need them

Driven by evidence, not guesswork: a second batch run of all 42 connectors tripped `semantic-scholar` into HTTP 429. Only `arxiv` sets `rateLimit` today, of 42 connectors.

**Files:**

- Modify: `backend/cli/src/science/connectors/literature/semantic-scholar.ts`, `genomics/eutils.ts`, `literature/pubmed.ts`, `omics/geo.ts`
- Test: `backend/cli/test/science/connector-ratelimit.test.ts` (create)

**Interfaces:**

- Consumes: `HttpOptions.rateLimit` — shape `{ minIntervalMs?: number; maxConcurrent?: number }`, applied per URL host by the shared http layer.
- Produces: no exported surface. Behavioural only.

**Note:** the eutils host `eutils.ncbi.nlm.nih.gov` has three independent consumers, not one — `genomics/eutils.ts` (shared by `ncbi-gene`, `dbsnp`, `clinvar`), `literature/pubmed.ts` (its own `BASE` at line 13), and `omics/geo.ts` (its own `EUTILS` at line 15). All three need the option or the unpaced one undermines the others.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/science/connector-ratelimit.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"
import { semanticScholar } from "../../src/science/connectors/literature/semantic-scholar"
import { dbsnp } from "../../src/science/connectors/genomics/dbsnp"
import { pubmed } from "../../src/science/connectors/literature/pubmed"
import { geo } from "../../src/science/connectors/omics/geo"

const realFetch = globalThis.fetch

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// science_fetch makes back-to-back record retrieval an ordinary action, and a
// second full pass over the connector set trips Semantic Scholar's keyless
// limiter. These assertions are on observed pacing, not on source text: the
// rateLimit option is consumed inside http.ts and never reaches globalThis.fetch,
// so the only honest way to test it is to measure the delay it imposes.
//
// Every call below uses a DISTINCT id. The http cache is keyed by `${method} ${url}`
// (http.ts:164), so identical ids would be served from cache and never paced.
describe("rate limits on the hosts that need them", () => {
  test("semantic-scholar paces successive requests about a second apart", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ paperId: "x", title: "t" }), { status: 200 })) as unknown as typeof fetch
    const started = Date.now()
    await semanticScholar.fetch("1111111111111111111111111111111111111111")
    await semanticScholar.fetch("2222222222222222222222222222222222222222")
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  test("the shared eutils host is paced across all three of its consumers", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 })) as unknown as typeof fetch
    const started = Date.now()
    // Three DIFFERENT connectors hitting one server. This is the whole reason
    // pacing is per-host rather than per-connector: pacing only some of them
    // would leave eutils.ncbi.nlm.nih.gov unpaced.
    await dbsnp.fetch("rs334")
    await pubmed.fetch("10508479")
    await geo.fetch("GSE1000")
    // Two gaps at 350ms each.
    expect(Date.now() - started).toBeGreaterThanOrEqual(700)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/cli && bun test test/science/connector-ratelimit.test.ts
```

Expected: FAIL — none of the four files contains `rateLimit`.

- [ ] **Step 3: Add the pacing constants**

In **`literature/semantic-scholar.ts`**, add below the existing `BASE` constant:

```ts
// Keyless Semantic Scholar throttles hard — a second pass over the connector
// set returned HTTP 429. With an API key the ceiling is far higher, but pacing
// costs nothing when one is set.
const RATE_LIMIT = { minIntervalMs: 1000 }
```

and add `rateLimit: RATE_LIMIT` to the options object of every `getJSON(...)` **call site** in the file — one in `search`, one in `fetch`. (Verify with `grep -n "getJSON(" src/science/connectors/literature/semantic-scholar.ts`; the import line is not a call site.) For example:

```ts
const data = await getJSON<Paper>(`${BASE}/${id.trim()}?fields=${FIELDS},references.title,citations.title`, {
  signal: opts?.signal,
  headers: apiHeaders(),
  rateLimit: RATE_LIMIT,
})
```

In **`genomics/eutils.ts`**, add below its `BASE` constant (line 11):

```ts
// NCBI allows ~3 requests/second without an API key, counted per host across
// every eutils consumer (this module, literature/pubmed.ts, omics/geo.ts).
const RATE_LIMIT = { minIntervalMs: 350 }
```

and add `rateLimit: RATE_LIMIT` to the options of every `getJSON`/`getText` call in the file.

Repeat exactly the same two edits in **`literature/pubmed.ts`** (below its `BASE` at line 13) and **`omics/geo.ts`** (below its `EUTILS` at line 15), using the identical `{ minIntervalMs: 350 }` value and comment.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend/cli && bun test test/science/ && bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/science/connectors/literature/semantic-scholar.ts src/science/connectors/genomics/eutils.ts src/science/connectors/literature/pubmed.ts src/science/connectors/omics/geo.ts test/science/connector-ratelimit.test.ts
git commit -m "fix(science): pace the sources that rate limit us

A second pass over all 42 connectors returned HTTP 429 from Semantic
Scholar; only arxiv declared a rate limit. science_fetch makes back-to-back
retrieval ordinary, so this would bite routinely.

The eutils host has three separate consumers -- eutils.ts, pubmed.ts and
geo.ts -- and pacing only some of them leaves the host unpaced."
```

---

### Task 9: Fixture recorder and registry-wide conformance

The recorder is run by hand, never in CI. Its output makes the offline suite's fixtures recorded truth rather than authored guesses — the distinction that stops a connector from passing its test while failing for a user.

**Files:**

- Create: `backend/cli/script/record-fetch-fixtures.ts`, `backend/cli/test/science/connector-fetch.test.ts`
- Reference: `backend/cli/script/pack-native-smoke.ts` (shebang + argv style)

**Interfaces:**

- Consumes: `registry`, `outcomeFor` from Task 1, the sample-id map (copy it from `PROTOTYPE-fetch-repl.ts`, which already carries all 42 entries).
- Produces: `test/science/fixtures/fetch/<db>.json` files; no exported code surface.

- [ ] **Step 1: Write the failing test**

Create `backend/cli/test/science/connector-fetch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { registry } from "../../src/science/connectors"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"
import { outcomeFor } from "../../src/science/connectors/fetch-outcome"

const realFetch = globalThis.fetch

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// Every fetch() implementation shipped unexercised. This drives all 42 offline
// against a benign body and asserts the contract science_fetch depends on:
// resolve, never reject, and classify into exactly one outcome.
describe("connector fetch conformance", () => {
  const connectors = registry.all()

  test("the registry is fully populated", () => {
    expect(connectors.length).toBe(42)
  })

  for (const c of connectors) {
    test(`${c.id} resolves and classifies`, async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ id: "x", title: "t" }), { status: 200 })) as unknown as typeof fetch
      // A connector that rejects is not a failure of this contract — science_fetch
      // catches and classifies. `.catch` turns it into undefined, which sentinelOf
      // reads as a miss. arxiv is the one connector that takes this path by design.
      const payload = await c.fetch("TEST123").catch(() => undefined)
      const outcome = outcomeFor({ db: c.id, id: "TEST123", payload })
      expect(["record", "file", "miss", "error"]).toContain(outcome.kind)
    })
  }

  // Assert arxiv's documented contract explicitly rather than exempting it above.
  test("arxiv rejects a non-Atom body instead of returning a bogus record", async () => {
    globalThis.fetch = (async () =>
      new Response("<html><body>503 Service Temporarily Unavailable</body></html>", {
        status: 200,
      })) as unknown as typeof fetch
    await expect(arxiv.fetch("1706.03762")).rejects.toThrow(/non-Atom/)
  })
})
```

Add `arxiv` to the imports at the top of the file:

```ts
import { arxiv } from "../../src/science/connectors/literature/arxiv"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/cli && bun test test/science/connector-fetch.test.ts
```

Expected: FAIL. The `arxiv` import does not resolve until you add it, and the arxiv contract test fails without it. If the whole file passes on the first run, stop — you have written a test that cannot fail, and the red-first step exists precisely to catch that.

- [ ] **Step 3: Write the recorder**

Create `backend/cli/script/record-fetch-fixtures.ts`:

```ts
#!/usr/bin/env bun
/**
 * Records live fixtures for every connector's fetch(). Run by hand, never in CI:
 *
 *   bun run script/record-fetch-fixtures.ts
 *
 * Writes test/science/fixtures/fetch/<db>.json and prints a per-connector
 * report. Failures here are findings, not bugs in this script — several
 * connectors are known-degraded (biogrid needs BIOGRID_ACCESS_KEY; depmap can
 * be served a bot-verification page).
 */
import fs from "node:fs/promises"
import path from "node:path"
import { registry } from "../src/science/connectors"
import { outcomeFor, formatBytes } from "../src/science/connectors/fetch-outcome"

// Copied from PROTOTYPE-fetch-repl.ts, which carries all 42 entries.
const SAMPLE: Record<string, string> = {
  uniprot: "P04637",
  "rcsb-pdb": "6LU7",
  pdbe: "6lu7",
  alphafold: "P04637",
  interpro: "IPR000001",
  pfam: "PF00001",
  sifts: "P04637",
  ensembl: "ENSG00000141510",
  "ncbi-gene": "7157",
  dbsnp: "rs334",
  clinvar: "12345",
  gnomad: "ENSG00000141510",
  ucsc: "chr17:7668402-7687550",
  mygene: "7157",
  myvariant: "chr7:g.140453134A>T",
  chembl: "CHEMBL25",
  pubchem: "2244",
  bindingdb: "P04637",
  gtopdb: "4139",
  surechembl: "1",
  chebi: "CHEBI:15377",
  reactome: "R-HSA-68886",
  kegg: "hsa:7157",
  "string-db": "9606.ENSP00000269305",
  biogrid: "7157",
  intact: "EBI-77613",
  wikipathways: "WP554",
  opentargets: "ENSG00000141510",
  pubmed: "10508479",
  europepmc: "10508479",
  biorxiv: "10.1101/2020.01.30.927871",
  crossref: "10.1038/nature12373",
  openalex: "W2741809807",
  "semantic-scholar": "649def34f8be52c8b66281af98ae884c09aef38b",
  arxiv: "1706.03762",
  geo: "GSE1000",
  arrayexpress: "E-MTAB-1234",
  gtex: "ENSG00000141510",
  hpa: "ENSG00000141510",
  "expression-atlas": "E-MTAB-5214",
  "single-cell-atlas": "E-MTAB-5061",
  depmap: "CRISPR",
}

const out = path.resolve(import.meta.dir, "../test/science/fixtures/fetch")
await fs.mkdir(out, { recursive: true })

let ok = 0
for (const c of registry.all()) {
  const id = SAMPLE[c.id] ?? ""
  const started = performance.now()
  try {
    const payload = await c.fetch(id, { signal: AbortSignal.timeout(30_000) })
    const outcome = outcomeFor({ db: c.id, id, payload })
    const ms = Math.round(performance.now() - started)
    await fs.writeFile(path.join(out, `${c.id}.json`), JSON.stringify({ id, payload }, null, 2))
    const size = outcome.kind === "record" || outcome.kind === "file" ? formatBytes(outcome.bytes) : "-"
    console.log(`${c.id.padEnd(19)}${outcome.kind.padEnd(8)}${size.padStart(10)}${String(ms).padStart(7)}ms`)
    if (outcome.kind === "record") ok++
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(`${c.id.padEnd(19)}${"THREW".padEnd(8)}${"".padStart(10)}${"".padStart(7)}  ${message.slice(0, 60)}`)
  }
}
console.log(`\n${ok}/${registry.all().length} returned a record. Fixtures in ${out}`)
```

- [ ] **Step 4: Run the recorder, then the offline suite**

```bash
cd backend/cli && bun run script/record-fetch-fixtures.ts
bun test test/science/
```

Expected: the recorder prints 42 rows and writes fixtures. Roughly 38 return a record; `biogrid`, `depmap`, and `expression-atlas` are expected non-records. **Record the actual failures in the commit message** — that list is the deliverable. Then the offline suite passes with no network.

- [ ] **Step 5: Commit**

```bash
git add script/record-fetch-fixtures.ts test/science/connector-fetch.test.ts test/science/fixtures/
git commit -m "test(science): record live fetch fixtures and add conformance suite

Every fetch() implementation shipped unexercised. The recorder runs all 42
against live APIs; the offline suite replays the results, so fixtures are
recorded truth rather than authored guesses -- which is what stops a
connector passing its test while failing for a user.

Known-degraded connectors are asserted as such rather than skipped."
```

---

### Task 10: Retire the prototype

The decision has been absorbed into `fetch-outcome.ts`. The TUI shell was optimised for being driven by hand and must not ship.

**Files:**

- Delete: `backend/cli/src/science/connectors/PROTOTYPE-fetch-outcome.ts`, `PROTOTYPE-fetch-repl.ts`
- Modify: `backend/cli/package.json` (remove the `prototype:fetch` script added at line 15)

**Interfaces:**

- Consumes: nothing. Confirms no production code imports either file.
- Produces: nothing.

- [ ] **Step 1: Confirm nothing imports the prototype**

```bash
cd backend/cli && grep -rn "PROTOTYPE-fetch" src/ test/ script/ package.json
```

Expected: hits only in `package.json` (the `prototype:fetch` script) and the two prototype files themselves. If any `src/` or `test/` file imports them, that is a bug from an earlier task — fix it to import `fetch-outcome` instead before continuing.

- [ ] **Step 2: Preserve the prototype on a scratch branch**

```bash
cd /home/keertan/codes/InkVell/openscience
git branch prototype/science-fetch-repl
```

This keeps the prototype reachable as a primary source without it living on the feature branch.

- [ ] **Step 3: Delete the files and the script entry**

```bash
cd backend/cli
rm src/science/connectors/PROTOTYPE-fetch-outcome.ts src/science/connectors/PROTOTYPE-fetch-repl.ts
```

Then remove this line from `package.json`:

```json
    "prototype:fetch": "bun run ./src/science/connectors/PROTOTYPE-fetch-repl.ts"
```

and restore the trailing comma on the preceding `"dev"` line so the JSON stays valid.

- [ ] **Step 4: Run the full suite**

```bash
cd backend/cli && bun run typecheck && bun test
```

Expected: PASS with no reference to the deleted files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(science): retire the science_fetch prototype

The validated classification logic moved to fetch-outcome.ts in the first
task of this branch. The TUI shell is preserved on branch
prototype/science-fetch-repl as a primary source.

It earned its keep: it falsified the original rationale for the size
threshold. Payload size is not predictable per connector -- hpa was
estimated at 0.5-5MB and measured 10.6KB, while the two largest payloads
(mygene 2.15MB, uniprot 1.42MB) were not predicted to be large at all -- so
size has to be measured at runtime rather than annotated."
```

---

## Verification against the spec

Acceptance criteria from `docs/specs/science-fetch-design.md`, mapped to the task that satisfies each:

| #   | Criterion                                                     | Task |
| --- | ------------------------------------------------------------- | ---- |
| 1   | `science_fetch` registered and reachable by all agents        | 3    |
| 2   | `science_list_dbs` reports `formats`                          | 4    |
| 3   | Record inline under 50 KB, spills over it with path + summary | 1, 3 |
| 4   | `rcsb-pdb` + `cif` writes a `.cif` file                       | 5    |
| 5   | Sentinel families render as misses; `{error}` as an error     | 1, 3 |
| 6   | No call throws; every failure carries `metadata.error`        | 3, 9 |
| 7   | ids with `/`, `:`, `>` produce valid filenames                | 1    |
| 8   | `semantic-scholar` and eutils declare `rateLimit`             | 8    |
| 9   | `bun test` passes with no network                             | 9    |
| 10  | Fixture recorder runs and reports per-connector status        | 9    |

Registry-wide coverage is enforced structurally rather than by inspection: the paired-declaration test in Task 2 fails if any connector declares `formats` without `fetchFile` or vice versa, and the Task 9 loop covers all 42 by iterating `registry.all()` rather than a hand-maintained list.
