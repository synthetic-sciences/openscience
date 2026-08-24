# Acceptance matrix

Status values are `todo`, `active`, `verified`, and `deferred`.

| ID      | Outcome                                                                           | Status   | Launch evidence                                        |
| ------- | --------------------------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| FLOW-00 | A new user reaches a reloadable, inspectable artifact in under five minutes       | todo     | Packaged clean-root walkthrough                        |
| NOW-00  | No fake UI or forced launch dependency                                            | active   | Visible-control audit and offline walkthrough          |
| NOW-01  | Stable session tabs and contextual work pane                                      | active   | Rapid switching, reload, keyboard, responsive tests    |
| NOW-02  | Calm Inter-based visual system                                                    | active   | Token audit and macOS/Linux screenshots                |
| NOW-03  | Minimal empty state and truthful composer                                         | active   | Draft, source, Plan/Act, Stop/Retry tests              |
| NOW-04  | Real left rail and Customize                                                      | active   | Settings round-trip and exact-result search tests      |
| NOW-05  | Per-session isolated scratch                                                      | active   | Cross-session isolation and lifecycle tests            |
| NOW-06  | One enforcing access broker                                                       | active   | Escape, revoke, Plan-mode, and network tests           |
| NOW-07  | Persistent local kernels and staged SSH Compute                                   | todo     | Restart, timeout, quota, reconnect, and staging tests  |
| NOW-08  | Immutable transactional artifact record                                           | active   | Concurrency, rollback, hash, reopen, and lineage tests |
| NOW-09  | Coherent Files, previews, and artifact management                                 | active   | Exact-version, menu, edit, and download tests          |
| NOW-10  | Provider-native auth, models, and effort                                          | todo     | Route-specific live smokes                             |
| NOW-11  | Safe install, update, export, deletion, and support bundle                        | todo     | Clean-root, upgrade, rollback, and trash tests         |
| HAR-00  | One primary research agent                                                        | todo     | Prompt and trace inspection                            |
| HAR-01  | Bounded delegation                                                                | todo     | Tool-level limits and trace inspection                 |
| HAR-02  | Tasteful tools and compute                                                        | todo     | Representative research traces                         |
| HAR-03  | Inspectable provenance and result validation                                      | todo     | Exact-version provenance flow                          |
| HAR-04  | One inspectable harness trace                                                     | todo     | Trace schema and redaction tests                       |
| ATL     | Atlas remains unchanged during this pass                                          | deferred | No Atlas diff                                          |
| MEMORY  | Existing Memory remains intact; redesign later from Hermes/company-brain research | deferred | No Memory implementation diff                          |
| CI      | Repair and harden CI/CD after product completion                                  | deferred | Required checks green at final gate                    |

## Active runtime milestone: enforcing access broker

- Filesystem authority now has four explicit durable scopes: one request, one
  session, one project, or the whole installation. The permission card's
  `Always` response materializes as installation authority instead of silently
  narrowing to the current project.
- Session snapshots merge session, project, and installation grants into one
  monotonic authority revision. Read grants remain read-only, write grants
  authorize brokered writes only, and external folders never become writable
  Bash, Python, R, notebook, or job mounts.
- Canonical path checks reject traversal and symlink escapes. Managed session
  scratch remains private even when a broader folder scope is requested.
- Grant creation, one-shot consumption, and revocation publish an awaited
  authority change. Session changes stop that session's terminals, kernels,
  and jobs; project changes stop every project session; installation changes
  propagate across every live project instance and stop all affected work.
- Files exposes the installation scope as the explicit
  `Always — every project` choice and labels active grants by their real scope.
- Plan mode continues to block the complete side-effecting tool dispatch
  envelope, and process startup remains fail-closed when the required sandbox
  is unavailable.

### Local evidence

- The filesystem suite passes 17 tests, including directional access,
  one-shot consumption, cross-session and cross-project isolation, project and
  installation persistence, symlink denial, broker-only external writes, and
  revocation.
- A live integration test starts real sandboxed jobs in two simultaneously
  loaded projects and proves that an installation authority change cancels
  both process trees.
- The complete backend suite passes with 1,651 tests and one skip. The
  workspace source suite passes with 423 tests and 12 skips.
- Repository typecheck, regenerated OpenAPI/JavaScript SDK contracts, and the
  production workspace build pass. Browser and packaged test-channel gates
  remain before this row is verified.

## Active runtime milestone: durable session workspaces

- Every new managed session owns a durable workspace record with a stable ID,
  immutable project/session ownership, exact scratch root, isolated/legacy
  mode, active/stopped/trash state, grant revision, timestamps, and byte size.
- New isolated scratch lives under the OpenScience data root at
  `workspaces/<project_id>/<session_id>` and remains separate from the
  compatibility project directory.
- Existing filesystem-authority records lazily acquire a workspace record
  without moving or losing their bytes. Opaque-project migration moves the
  workspace record with the session and preserves its stable workspace ID.
- Session deletion moves isolated scratch to internal recoverable trash rather
  than deleting it. Restore is idempotent, keeps the same workspace/root
  identity, and preserves bytes; only trash older than seven days is purged.
- Legacy folder sessions retain their explicit `legacy` label and their host
  folder is never moved or deleted by workspace lifecycle operations.

### Local evidence

- 45 focused project/session/filesystem/execution-authority tests pass,
  including distinct roots, cross-session denial, lazy record migration,
  opaque-project migration, recoverable trash, idempotent restore, seven-day
  purge, legacy retention, and Bash/Python/R scratch ownership.
- Backend typecheck and regenerated SDK contracts pass. Broader runtime,
  workspace, browser, and packaged gates remain before this row is verified.

## Current milestone: immutable local artifacts and coherent Files

- Explicit saves stream exact bytes into a SQLite/WAL-backed local store
  instead of loading and base64-expanding binary files.
- The store writes content-addressed blobs outside session scratch and keeps
  immutable versions, a current-version pointer, source session/message fields,
  capture quality, and an optional execution record.
- A repeated save of one source creates the next version; identical content
  reuses one blob. Concurrent saves serialize without overwriting a version.
- Each version is capped at 1 GiB and saves preserve a 1 GiB free-space reserve.
- Files distinguishes writable session files, durable artifacts, and connected
  folders. The Artifact list comes from the durable store rather than a project
  directory scan.
- Saved artifacts reopen from their immutable blob even when the source file is
  gone. Preview, Versions, How made, Review, and exact Download are separate
  actions, and missing execution/review evidence is stated rather than inferred.
- Renaming changes only record metadata. Delete moves the artifact and all
  versions to recoverable Trash; Restore returns it to Files, and trash older
  than 30 days removes only blobs no remaining version references.
- Provenance binds a selected version to a project-owned target whose identity
  includes the immutable version ID and SHA-256. Later records remain linked to
  that exact version instead of silently following a mutable file path.
- The saved-artifact menu keeps preview, edit, version history, rename, download,
  and recoverable deletion compact and explicit. Unsupported binary formats
  state their limitation instead of inventing a verdict.
- A launch or failed model run is never presented as a scientific pass. Result
  cards distinguish produced artifacts from validated empirical claims.

### Local evidence

- Explicit-save route tests cover text, raw binary, 6 MiB streaming, the 1 GiB
  boundary, path containment, deduplication, source deletion, concurrent saves,
  list/detail, immutable raw reads, hashes, and missing files.
- The backend suite passes with 1,646 tests and one skip. The workspace source
  suite passes with 423 tests and 12 skips.
- Repository typecheck and the production workspace build pass.
- Browser walkthrough proves a v1 → v2 → v3 save sequence, live refresh of an
  already-open artifact, historical versions and hashes, truthful missing
  execution/review evidence, exact download, and reopening after the source
  file is deleted. A second pass proves live rename, two-step deletion,
  recoverable Trash, and Restore. Desktop 1440×900 and mobile 390×844 have no
  page overflow.
- An exact-version browser pass proves the Review surface shows version 3 plus
  its SHA, launches a brief containing the same immutable target ID, keeps the
  UI at “waiting for recorded evidence” when no model can produce findings,
  and has no horizontal overflow at 390×844.
- A packaged test-channel pass of this milestone remains required before these
  rows become `verified`.

## Previous milestone: stable shell and truthful composer

- Session tabs persist, reorder, expose draft/working/unread state, and close
  without deleting sessions.
- Collection and file tabs share one contextual strip; closing the active tab
  focuses its nearest neighbor and closing the final tab removes the pane.
- Context, work tabs, selected file, scroll state, and pane width remain scoped
  to project plus session.
- Desktop uses a split pane at 1100px and wider; tablet and mobile use one
  full-pane context view with a persistent Back action.
- The empty session remains blank and focuses the composer.
- Attach, model plus source, Plan/Act, and Send/Stop remain visible; only clear
  attachments, Terminal, preferences, and prompt history live in overflow.
- Missing-model setup is an inline row immediately above the composer.
- Inter Variable is bundled and app chrome routes through the canonical shared
  icon source.

### Local evidence

- 73 focused shell, state, composer, and token tests pass.
- Workspace `tsgo -b` and production Vite build pass.
- Browser walkthrough passes at 1440×900, 900×800, and 390×844.
- Test-channel package verification is required before these rows become
  `verified`.
