# OpenScience × Atlas — improvement sprint (Phase 0: plans)

Branch: `sprint/openscience-atlas-polish`. This directory holds one plan doc per workstream.
Each plan: **Current state · What's broken/missing · Proposed change · Risks · Acceptance criteria**.
Investigation-heavy workstreams (CI, compute, sandboxing) are findings-first.

Nothing irreversible ships without owner sign-off — **sandboxing (10) is design-only pending a go/no-go**.

## Workstreams

| #   | Workstream                     | Plan                                                       | Kind                    | Status |
| --- | ------------------------------ | ---------------------------------------------------------- | ----------------------- | ------ |
| 1   | CI + test suite hardening      | [01-ci-tests.md](01-ci-tests.md)                           | fix + investigate       | 📝     |
| 2   | Codex OAuth login              | [02-codex-oauth.md](02-codex-oauth.md)                     | fix                     | 📝     |
| 3   | Atlas account sync             | [03-atlas-sync.md](03-atlas-sync.md)                       | fix                     | 📝     |
| 4   | Onboarding → setup (browser)   | [04-onboarding-setup.md](04-onboarding-setup.md)           | feature                 | 📝     |
| 5   | UX polish                      | [05-ux-polish.md](05-ux-polish.md)                         | feature                 | 📝     |
| 6   | Compute integrations audit     | [06-compute-integrations.md](06-compute-integrations.md)   | investigate + fix       | 📝     |
| 7   | Atlas experience               | [07-atlas-experience.md](07-atlas-experience.md)           | feature                 | 📝     |
| 8   | Wallet + usage in settings     | [08-wallet-usage-settings.md](08-wallet-usage-settings.md) | feature                 | 📝     |
| 9   | arXiv fetching                 | [09-arxiv-retrieval.md](09-arxiv-retrieval.md)             | fix                     | 📝     |
| 10  | Agent sandboxing (design only) | [10-agent-sandboxing.md](10-agent-sandboxing.md)           | design — needs sign-off | 📝     |
| 11  | Reviewer agent + open ideas    | [11-reviewer-agent.md](11-reviewer-agent.md)               | prototype/spec          | 📝     |

Status: 🔎 exploring · 📝 plan drafted · 🚧 implementing · ✅ done · ⛔ blocked on owner decision.

## Landed so far (implementation)

- **Urgent hang fix** — every Atlas call (bridge + client) is now timeout-bounded, so `openscience project init` (run every session by the research prompt) and the per-command sync probe can't wedge a session for 60 min.
- **WS1 — CI determinism ✅** — tests seed a committed models.dev catalog fixture (zero network); the live delisting check moved to a nightly `catalog.yml` job. **855 pass / 0 fail**, deterministic. (Coverage — WS1-B — grows alongside each feature workstream.)
- **WS2 — Codex login 🚧** — hardened the OAuth flow (HTTP timeouts, port-in-use fallback, device-poll deadline, refresh that retries transient 5xx but only says "reconnect" on a real 4xx), clean error surfacing + headless device fallback, and made **"Sign in with ChatGPT (Codex)" a first-class option in the wizard picker** (it was previously unreachable there). Remaining: the managed-proxy P0 — the backend actually _consuming_ the pushed Codex tokens — needs the token-owner decision.

Next: WS3 (sync billing-flip + atomic writes).

## Notes at kickoff

- **CI is already green** on `main` — the previously-flaky live-catalog tests were fixed by #91/#92. Workstream 1 is now hardening + coverage on the paths this sprint touches, not firefighting.
- The settings surface already ships `Spend`, `Usage`, `Storage`, `Compute` panels with backing routes — workstream 8 is surfacing/wiring a wallet view, not building from scratch.
- **Phase 0 exploration is complete — all 11 plans are drafted.** Next: check in with the owner on sequencing + the open decisions, then implement workstream by workstream.
- Atlas managed compute: the `atlas compute:*` CLI suite (Modal sandboxes + reseller GPUs → `/api/compute/leases`) **exists in the published 0.13.2**, but OpenScience pins `@synsci/atlas@^0.5.12` — a version-alignment gap, not a missing feature (see [06](06-compute-integrations.md)).
- **No isolation exists today** — the default permission policy is `"*": "allow"`, so in-project `bash`/`edit`/`webfetch` run unprompted (see [10](10-agent-sandboxing.md), design-only, needs sign-off).
- **Open question for the owner:** whether to make real Atlas-repo changes this sprint (parallel branch + its own PR) or document them for your team, since Atlas is the production backend. Per-workstream plans flag where an Atlas-side change is required.
