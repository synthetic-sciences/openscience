# Deferred work & owner decisions

Companion to `docs/plans/`. Records what the Atlas-polish sprint deliberately did
**not** ship, and why — so nothing silently reads as "done." Anything here needs
either an owner/Atlas-team decision or a follow-up sprint. Updated 2026-07-06.

## What shipped this sprint

| WS     | Scope                                    | State                                                                                   |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| **1**  | Deterministic CI/tests                   | ✅ catalog fixture, live-fetch disabled in tests, nightly delisting check               |
| **2**  | Codex OAuth                              | ✅ hardened refresh/device/browser flows; discoverable in the auth wizard               |
| **3**  | Atlas sync correctness                   | ✅ shell-export precedence (no billing flip), atomic writes, torn-file tolerance + test |
| **4**  | Browser onboarding                       | ✅ browser Atlas login (`/account/login-key` + SetupDialog) + no-model dead-end killed  |
| **5**  | UX polish                                | ✅ transition typos + real file error states (retry on read/permission/listing failure) |
| **6**  | Atlas companion version                  | ✅ release line updated with the retired compute and hosted-job surfaces removed        |
| **7**  | Atlas experience — **A1 unified status** | ✅ `openscience status` = connection + account + wallet + usage + companion             |
| **8**  | Wallet (backend + panel)                 | ✅ `/settings/wallet` + Wallet panel; routes verified live, UI typecheck-only           |
| **9**  | arXiv retrieval                          | ✅ throttle, PDF/error parsing, graceful degrade, 20 tests (merged)                     |
| **11** | Dedicated reviewer workflow              | Retired; exact-version provenance remains without a hidden reviewer model or gate       |
| —      | Atlas repo rebrand + sync-hash parity    | ✅ draft PR `synthetic-sciences/atlas#188`                                              |
| —      | >60-min hang fix                         | ✅ all Atlas calls timeout-bounded; verified fail-fast e2e                              |

WS4/WS5/WS8 are now merged into `sprint/openscience-atlas-polish` (PR #94). The WS8
`/settings/wallet` and WS4 `/account/login-key` routes are runtime-verified against
the live backend; the WS4/WS8 **frontend UI** (Wallet panel render, SetupDialog
click-through) is typecheck-verified but not yet exercised in a live browser
session — the one remaining verification gap.

## Deferred — needs owner sign-off

### WS10 — agent sandboxing (design-only)

`docs/plans/10-agent-sandboxing.md` is a design, not an implementation. The agent
runs tools with the user's own permissions; there is no isolation boundary.
Shipping real sandboxing (seatbelt/landlock/container per platform) changes the
security and execution model and must not be flipped on without the owner
choosing the substrate and default posture. **Unblock:** owner picks the isolation
mechanism + whether it's default-on. Left entirely as design per explicit
instruction.

### WS7 A3 — BYOK key source of truth

Resolved by the Ace PAYG transition. Compute credentials are local and are used
only for direct user-owned execution. The Gateway no longer stores compute keys,
provisions compute, or bills compute through Wallet credits.

### WS7 A6 — name/brand pass

One platform still shows three user-facing names ("Atlas" / "Thesis" / "synsci").
The wire identifiers (`synsci` provider id, `thk_`, `THESIS_*`) are contract and
**must stay**, but the internal names leak into copy — e.g. `status` prints
`Device: synsci · …` (the device name is stamped at login). This is a broad,
low-risk copy sweep, batched separately to keep the wire contract untouched.
The Atlas-side `/cli` page rebrand already shipped in PR #188.

### SSH-hosts / custom model-endpoints removal

Flagged as a possible product simplification; a removal is a product decision, not
a bug. Left as-is.

## Deferred — follow-up (no decision needed, just scope)

- **WS9 A4** — arXiv pagination past 50 (`start` param) + surfacing
  `opensearch:totalResults`. Not implemented.
- **WS9 S6** — full typed-error union (`{ kind: "rate_limited" | "malformed" |
"network"; retryAfterMs? }`) in `connectors/types.ts`. A lightweight equivalent
  shipped (arXiv throws clear messages; the tool classifies `rate_limited` vs
  `source_error`), but not the typed union.
- **WS9 A7** — allowlist `export.arxiv.org` in `settings/network.ts` (that file was
  outside the agent's allowed edit paths).
- **Former WS11 reviewer levels** — superseded by the single adaptive Research
  agent, bounded Explore/Execute delegation, immutable Result lineage, and
  append-only provenance. Do not reintroduce a hidden reviewer model or a
  completion gate under this item.
- **Atlas PR #188 flag** — `backend/app/routes/cli.py:150` carries a user-facing 402
  message with the old `synsc` spelling, sitting inside the auth/billing gate. Left
  untouched to honor "don't touch billing/auth"; rebrand it in a separate pass.

## Verification posture

CLI: `bun run typecheck` clean; `bun test` (backend/cli) 882 pass / 0 fail; the
hang fix and unified `status` verified live against the real backend. The Atlas PR
is a **draft** — nothing merged there. Sandboxing (WS10) remains unshipped by
design.
