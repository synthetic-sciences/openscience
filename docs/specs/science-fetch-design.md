# science_fetch — design

Status: approved, ready for implementation planning
Date: 2026-07-29
Roadmap items: unblocks the top entry in `docs/ROADMAP.md` "Wire what already exists"; absorbs part of **97**; partially addresses **98**

## Problem

All 42 connectors in `backend/cli/src/science/connectors/` implement `fetch(id, opts)`. Nothing calls it —
`tool/science.ts` exposes only `search()`. A grep for `connector.fetch` across the repo returns zero hits.

The user-visible consequence: the agent can find a record and cannot retrieve it. Ask for structures of the
SARS-CoV-2 main protease and `science_search` returns `6LU7` with a title and URL, then the loop dead-ends at
the exact moment the work becomes science. Record retrieval is fully implemented and unreachable.

This spec covers exposing it, plus the minimum required to do so safely.

## Evidence

A throwaway prototype (`PROTOTYPE-fetch-outcome.ts` + `PROTOTYPE-fetch-repl.ts`, see Prototype below) executed
all 42 `fetch()` implementations against live APIs — their first execution ever. Two independent batch runs.

**Outcome distribution (both runs):**

| Outcome        | Count | Notes                                                                |
| -------------- | ----- | -------------------------------------------------------------------- |
| Record, inline | 31    | Stable across both runs                                              |
| Record, spill  | 6–7   | uniprot, mygene, sifts, bindingdb, pfam, ensembl (+semantic-scholar) |
| Clean miss     | 2     | expression-atlas, depmap — both `found: false`                       |
| Error          | 1–3   | biogrid (no key), myvariant (bad sample id), semantic-scholar (429)  |

**Size distribution:** median 10.9 KB · max 2.15 MB · largest inline 46.5 KB (`rcsb-pdb`) · smallest spill
82.4 KB (`semantic-scholar`).

Three findings drive the design:

1. **Payload size is not predictable per connector.** Pre-audit estimates were wrong in both directions: `hpa`
   was predicted at 0.5–5 MB and measured 10.6 KB, while the two largest payloads — `mygene` at 2.15 MB and
   `uniprot` at 1.42 MB — were not predicted to be large at all. Size must therefore be **measured at runtime**;
   per-connector annotation cannot work, and inline-with-truncation would silently cut 2 MB from an ordinary
   `mygene` lookup.
2. **The 50 KB cap sits in a natural gap.** Nothing measured between 46.5 KB and 82.4 KB. The split was
   identical in both runs under different network conditions.
3. **"Not found" and "failed" are genuinely different, and both occur.** Nine connectors signal a miss with a
   sentinel value rather than throwing. Conflating them would render two ordinary misses as outages.

## Design

### 1. Connector interface

Two optional additions to `Connector` in `connectors/types.ts`. Both optional, so 35 connectors are untouched.

```ts
export interface Connector {
  // ... existing members unchanged
  /**
   * FILE formats this connector can serve, e.g. ["pdb", "cif"]. Absent = records only.
   * Never includes "json" — omitting `format` altogether is the record path via `fetch()`.
   */
  formats?: string[]
  /** Retrieve a record as a file in one of `formats`. Present iff `formats` is. */
  fetchFile?(id: string, format: string, opts?: FetchOptions): Promise<FetchedFile>
}

export interface FetchedFile {
  body: string
  contentType: string
  /** Extension-bearing suggested name, e.g. "6LU7.cif". */
  filename: string
}
```

`"json"` is deliberately not a member of `formats`. Omitting `format` calls `fetch()` and yields a record;
passing one calls `fetchFile()` and yields a file. Keeping `"json"` out of the list removes the ambiguity of
two routes to the same result.

Records and files are split rather than unified behind `FetchOptions.format` because they have different
contracts: a record is structured, size-varying, and may go inline; a file is opaque, potentially large, and
always spills. Splitting makes the spill policy **structural** — derivable from which method was called —
rather than a threshold applied to an opaque payload. It also lets `science_list_dbs` advertise real format
coverage so the model never guesses at a format that does not exist.

`FetchOptions.format` is left in place and `uniprot.fetch()` keeps honouring it, so no existing behaviour
changes. It is not the mechanism `science_fetch` uses: the tool routes a supplied `format` to `fetchFile()` and
never passes it to `fetch()`. `uniprot` therefore ends up with both paths, which is acceptable — the field is
pre-existing public surface and removing it is not this spec's concern.

### 2. The tool

One new tool in `tool/science.ts`, bringing the total to three. The tool passes `format` through as an opaque
string and never learns what any of them mean — the registry-routing constraint in `connectors/types.ts` holds.

```
science_fetch(db, id, format?)
  → registry.get(db)                 unknown db → list available ids (mirrors science_search)
  → format given?
      yes → connector.fetchFile(id, format)   → always spill → path + summary
      no  → connector.fetch(id)               → bytes > cap ? spill : inline
```

`science_list_dbs` additionally reports each connector's `formats`.

### 3. Spill

Oversized records and all files are written to `.openscience/fetch/<db>/<id>.<ext>` in the project directory —
the existing project-local convention, reachable by the `Read` tool and, later, the file preview. The tool
returns the path, byte count, and a key-level summary so the model can decide whether to read it.

Cap is **50 KB**. `tool/read.ts` already defines `MAX_BYTES = 50 * 1024` as a module-private constant; lift it
to a shared location and import it in both places rather than duplicating the literal, so the codebase carries
one number.

ids are not safe path segments: `crossref` takes `10.1038/nature12373` (slash), `kegg` takes `hsa:7157`
(colon), `myvariant` takes `chr7:g.140453134A>T` (colon and angle bracket). Colons and backslashes are illegal
on Windows, which this project ships binaries for. Sanitisation reduces to `[A-Za-z0-9._-]`, collapses runs to
`_`, trims leading and trailing separators, and caps length at 120 chars.

**Not** the RLM artifact store (`session/rlm/artifacts.ts`). That store discards the `type` and `summary` it is
given and hardcodes `type: "unknown"` on `list()`; repairing it is roadmap item 13, not this work.

### 4. Error handling

Extends the degradation pattern `science_search` already implements — never throw a raw `HTTP 429`, always
return an actionable result carrying `metadata.error`.

| Condition                             | Result                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| Unknown `db`                          | List available ids, `metadata.error = "unknown_db"`           |
| Sentinel: `null`, `{}`, `found:false` | Clean miss. **Not** an error. `metadata.count = 0`            |
| Sentinel: `{error: string}`           | Error carrying the connector's own message (e.g. biogrid key) |
| Thrown, 429/503/408 or /rate.?limit/  | `metadata.error = "rate_limited"`, actionable retry guidance  |
| Thrown, anything else                 | `metadata.error = "source_error"`, message preserved          |
| `format` requested, no `formats`      | Report that the connector serves records only                 |
| `format` not in `formats`             | List what the connector does support                          |

### 5. Rate limiting (scoped)

`science_fetch` makes sequential multi-record retrieval an ordinary action, and the prototype's second batch run
tripped `semantic-scholar` into HTTP 429. Only `arxiv` sets `rateLimit` today, of 42 connectors.

In scope: `semantic-scholar` (429 observed directly) and the four NCBI eutils connectors — `pubmed`,
`ncbi-gene`, `dbsnp`, `clinvar` — which share a documented 3 req/s keyless ceiling. Roughly one line each.

Out of scope: the other 36. Roadmap item 98 stays open for them.

### 6. Formats

Seven connectors gain `formats` + `fetchFile`, chosen because they serve files a user actually wants and that
existing renderers can display:

| Connector   | `formats`  | URL shape                                            |
| ----------- | ---------- | ---------------------------------------------------- |
| `rcsb-pdb`  | pdb, cif   | Different host — `files.rcsb.org/download/{id}.cif`  |
| `pdbe`      | cif        | `ebi.ac.uk/pdbe/entry-files/download/{id}.cif`       |
| `alphafold` | pdb, cif   | URLs live **inside** the JSON response — fetch first |
| `uniprot`   | fasta, txt | Query param — `?format=fasta`                        |
| `pubchem`   | sdf        | Path segment — `/compound/cid/{id}/SDF`              |
| `ensembl`   | fasta      | Different path — `/sequence/id/{id}`                 |
| `kegg`      | fasta      | Path suffix — `/get/{id}/aaseq`                      |

`alphafold` is why format resolution lives in the connector rather than a declarative `id → URL` map: its file
URLs are only discoverable by reading the JSON record first, which a pure function of `id` cannot express.

`uniprot` also demonstrates the payoff — its default JSON measured 1.42 MB; the same record as FASTA is
roughly a kilobyte.

## Testing

House pattern, established by `test/science/arxiv.test.ts` and `http.test.ts`: stub `globalThis.fetch` with
fixture bodies, exercise the real connector code, no network in CI.

**Tier 1 — `script/record-fetch-fixtures.ts`.** Calls all 42 `fetch()` implementations live, writes bodies to
`test/science/fixtures/fetch/<db>.json`, prints a pass/fail report. Run on demand, not in CI. Fixtures are
recorded truth rather than authored guesses — the distinction that keeps a connector from passing its test
while failing for a user.

**Tier 2 — `test/science/connector-fetch.test.ts`.** Iterates the registry offline. For every connector:
`fetch()` resolves without throwing, returns a defined value, and renders through the real `science_fetch` tool.
Targeted cases for the seven `fetchFile` connectors, for each sentinel family, and for inline/spill at the
boundary.

Known-degraded connectors are asserted as such rather than skipped: `biogrid` returns its key-required error
without `BIOGRID_ACCESS_KEY`, and `depmap` can be served a bot-verification page.

## Out of scope

Each is a separate roadmap item; none is a prerequisite.

- Repairing the RLM artifact store (item 13)
- Routing spilled files to the Mol\*/RDKit/igv renderers (items 16, 73)
- Auto-recording provenance on fetch (item 10) — tempting, deliberately deferred
- The four catalogue-scan connectors that download an index to return one record — documented, not fixed
- `formats` for the other 35 connectors
- Rate limiting for the other 36 connectors (item 98)

## Acceptance criteria

1. `science_fetch` is registered and reachable by all agents that have `science_search`.
2. `science_list_dbs` reports `formats` for the seven connectors that declare them.
3. A record under 50 KB renders inline; one over it writes to `.openscience/fetch/<db>/<id>.<ext>` and returns
   path, byte count, and summary.
4. `science_fetch(db: "rcsb-pdb", id: "6LU7", format: "cif")` writes a `.cif` file and returns its path.
5. All four sentinel families render as clean misses with `count: 0`, never as errors — except `{error: string}`,
   which renders as an error.
6. No `science_fetch` call throws; every failure returns a tool result carrying `metadata.error`.
7. ids containing `/`, `:`, and `>` produce valid filenames on Windows and POSIX.
8. `semantic-scholar` and the four eutils connectors declare `rateLimit`.
9. `bun test` passes with no network access.
10. The fixture recorder runs and reports per-connector status.

## Prototype

`backend/cli/src/science/connectors/PROTOTYPE-fetch-outcome.ts` (pure classification logic) and
`PROTOTYPE-fetch-repl.ts` (terminal shell), runnable via `bun run prototype:fetch` from `backend/cli`.

The pure module is the liftable part — `sentinelOf`, `classifyError`, `safeSegment`, `filenameFor`, `summarize`,
and `outcomeFor` transfer into the real implementation. The TUI is throwaway and goes to a scratch branch.
