# Local verification

Before pushing to `main` (or opening a PR), run the same gates CI enforces, so a
red build never reaches the default branch.

```bash
bun run typecheck                        # all workspaces (tsgo), matches CI "Typecheck"
bun run format:check                     # matches CI "Format"
bun run --cwd frontend/workspace build   # first half of CI "Build (web)"
bun run --cwd frontend/docs build        # second half of CI "Build (web)"
bun run --cwd backend/cli script/generate-web-assets.ts
bun test --cwd backend/cli               # CLI unit + integration suite, matches CI "Test"
```

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
main-only `test publish` workflow with packaged E2E and OS smoke enabled. The
workflow also installs the exact candidate and runs all five packaged
scientific capability lifecycles on Linux x64, Linux ARM64, and macOS ARM64;
each evidence record must match the immutable source SHA compiled into that
candidate. `test` dist-tag promotion depends on all three evidence jobs.
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
- An unsigned release must retain its GitHub warning and all seven desktop
  payload checks: two macOS DMGs, two architecture-specific macOS updater ZIPs,
  one Windows EXE, and two Linux AppImages. macOS artifacts are ad-hoc signed
  but not notarized; the Windows installer is unsigned.
- Organization funding and team billing are not part of this release tree. PR
  #413 remains unmerged and must not be included in shipped-feature claims.
