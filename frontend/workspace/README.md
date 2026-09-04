# OpenScience workspace

The browser workspace UI, written in SolidJS. The CLI embeds a production
build of this package and serves it; in development you can run it against a
source server with hot reload.

```bash
bun dev serve        # from the repo root: API server on http://localhost:4096
bun run dev:ui       # from the repo root: this package on http://localhost:3000
```

The dev build calls port 4096 unless `VITE_OPENSCIENCE_SERVER_PORT` (or
`VITE_OPENSCIENCE_SERVER_HOST` / `VITE_OPENSCIENCE_SERVER_URL`) says otherwise.
`bun run build` writes `dist/`, which `backend/cli/script/generate-web-assets.ts`
embeds; `bun run setup --web` at the repo root does both. Unit tests run with
`bun test` in this directory (happy-dom); `bun run typecheck` uses tsgo.

Setup, checks, and pull-request expectations are in
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## E2E Testing

`bun run test:e2e` is the safe default: it allocates fresh backend, Vite, and
model ports, creates a temp sandbox, seeds data, and never reuses an existing
port-3000 listener. `test:e2e:local` is an equivalent compatibility alias.
It also starts a loopback-only deterministic model so prompt/reply coverage never
uses developer credentials or an external inference service. Raw
`playwright test` is intentionally rejected because it cannot establish which
backend or checkout owns an existing listener.

```bash
bunx playwright install
bun run test:e2e
bun run test:e2e -- --grep "settings"
```

To test an already-running or packaged OpenScience server, opt in explicitly.
The external command requires `PLAYWRIGHT_BASE_URL`, does not start Vite, and
derives the SDK backend host/port from that URL unless separately overridden:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4112 bun run test:e2e:external
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4112 bun run test:e2e:packaged
```

Environment options for explicit external runs:

- `PLAYWRIGHT_BASE_URL` (required server URL)
- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (optional SDK backend override)

If the bundled browser cannot be installed on the host, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a compatible Chromium executable.
