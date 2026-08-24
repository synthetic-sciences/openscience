# Deferred work & owner decisions

Historical companion to `docs/plans/`. It records the 2026-07-06 sprint state
and is not a current product-offering document. Atlas distribution and managed
compute resale were subsequently retired; references below are retained only as
implementation history.

## What shipped this sprint

| WS     | Scope                                    | State                                                                                   |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| **1**  | Deterministic CI/tests                   | ✅ catalog fixture, live-fetch disabled in tests, nightly delisting check               |
| **2**  | Codex OAuth                              | ✅ hardened refresh/device/browser flows; discoverable in the auth wizard               |
| **3**  | Atlas sync correctness                   | ✅ shell-export precedence (no billing flip), atomic writes, torn-file tolerance + test |
| **4**  | Browser onboarding                       | ✅ browser Atlas login (`/account/login-key` + SetupDialog) + no-model dead-end killed  |
| **5**  | UX polish                                | ✅ transition typos + real file error states (retry on read/permission/listing failure) |
| **6**  | Historical companion version             | ✅ Version alignment completed at the time; the companion is no longer distributed    |
| **7**  | Atlas experience — **A1 unified status** | ✅ `openscience status` = connection + plan + wallet + usage + compute + companion      |
| **8**  | Wallet (backend + panel)                 | ✅ `/settings/wallet` + Wallet panel; routes verified live, UI typecheck-only           |
| **9**  | arXiv retrieval                          | ✅ throttle, PDF/error parsing, graceful degrade, 20 tests (merged)                     |
| **11** | Reviewer gate                            | ✅ Level 0 annotate-only, code-level, flag-gated (`experimental.reviewGate`)            |
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

BYOK keys live in three unreconciled stores (local Compute panel, local
Credentials panel, Atlas server-side `compute_keys_service`). No single authority,
so a key can be silently shadowed across execution contexts. **Recommendation in
the plan:** local stores authoritative for local skill runs; Atlas vault for
managed sandboxes; a labeled one-way sync. **Unblock:** owner + Atlas-team ratify
the source-of-truth rule before code moves keys around.

### WS7 A6 — name/brand pass

One platform still shows three user-facing names ("Atlas" / "Thesis" / "synsci").
The wire identifiers (`synsci` provider id, `thk_`, `THESIS_*`) are contract and
**must stay**, but the internal names leak into copy — e.g. `status` prints
`Device: synsci · …` (the device name is stamped at login). This is a broad,
low-risk copy sweep, batched separately to keep the wire contract untouched.
The Atlas-side `/cli` page rebrand already shipped in PR #188.

### Retired: managed-compute live leasing

This is no longer deferred work. OpenScience does not resell compute. Local,
SSH, scheduler, and directly connected user-owned compute remain supported.

### Codex managed-proxy (P0 from WS2)

Codex OAuth tokens are pushed to Atlas but have **zero consumers** server-side — no
managed proxy routes ChatGPT-subscription inference through them, so today the
tokens power only a status dot. **Unblock:** Atlas-team decision + route work; this
is an Atlas-repo change, not a CLI one.

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
- **WS11 Level 1/2** — the soft gate (inject findings, bounded fix-cycles) and hard
  gate (refuse to finalize on unresolved blocking findings). Level 0 (annotate) is
  the shipped, non-breaking default; promotion needs the fix-cycle loop + a seeded
  blocking-finding test. Also open from the plan's menu: wire `reviewer` into the
  `research`/`biology`/`physics` prompts (currently `ml`-only) for advisory
  coverage alongside the code gate.
- **Atlas PR #188 flag** — `backend/app/routes/cli.py:150` carries a user-facing 402
  message with the old `synsc` spelling, sitting inside the auth/billing gate. Left
  untouched to honor "don't touch billing/auth"; rebrand it in a separate pass.

## Verification posture

CLI: `bun run typecheck` clean; `bun test` (backend/cli) 882 pass / 0 fail; the
hang fix and unified `status` verified live against the real backend. The Atlas PR
is a **draft** — nothing merged there. Sandboxing (WS10) remains unshipped by
design.
