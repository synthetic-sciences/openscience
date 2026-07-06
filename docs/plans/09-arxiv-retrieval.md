# 09 — arXiv retrieval reliability

Workstream: make arXiv query/fetch/parse reliable and gracefully degrading under rate limits and malformed responses. Most fixes belong at the shared-connector layer, so OpenAlex / Semantic Scholar / PubChem/PubMed benefit too. Findings-first; citations are `file:line` under `backend/cli/src`.

## Current state

**Call path (agent → tool → connector → HTTP).** arXiv is not an MCP server or a dedicated tool; it is one `Connector` behind two generic agent tools:

1. `tool/science.ts` exposes exactly `science_list_dbs` (`science.ts:13`) and `science_search` (`science.ts:57`) regardless of DB count. `science_search.execute` looks up the connector by `db` id (`science.ts:70`), clamps `limit` to 1–50 (`science.ts:83`), calls `connector.search(query, { limit, organism, signal })` (`science.ts:84`), renders hits to markdown. Wired into every agent at `tool/registry.ts:132` (`...ScienceTools`).
2. `science/connectors/index.ts:30` registers all connectors into one shared `ConnectorRegistry` (`connectors/types.ts:93`); arXiv exported from `connectors/literature/index.ts:16,21`.
3. `connectors/literature/arxiv.ts` implements the uniform `Connector` contract (`types.ts:63`): `search()` + `fetch()`.
4. `connectors/http.ts` `getText()` (`http.ts:150`) → `request()` (`http.ts:64`) → Bun global `fetch`.

A thrown connector error propagates un-caught out of `science_search.execute` (no try/catch, `science.ts:69–110`), becomes a `tool-error` part, and the agent sees `error.toString()` verbatim (`session/processor.ts:242`).

**API / flow / format.** Host `https://export.arxiv.org/api/query` (`arxiv.ts:12`); response is Atom XML, not JSON (`arxiv.ts:6–9`). `search` (`arxiv.ts:73`): `max = min(limit ?? 10, 50)`, GET `?search_query=all:<q>&start=0&max_results=<max>&sortBy=relevance`. `fetch` (`arxiv.ts:82`): `bareId(id)` strips `arxiv.org/abs/` (`arxiv.ts:27`), GET `?id_list=<id>&max_results=1`. `parse` (`arxiv.ts:31`): `xmlBlocks(xml,"entry")` → per-entry id/title/summary/dates/authors/doi/primary_category + PDF `<link>`.

**Shared framework.** `http.ts` is the only reliability layer: `USER_AGENT` set (`http.ts:15`), timeout 30 s (`:16`), retries 3 (`:17`), GET cache TTL 5 min (`:18`), `Accept: application/json` forced on every request (`http.ts:80`), retry on 429/408/5xx honoring `Retry-After` else exp backoff capped 15 s + jitter (`http.ts:124`), in-memory `Map` cache keyed `"<METHOD> <url>"` that stores any 2xx body (`http.ts:101–107`). `shared.ts` has dependency-free regex XML helpers, all defensive (`xmlText:78`, `xmlBlocks:86`, `xmlAttr:94`).

| Concern | Status |
| --- | --- |
| Timeout | 30 s per attempt (`http.ts:16`) |
| Retries | 3, exp backoff + jitter, honors `Retry-After` (`http.ts:85–131`) |
| **Rate limiting** | **None** — no per-host throttle/min-interval/concurrency gate anywhere in `science/` |
| Caching | 5-min in-memory GET cache; **caches empty/error 2xx bodies too** (`http.ts:101`) |
| **Pagination** | **None** — `start=0` hardcoded, hard ceiling 50 (`arxiv.ts:74,76`) |
| **Tests** | **None** — 0 test files under `science/` |

Latent: `settings/network.ts:85` allowlists `arxiv.org` but the connector calls `export.arxiv.org`; `Network.allowlist()` has no consumers today (`network.ts:142`), so nothing is enforced — but exact-host enforcement would later break arXiv.

## What's broken / missing

1. **PDF link extraction is silently broken (concrete bug).** arXiv `<link>` is self-closing (`<link title="pdf" href="…" rel="related" type="application/pdf"/>`), but `xmlBlocks(block,"link")` (`arxiv.ts:37`) requires a `</link>` close tag (`shared.ts:87`) → always `[]` → `e.pdf` is **always undefined**. (`xmlAttr` matches self-closing openings, which is why `primaryCategory` still works — the asymmetry is the trap.)
2. **arXiv error responses mis-surfaced as fake hits.** For a malformed query/id, arXiv returns HTTP 200 with one `<entry>` whose id is `http://arxiv.org/api/errors#…` and title `Error`. `parse()` yields it and `search()` returns a bogus hit titled "Error" (`arxiv.ts:31–63`); `isRetryable` only checks status codes (`http.ts:42`).
3. **No rate-limit etiquette.** arXiv asks ≤1 req/3 s, low concurrency. Nothing spaces requests; sibling connectors even fan out (`biorxiv.ts:91,99` `Promise.all`). Reactive backoff only helps after a 429/503.
4. **Empty/error responses poison the 5-min cache** (`http.ts:101`) and are re-served.
5. **Non-Atom/empty 200 bodies degrade to a misleading "No results."** `xmlBlocks(xml,"entry")` → `[]` → indistinguishable from a genuine zero-hit query (`science.ts:90`).
6. **Errors surface raw and abort the whole call** — exhausted retries throw `HTTP 429 for …: <body>` (`http.ts:99`), seen verbatim by the agent; no partial results.
7. **`Accept: application/json` on an XML source** (`http.ts:80`) — wrong etiquette, fragile under content negotiation. Same for PubMed EFetch (`pubmed.ts:91`).
8. **Pagination ceiling 50** (`arxiv.ts:74`); `opensearch:totalResults` never read.
9. **Fielded queries clobbered** — `all:<q>` wrapping breaks `ti:transformer AND cat:cs.LG` (`arxiv.ts:76`).
10. **No tests** for parsing, retry/backoff, or degradation.

## Proposed change

Shared-connector layer (benefits arXiv + OpenAlex + Semantic Scholar + PubChem/PubMed):

- **S1 — per-host throttle** (`http.ts` + `types.ts`): a per-host min-interval queue keyed by URL host; add optional `rateLimit?: { minIntervalMs; maxConcurrent }` to the connector/request options (arXiv 3000 ms, keyless Semantic Scholar ~1000 ms, OpenAlex polite-pool). Per-host so multi-DB fan-out isn't over-serialized.
- **S2 — don't cache empty/error bodies** (`http.ts:101`): skip caching (or short negative TTL) when body is empty or fails a caller `looksValid` predicate.
- **S3 — fix content negotiation** (`http.ts:80,150`): default `Accept: */*`, let `getJSON` set JSON explicitly.
- **S4 — self-closing XML helper** (`shared.ts`): extract self-closing `<tag …/>` elements + attrs; unblocks the arXiv PDF fix; benefits any Atom/XML source.
- **S5 — structured degradation at the tool layer** (`science.ts:84`): wrap `connector.search/fetch` in try/catch; on failure return a normal tool result with a clear title ("arXiv temporarily unavailable — rate limited, retry shortly"), `metadata.error`, and any partial hits; distinguish "no results" from "source error."
- **S6 — typed connector errors** (`types.ts`): `{ kind: "rate_limited" | "malformed" | "network"; retryAfterMs? }` so the tool renders actionable guidance and the agent can retry.

arXiv-specific (`arxiv.ts`):

- **A1** fix PDF extraction using S4 (replace `arxiv.ts:37`).
- **A2** detect error entries (`id` starts `http://arxiv.org/api/errors` or `title === "Error"`) → typed error, never a hit.
- **A3** validate body is an Atom feed before parsing; HTML/empty → typed error, not `[]`.
- **A4** read `opensearch:totalResults`; support `start`-based pagination for >50.
- **A5** pass fielded queries through — only prepend `all:` when no `field:` prefix.
- **A6** give arXiv the 3 s per-host limit from S1; keep the identifiable UA.
- **A7** (latent) when allowlist enforcement lands, add `export.arxiv.org` / suffix-match (`network.ts:85`).

## Risks

- Throttle latency (S1/A6) slows fan-out — mitigate with per-host-only queues.
- `Accept` change (S3) — verify against all four connectors before merge (low risk; they key off the path).
- Not caching empties (S2) — use a short negative TTL rather than none.
- Swallowing throws (S5) can hide outages — always populate `metadata.error` + a visible degraded title.
- Regex parsing stays fragile by design (`shared.ts:1–10`); fixes are targeted, not a full XML-parser rewrite (CDATA/deep namespacing out of scope).

## Acceptance criteria

1. `science_search db=arxiv` on a known paper returns a non-empty PDF URL (A1/S4); regression test on a real Atom fixture with self-closing `<link/>`.
2. A malformed query yields a clear "source error" vs "no results" distinction and never a hit titled "Error" (A2/A3/S6).
3. Under simulated 429/503 with `Retry-After`, retrieval succeeds after backoff; under sustained rate-limiting the tool returns an actionable message + partial hits, not a raw `HTTP 429` string (S5/S6).
4. A burst of N arXiv calls is spaced ≥3 s apart, verified with a fake clock / stubbed `fetch` (S1/A6).
5. Empty/HTML 200 responses are not cached and are surfaced as errors, not silent "No results" (S2/A3).
6. >50-result queries can page via `start`; `opensearch:totalResults` exposed (A4).
7. Fielded queries (`ti:…`, `cat:…`) reach arXiv unwrapped (A5).
8. Tests exist (currently 0): `parse()` over real Atom fixtures (self-closing links, error entry, empty feed, entity/LaTeX titles); `http` retry/backoff/negative-cache/throttle; tool-layer degradation.
9. No regression: OpenAlex, Semantic Scholar, PubChem/PubMed still return hits after the shared-layer changes.

**Files:** `connectors/http.ts` (S1–S3), `connectors/types.ts` (S1,S6), `connectors/literature/shared.ts` (S4), `tool/science.ts` (S5), `connectors/literature/arxiv.ts` (A1–A6), `settings/network.ts` (A7, latent); new tests under `science/`.

**Highest-value defects:** the always-undefined PDF link (`arxiv.ts:37` + `shared.ts:87`), the missing rate limit, and the mis-surfaced 200-error-entry.
