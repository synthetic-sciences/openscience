# Working in this repository

This file is for coding agents and new contributors alike. It says where things
are, how to verify a change, and the conventions the code follows. Product
behaviour for the OpenScience agent itself lives in `backend/cli/src/agent/prompt/`
and `backend/cli/AGENTS.md` (the instructions the shipped agent reads when it
works inside `backend/cli` as a project); this file is about the repository.

## Map

| Path                 | What lives there                                                            |
| -------------------- | --------------------------------------------------------------------------- |
| `backend/cli`        | The `openscience` CLI and local server: sessions, tools, providers, skills  |
| `frontend/workspace` | The browser workspace (SolidJS), embedded into the CLI at build time        |
| `frontend/ui`        | Shared components, themes, icons (`@synsci/ui`)                             |
| `frontend/desktop`   | The Electron shell and its signed self-updater                              |
| `frontend/docs`      | The documentation site                                                      |
| `frontend/landing`   | openscience.sh (own lockfile, not a workspace member)                       |
| `tooling/sdk/js`     | The TypeScript SDK, generated from the server's OpenAPI contract            |
| `tooling/plugin`     | The plugin runtime (`@synsci/plugin`)                                       |
| `tooling/util`       | Small helpers shared by backend and frontend (`@synsci/util`)               |
| `tooling/repo`       | Setup, SDK regeneration, test sharding, release scripts                     |
| `tooling/harbor`     | Harbor / Terminal-Bench adapter for the headless `openscience run` contract |
| `evals`              | Launch evals and the research-harness dev lab                               |
| `docs/notes`         | Engineering notes: verification loop, release process, extension guides     |

`ARCHITECTURE.md` explains how the pieces fit; `CONTRIBUTING.md` covers the
dev loops and PR expectations; `docs/notes/release-process.md` is how releases
are cut.

## Commands

```bash
bun run setup                     # verify Bun, install, embed the workspace UI once
bun run check                     # format, typecheck, backend + frontend + sdk unit tests
bun run typecheck                 # turbo, ~5 s warm
bun run --cwd backend/cli test    # backend suite with the 15 s per-test timeout
bun test --timeout 15000 ./test/<dir>            # one backend directory (from backend/cli)
bun test --timeout 15000 ./test/<dir>/<file>.test.ts -t "<name>"
bun run test:workspace            # frontend/workspace unit tests (happy-dom, ~40 s)
bun run test:ui                   # @synsci/ui unit tests
bun run --cwd frontend/workspace build           # the workspace bundle the CLI embeds
./tooling/repo/generate.ts        # regenerate the SDK after changing backend/cli/src/server
```

Things that bite:

- Use the pinned Bun (`packageManager` in package.json). Other versions
  produce a different install layout and the frozen lockfile fails.
- Bare `bun test` in `backend/cli` uses Bun's 5 s default timeout and fails
  spuriously; the package script adds `--timeout 15000`.
- Bun treats a bare `test/<dir>` argument as a name filter; pass `./test/<dir>`.
- `frontend/workspace` unit tests live under `src/`; the Playwright specs in
  `e2e/` run through `bun run --cwd frontend/workspace test`, not `bun test`.
- Generated, gitignored files: `backend/cli/src/web/assets.generated.ts`
  (the embedded UI; `bun run setup --web` makes it), `src/provider/models-snapshot.ts`
  (written by the build; the runtime falls back to a live fetch), and
  `src/skill/bundled.generated.ts` (build only). Tests are hermetic and do not
  need them.
- The Fast CI `Test` job runs only the backend tests affected by the diff; the
  full backend suite, native ownership tests, and the web builds run in Deep
  CI (`gh workflow run deep-ci.yml --ref <branch>`, ~5 min).

## Conventions

- Keep things in one function unless composable or reusable.
- Avoid unnecessary destructuring: `obj.a` and `obj.b` keep context; `const { a, b } = obj` loses it.
- Avoid `try`/`catch` where a result type or `.catch(() => undefined)` reads better.
- No `any`. Rely on inference; annotate exports and anything a reader would otherwise have to look up.
- Prefer `const`; avoid `let` plus if/else reassignment (use a ternary or an `iife`).
- Prefer early returns to `else`.
- Prefer single-word names when one word is precise.
- Use Bun APIs (`Bun.file()`, `Bun.spawn`, `$`) over Node equivalents.
- Comments explain why, not what. Do not narrate a change in a comment.

### Tests

- Test behaviour, not text. A test that reads a component's source and asserts
  substrings is not a test; it is a snapshot of the current markup and it breaks
  on every refactor. The only source-reading tests that stay are the
  cross-cutting design contracts under `frontend/*/src/styles`.
- No mocks where the real implementation can run. Fixtures live next to the
  tests that use them.
- New backend tests go in the `backend/cli/test/<area>` directory whose shard
  they belong to (`tooling/repo/test-shards.ts` balances by directory).

### Changes that need a matching update

- `backend/cli/src/server` → run `./tooling/repo/generate.ts` and commit `tooling/sdk`.
- User-visible behaviour → a line under `Unreleased` in `CHANGELOG.md` and, when
  it changes how something is used, the page in `frontend/docs`.
- A new skill, connector, tool, or plugin → the guide in `docs/notes/adding-*.md`
  or `writing-a-plugin.md` says what else must change.
- Never edit package versions in a PR; `publish.yml` bumps them.

## Releases

Stable releases are cut from `main` by the `publish` workflow after a green
release rehearsal at the same commit; see `docs/notes/release-process.md`.
Once npm packages for a version are staged, only release infrastructure may
change before publish, or the resume refuses the drift.
