# Product experience and runtime release plan

Status values are `todo`, `active`, `verified`, and `blocked`.

This plan is the release authority for the product-quality work requested on
2026-08-29. It starts from Aayam's exact `origin/main` commit
`284137c76bd4f3a555d9a2b29f1ef478dba33e36`. Before every merge and release,
the branch must fetch and incorporate any newer Aayam commits without dropping
their wallet, signing, notarization, or draft-release behavior.

The work is intentionally split into independently reviewable slices. A visible
control is complete only when it has a backend transition, durable/recoverable
state, truthful failure copy, and behavior tests. Marketing labels must
distinguish governed integrations, credential/CLI bridges, and stored
credentials.

## Product principles

- Reach a useful composer in under 60 seconds on a clean install.
- Show a visible response within 400 ms. Never use a blank loading surface.
- Prefer progressive disclosure: one recommended action first, advanced setup
  later in Customize.
- Use no ornamental entrance motion. Use determinate, linear motion only for
  real progress and honor reduced-motion preferences.
- Use at least 32 px interaction targets and 44 px for primary touch actions.
- Ask for authority at the real side-effect boundary. Independence never
  bypasses permissions.
- Preserve the user's working app, sessions, drafts, files, and purchased Wallet
  through failure, update, relocation, and restart.
- Do not call a capability verified merely because a credential is present.

## Release baseline and invariants

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| SYNC-01 | Branch contains the latest Aayam main before each landing | active | ancestry and exact-head check |
| SYNC-02 | Preserve `managedUnlocked` onboarding and Wallet routing | todo | mounted onboarding and billing tests |
| REL-01 | Modal token-free SDK prewarm lands from PR #431 | active | 93 focused tests and terminal PR CI |
| REL-02 | Production publisher can create the release commit and tag when workflows changed | blocked | latest run 33255944525 permission failure |
| REL-03 | Signed/notarized macOS artifacts remain required | active | latest run signed/notarized successfully |
| REL-04 | Do not reuse partially staged `2.0.54`; release the integrated tree as the next free version | todo | npm/tag/release preflight |
| REL-05 | Atlas Nia retirement and Firecrawl hardening deploy from exact green SHA | todo | Atlas preflight, one bounded search, zero new Nia rows |

## Execution order

### 1. Harness settlement and recoverability

| ID | Outcome | Status | Required evidence |
| --- | --- | --- | --- |
| HAR-01 | Active Task assignments remain byte-exact and executable prompts reject compaction markers | active | long six-artifact assignment regression |
| HAR-02 | `content-filter` with no textual handoff is retryable even after tools ran | todo | processor snapshot and restart tests |
| HAR-03 | Managed-search pending/unavailable is a typed partial outcome with a durable operation ID | todo | 503/pending/reconciliation tests |
| HAR-04 | Task never reports Completed for tool-only/partial/provider-filtered child work | todo | full long-task settlement regression |

Implementation notes:

- Generic historical message rendering may stay compact, but the Task input used
  to create a child must never be reconstructed from a 200-character display
  projection.
- Provider retry cannot blindly replay side effects. Reconcile pending search by
  session plus canonical request signature and reuse its operation ID.
- Persist a structured child result containing finish reason, textual handoff,
  partial tool count, changed-file count, and retryability.

### 2. Permission and independence contracts

| ID | Outcome | Status | Required evidence |
| --- | --- | --- | --- |
| PERM-01 | `Ask always`, `Ask risky`, and `Full access` are execution-time authority floors | todo | exhaustive tool x mode matrix |
| PERM-02 | Standing/session/config grants cannot weaken the selected floor | todo | override, child, and migration tests |
| PERM-03 | New permission kinds default to ask/deny, never allow | todo | registry exhaustiveness test |
| PERM-04 | UI shows requested and effective mode without coercing users to Full | todo | mounted managed-policy and sandbox tests |
| DEC-01 | Interactive pauses at consequential decisions and recommends one option | todo | fake-model behavioral trace |
| DEC-02 | Balanced decides reversible matters and asks only on consequential ambiguity | todo | fake-model behavioral trace |
| DEC-03 | Independent takes the recommended reversible path, records assumptions, and asks only for missing authority/input | todo | fake-model behavioral trace |

The decision request contract is
`{ recommendation, options, impact, blocking }`. Each turn snapshots its mode;
changing a global preference cannot mutate a turn already in flight.

### 3. Skills, slash menu, and undo

| ID | Outcome | Status | Required evidence |
| --- | --- | --- | --- |
| SKILL-01 | One permission-filtered catalog backs system prompt, Skill tool, settings, and slash | todo | denied-skill boundary tests |
| SKILL-02 | Empty `/` shows native commands plus recent/pinned/recommended skills only | todo | row cap and <400 ms open test |
| SKILL-03 | Queries show the best 8-12 results and Browse all opens the library | todo | ranking, keyboard, IME, and mobile tests |
| SKILL-04 | UI distinguishes Library, Allowed, Recommended/Recent, and Loaded this turn | todo | mounted state tests |
| UNDO-01 | Undo/redo restores the exact target tree, including deletions and renames | todo | file-mode/symlink/untracked/failure tests |
| UNDO-02 | Undo reports a structured preview and cannot double-submit | todo | mounted transaction tests |

OpenScience already lazily loads Skill contents. Preserve that foundation and
remove the UI behavior that renders all installed skills in the empty slash
menu.

### 4. First-run activation and brand system

| ID | Outcome | Status | Required evidence |
| --- | --- | --- | --- |
| ONB-01 | Branded, nonblank status appears within 400 ms | todo | slow-preference mounted test |
| ONB-02 | Account -> recommended Open a folder -> composer in under 60 seconds | todo | packaged clean-root walkthrough |
| ONB-03 | Blank project remains a secondary path and provider setup is progressive | todo | keyboard and restart tests |
| ONB-04 | BYOK credential and billing-mode change are transactional | todo | failure rollback and double-submit tests |
| BRAND-01 | One canonical OpenScience mark serves onboarding, shell, splash, notification, docs, and landing | todo | generated asset/visual coverage |
| BRAND-02 | Every compute/credential/MCP catalog entry has an audited local logo | todo | catalog exhaustiveness test |

### 5. Desktop update and storage

| ID | Outcome | Status | Required evidence |
| --- | --- | --- | --- |
| UPD-01 | One persisted UpdateController backs banner and Settings | todo | state-machine and crash/restart tests |
| UPD-02 | Background ZIP stage exposes bytes/progress/cancel and never surprise-restarts | todo | network/full-disk/cancel tests |
| UPD-03 | Apply waits for active work, preserves drafts, and uses explicit Restart to update | todo | active-run packaged test |
| UPD-04 | Update validates version, bundle, GitHub digest, signing team/designated requirement, and Gatekeeper | todo | wrong-signer/downgrade/tamper tests |
| UPD-05 | Old bundle remains until new-version health handshake; failure rolls back and relaunches | todo | helper crash/launch failure test |
| UPD-06 | macOS in-app update is truthful; Windows/Linux show honest manual fallback until a complete updater exists | todo | platform behavior tests |
| STORE-01 | Retry bypasses storage scan error TTL | todo | immediate retry behavior test |
| STORE-02 | Relocation preflights free space and reports drain/copy/verify/switch phases | todo | ENOSPC/crash/active-writer tests |
| STORE-03 | UI truthfully separates data, config, cache, state, and safety copies | todo | mounted copy/reveal/cleanup tests |

The DMG remains the first-install artifact. The macOS updater consumes the
architecture-specific ZIP. Production update artifacts must be signed and
notarized; removing quarantine is not accepted as a trust check.

### 6. Compute, SSH, GiveMeANode, MCP, and credentials

| ID | Outcome | Status | Required evidence |
| --- | --- | --- | --- |
| COMP-01 | UI labels Modal/SSH as governed, GPU providers as CLI bridges, cloud/NVIDIA as credential-only | todo | catalog truth matrix |
| COMP-02 | Provider doctors report configured, valid, expired, scope-limited, unreachable, or CLI missing | todo | official-contract fixtures |
| COMP-03 | Credentials are injected only into the reviewed provider operation | todo | redaction and process-ledger tests |
| SSH-01 | Identity/agent selection, `ssh -G`, ProxyJump, and explicit host-key trust are smooth | todo | local OpenSSH fixture matrix |
| MCP-01 | OAuth tokens/client secrets migrate from plaintext to SecretBox/keychain | todo | migration and no-plaintext tests |
| MCP-02 | OAuth callback ownership, cancel, headers, and restart recovery are durable | todo | two-process local OAuth tests |
| GMAN-01 | Recommended one-click GiveMeANode connector saves, authenticates, inspects, and rolls back atomically | todo | local OAuth/connect tests |
| GMAN-02 | Governed GiveMeANode JobBroker target is idempotent, rate-aware, bounded, recoverable, and defaults to stop | todo | fake-provider lifecycle suite |

Provider truth:

- Governed today: local, SSH, Modal.
- Credential/CLI bridge: TensorPool, Lambda, Prime Intellect, Vast.ai, RunPod.
- Stored credential only: AWS, GCP, Azure, NVIDIA NIM/NGC.
- GiveMeANode stage 1 is a one-click OAuth MCP connector. Stage 2 is a typed
  JobBroker target; raw node provisioning is not delegated directly to the
  model.

Every provider contract is pinned to its official documentation. Doctors are
read-only and must not create a billable resource.

### 7. Ace billing and recovery

| ID | Outcome | Status | Required evidence |
| --- | --- | --- | --- |
| BILL-01 | Docs and UI match $0 Ace activation, purchased-only threshold, fixed $20 reload, separate fee | todo | server-constant copy contract |
| BILL-02 | 402 includes reload state/retry guidance and only pre-dispatch work auto-retries once | todo | webhook/idempotency tests |
| BILL-03 | Monthly limit includes pending/committed spend and is visible during consent | todo | concurrent hold tests |
| BILL-04 | Whole-cent legacy settlement path is unreachable/fail-closed | todo | production-caller and negative tests |
| BILL-05 | Catalog-wide maximum-cost reservations prevent unlimited under-reserve spend | todo | model/image/search invariant tests |

Wallet always means purchased balance. Promotional credits remain a separate,
expiring plan benefit. An insufficient hold must stop before provider dispatch.

### 8. Deep verification, landing, deployment, and release

1. Run focused behavior tests during each slice; run typecheck, formatting, and
   diff checks before every PR.
2. Review each slice against exact latest main and resolve Aayam overlap before
   landing.
3. Run complete backend/workspace/desktop suites, production builds, migration
   matrices, accessibility checks, and responsive browser QA.
4. Run packaged clean-root onboarding, signed macOS update/rollback, storage
   relocation, SSH, local compute, Modal, and provider-free connector doctors.
5. Run `test publish` from the exact green main and require all immutable npm,
   OS smoke, packaged E2E, and scientific capability gates.
6. Run the bounded paid Modal canary from the exact candidate. Stop on the first
   failure and confirm resource cleanup.
7. Repair the workflow-capable release identity. Release the next unused stable
   version; verify 20 exact assets, package provenance/signatures, DMG and ZIP
   identities, notarization, stable tags, website, and in-app update.
8. Deploy Atlas exact green main, verify Firecrawl policy, make one bounded
   Wallet-funded search, and prove no new Nia use. Only after the Nia-free
   backend is live, inventory and delete authorized private upstream Nia
   sources, then remove/revoke its credential.

Paid/provider actions remain fail-closed: doctors and fake-provider tests first;
one bounded canary only after every non-paid gate is green.
