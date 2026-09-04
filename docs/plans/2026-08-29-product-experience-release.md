# Product experience and runtime release plan

Status values are `verified`, `active`, and `blocked`.

This is the release authority for the product-quality work requested on
2026-08-29. “Verified” means the implementation and its local/provider-free
contract tests pass. It does not mean an external provider, signed artifact, or
production deployment was exercised unless the evidence says so explicitly.

The current branch is an exact descendant of Aayam's fetched
`origin/main` at `5ad5d6e183bd1deba79d78b35fe21cc882c0cada`. Recheck that
ancestry immediately before landing. PR #440 still points at the older
`d0b2574e` head until the local commits listed below are pushed.

## Product principles

- Reach a useful composer in under 60 seconds on a clean install.
- Show a visible response within 400 ms; never use a blank loading surface.
- Put one recommended action first and progressively disclose advanced setup.
- Ask for authority at the real side-effect boundary. Independence never
  bypasses permissions.
- Preserve sessions, drafts, files, credentials, and local settings
  through update, relocation, rollback, and restart.
- Never call a provider or tool verified merely because a credential exists.
- Keep secret-bearing provider operations behind reviewed brokers. Do not solve
  usability by exporting control-plane credentials to generic Bash or MCP.
- Distinguish local contract evidence, signed-artifact evidence, provider
  canaries, and production evidence.

## Current outcome matrix

### Harness, permissions, skills, and undo

| ID       | Outcome                                                                                                      | Status   | Evidence / remaining gate                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------- |
| HAR-01   | Active Task assignments remain byte-exact; executable compaction markers are rejected                        | verified | `68dfddbc`; long-assignment regressions                                                        |
| HAR-02   | A provider `content-filter` with no textual handoff is retryable even after tools ran                        | verified | `68dfddbc`, `906bca04`; focused content-filter suite                                           |
| HAR-03   | Managed-search pending/unavailable settles as a typed partial failure                                        | verified | `68dfddbc`; operation/reconciliation tests                                                     |
| HAR-04   | Tool-only, partial, or filtered child work never reports a misleading Completed state                        | verified | `68dfddbc`, `906bca04`; Task settlement tests                                                  |
| PERM-01  | Ask always, Ask risky, and Full access are execution-time authority floors                                   | verified | `2a8a92b4`, `15f974b8`, `a1d4d553`; permission/Bash matrices                                   |
| PERM-02  | Standing, session, and config grants cannot weaken the selected floor                                        | verified | pending-settlement and standing-approval regressions                                           |
| PERM-03  | Destructive or ambiguous shell syntax is risky; new kinds fail closed                                        | verified | `ab5e4a13`; 75 permission tests plus adversarial parser cases                                  |
| PERM-04  | UI exposes requested/effective access without coercing Full access                                           | verified | mounted managed-policy and sandbox tests                                                       |
| DEC-01   | Interactive asks on planning/consequential decisions with a recommendation first                             | verified | `3f68be07`; real two-step fake-provider trace                                                  |
| DEC-02   | Balanced resolves routine planning and asks on consequential ambiguity                                       | verified | `3f68be07`; real QuestionTool trace                                                            |
| DEC-03   | Independent selects the recommendation, records the assumption, and pauses only for missing authority/input  | verified | `3f68be07`; persisted tool outcome; permission boundary unchanged                              |
| SKILL-01 | One permission-filtered lazy catalog backs prompt, settings, and slash discovery                             | verified | `b5769137`, `15f974b8`; bundled catalog and boundary tests                                     |
| SKILL-02 | Empty `/` shows native actions plus a bounded skill shortlist                                                | verified | prompt/slash mounted and ranking tests                                                         |
| SKILL-03 | Browse all opens the real library, preserves the query/caret, and supports keyboard selection                | verified | 43 focused mounted/unit tests and production build                                             |
| UNDO-01  | Undo/restore is scoped to the transaction files and does not overwrite unrelated later edits                 | verified | scoped restore regression in `15f974b8`                                                        |
| UNDO-02  | Undo exposes a structured preview and prevents duplicate settlement                                          | verified | transaction and mounted UI tests                                                               |
| UNDO-03  | Conversation-only Undo works without Git; file restore is bound to verified parents and one filesystem mount | verified | `773f9319`, `7883b226`, `55a485a6`; non-Git browser flow plus symlink and mount race sentinels |

### First run and brand

| ID       | Outcome                                                                                  | Status   | Evidence / remaining gate                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ONB-01   | A branded nonblank first-run surface appears promptly                                    | verified | `fd0373eb`, `15f974b8`; mounted slow-preference tests                                                                                      |
| ONB-02   | Account to folder/project to composer is smooth and crash-idempotent                     | active   | durable operation binding and concurrent-window tests plus a clean disposable browser walkthrough pass; exact packaged walkthrough remains |
| ONB-03   | Recommended folder path is primary; blank project and provider setup are progressive     | verified | mounted keyboard/remount tests                                                                                                             |
| ONB-04   | BYOK credential plus billing-mode change rolls back as one server transaction on failure | verified | `aac06db4`; 86 backend/provider and 9 mounted onboarding tests                                                                             |
| BRAND-01 | One canonical OpenScience mark serves every shell/onboarding/docs surface                | active   | main product surfaces use the brand, but an exhaustive single-source asset contract is not yet proven                                      |
| BRAND-02 | Every built-in compute, credential, and MCP catalog row has a local audited mark         | verified | `15f974b8`, `bc9b21af`; exhaustive provider/catalog tests; no render-time tracking requests                                                |

### Desktop update and storage

| ID       | Outcome                                                                                                | Status   | Evidence / remaining gate                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| UPD-01   | One persisted controller backs update state, retry, cancel, and recovery UI                            | verified | controller/backend/Electron state-machine tests                                                                                  |
| UPD-02   | Architecture ZIP stages with progress/cancel and never surprise-restarts                               | verified | network, cancellation, restart-blocked, and signed-out tests                                                                     |
| UPD-03   | Apply drains admitted work and preserves the old runtime until disposal is proven                      | verified | quiescence/disposal/helper regressions                                                                                           |
| UPD-04   | Final replacement binds digest, version, inode, signer, Team ID, and notarization trust                | verified | downgrade, wrong-signer, tamper, journal-trust, and race tests                                                                   |
| UPD-05   | Health-bound activation rolls back only with exact process-tree evidence and otherwise fails closed    | verified | helper/reconciler/killpoint tests; ambiguous live-runtime crashes intentionally preserve the journal                             |
| UPD-06   | Signed macOS installs get in-app update; unsupported/unsigned/Windows/Linux show manual installer copy | verified | platform/account-gate UI and capability tests                                                                                    |
| UPD-07   | Exact immutable signed ZIP and DMG complete the real updater lifecycle before publication              | blocked  | `0c46c64c` adds the fail-closed per-arch CI canary; Developer ID/notary artifacts can only be exercised after push in release CI |
| STORE-01 | Retry bypasses stale scan failures                                                                     | verified | `e6503e0c`; immediate retry tests                                                                                                |
| STORE-02 | Relocation preflights capacity and journals copy/ready/publish/switch recovery                         | verified | ENOSPC and crash-phase tests in `15f974b8`                                                                                       |
| STORE-03 | Storage UI reports truthful phases, interruption, and safe resume                                      | verified | backend 11 pass/1 platform skip; frontend 16 pass                                                                                |
| STORE-04 | User cancellation during a synchronous relocation                                                      | active   | crash-safe resume exists; no racy fake cancel was shipped                                                                        |

### Compute, SSH, MCP, and GiveMeANode

| ID      | Outcome                                                                                                       | Status   | Evidence / remaining gate                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COMP-01 | UI truthfully distinguishes governed Modal/SSH, provider bridges, and stored cloud credentials                | verified | compute truth matrix and mounted tests                                                                                                                                     |
| COMP-02 | TensorPool, Lambda, Prime Intellect, Vast.ai, and RunPod have reviewed read-only doctor contracts             | active   | exact argv/stdin fixtures pass, but ordinary user-owned Homebrew/pip CLIs are deliberately ineligible for saved-key admission                                              |
| COMP-03 | Provider credentials enter only a pinned reviewed child and are revoked across processes                      | verified | CredentialLifecycle/process-ledger tests; `1c2d58cf` rejects PATH substitution                                                                                             |
| COMP-04 | Saved provider credentials enable governed agent list/status work without generic shell exposure              | blocked  | `657a14a3` admits only approved admin-managed immutable binaries; Lambda system curl is viable, but normal tp/prime/vastai/runpodctl installs need managed/native adapters |
| COMP-05 | Paid or mutating provider operations have typed schemas, live quote/cost approval, idempotency, and recovery  | blocked  | no generic production broker exists for all five providers; must not be simulated by Bash                                                                                  |
| SSH-01  | Literal identity files, bounded Include, ProxyJump, pinned host keys, and trusted OpenSSH executables work    | verified | local adapter/job fixtures; `1c2d58cf` pins `ssh`, `ssh-keyscan`, and `ssh-keygen`                                                                                         |
| SSH-02  | Import never executes user SSH directives while resolving aliases and effective connection fields             | verified | raw `ssh -G -F ~/.ssh/config` evaluates `Match exec`; a bounded data-only parser and broker-owned config are safer and covered by no-exec tests                            |
| MCP-01  | MCP headers/env/client secrets/OAuth authority are encrypted, authority-bound, redacted, and revocable        | verified | migration, transplant, URL/tenant binding, malformed-store, and two-process tests                                                                                          |
| MCP-02  | OAuth start/wait/cancel/callback/restart/refresh settlement is exact-flow and cross-process durable           | verified | `15f974b8`, `53f7c344`, `63c1ccee`, `abdb1eaf`, `ab5e4a13`; MCP suite green                                                                                                |
| GMAN-01 | Recommended GiveMeANode preset saves disabled, completes OAuth, inspects, and rolls back setup failures       | verified | one-click connector tests and resumable SDK contract                                                                                                                       |
| GMAN-02 | Agents receive current MCP-first operating guidance for nodes, jobs, limits, billing, recovery, and safe stop | verified | `bc9b21af`; bundled skill validation, connector UI tests, typechecks, production build                                                                                     |
| GMAN-03 | GiveMeANode is a typed native JobBroker target with durable operation receipts                                | blocked  | preview/untyped responses, no pre-submit quote or server-enforced max cost, and no authorized internal MCP seam make this unsafe to invent                                 |

Saved dashboard credentials are deliberately not inherited by Bash, Task,
notebooks, kernels, plugins, or local MCP. `provider_compute` owns reviewed
read-only account, availability, list, and status argv, but it admits a saved
key only to an executable explicitly approved in Settings whose complete path
is administrator-owned and non-writable. That safely supports system curl for
Lambda and managed enterprise installs; ordinary user-owned Homebrew, pip,
pipx, and manual CLI installs remain credential-only until OpenScience ships a
managed installer or in-process provider adapter. Paid and mutating provider
operations remain unavailable until provider-specific schemas can bind a live
quote, exact approval, idempotency, and recovery.

### Ace billing

| ID      | Outcome                                                                                        | Status   | Evidence / remaining gate                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| BILL-01 | UI/docs match $0 activation, purchased-balance threshold, fixed $20 reload, and separate fee   | verified | OpenScience copy contracts plus Atlas PR #300                                                                                     |
| BILL-02 | Authoritative 402 includes reload state/guidance and only pre-dispatch work retries once       | verified | Atlas PR #300 plus OpenScience `a116bfae`; same-key replay only; a dispatched body is never re-sent automatically (v2.0.69)       |
| BILL-03 | Monthly limits include pending and committed spend                                             | verified | Atlas real-Postgres concurrent hold tests                                                                                         |
| BILL-04 | Legacy whole-cent settlement is unreachable                                                    | verified | Atlas microusd-only API and negative signature/caller invariants                                                                  |
| BILL-05 | Curated chat, image, and search reservations are exhaustively bounded                          | verified | Atlas catalog parity/reservation suite                                                                                            |
| BILL-06 | Exact Atlas billing commit is merged, deployed, and passes Stripe/provider production canaries | blocked  | PR #300 is green and mergeable (1,504 real-Postgres backend tests) but is not merged/deployed; no paid or Stripe mutation was run |

### Tools and live-provider truth

| ID      | Outcome                                                                              | Status   | Evidence / remaining gate                                                                                                        |
| ------- | ------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| TOOL-01 | All 312 bundled skills parse and validate; slash/settings use the same lazy catalog  | verified | bundled skill contract and workspace build                                                                                       |
| TOOL-02 | Local/provider-free tool contracts, permission boundaries, and redaction suites pass | verified | focused suites across MCP, compute, storage, updater, permissions, onboarding, and Fable                                         |
| TOOL-03 | Every external tool/provider works against a live production account                 | blocked  | credentials and paid calls are intentionally not inferred; only bounded canaries after non-paid gates and explicit cost approval |

## Completed local commits awaiting push

- `ab5e4a13` — harden MCP identifiers and shell target parsing.
- `0c46c64c` — require the signed/notarized desktop lifecycle.
- `aac06db4` — transactional onboarding credential rollback.
- `906bca04` — filtered Task settlement failure copy.
- `a116bfae` — bounded pending-Ace retry.
- `1c2d58cf` — pin secret-bearing host executables.
- `3f68be07` — behavioral independence traces.
- `a1d4d553` — permission and credential CI contracts.
- `bc9b21af` — GiveMeANode agent guidance and local connector marks.
- `6a6676bc` — bind GiveMeANode MCP compute to the actual preview contract.
- `c24389f9` — broker saved provider credentials for governed reads.
- `20fb8836` — prove SSH import remains data-only and never evaluates user commands.
- `1eb2e353`, `6d2927c5` — make OpenAPI generation repeatable and regenerate the SDK contract.
- `331cec0c`, `74ec56bb`, `467b2f0e` — isolate revoker, authority-fingerprint, and redaction/listener tests.
- `b9879123`, `773f9319`, `73fbc990` — fix theme contrast, non-Git Undo, and controlled-model preference loops found in browser QA.
- `7883b226`, `c636bb63`, `55a485a6` — bind snapshot mutation to directory handles and reject mount traversal.
- `49ea37fe`, `657a14a3` — scrub removal tombstones, serialize credential save/delete, and fail closed on mutable executables.

## Landing and release gates

| Gate                                               | Status   | Acceptance                                                                                                                                                                                                                                       |
| -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Latest Aayam sync                                  | verified | fetched `origin/main` is an ancestor of local HEAD                                                                                                                                                                                               |
| OpenScience local tests/typechecks/builds          | active   | exact-head aggregate reached 3,245 pass / 23 skip; four peak-disk reserve failures pass 68/68 focused and real SSH passes 2/2 focused; typecheck, format, backend build, and workspace build are green; fresh CI must supply the clean aggregate |
| Push PR #440 and rerun Test/CodeQL on the new head | active   | old red checks are against `d0b2574e`, not the local fixes                                                                                                                                                                                       |
| Atlas PR #300 CI                                   | verified | all five checks green; backend used real pgvector Postgres, 1,504 passed                                                                                                                                                                         |
| Merge Atlas PR #300                                | blocked  | requires review/landing authority                                                                                                                                                                                                                |
| Merge OpenScience PR #440                          | blocked  | requires new-head CI, final review, and explicit merge confirmation                                                                                                                                                                              |
| Signed/notarized exact ZIP+DMG updater canary      | blocked  | runs only in release CI with Developer ID/notary artifacts and a prior signed baseline                                                                                                                                                           |
| Packaged clean-root onboarding/storage/browser QA  | active   | disposable source browser QA is green for onboarding, updates, Undo/redo, slash/skills, Compute, and GiveMeANode; packaged walkthrough remains                                                                                                   |
| Paid Modal/GiveMeANode/Atlas/Stripe canaries       | blocked  | require explicit cost/production approval after non-paid gates                                                                                                                                                                                   |
| Deploy and stable release                          | blocked  | neither PR is landed; next unused version/tag/assets must be rechecked immediately before release                                                                                                                                                |

## Execution order from here

1. Keep GMAN-03, user-owned credential-bearing provider CLIs, and generic paid
   provider mutation blocked until OpenScience has managed/native adapters and
   each paid provider exposes a stable, pre-authorizable cost contract with a
   durable operation seam.
2. Push PR #440 normally and require fresh Test, CodeQL, workflow lint, platform
   ownership, migration, build, and preview checks on the exact head.
3. Complete a fresh pre-landing review and packaged clean-root UI walkthrough.
4. Obtain explicit confirmation before merging OpenScience or Atlas.
5. Run the exact signed/notarized desktop artifact canary from the immutable
   release candidate.
6. With explicit cost and production approval, run one bounded Modal,
   GiveMeANode, Atlas managed-call, and Stripe/Ace canary with cleanup evidence.
7. Release the next unused stable version, verify every immutable asset,
   notarization/signature/provenance, website, and in-app update behavior.

No merge, deployment, paid provider call, Stripe mutation, or stable release is
complete at this snapshot.
