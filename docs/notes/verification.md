# Local verification

Before pushing to `main` (or opening a PR), run the same gates CI enforces, so a
red build never reaches the default branch.

```bash
bun run format:check                     # Fast CI "Format"
bun run typecheck                        # all workspaces (tsgo), Fast CI "Typecheck"
bun run --cwd frontend/workspace build   # Fast CI "Build (web)"
bun run --cwd backend/cli script/generate-web-assets.ts
bun run --cwd frontend/docs build        # Deep CI only
bun run test:ui                          # Fast CI shared UI unit tests
bun run test:workspace                   # Fast CI workspace unit tests
bun run test:sdk                         # Fast CI SDK unit tests
bun run --cwd backend/cli test           # full CLI unit + integration suite
```

Fast CI (`.github/workflows/ci.yml`) runs on every pull request. It checks
formatting, monorepo types, release-entrypoint syntax, the workspace build,
all UI/workspace/SDK unit tests, and affected backend tests selected by
`tooling/repo/test-shards.ts`. The full backend suite and native platform,
docs/landing, and workflow checks run in Deep CI
(`.github/workflows/deep-ci.yml`, nightly and on manual dispatch). Cross-cutting
changes still need that full suite; a green affected-test selection is not
full-release evidence. Start backend tests through the `test` script: it passes
`--timeout 15000`, and bare `bun test` fails spuriously at Bun's 5 s default.

The landing site has its own lockfile and is not a root-workspace package:

```bash
(
  cd frontend/landing
  bun install --frozen-lockfile
  bunx tsc -b
  bun run build
)
```

Before a production release, also run the launcher and release-script smoke
checks from `.github/workflows/ci.yml`. After the candidate lands, dispatch the
main-only `test publish` workflow with packaged E2E, OS smoke, and scientific
canary inputs enabled. The
workflow also installs the exact candidate and runs all five packaged
scientific capability lifecycles on Linux x64, Linux ARM64, and macOS ARM64;
each evidence record must match the immutable source SHA compiled into that
candidate. `test` dist-tag promotion depends on all fifteen capability/OS evidence jobs.
Production publishing also verifies the exact-source run and every required
job through the GitHub Actions API; disabled or skipped candidate gates fail
closed. When Modal is an advertised backend, also install the exact candidate
in an isolated release-operator root and run
`openscience debug capability-canary --all --target modal
--acknowledge-remote-cost`; retain the JSON report. The migration matrix, Windows Job
Object tests, macOS responsibility tests, Linux bubblewrap/OpenSSH integration,
and workflow lint run on their native CI platforms; the exact `main` commit
being released must be green there. The nightly/manual Playwright E2E workflow
is not a required push check, but run it for changes to packaged browser flows.

Notes:

- `.mdx` documentation pages are intentionally excluded from prettier (its MDX
  parser is deprecated and can mangle JSX-in-markdown). Keep them plain-markdown
  and let the docs build validate them.
- The model catalog is fixtured in tests, so the suite is deterministic and runs
  offline; a nightly job checks the live catalog for delistings separately.
- Synthetic Sciences account routes degrade gracefully when signed out or
  offline — exercise both states when touching them.

## Release-specific evidence boundaries

- Native DeepSeek direct-BYOK routing and strict tool-schema normalization have
  deterministic contract coverage. A live official-API canary has not yet been
  recorded, so release claims must not describe that route as live-verified.
- The scientific capability registry contains 54 truthful inventory entries.
  Five experimental Python capabilities have full governed local/Modal
  lifecycles and exact runtime locks; ten experimental BioNeMo capabilities
  have strict BYOK NVIDIA NIM adapters; two entries are blocked. Source-tree
  local and Modal preparation canaries do not make a released package verified:
  require matching release-artifact evidence before changing maturity or making
  a live-verified claim. No live BioNeMo provider canary is implied by offline
  tests.
- Modal concurrency is an admission limit. A start beyond capacity should fail
  visibly; autonomous waiting-queue behavior is deferred and must not appear in
  product or release copy.
- Stable releases require signed, notarized macOS DMGs and updater ZIPs; there
  is no unsigned stable macOS channel. Both architectures must retain immutable
  GitHub digests and pass their native previous-stable upgrade, packaged
  main/sidecar health, cleanup, and injected safe-rollback canaries before the
  draft is made public. The Windows installer may be unsigned only when both
  optional Windows signing secrets are absent, with an explicit release note.
- Organization-scoped workspaces shipped in PR #413. Tests must preserve the
  selected workspace, membership permissions, and purchased-Wallet boundaries;
  a passing personal-account test does not establish organization billing.
