# Contributing to OpenScience

Thank you for helping. This guide gets you from a clone to a merged pull request. The repository conventions live in [AGENTS.md](AGENTS.md), the code map in [ARCHITECTURE.md](ARCHITECTURE.md), and the deeper engineering notes in [docs/notes](docs/notes).

## What we merge

These changes are welcome and usually merge quickly:

- Bug fixes with a reproduction
- New or repaired bundled skills and scientific connectors
- New language servers and formatters
- Better model behavior: prompts, tool contracts, provider support
- Fixes for platform or environment quirks
- Documentation that matches what the software does

Anything that adds a UI surface or changes core product behavior starts as an issue so the design can be agreed before you build it. If you are unsure, ask in an issue or pick something labeled [`good first issue`](https://github.com/synthetic-sciences/OpenScience/issues?q=is%3Aissue+state%3Aopen+label%3A%22good+first+issue%22), [`help wanted`](https://github.com/synthetic-sciences/OpenScience/issues?q=is%3Aissue+state%3Aopen+label%3A%22help+wanted%22) or [`bug`](https://github.com/synthetic-sciences/OpenScience/issues?q=is%3Aissue+state%3Aopen+label%3Abug).

## Prerequisites

| Tool                                                        | Why                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bun 1.3.14** (the `packageManager` pin in `package.json`) | Any `bun@^1.3.14` runs the repo and `bun run setup` warns on drift, but CI and releases use the exact pin. Other versions produce a different install layout and the frozen lockfile fails.                          |
| **Node 18 or newer**                                        | The release entrypoints, the `preinstall` script, the `npx synsci` launcher and the desktop shell are Node scripts.                                                                                                  |
| **gitleaks**                                                | The pre-commit hook runs `gitleaks git --pre-commit --staged`. Without it every commit fails with `command not found`. Install from [github.com/gitleaks/gitleaks](https://github.com/gitleaks/gitleaks#installing). |
| **Playwright** (optional)                                   | `bunx playwright install` for the browser end-to-end suite.                                                                                                                                                          |

## Setup

```bash
git clone https://github.com/synthetic-sciences/OpenScience.git
cd OpenScience
bun run setup
```

`bun run setup` verifies your Bun version, warns if `gitleaks` or `node` are missing, runs `bun install --frozen-lockfile`, downloads the models.dev catalog snapshot, and builds the workspace UI into the gitignored manifest that `bun dev` serves. Rerun it with `--web` to rebuild the embedded UI after workspace changes, or `--skip-web` to skip the build.

Always install with the frozen lockfile. A pull request that churns `bun.lock` without a dependency change will be asked to revert it.

## Running from source

`bun dev` is the local equivalent of the built `openscience` command; every subcommand works the same way in both.

```bash
bun dev --help          # list commands
bun dev serve           # headless API server (port 4096, then 4097, then a random port)
bun dev web             # start the server and open the workspace (the default)
bun dev <directory>     # open the workspace in a project (absolute path)
bun dev "$PWD"          # run in this checkout
```

With no directory, `bun dev` runs in `backend/cli`, so the agent treats `backend/cli` as its project and reads `backend/cli/AGENTS.md`. That file is the agent's own instructions for that demo project; the repository style guide is the root [AGENTS.md](AGENTS.md). Relative paths resolve from `backend/cli` too, so pass an absolute path such as `bun dev "$PWD"` to run in this checkout.

### Two development loops

**Live UI.** Edit the workspace with hot reload by running the API server and the Vite dev server in two terminals:

```bash
bun dev serve        # terminal 1: API on http://localhost:4096
bun run dev:ui       # terminal 2: workspace on http://localhost:3000
```

The workspace dev build talks to port 4096. If another OpenScience already listens there, `bun dev serve` falls back to another port and the UI may talk to the wrong process; point it at the printed port with `VITE_OPENSCIENCE_SERVER_PORT=4097 bun run dev:ui` (`VITE_OPENSCIENCE_SERVER_HOST` and `VITE_OPENSCIENCE_SERVER_URL` are honored too).

**Packaged-like.** `bun run setup` embeds a production build of the workspace and `bun dev` serves it exactly as the binary does. Rerun `bun run setup --web` to pick up UI changes.

### Provider keys in development

Repository `.env` files are ignored on purpose: the root `dev` script runs Bun with `--no-env-file`, and `backend/cli/src/openscience/preload-env.ts` scrubs project dotenv values so a checked-out project can never inject credentials into the agent. Supply a key the way users do:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # shell environment
bun dev keys add                      # or the local credential store
```

The Credentials panel in the workspace works too. Keys live under `~/.openscience/` and never in the repository.

### Generated files

Three gitignored files matter. None is needed by the test suite; `backend/cli/test/preload.ts` seeds a fixture catalog and sets `OPENSCIENCE_DISABLE_MODELS_FETCH`.

| File                                          | Produced by                                                                                       | Needed for                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `backend/cli/src/web/assets.generated.ts`     | `bun run setup` (workspace build plus `backend/cli/script/generate-web-assets.ts`), release build | Serving the workspace from `bun dev` or `openscience web`. Missing: every UI route 404s. |
| `backend/cli/src/provider/models-snapshot.ts` | `bun run setup` (models.dev download), `backend/cli/script/build.ts`                              | Offline model catalog. The runtime falls back cache, then snapshot, then live fetch.     |
| `backend/cli/src/skill/bundled.generated.ts`  | `backend/cli/script/generate-skill-bundle.ts` during `backend/cli/script/build.ts`                | Release binaries only. Development reads `backend/cli/skills/` directly.                 |

`frontend/workspace/dist/` is the intermediate Vite output the asset manifest imports.

### Useful environment variables

| Variable                           | Effect                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `OPENSCIENCE_CONFIG_DIR`           | Config directory (default `~/.config/openscience`). Use a scratch directory to keep development separate. |
| `OPENSCIENCE_DATA_DIR`             | Data root (default `~/.openscience`).                                                                     |
| `OPENSCIENCE_DISABLE_MODELS_FETCH` | Never fetch models.dev; use the cache or snapshot.                                                        |
| `OPENSCIENCE_DISABLE_LSP_DOWNLOAD` | Skip language-server downloads for faster cold starts.                                                    |
| `OPENSCIENCE_DISABLED_SKILLS`      | Comma-separated skill names to hide from every source.                                                    |
| `OPENSCIENCE_PUSH_CHECKS`          | `1` makes the pre-push hook run the Bun version check and `bun typecheck`.                                |
| `VITE_OPENSCIENCE_SERVER_PORT`     | Port the workspace dev build calls (default 4096).                                                        |

## Tests

Backend tests live in `backend/cli/test` and run with Bun's test runner. Start them through the package script, which adds `--timeout 15000`; bare `bun test` uses Bun's 5 s default and fails spuriously, and Bun ignores a `timeout` key in `bunfig.toml`, so pass the flag yourself for a subset:

```bash
bun run --cwd backend/cli test                        # full backend suite
cd backend/cli
bun test --timeout 15000 ./test/skill/skill.test.ts   # one file
bun test --timeout 15000 ./test/skill                 # one directory
bun test --timeout 15000 -t "resolves"                # cases whose name matches
bun test --timeout 15000 --watch ./test/skill         # rerun on change
```

Bun treats a bare `test/<dir>` argument as a name filter; pass `./test/<dir>`. The full backend suite takes about ten minutes on one machine (Deep CI shards it), so run the directories you touched while iterating and let Deep CI run the rest. Bare `bun test` at the repository root fails immediately on purpose; always run per package.

Other suites:

```bash
bun run test:ui                              # frontend/ui unit tests
bun run test:sdk                             # tooling/sdk/js unit tests
bun run test:workspace                       # frontend/workspace unit tests (happy-dom)
bun run test:docs                            # frontend/docs content checks
bun run --cwd frontend/workspace test:e2e    # Playwright end-to-end; run `bunx playwright install` first
```

See [frontend/workspace/README.md](frontend/workspace/README.md) for the end-to-end options. Tests use fixture data and isolated local servers. `OPENSCIENCE_LIVE_CATALOG=1` opts into the external models.dev check in `test/provider/live-catalog.test.ts`; `OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST=1` exposes the thin `researchagent-test` profile used by `evals/cadence-harness`. Neither flag is authorization to run paid inference or remote compute.

### How to write a test here

- Test behavior, not text. A test that reads a component's source and asserts substrings is a snapshot of the current markup and breaks on every refactor. The only source-reading tests that stay are the cross-cutting design contracts under `frontend/*/src/styles`.
- No mocks where the real implementation can run. Fixtures live next to the tests that use them.
- Assert the invariant, not a number that load can move. A bound like `elapsed < 300` fails on a busy runner; `charged < wallTime - downtime` does not.
- New backend tests go in the `backend/cli/test/<area>` directory whose shard they belong to (`tooling/repo/test-shards.ts` balances by directory).

## Checks and hooks

Before pushing, run the gates CI enforces:

```bash
bun run check         # format:check + typecheck + backend, UI, workspace, SDK and docs tests
bun run check:fast    # format:check + backend typecheck only, for the inner loop
```

The individual gates are `bun run format:check` (Prettier, `printWidth: 120`), `bun run typecheck` (TypeScript across every workspace), `bun run --cwd backend/cli test`, `bun run test:ui`, `bun run test:workspace`, `bun run test:sdk` and `bun run test:docs`. `bun run format` fixes formatting. There is no linter; the style rules in [AGENTS.md](AGENTS.md) are enforced in review.

**Fast CI** (`.github/workflows/ci.yml`) runs on every pull request: formatting, typecheck, the workspace build, release-entrypoint syntax, every UI, workspace, SDK and docs unit test, and the backend tests affected by the diff (`tooling/repo/test-shards.ts`). Cross-cutting changes can affect more tests than that selection, so run the directories you touched.

**Deep CI** (`.github/workflows/deep-ci.yml`) runs the full backend suite in shards, native ownership checks on macOS and Windows, and the web and docs builds. Dispatch it on your branch when a change is broad: `gh workflow run deep-ci.yml --ref <branch>`. It takes about five minutes.

Two git hooks are installed by `bun install` through husky:

- `pre-commit` runs gitleaks on the staged changes.
- `pre-push` is opt-in: `OPENSCIENCE_PUSH_CHECKS=1 git push` runs the Bun version check and `bun typecheck` first.

### Building a standalone binary

```bash
./backend/cli/script/build.ts --single
./backend/cli/dist/@synsci/openscience-<platform>/bin/openscience
```

Replace `<platform>` with yours, for example `darwin-arm64` or `linux-x64`. The build fetches models.dev, bundles the skills, builds the workspace and compiles the binary.

## Where things live

| Path                                                | What lives there                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `backend/cli`                                       | The CLI, server, agent runtime, tools, scientific connectors and the bundled skill library (`skills/`) |
| `frontend/workspace`                                | The workspace UI (SolidJS), embedded into the CLI                                                      |
| `frontend/desktop`                                  | The Electron shell that wraps the packaged runtime (packaging notes in its README)                     |
| `frontend/ui`                                       | Shared components, themes and icons                                                                    |
| `frontend/docs`                                     | The documentation site (Vite + React, MDX content)                                                     |
| `frontend/landing`                                  | The site at [openscience.sh](https://openscience.sh); it has its own lockfile                          |
| `tooling/sdk/js`                                    | The TypeScript SDK, generated from the server's OpenAPI contract                                       |
| `tooling/plugin`                                    | The source for `@synsci/plugin`                                                                        |
| `tooling/launcher`                                  | The `npx synsci` installer                                                                             |
| `tooling/repo`                                      | Repository automation: `setup.ts`, `generate.ts` (SDK regeneration) and the release scripts            |
| `tooling/script`, `tooling/util`, `tooling/patches` | The build helper, shared utilities and dependency patches applied at install time                      |
| `evals/`                                            | Launch evals and the cadence dev lab used to evaluate the research harness                             |
| `docs/notes`, `docs/adr`                            | Engineering notes and architecture decision records                                                    |
| `.openscience/`                                     | Repo-local agent config used when you run `bun dev "$PWD"` here: custom commands, a skill and a theme  |

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.

## Extending OpenScience

Most external contributions add one of these. Each guide lists the contract, where the file goes and which tests to run:

- [Adding a bundled skill](docs/notes/adding-a-skill.md)
- [Adding a scientific connector](docs/notes/adding-a-connector.md)
- [Adding a tool](docs/notes/adding-a-tool.md)
- [Writing a plugin](docs/notes/writing-a-plugin.md)
- [Linux compatibility evidence](docs/notes/linux-compatibility.md)

### Changes that need a matching update

| If you change                                  | Also do                                                                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/cli/src/server`                       | Run `./tooling/repo/generate.ts` and commit the regenerated `tooling/sdk` output in the same pull request                                                              |
| User-visible behavior                          | Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md), and update the page in `frontend/docs/src/content/openscience/` when it changes how something is used |
| `frontend/workspace` or `frontend/ui`          | Make sure `bun run --cwd frontend/workspace build` succeeds                                                                                                            |
| `install` or `frontend/landing/public/install` | Keep the two files byte-identical                                                                                                                                      |
| A skill, connector, tool or plugin             | Follow the matching guide above; it says what else must change                                                                                                         |

### Working on the docs or landing site

```bash
bun run --cwd frontend/docs dev
cd frontend/landing && bun install --frozen-lockfile && bun run dev
```

Docs pages are MDX under `frontend/docs/src/content/openscience/`; keep them plain Markdown, since the MDX parser is deprecated and those files are excluded from Prettier. [docs/notes/documentation-map.md](docs/notes/documentation-map.md) connects product behavior to the page that documents it.

## Pull requests

**Link an issue.** Reference the issue with `Fixes #123` or `Closes #123`. Small fixes such as typos, documentation, a broken skill script or a connector that stopped parsing do not need an issue first; say "small fix, no issue" in the description. Anything that adds behavior or changes the UI starts as an issue.

**Keep it small.** One concern per pull request. Explain the problem and why your change fixes it. Check that the behavior does not already exist elsewhere before adding it.

**Show your work.** For UI changes, include before and after screenshots or a short video. For logic changes, say how you verified it: what you ran, what you observed, and how a reviewer can reproduce the result.

**Write it yourself.** Short descriptions in your own words. Long generated walls of text in issues and pull requests may be ignored. If you cannot explain a change briefly, it may be too large.

**Never bump versions.** `package.json` versions and git tags are written by the release workflow.

**Titles** follow conventional commits with an optional scope: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, for example `fix(app): resolve crash on startup` or `docs: update contributing guide`. Release notes are generated from these prefixes, so `feat`, `fix`, `docs`, `refactor` and `perf` show up in the changelog while `chore`, `test` and `ci` do not.

### Style

The full conventions are in [AGENTS.md](AGENTS.md). In short:

- Keep logic in one function unless splitting it adds real reuse.
- Avoid unnecessary destructuring; `obj.a` keeps its context.
- Prefer early returns to `else`.
- Prefer `.catch(...)` over `try`/`catch` where it reads well.
- Use precise types and never `any`.
- Prefer `const`; avoid `let` plus reassignment.
- Choose concise, descriptive names; one word when one word is precise.
- Use Bun helpers such as `Bun.file()` and `Bun.spawn` over Node equivalents.
- Comments explain why, not what.

### Review

A maintainer responds within a few working days. Review looks for correctness first, then for the invariant the tests pin, then for whether the change is the smallest one that satisfies the request. Expect questions rather than rewrites; answer them in the thread and push follow-up commits, and the reviewer squashes on merge.

## Releases and versioning

Versions and tags are produced by the release workflow, never by hand. A maintainer dispatches `.github/workflows/publish.yml` from a green `main` commit after a full rehearsal at the same commit; it computes the next version, commits `release: vX.Y.Z`, tags it and publishes the npm packages, binaries and desktop installers. Do not edit any `package.json` `version` field in a pull request, and do not open version-bump pull requests.

`CHANGELOG.md` has one **Unreleased** section. Add a bullet there in the same pull request when your change is user-visible: a new skill or connector, a behavior change, a fix a user would notice. Skip it for refactors, tests and CI. Say what changed for the user.

The full procedure, including the rehearsal workflow, the packaged canaries and signing requirements, is in [docs/notes/release-process.md](docs/notes/release-process.md); [docs/notes/verification.md](docs/notes/verification.md) lists the gates a release commit must pass.

## Finding something to work on

Labels mean something specific here:

- `good first issue`: scoped to one file or directory, has a reproduction or the expected diff, names a reviewer and needs no design decision. Comment on the issue when you take it so nobody duplicates the work.
- `help wanted`: maintainers agree the change belongs but will not schedule it themselves. Larger than a first issue; ask in the thread before starting if the approach is not spelled out.
- `needs-triage`: applied by the issue templates; a maintainer replaces it with an `area:*` label (`area:backend`, `area:workspace`, `area:skills`, `area:connectors`, `area:desktop`, `area:release`, `area:docs`) and, where it fits, one of the two labels above. Triage happens weekly.
- `pinned`, `security`, `on-hold`, `enhancement`, `good first issue` and `help wanted` are exempt from the stale bot; everything else closes after 90 days without activity and can be reopened.

## Feature requests

For new functionality, start with a design conversation. Open an issue describing the problem, an optional proposed approach and why it belongs in OpenScience. Wait for maintainer agreement before opening a feature pull request.

## Code of conduct and security

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.
