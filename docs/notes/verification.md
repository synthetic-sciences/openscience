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
main-only `test publish` workflow with packaged E2E and OS smoke enabled, and
require it to pass before production publishing. The migration matrix, Windows Job Object
tests, macOS responsibility tests, Linux bubblewrap/OpenSSH integration, and
workflow lint run on their native CI platforms; the exact `main` commit being
released must be green there. The nightly/manual Playwright E2E workflow is not
a required push check, but run it for changes to packaged browser flows.

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
- The scientific capability registry is a six-entry experimental foundation:
  five pinned-package plans plus a blocked AlphaFold2 entry. Verify registry and
  planning tests, and do not claim hosted 54-tool parity or automatic dispatch.
- Modal concurrency is an admission limit. A start beyond capacity should fail
  visibly; autonomous waiting-queue behavior is deferred and must not appear in
  product or release copy.
- An unsigned release must retain its GitHub warning and the five desktop asset
  checks. macOS artifacts are ad-hoc signed but not notarized; the Windows
  installer is unsigned.
- Organization funding and team billing are not part of this release tree. PR
  #413 remains unmerged and must not be included in shipped-feature claims.
