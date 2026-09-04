# Contributing to OpenScience

Thanks for your interest in contributing. These changes are the most likely to be merged:

- Bug fixes
- New or repaired bundled skills and scientific connectors
- New LSPs and formatters
- Better model performance
- Support for new providers
- Fixes for environment-specific quirks
- Missing standard behavior
- Documentation improvements

Any UI or core product feature should go through a design discussion with the maintainers before you build it. If you are not sure whether a change would be accepted, ask in an issue or look for issues labeled [`help wanted`](https://github.com/synthetic-sciences/OpenScience/issues?q=is%3Aissue+state%3Aopen+label%3A%22help+wanted%22), [`good first issue`](https://github.com/synthetic-sciences/OpenScience/issues?q=is%3Aissue+state%3Aopen+label%3A%22good+first+issue%22), or [`bug`](https://github.com/synthetic-sciences/OpenScience/issues?q=is%3Aissue+state%3Aopen+label%3Abug).

## Prerequisites

- **Bun 1.3.14**, the `packageManager` pin in `package.json`. Any `bun@^1.3.14` runs the repo (`bun run setup` warns when you drift), but CI and release builds use the exact pin.
- **Node 18 or newer.** The release entrypoints, `backend/cli`'s preinstall script, the `npx synsci` launcher, and the desktop shell are Node scripts.
- **gitleaks.** The pre-commit hook (`.husky/pre-commit`) runs `gitleaks git --pre-commit --staged`; without the binary every commit fails with `command not found`. Install it from [github.com/gitleaks/gitleaks](https://github.com/gitleaks/gitleaks#installing). CI runs the same scan on pushes.
- **Playwright** (optional) for the browser E2E suite: `bunx playwright install`.

## Setup

```bash
git clone https://github.com/synthetic-sciences/OpenScience.git
cd OpenScience
bun run setup
```

`bun run setup` verifies your Bun version, warns if `gitleaks` or `node` are missing, runs `bun install --frozen-lockfile`, downloads the models.dev catalog snapshot, and builds the workspace UI into the gitignored manifest that `bun dev` serves. Rerun it with `--web` to rebuild the embedded UI after workspace changes, or `--skip-web` to skip the build.

Always install with the frozen lockfile (`bun run setup` or `bun install --frozen-lockfile`). Pull requests that churn `bun.lock` without a dependency change will be asked to revert it.

## Running from source

`bun dev` is the local equivalent of the built `openscience` command. Every subcommand works the same way in both:

```bash
bun dev --help          # list commands
bun dev serve           # headless API server (port 4096, then 4097, then a random port)
bun dev web             # start the server and open the workspace (the default command)
bun dev <directory>     # open the workspace in a specific project (absolute path)
bun dev "$PWD"          # run in this checkout
```

With no directory, `bun dev` runs in `backend/cli` (the root script passes `--cwd backend/cli`), so the agent treats `backend/cli` as its project and reads `backend/cli/AGENTS.md`. That file is the agent's ML-workflow instructions for that demo project, not guidance for repo contributors; the repo style guide is the root [AGENTS.md](./AGENTS.md). Relative paths resolve from `backend/cli` too — `bun dev .` lands there, not in the repo root — so pass an absolute path such as `bun dev "$PWD"` to run in this checkout.

### Two dev loops

**Live UI (edit the workspace with hot reload).** Run the API server and the Vite dev server in two terminals:

```bash
bun dev serve        # terminal 1: API on http://localhost:4096
bun run dev:ui       # terminal 2: workspace on http://localhost:3000
```

The workspace dev build talks to port 4096. If another OpenScience is already listening there, `bun dev serve` silently lands on 4097 and the UI talks to the wrong process; either stop the other instance or point the UI at the right port with `VITE_OPENSCIENCE_SERVER_PORT=4097 bun run dev:ui` (`VITE_OPENSCIENCE_SERVER_HOST` and `VITE_OPENSCIENCE_SERVER_URL` are also honored).

**Packaged-like (what users get).** `bun run setup` embeds a production build of the workspace, and `bun dev` serves it exactly like the binary does. Rerun `bun run setup --web` to pick up UI changes.

### Provider keys in dev

Repository `.env` files are intentionally ignored: the root `dev` script runs Bun with `--no-env-file`, and `backend/cli/src/openscience/preload-env.ts` scrubs project dotenv values so a checked-out project can never inject credentials into the agent. Supply a key the way users do:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # shell environment
bun dev keys add                      # or store it in the local credential store
```

The Credentials panel in the workspace works too. Keys live under `~/.openscience/` and never in the repo.

### Generated files

Three gitignored files matter. None of them is needed for the test suite (`backend/cli/test/preload.ts` seeds a fixture catalog and sets `OPENSCIENCE_DISABLE_MODELS_FETCH`).

| File                                          | Produced by                                                                                               | Needed for                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `backend/cli/src/web/assets.generated.ts`     | `bun run setup` (`frontend/workspace` build + `backend/cli/script/generate-web-assets.ts`), release build | Serving the workspace from `bun dev` / `openscience web`. Missing: every UI route 404s.                          |
| `backend/cli/src/provider/models-snapshot.ts` | `bun run setup` (models.dev download), `backend/cli/script/build.ts`                                      | Offline model catalog. The runtime falls back cache → snapshot → live fetch, so it only matters without network. |
| `backend/cli/src/skill/bundled.generated.ts`  | `backend/cli/script/generate-skill-bundle.ts` during `backend/cli/script/build.ts`                        | Release binaries only. Dev reads `backend/cli/skills/` directly.                                                 |

`frontend/workspace/dist/` is the intermediate Vite output that the asset manifest imports.

### Useful environment variables

| Variable                           | Effect                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `OPENSCIENCE_CONFIG_DIR`           | Config directory (default `~/.config/openscience`). Use a scratch dir to keep dev separate. |
| `OPENSCIENCE_DATA_DIR`             | Data root (default `~/.openscience`).                                                       |
| `OPENSCIENCE_DISABLE_MODELS_FETCH` | Never fetch models.dev; use the cache or snapshot.                                          |
| `OPENSCIENCE_DISABLE_LSP_DOWNLOAD` | Skip language-server downloads for faster cold starts.                                      |
| `OPENSCIENCE_DISABLED_SKILLS`      | Comma-separated skill names to hide from every source.                                      |
| `OPENSCIENCE_PUSH_CHECKS`          | `1` makes the pre-push hook run the Bun version check and `bun typecheck`.                  |
| `VITE_OPENSCIENCE_SERVER_PORT`     | Port the workspace dev build calls (default 4096).                                          |

## Tests

Backend tests live in `backend/cli/test` and run with Bun's test runner. Always start them through the `test` script, which adds `--timeout 15000`; bare `bun test` uses Bun's 5 s default and fails spuriously, and Bun ignores a `timeout` key in `bunfig.toml`, so pass the flag yourself when you run a subset:

```bash
bun run --cwd backend/cli test                        # full backend suite
cd backend/cli
bun test --timeout 15000 ./test/skill/skill.test.ts   # one file
bun test --timeout 15000 ./test/skill                 # one directory
bun test --timeout 15000 -t "resolves"                # cases whose name matches
bun test --timeout 15000 --watch ./test/skill         # rerun on change
```

The full backend suite is long (Deep CI budgets 45 minutes for the whole Linux job), so run the directories you touched while iterating and the full suite before you push. Bare `bun test` at the repo root fails immediately on purpose (`bunfig.toml` points `test.root` at a nonexistent directory, so Bun exits 1 without scanning anything); always run per package.

Other suites:

```bash
bun run test:ui                              # frontend/ui unit tests (~8 s)
bun run test:sdk                             # tooling/sdk/js unit tests (<1 s)
cd frontend/workspace && bun test            # workspace unit tests (happy-dom); has known failures on main and is not a gate yet
bun run --cwd frontend/workspace test:e2e    # Playwright E2E; run `bunx playwright install` first
```

See [frontend/workspace/README.md](frontend/workspace/README.md) for the E2E options. Two backend tests are gated behind environment variables and skipped by default: `OPENSCIENCE_LIVE_CATALOG=1` enables the live models.dev check in `test/provider/live-catalog.test.ts` (the only test that touches the network), and `OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST=1` exposes the thin `researchagent-test` profile used by `evals/cadence-harness`.

## Checks and hooks

Before pushing, run the same gates CI enforces:

```bash
bun run check         # format:check + typecheck + backend, frontend/ui, and SDK tests
bun run check:fast    # format:check + backend typecheck only, for the inner loop
```

The individual gates are `bun run format:check` (Prettier, `printWidth: 120`), `bun run typecheck` (TypeScript across every workspace: tsgo, or `tsc --noEmit` in tooling/util and frontend/docs; `turbo typecheck --filter=@synsci/openscience` for the backend only), `bun run --cwd backend/cli test`, `bun run test:ui`, and `bun run test:sdk`. Run `bun run format` to fix formatting. There is no linter; the style rules in [AGENTS.md](./AGENTS.md) are enforced in review.

Fast CI (`.github/workflows/ci.yml`) runs on every pull request and checks formatting, typecheck, the workspace build, and a syntax smoke of the release entrypoints. The backend suite, docs build, landing build, and workflow lint run in Deep CI (`.github/workflows/deep-ci.yml`) nightly and on manual dispatch, so a green pull request does not prove the tests pass — run them locally. [docs/notes/verification.md](docs/notes/verification.md) has the full list.

Two git hooks are installed by `bun install` (husky):

- `pre-commit` runs gitleaks on the staged changes.
- `pre-push` is opt-in: `OPENSCIENCE_PUSH_CHECKS=1 git push` runs the Bun version check and `bun typecheck` first.

### Building a standalone binary

```bash
./backend/cli/script/build.ts --single
./backend/cli/dist/@synsci/openscience-<platform>/bin/openscience
```

Replace `<platform>` with your platform, for example `darwin-arm64` or `linux-x64`. The build fetches models.dev, bundles the skills, builds the workspace, and compiles the binary.

## Where things live

- `backend/cli`: the CLI, server, agent runtime, tools, scientific connectors, and the bundled skill library (`skills/`).
- `frontend/workspace`: the workspace UI, written in SolidJS and embedded into the CLI.
- `frontend/desktop`: the Electron shell that wraps the packaged runtime (packaging notes in its README).
- `frontend/ui`: shared UI components and themes.
- `frontend/docs`: the documentation site (Vite + React, MDX content).
- `frontend/landing`: the marketing site for [openscience.sh](https://openscience.sh); it has its own lockfile.
- `tooling/sdk/js`: the TypeScript SDK, generated from the server's OpenAPI contract.
- `tooling/plugin`: the source for `@synsci/plugin`.
- `tooling/launcher`: the `npx synsci` installer.
- `tooling/repo`: repo automation — `setup.ts`, `generate.ts` (SDK regeneration), and the release scripts.
- `tooling/script`, `tooling/util`, `tooling/patches`: the build helper, shared utilities, and dependency patches applied at install time.
- `evals/`: launch evals and the cadence dev lab used to evaluate the research harness.
- `docs/`: engineering notes (`docs/notes`), ADRs, specs, and historical plans.
- `.openscience/`: repo-local agent config used when you run `bun dev "$PWD"` from this checkout — custom commands, a skill, and a theme.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.

## Extending OpenScience

Most external contributions add one of these. Each guide lists the contract, where the file goes, and which tests to run:

- [Adding a bundled skill](docs/notes/adding-a-skill.md)
- [Adding a scientific connector](docs/notes/adding-a-connector.md)
- [Adding a tool](docs/notes/adding-a-tool.md)
- [Writing a plugin](docs/notes/writing-a-plugin.md)

If you change the server API (anything under `backend/cli/src/server`), run `./tooling/repo/generate.ts` and commit the regenerated `tooling/sdk` output in the same pull request.

### Working on the docs or landing site

The documentation site is `frontend/docs` and the marketing site is `frontend/landing`. Run either with its dev server:

```bash
bun run --cwd frontend/docs dev
cd frontend/landing && bun install --frozen-lockfile && bun run dev
```

Docs pages live under `frontend/docs/src/content/openscience/` as MDX; keep them plain-markdown — the MDX parser is deprecated and those files are excluded from Prettier. When a change alters user-visible behavior, update the matching docs page in the same pull request.

Please follow the [style guide](./AGENTS.md).

## Pull requests

### Link an issue

Reference the issue your change addresses with `Fixes #123` or `Closes #123`. Small fixes — typos, documentation, a broken skill script, a connector that stopped parsing — do not need an issue first; say "small fix, no issue" in the description. Anything that adds behavior or changes the UI should start as an issue so the design can be agreed before you build it.

### Keep it small

- Keep pull requests small and focused.
- Explain the problem and why your change fixes it.
- Check that the behavior does not already exist elsewhere before adding it.
- Do not bump versions. `package.json` versions and git tags are written by the release workflow.
- Add a bullet under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) when the change is user-visible.

### Show your work

For UI changes, include before-and-after screenshots or a short video. For logic changes, say how you verified the change: what you tested, and how a reviewer can reproduce the result.

### Write it yourself

Write short descriptions in your own words. Long generated walls of text in issues and pull requests may be ignored. If you cannot explain a change briefly, it may be too large.

### Pull request titles

Follow conventional commits, with an optional scope:

- `feat:` a new feature
- `fix:` a bug fix
- `docs:` documentation changes
- `chore:` maintenance and dependency updates
- `refactor:` refactoring with no behavior change
- `test:` tests
- `ci:` CI and release workflow changes

Examples: `docs: update contributing guide`, `fix: resolve crash on startup`, `feat(app): add dark mode`. Release notes are generated from these prefixes, so `feat`, `fix`, `docs`, `refactor`, and `perf` commits show up in the changelog while `chore`, `test`, and `ci` do not.

### Style

These are guidelines, not hard rules:

- Keep logic in one function unless splitting it adds real reuse.
- Avoid unnecessary destructuring.
- Avoid `else`.
- Prefer `.catch(...)` over `try`/`catch` where it reads well.
- Use precise types and avoid `any`.
- Prefer immutable values and avoid `let`.
- Choose concise, descriptive names.
- Use Bun helpers such as `Bun.file()` when they fit.

## Releases and versioning

Versions and tags are produced by the release workflow, never by hand. A maintainer dispatches `.github/workflows/publish.yml` from a green `main` commit (`gh workflow run publish.yml --ref main -f bump=patch`, or `minor` / `major`); it computes the next version, commits `release: vX.Y.Z`, tags it, and publishes the npm packages, binaries, and desktop installers. Do not edit any `package.json` `version` field in a pull request, and do not open version-bump pull requests.

`CHANGELOG.md` has one **Unreleased** section. Add a bullet there in the same pull request when your change is user-visible (a new skill or connector, a behavior change, a fix a user would notice); skip it for refactors, tests, and CI. Release notes are generated from commit messages by `tooling/repo/changelog.ts` and the maintainer curates the changelog from both at release time, so the bullet only needs to say what changed for the user.

The full procedure, including the rehearsal workflow, the packaged canaries, and signing requirements, is in [docs/notes/release-process.md](docs/notes/release-process.md); [docs/notes/verification.md](docs/notes/verification.md) lists the gates a release commit must pass.

## Finding something to work on

Labels mean something specific here:

- `good first issue`: scoped to one file or directory, has a reproduction or the expected diff, names a reviewer, and needs no design decision. If you take one, comment on the issue so nobody duplicates the work.
- `help wanted`: maintainers agree the change belongs but will not schedule it themselves. Larger than a first issue; ask in the thread before starting if the approach is not spelled out.
- `needs-triage`: applied by the issue templates; a maintainer replaces it with an `area:*` label (`area:backend`, `area:workspace`, `area:skills`, `area:connectors`, `area:desktop`, `area:release`, `area:docs`) and, where it fits, one of the two labels above. Triage happens weekly.
- `pinned`, `security`, `on-hold`, `enhancement`, `good first issue`, and `help wanted` are exempt from the stale bot; everything else closes after 90 days without activity and can be reopened.

## Feature requests

For new functionality, start with a design conversation. Open an issue describing the problem, an optional proposed approach, and why it belongs in OpenScience. Wait for maintainer agreement before opening a feature pull request.
