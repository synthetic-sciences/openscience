# Changelog

All notable changes to OpenScience are recorded here. The project follows
[semantic versioning](https://semver.org). Releases are cut from `main` via the
`publish` workflow and published to npm as
[`@synsci/openscience`](https://www.npmjs.com/package/@synsci/openscience); each
tagged release also ships native binaries for Linux, macOS, and Windows.

## Unreleased

### Added

- Made `openscience run` usable without a terminal: `--auto-approve` (alias
  `--dangerously-skip-permissions`) and `--deny-prompts` answer permission
  requests for the session and its delegated children without persisting
  anything, stray questions are rejected instead of hanging the run, an
  unknown model exits 2 before anything runs, a prompt that fails before the
  loop exits 2 instead of waiting forever, and `--format json` adds `user`,
  `reasoning`, `permission`, and `done` events plus failed tool calls, with
  exit codes 0/1/2/3. `run` and `--agent` are now visible in `--help`; the
  dead `--port` flag is gone.
- Added a Harbor / Terminal-Bench adapter under `tooling/harbor`
  (`openscience_harbor.agent:OpenScienceAgent`) that installs a pinned release,
  runs `openscience run --format json --auto-approve` in the task container,
  and writes an ATIF trajectory, and documented the headless container
  environment contract on the Sessions docs page.
- Added strict bring-your-own-key NVIDIA NIM adapters for Boltz-2, DiffDock,
  Evo 2, GenMol, MolMIM, MSA Search, OpenFold2, OpenFold3, ProteinMPNN, and
  RFdiffusion, with typed requests, bounded response capture, restart-safe NVCF
  reconciliation, artifact hashing, durable dispatch ownership, an offline
  credential doctor, and a one-time approval that discloses a bounded,
  secret-scrubbed summary of data leaving the device. Provenance records the
  reviewed NVIDIA API schema version; it does not claim an undisclosed
  model-weight version. They remain experimental until bounded live provider
  canaries are recorded from a release artifact.
- Added a visible local-model settings surface and real Ollama context-window
  controls that create tuned `num_ctx` aliases through Ollama's native API.
- Added a conversation-first Research harness with model-directed delegation,
  persistent Python and R analysis, governed remote compute, and a reproducible
  trajectory dashboard for harness evaluation.
- Added native DeepSeek direct-BYOK routing through the official adapter, while
  keeping explicit OpenRouter models on OpenRouter and normalizing strict tool
  schemas at the provider boundary. Deterministic contract tests cover the
  route; a live provider canary is still pending.
- Added a versioned 54-entry scientific capability inventory behind one
  model-facing lifecycle tool. Five experimental Python capabilities run with
  exact hashed local or Modal environments and bounded scientific smokes; ten
  experimental BioNeMo capabilities use strict BYOK hosted adapters; two
  entries are explicitly blocked. No entry is labeled verified without a
  matching release-artifact canary.
- Added five reviewed MCP connector presets with explicit read/write surfaces,
  setup requirements, and safety notes. Presets save disabled for inspection;
  they do not claim first-party ELN, LIMS, clinical, or regulatory write-back.

### Changed

- Restored the model options popover to its previous layout.
- Calmed the agent trajectory: each tool call is one fixed-height row with a
  present-tense label while it runs ("Reading paper.tex"), a live elapsed
  clock, and on completion a status glyph (done, failed, cancelled), the
  duration, and a one-line receipt (lines, matches, files, non-zero exit
  code) with the output folded until opened; failures keep the tool's own row
  with the first error line inline; consecutive completed calls of one tool
  fold behind a counted header; reasoning folds to "Thinking (12s)" and stays
  open once a reader opens it; streaming prose ends in a quiet static caret;
  the status line and the write/edit placeholder keep a fixed height so the
  transcript no longer jumps while a turn works.
- Replaced the generic "Considering next steps" status with the request's real
  phase (connecting, waiting for the first token, receiving, waiting on the
  gateway, or retrying) and its elapsed time, so a stalled turn is visible as
  such.
- Showed the live context size as a quiet token count in the session header
  and added a Customize → General row for the auto-compact threshold, backed
  by `/settings/preferences`.
- Removed the over-budget context warning bar above the composer with its
  "Compact now" and "Start a new session" actions, the "Warn above N tokens"
  row, and the `compaction.warn_tokens` config key. A stale key left in
  `openscience.json` is ignored.
- Made the workspace event stream non-blocking: each browser connection drains
  its own bounded queue, so a stalled tab can no longer back-pressure the agent
  loop, and per-request and per-event logging moved to debug.
- Loaded session lists and transcripts in parallel windows and reused the
  already-loaded transcript for research-contract gating, trimming per-turn
  latency.
- Served a recently verified Ace balance while refreshing it in the background
  under a bounded timeout, so managed turns no longer wait on the account
  service.
- Shared one in-flight Ace account status, entitlement, and wallet read per
  funding context, so a managed turn, the settings panels, and credential sync
  that check the account at the same time no longer repeat the request, and
  the account summary no longer reads the profile twice.
- Stopped loading the full account and workspace summary before every managed
  turn. A scoped session now starts from the local session file and the
  cached balance check; only a legacy unscoped session still reconciles its
  workspace first, and the gateway's funding echo is still verified before
  anything is charged.
- Persisted the last good Ace account summary (the shown profile fields,
  funding context, wallet and entitlement; never the key) in the data
  directory and served it to the Ace and account panels at once, marked
  `refreshing` while a newer one is read in the background and announced as
  `account.updated`. A panel no longer shows a spinner for the account
  service when a summary exists, a refresh that failed or did not fully
  answer keeps the last good values with the reason, a refusal from the
  gateway is shown but never stored, and a spend right after a refresh does
  not start another one.
- Replaced the Ace panel's 6-second timeout racing 60 seconds of server work
  with one bounded 15-second account deadline owned by the server and
  propagated, together with the request's own abort signal, to every
  outbound account read. A panel that closes cancels the reads it started,
  a shared read is cancelled only when its last waiter leaves, and the UI
  waits for the server's answer instead of giving up first.
- Kept the built provider catalog across project switches. The provider
  state is now keyed on a revision of the inputs that can differ between
  projects (provider config, enabled/disabled providers, billing routing,
  plugins, trust) instead of on the project itself, so opening another
  project with the same provider setup no longer reruns the whole
  "[provider] init" pass; a config, auth, or trust change still rebuilds it.
- Unified loading, empty, alert, and control styling across Customize panels,
  moved Credentials under Capabilities, renamed Security & access to
  Permissions, and gave Local models inline errors and skeleton rows.
- Reconnected the workspace terminal in place with backoff after an abnormal
  close, replaying scrollback instead of requiring a new PTY.
- Kept only text-bearing prompts in composer history, stopped persisting
  attachment data to browser storage, and batched persisted writes off the
  input path.
- Removed dead workspace components (the legacy compute jobs view, an unused
  file tree, the legacy model dialog, and the unused session review) together
  with their source-text tests.
- Required explicit consent before the launcher falls back to the standalone
  installer, and returned the child's real exit status on signals.
- Reworked the Files workspace into clear Project, Session, and Results tabs,
  with connected folders and recovery locations kept in a non-duplicating More
  menu, and polished file-type identity, preview chrome, and compact controls.
- Moved worker-model selection into Customize → Models and reduced delegation
  controls to concise Off, Auto, and High postures plus a compact independence
  slider.
- Made the user-facing Research agent use the proven minimal collaborative
  prompt, lazy skills and MCP capabilities, and the same thin runtime for
  delegated specialists. Removed the mandatory research-contract and eager
  capability prose from ordinary work while preserving explicit tools,
  permissions, evidence, compute, and durable Results.
- Materialized a small request-local tool set on every Research turn, with
  loaded skills activating only their relevant scientific capabilities, and
  simplified delegation to Off/Auto/High posture, worker model, and agent
  independence without per-turn worker quotas or default child deadlines.
- Stopped bundling or offering Atlas through the OpenScience npm distribution
  and `synsci` launcher, including both graph-initialization slash-command
  skills, while preserving automatic native-binary installation.
- Replaced the retired Ace subscription copy with pay-as-you-go managed credits:
  a free card-backed authorization, one purchased Wallet for OpenRouter model
  usage and enhanced search, fixed 20-credit reloads below a 5-credit purchased
  balance, and no scheduled monthly top-up.
- Retired managed-compute billing and budget behavior while preserving local,
  SSH, scheduler, and other user-owned compute workflows. Deprecated 2.x config
  and SDK fields remain as inert compatibility shims for this patch release.
- Added Ask for approval, Approve for me, and Full access presets directly to
  the composer’s Research tools menu, with trusted Full access as the default
  for new local projects and explicit or managed restrictions preserved.
- Simplified the project sidebar, model and effort controls, chat typography,
  sent-message surfaces, and Compute into a quieter results-first workspace.
- Reorganized Customize around seven focused top-level destinations with
  secondary settings disclosed in context, shared panel chrome, and no dead
  controls.
- Unified logical model names while keeping API-key and ChatGPT access routes
  explicit in both the composer and Settings.
- Consolidated Modal guidance into one governed `compute_job` workflow. Omitted
  uploads stage safe session files, an explicit empty upload list stages none,
  and the configured concurrency value is an admission limit rather than a
  hidden waiting queue.
- Let untrusted projects run routine terminal, kernel, shell, and local-compute
  work immediately inside the enforced native sandbox, while keeping project
  extensions, remote compute, package installation, and host execution behind
  explicit trust or stricter managed policy.

### Fixed

- `openscience <directory>` and `openscience web <directory>` open the workspace
  in that directory again. The project argument was declared only on the
  default-command alias, which yargs ignores, so every directory argument was
  rejected with the usage text.
- Renewed synchronized workspace credentials every 90 seconds instead of every
  4 minutes against their 5-minute grant, and retried a failed refresh with
  short backoff (5 s, 15 s, 30 s) inside that grant, logging the HTTP status
  and error class of each failure. One refresh lost to a saturated link or a
  transient gateway error no longer lets the grant lapse unnoticed.
- Scoped the expiry of a synchronized workspace credential grant to the
  runtimes that actually inherited it. The synced provider and service keys are
  a separate overlay from Ace's managed access and from locally owned keys, so
  their expiry now revokes only children whose spawn environment carried that
  overlay, as stamped in the credential process ledger at spawn, instead of
  disposing every project instance and aborting the active model request
  mid-turn. Language servers, the SSH broker, and credential helpers never
  receive the overlay and are left alone; ledger entries written by earlier
  builds, which carry no stamp, are still revoked for the command, compute,
  MCP, credential-helper and Modal volume kinds, including MCP transports
  whose owner server has since died. A grant that lapses before its expiry is
  published still stamps every child spawned in that window, and a failed
  expiry is retried with backoff. Expired grants remain unusable for new
  requests.
- Named the cause when a credential change other than an overlay expiry
  cancels a turn or a tool call ("Interrupted: credentials changed (...)"),
  and recorded an overlay expiry on the commands it stops. A tool call that is
  cancelled before it started, by a credential change or by the user, is now
  marked cancelled with "had not started; no action was taken" instead of a
  failed call with empty arguments.
- Made title and summary generation single-flight with a bounded number of
  attempts per message, so a slow first turn no longer fans out into duplicate
  title requests.
- Stopped retrying managed gateway conflicts in a loop: the idempotency key
  is stable across attempts, a duplicate of a stream still in progress waits
  for the original, a request the gateway already dispatched (its stream is
  sealed at completion) is never re-sent automatically — the user is told it
  may have been billed and must resubmit to retry — and an unknown provider
  outcome is never sent again.
- Attributed request timing logs to the model named in the request body and
  the agent that issued it, instead of whichever model first created the
  shared SDK instance.
- Logged a duplicate-skill warning once per process per pair instead of on
  every catalog rebuild.
- Made the batch tool honor the same tool gating and plugin hooks as direct
  calls, so a child session or a config-disabled tool cannot be reached by
  batching.
- Fixed the event stream leaking its heartbeat and subscription when a project
  instance was disposed.
- Stopped marking a failed storage migration as complete, surfaced list errors
  instead of reporting an empty session list, and stopped caching a rejected
  provider catalog load.
- Bounded governed shell output at 256 KB with coalesced part updates, and
  attached error handlers to floating summary and part-flush promises.
- Read compute job logs by tail instead of whole file, polled recovered local
  jobs with backoff instead of a 50 ms dlopen loop, removed unreachable sync
  and cancel branches, and guarded missing job authority.
- Resolved the managed API base at request time so search, pricing, and the
  verification page follow the configured endpoint.
- Opened external links from settings with noopener, guarded storage access
  that can throw, and stopped the reconnecting event stream from hiding handler
  errors or resetting its backoff after a single event.
- Refreshed the kernel route fallback so an upgraded backend is rediscovered
  instead of pinning the legacy route forever.
- Gated desktop permission requests to the local workspace origin, blocked
  off-origin redirects, hid DevTools in packaged builds, and reported a crashed
  sidecar instead of leaving a frozen window.
- Split the launcher recovery test so the codesign-rejection case runs only on
  macOS while every POSIX platform still proves an unverified command on PATH
  is refused, fixing the nightly Linux CI failure.
- Verified release checksums loudly, downloaded from the resolved immutable
  tag, and corrected the release workflow's checksum comparison step.
- Made runtime restart transfer a cancelled startup's durable lease without a
  closing-handle race, so the replacement incarnation cannot fail or be reaped
  by the superseded boot.
- Made PDF.js use one dev- and production-safe worker URL, added responsive page
  thumbnails and better use of available preview space, and prevented the
  `Invalid workerSrc type` failure seen in local development.
- Advertised Fast only on exact routes that can actually execute it, including
  validated OpenRouter `-fast` siblings, while hiding no-op xAI and unsupported
  ChatGPT/Codex offerings and preserving native and managed routes separately.
- Prevented the launcher from attaching a browser to an API-only, stale, or
  version-mismatched process, and added a stable secondary local port so layout
  and workspace state remain persistent when the default port is occupied.
- Activated a loaded skill's declared tools on the current Research turn while
  preserving normal execution permissions, restored plural image and figure
  routing, and made explicit slash skills authoritative instead of expanding
  them into unrelated writing or review workflows.
- Paced same-host WebFetch calls with `Retry-After` handling to prevent citation
  lookup stampedes, and required a fresh file read before retrying a stale
  patch against the same target.
- Removed the remaining child-agent wall-clock, dispatch, step, handoff, and
  output-recovery ceilings; delegated agents may delegate further while shared
  concurrency still protects machine capacity.
- Made chat file references clickable only after resolution inside the active
  workspace, so external temporary paths stay plain text and denied reads show
  a clear workspace-boundary explanation instead of raw request JSON.
- Kept live reasoning and tool activity mounted in chronological order, removed
  the streaming-only truncation and regrouping that made rows disappear until
  refresh, kept assistant text in that same literal timeline, and made semantic
  status changes visible immediately.
- Kept durable Project-file browsing and previews separate from session scratch
  authority, resolved chat file links against session scratch before durable
  project files, surfaced
  Python and R output files with explicit Save to Results actions, and labeled
  opened files by their real workspace instead of reporting valid project
  folders as disconnected.
- Made active Python and R startup visible in Compute, removed duplicate
  `/compact` and `/context` actions, retained the latest readable streamed
  thought through provider-redacted parts, and kept routine analysis outputs in
  Session scratch unless the user asks to preserve them.
- Removed empty interprocess compute-lock sidecars after the final coordinator
  exits, preventing successful concurrent jobs from leaving stale lock state.
- Recovered an assistant turn's exact durable parent when a concurrent metadata
  replacement makes a cross-process session scan momentarily omit that user message.
- Prevented streamed tool arguments from generating quadratic event and disk
  traffic, restored exact project-root authority to sandboxed commands, and
  made loaded-skill references readable only within their authorized directory.
- Made delegated work recover provider placeholder session IDs, retain useful
  partial handoffs after provider rejection, and display only one concise live
  thought while preserving the complete completed trajectory.
- Made compute waits suspend until meaningful state or output changes instead
  of spending model turns on polling, preserved active remote jobs during
  evaluator cleanup, and stopped trusted encrypted credential updates from
  aborting unrelated live sessions.
- Made Modal cancellation stop only the sandbox, collect declared partial
  outputs, and retain the durable Volume until an explicit release, so recovery
  never requires destroying useful work.
- Replayed research-contract continuation from semantic evidence progress,
  allowed one focused repair when progress stalls, and retained immutable
  ArtifactStore versions in session traces even when their tool row is absent.
- Preserved completed activity and durable work when Ace verification is
  temporarily unavailable, presenting a calm retryable pause instead of ending
  a long turn without a useful handoff.
- Refined reasoning and tool activity into a quieter chronological trace with
  consistent spacing, focus states, and compact status presentation.
- Made every built-in research tool advertise an object-rooted JSON Schema so
  strict OpenAI-compatible providers such as DeepSeek and Kimi accept tool-enabled requests.
- Selected the x86-64 baseline binary automatically on Linux and macOS hosts
  that do not support AVX2, with an actionable SIGILL diagnostic.
- Made the research harness normalize WebFetch download destinations, authorize
  Explore retrieval consistently, apply multi-file patches transactionally,
  resolve the default Python environment, enforce image limits by the active
  provider, and accept valid manual-run provenance.
- Hardened research runs against repeated terminal URLs, guessed download-size
  escalation, substantially identical timed-out kernel work, stale tool
  outcomes, cross-process cancellation races, and orphaned kernel lifecycles.
- Made compute-job actions self-describing and recover harmless legacy aliases
  and stringified targets without weakening canonical validation.
- Made brokered downloads derive their safe size from available workspace disk
  instead of agent-guessed byte caps, with copy-ready root-download and
  sandboxed move guidance for folder destinations.
- Removed the fixed Modal Volume browser-download ceiling and made large file
  delivery use live disk-derived staging capacity plus cancellation-safe
  streaming instead of buffering responses in memory.
- Preserved exact session and tool-output filesystem capabilities across local
  work and delegated handoffs without broadening external-directory access.
- Restored the v2 Review settings API, truthful runtime progress capture, and
  hermetic browser and publication workflows for release validation.
- Made project removal a recoverable archive operation, kept archived projects
  out of the active Home list, and added an explicit Restore action so local
  project discovery cannot make intentionally removed projects reappear.
- Made stale-patch diagnostics identify the exact failed hunk and show useful
  bounded context near its intended location, including in long files whose
  target text changed completely.
- Made storage scans report allocated disk use without double-counting hard
  links, finish in the background, and keep their loading and error states
  truthful.

## v2.0.23 — 2026-08-09

### Changed

- Unified scientific compute, results, and artifact workflows around a smaller
  project-scoped Compute surface, with truthful kernel lifecycle and durable job
  history.
- Minimized completed compute records while keeping recovery, result delivery,
  and provenance visible.
- Updated provider branding in settings.

## v2.0.22 — 2026-08-07

### Changed

- Streamlined the research workspace and terminal, removed redundant starter
  surfaces, and unified credential access with Atlas sync.
- Hardened legacy data migration and added recognizable credential-provider
  logos.

## v2.0.21 — 2026-08-07

### Fixed

- Restored legacy OpenScience data during upgrades.

## v2.0.2 — 2026-08-06

### Added

- Added the local-first scientific workbench, 42 scientific connectors, durable
  artifacts, governed Modal compute, truthful host/kernel capacity, and rich
  previews for scientific files.

### Changed

- Rebuilt Files and Artifacts, simplified model selection and research
  navigation, and made the core workspace work offline without an Atlas account.

### Fixed

- Stabilized sessions, storage, managed inference, kernel startup, Modal Volume
  delivery, model-picker navigation, and multi-platform packaging.

## v2.0.1 — 2026-07-29

### Changed

- Focused the workspace around Files, stabilized Evidence, and simplified the
  research session surface.

## v2.0.0 — 2026-07-29

### Added

- Added a scientific workbench with native notebook and data-table views,
  molecular and binary-file inspection, local artifacts, managed compute jobs,
  research mission control, and resilient workspace recovery.
- Added reproducibility and publication workflows, versioned review annotations,
  secure HTML export, and manuscript authoring and review.

### Changed

- Reworked the workspace around contextual artifact inspection and focused
  research sessions.

## v1.3.5 — 2026-07-27

### Changed

- Updated frontier-model routing and reasoning controls, hardened managed and
  bring-your-own-key paths, and improved model-selection UX.
- Hardened native packaging, network boundaries, subprocess environments,
  kernel/process cleanup, scientific viewers, and workspace performance.

## v1.3.4 — 2026-07-11

### Added

- Added refreshable command-based provider credentials and text/Markdown file
  attachments.

### Fixed

- Improved context compaction, weak-model continuity, user-config precedence,
  notebook thread limits, and terminal-session completion behavior.

## v1.3.3 — 2026-07-10

### Added

- Added automatic context compaction and richer streaming chat, tool, skill, and
  scroll behavior.

### Fixed

- Prevented PDF tab-close hangs and isolated failing file/skill panes from the
  rest of the session.

## v1.3.2 — 2026-07-09

### Changed

- Consolidated Wallet, Spend, and Usage into Billing and promoted Skills to its
  own workspace tab.
- Corrected provider reasoning-effort routing and stabilized the development
  Atlas graph bridge.

## v1.3.1 — 2026-07-08

### Added

- Added browser-first onboarding, ChatGPT/Codex sign-in, wallet and status
  surfaces, and broader provider-native reasoning modes.

### Fixed

- Hardened Atlas timeouts, credential precedence, Codex OAuth, scientific source
  retrieval, local BYOK routing, and file error states.

## v1.3.0 — 2026-07-08

### Added

- Added the opt-in Seatbelt/bubblewrap execution sandbox, first-class local
  models, session search and history controls, and a simpler composer/model
  picker.

### Fixed

- Hardened provider routing, config precedence, session retries and cancellation,
  credential handling, installation detection, and repository transport safety.

## v1.2.10 — 2026-07-06

### Fixed

- Requested OpenAI reasoning summaries on the managed path and replaced the chat
  turn divider with clearer spacing.

## v1.2.9 — 2026-07-06

### Changed

- Flattened the new-session action and refined composer focus and corner styling.

## v1.2.8 — 2026-07-06

### Fixed

- Managed models (e.g. GPT-5.5, Gemini) failed with "isn't connected to your
  Atlas wallet" or a proxy 401 ("thk\_\* token not found") when a provider key
  such as `OPENAI_API_KEY` was exported in the shell. Managed-proxy calls now
  always authorize with the Atlas session token, so an ambient shell key can't
  shadow it — for OpenAI, Anthropic, Gemini, and OpenRouter.
- OAuth subscriptions (Sign in with ChatGPT/Codex, Claude Pro/Max, Copilot) are
  no longer blocked when managed LLM spend is on — they run on your own account,
  free of the wallet.

## v1.2.7 — 2026-07-06

### Changed

- In-project workspace polish: on-scale typography (hero heading, chat-markdown,
  tabs), a tighter header, unified sidebar and tab alignment, and corrected
  muted-text tokens that had rendered at full strength.
- Landing page: structured data (JSON-LD) for search engines and async image
  decoding.
- Docs: a changelog, release-process and verification notes, a skills reference,
  and a supported-versions security policy.

## v1.2.6 — 2026-07-06

Atlas experience polish.

### Added

- Unified `openscience status`: connection, plan, wallet balance + lifetime
  spend, recent usage, managed-compute availability, and the bundled `atlas`
  companion version — all in one view, degrading gracefully when signed out.
- Wallet settings panel and a `/settings/wallet` route surfacing the Atlas
  credits balance, billing mode, and recent transaction ledger.
- Browser Atlas login (`/account/login-key` + a first-run setup dialog) and a
  first-run flow that no longer dead-ends when no model is configured.
- Opt-in reviewer gate (`experimental.reviewGate`) that runs a blind review pass
  on a primary agent's final answer and annotates it with the verdict.

### Changed

- Bundled `@synsci/atlas` companion bumped to `^0.13.2` so managed compute
  resolves.
- arXiv retrieval hardened: per-host throttling, honest content negotiation,
  PDF-link and error-response parsing, and graceful degradation when a source
  fails.
- Model-catalog tests are deterministic (fixtured) with a nightly delisting
  tripwire.

### Fixed

- Every Atlas network call is timeout-bounded, fixing a hang where
  `project init` could run indefinitely.
- Credential sync no longer flips managed billing when a user's own exported key
  is present; synced files are written atomically.
- Codex OAuth recovers from refresh-token rotation and distinguishes a
  reconnect-required error from a transient one.

## v1.2.5 — 2026-07-05

- Seamless first-run onboarding with a clear managed vs. BYOK choice.
- Centralized catalog model pins with a delisting tripwire.
- OpenScience docs site at openscience.sh/docs.
- Spend controls in the workspace; compute keys actually applied.

## v1.2.4 — 2026-07-04

- Codex recovers from refresh-token rotation races.
- Release and npm-provenance fixes so packages publish reliably.

## v1.2.3 — 2026-07-04

- First tagged release of the `1.2.x` line.
