# Adding a scientific connector

A connector wraps one public scientific database behind the uniform contract
the `science_search`, `science_list_dbs`, and `science_fetch` tools route
through. The model never learns about individual databases; it picks a `db` id
from the registry.

## The contract

Implement `Connector` from `backend/cli/src/science/connectors/types.ts`:

| Member        | Required | Notes                                                                                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | yes      | Stable lowercase id used for routing (`chebi`, `rcsb-pdb`).                                                                                            |
| `name`        | yes      | Display name.                                                                                                                                          |
| `domain`      | yes      | One of `ConnectorDomain` (`biology`, `chemistry`, `physics`, `genomics`, `proteomics`, `structure`, `literature`, `materials`, `clinical`, `general`). |
| `description` | yes      | One line shown by `science_list_dbs`.                                                                                                                  |
| `homepage`    | no       | Docs or landing URL.                                                                                                                                   |
| `search`      | yes      | `(query, opts?) => Promise<ConnectorHit[]>`; honor `opts.limit` and `opts.signal`.                                                                     |
| `fetch`       | yes      | `(id, opts?) => Promise<unknown>`; return the source's record shape.                                                                                   |
| `formats`     | no       | File formats the source can serve (`["pdb", "cif"]`). Never `json`.                                                                                    |
| `fetchFile`   | no       | Present exactly when `formats` is; returns `{ body, contentType, filename }`.                                                                          |

`ConnectorHit` is `{ id, title, summary?, url?, score?, extra? }`. Keep the
source's structured fields in `extra` rather than inventing a schema.

Use the shared HTTP helper (`../http`: `getJSON`, `getText`, `request`) for
every call. It adds the timeout, a polite User-Agent, retry with backoff on
429/5xx, a five-minute GET cache, and per-host rate limiting through the
`rateLimit: { minIntervalMs, maxConcurrent }` option. Every bundled source
works without a key. Optional keys (Semantic Scholar, OpenAlex) are read from
`process.env` as injected by the credential store and only raise rate limits;
never make a key required or return empty results without one.

## Where it goes

1. Create `backend/cli/src/science/connectors/<group>/<id>.ts` exporting a
   `const <id>: Connector`. `chemistry/chebi.ts` (55 lines) is a good template.
   The six groups on disk are `chemistry`, `genomics`, `literature`, `omics`,
   `pathways` and `proteins`; they are directories, not the `domain` field. A
   connector's `domain` is independent (`pathways/` holds `biology` sources,
   `proteins/` holds `proteomics` and `structure`, `genomics/` holds
   `clinical`), so pick the group your source reads most like.
2. Export it from `<group>/index.ts` and append it to that file's default
   array. `connectors/index.ts` imports those six arrays and spreads them into
   the shared registry, so an existing group needs no edit there — but a new
   group does need its import and spread added, or the connector never
   registers and never appears in `science_list_dbs`. (That file's header
   comment still describes an older `./impl/<id>.ts` layout — the group
   directories are the current one.)
3. Add a known-good record id for your source to `SAMPLE` in
   `backend/cli/script/record-fetch-fixtures.ts`.

## Tests

The conformance suite replays recorded live responses, so record one for your
connector first. The recorder talks to the real APIs and is run by hand, never
in CI:

```bash
cd backend/cli
bun run script/record-fetch-fixtures.ts     # writes test/science/fixtures/fetch/<id>.json
```

Commit the fixture (`test/science/fixtures/` is excluded from Prettier), then
run the suites:

```bash
cd backend/cli
bun test --timeout 15000 ./test/science/connector-contract.test.ts   # structural contract
bun test --timeout 15000 ./test/science/connector-fetch.test.ts      # fixture replay + counts
bun test --timeout 15000 ./test/science/connector-ratelimit.test.ts  # pacing, if you set rateLimit
bun test --timeout 15000 ./test/science/connector-formats.test.ts    # if you serve file formats
```

`connector-fetch.test.ts` pins the registry size (`toBe(42)`) and the number of
fixture files (`toBe(40)`); bump both in the same change. If your source's
response exceeds the 50 KB inline cap, add its id to `EXPECTED_SPILL` there.
Do not add connector counts to README.md; they drift.

## Try it

Run `bun dev "$PWD"` and ask the agent to search your database, or call the tools
directly: `science_list_dbs` should list the new id and `science_search` with
`db: "<id>"` should return hits.

## Pull request

Title `feat(connectors): add <id>` or `fix(connectors): <source> <what changed>`.
A connector broken by an upstream API change does not need an issue first.
Describe the sample record you verified and paste the recorder's report line
for your connector.
