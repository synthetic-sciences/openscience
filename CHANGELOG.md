# Changelog

All notable changes to OpenScience are recorded here. The project follows
[semantic versioning](https://semver.org). Releases are cut from `main` via the
`publish` workflow and published to npm as
[`@synsci/openscience`](https://www.npmjs.com/package/@synsci/openscience); each
tagged release also ships native binaries for Linux, macOS, and Windows.

## Unreleased

- Keep launcher CPU fallback confined to a read-only startup probe, respect scientific-source cooldowns without early retries, preserve special characters in local file links, and verify upgrades when the old versioned executable remains on disk.

### Changed

- Keep Settings usable while it refreshes: panels no longer flash their loading
  skeleton or jump back to the top after Rescan, Save, or Add, and confirmations
  raised inside Settings (removing a key, connector, or network rule) stack above
  it and return to the same page instead of closing Settings.
- Show the model picker's unconnected models as **Connect to use** rows that open
  the connection settings, remember the last model you chose across reloads and
  new sessions, and name the provider plus the fix when a request fails on a
  rejected API key.
- Reveal local models in the picker as soon as they are added, and record a
  context window for every local, SSH, or direct endpoint (not only Ollama) so
  long sessions on larger servers are not compacted at 32k tokens.
- Redact provider API keys and auth headers from every served configuration
  payload (`GET /config`, `/global/config`, `/config/providers`), and keep
  `{env:…}` references as written when a project config is saved from the UI
  or `openscience local --project`.
- Answer the next prompt after a failed or stopped `/compact` instead of
  replaying the summary under it; with a compaction model that kept failing,
  every later prompt in the session was silently swallowed.
- Keep OpenRouter's signed reasoning replay for models flagged as interleaved
  (Gemini 3, GLM 5, MiniMax, Kimi via BYOK OpenRouter), and pass provider error
  details through when the body nests them under `error.message` or `detail`.
- Scope a dashboard credential change or a lost workspace grant to the
  commands and jobs that inherited the synced credentials. Adding a key on the
  dashboard no longer interrupts every running turn on the device.
- Offer `compute_job` for long-running work described in ordinary words (SRA
  downloads, STAR/bwa alignment, Nextflow or Snakemake pipelines, fine-tuning,
  "this will take hours"), not only for prompts naming a cluster or GPU.
- Show the sign-in page as a link while a browser sign-in is pending, so a
  host that cannot open a browser (SSH, containers) can still finish signing in.
- Give the recovery page a **Back to Projects** action with plain explanations
  for project and folder errors instead of a raw JSON payload and a reload
  loop, ask the server for JSON on every request so an older server cannot
  answer an unknown route with the UI shell, and stop cutting a Windows drive
  root (`C:\`) down to a drive-relative path when a project is opened there.
- Say that a rejected oversized request is being compacted and retried, honour
  a turn's own context limit for mid-turn overflow checks, take Ace image
  support from the reviewed route catalogue, and stop advertising a Claude Max
  sign-in the CLI has no plugin for.
- Fix the Homebrew update check, which queried homebrew-core and always failed;
  Homebrew installs now resolve the latest version from GitHub releases and
  upgrade `synthetic-sciences/tap/openscience`. `openscience upgrade` downloads
  the installer before running it and verifies the installed version afterwards,
  so a failed download or a no-op package-manager run is reported instead of
  "Upgrade complete".
- Detect AVX2 on macOS through `hw.optional.avx2_0` in the npm launcher,
  `npx synsci` and the install step (fixing Apple Silicon and Rosetta hosts),
  recognise Windows illegal-instruction exits, retry once with the baseline
  build when the optimized binary crashes on a CPU without AVX2, and name
  `--omit=optional`/`--ignore-scripts` in the "binary not found" message.
- Report a desktop sidecar that exits during startup immediately, with its exit
  status, log path and the last lines of its log, keep the previous run's
  sidecar log as `openscience-sidecar.prev.log`, and refuse Linux ARM64
  kernels without 4 KB pages in the install script with the same guidance the
  npm launcher prints. Remote `.well-known/openscience` configuration fetches
  time out after 10 seconds instead of stalling startup.
- Resolve `skills/<category>/<name>/…` script references inside loaded skill
  instructions to the skill library's real location, so bundled skills that
  call sibling scripts work from compiled releases, not only from a source
  checkout; correct the Hugging Face Jobs, Evaluation and Model Trainer script
  paths and make `generate-responses.py` run on Python 3.10 and 3.11 as
  declared; and point the shipped agent instructions at real skill names.
- Surface a skill with invalid frontmatter (for example a missing
  `description`) as a visible error instead of silently dropping it, join
  Crossref's polite pool when `CROSSREF_MAILTO` or `OPENALEX_MAILTO` is set,
  cap `Retry-After` waits from scientific sources at 15 seconds, and state in
  the bioRxiv/medRxiv connector that keyword search covers only recent postings.
- Treat the validated provider tool call as authoritative, so an incomplete call
  can be repaired safely without conflicting with its provisional stream event.
- Keep the model you picked in the composer when you leave a project, open
  another one, or reload; the install default is used only until you choose.
- Stop the conversation from going blank after approving an action or any
  other background refresh: the session page no longer sits under a Suspense
  boundary that swapped the whole transcript for its loading spinner while a
  refetch was pending, which could leave it empty until the project was
  reopened.
- Record one tool receipt per provider call. When a tool call arrived in a
  single chunk (local models, short arguments) the executor could register the
  call before its streamed placeholder was written, leaving a duplicate part
  stuck in **running** and sending two tool results for one call ID on the
  next request.
- Switching a project to **Full access** now settles the approval cards that
  were already waiting under **Ask risky**, and fetch prompts show the address
  being fetched; folder and host prompts showed a literal `{path}`/`{host}`
  instead of the folder or host.
- Open files the agent links in the conversation in the Files tab, including
  results in the conversation's working area, connected folders, `file://`
  links and echoed `/file/raw` URLs, instead of navigating to a `localhost`
  page (opened in an external browser from the desktop app).
- Keep folder access inside the project that approved it: **Allow always** is
  no longer offered for folder prompts and never creates an installation-wide
  grant, older installation-wide folder grants no longer apply, a shell working
  directory outside the project is granted itself rather than its parent
  (`cd /tmp` no longer granted `/private`), and the Files tab's **Working
  files** list no longer shows the project's own root or loaded skill
  directories as connected folders.
- Preserve completed delegated work when a task is cancelled, report the
  worker's actual outcome and changed files to both the lead and UI, and bound
  silent remote response bodies without cutting off active streams. Keep the
  conversation mounted while execution-access settings refresh, and describe
  request waits by the transport phase OpenScience actually observed.
- Retry transient Windows sharing errors when atomically saving compute job status,
  preserving the previous file and reporting persistent storage failures.
- Keep settings dropdowns inside their dialog so assistive technology can reach
  skill creation and filter options. Restore the skill-authoring browser test.
- Keep delayed history loading from undoing a newer **Jump to Latest**, send, or
  reading position; discard scroll restoration after switching conversations.
- Publish the official Homebrew tap with a credential scoped to that repository,
  verified platform checksums, and idempotent formula updates. Automatically keep
  each draft release's Windows signing disclosure consistent with its build.
- Keep the conversation mounted while checking output files or refreshing compute
  status, so sending a message cannot reset the chat to the top. Sending and
  **Jump to Latest** follow the latest response; incoming activity preserves the
  reader's position in earlier messages.
- Resolve output receipts by their exact absolute path within the active session's
  authorized files, including session scratch, without falling back to another
  file with the same name.
- Preserve complete historical tool arguments during output compaction and reject
  copied legacy argument previews before file mutations. Retain Task outcomes and
  immutable output handles during compaction; earlier progress text no longer
  counts as a worker's final handoff.
- Let leads read saved worker Results by exact artifact and version IDs without
  opening private scratch directories. Include observed command receipt references
  in handoffs, without treating shell success as proof of passing tests.
- Record the selected Python executable separately from measured version evidence,
  use that same interpreter for local compute receipts, and label remote submitter
  metadata honestly. Explain changes to advertised tools at the provider boundary.
- Discover Git Bash across Windows installation layouts and require a POSIX shell
  for local compute, so a fallback command prompt cannot report success without
  executing the job script. Capture mixed shell and native-program output through
  one append writer, and flush it before reporting completion.
- Keep delegated-agent progress connected throughout execution and propagate parent
  cancellation through child preparation, resumed work and active model requests.
  Normalize empty continuation fields and stop repeated same-cause failures even
  after recovery guidance has been attached to an earlier error.
- Cancel scientific connector queue waits and retry backoff promptly, and prevent
  late connector responses from publishing success or saving files after a stop.
- Show the active assignment when a worker is reused, retain the reasoning/activity
  toggle when no readable reasoning was returned, and distinguish historical
  compute receipts from a job's current state, including completed jobs.
- Share the prepared Python runtime between scientific kernels, shell commands and
  local compute without restoring ambient Python injection paths or provider keys.
  Observe bounded filesystem changes for shell output receipts, including scratch
  and non-Git files, and remove deleted paths from the output list.
- Return saved, formatted file contents and hashes in patch receipts. Use guarded
  atomic replacement on macOS and Linux, preserve concurrent edits during rollback,
  and honor revoked or read-only filesystem grants when trashing/restoring files.
- Preserve Windows drive letters and colons in patch paths, and handle Windows
  environment key casing consistently without admitting host credentials.
- Preserve exact large file identities in recoverable trash and guarded writes,
  close recovery handles after metadata failures, and keep ordinary file-save
  paths present during replacement on macOS and Linux.
- Report failed language-server startup through diagnostics status without retrying
  on every read, and include document tokens in estimated context composition.
- Clarify environment readiness, nested test-process verification and protected
  evaluator seed retention in Research, delegation and benchmark guidance.
- Publish the Windows desktop installer unsigned, with a workflow warning that
  names the missing values, until the Microsoft Artifact Signing profile and its
  repository configuration are complete.
- Match the new-terminal shortcut by physical key so Ctrl+Shift+` works on layouts
  where Shift+backtick reports a different symbol, and point twelve more skills at
  the real scientific-schematics script path.
- Document the 5.5% Ace funding fee (applied once per request, with no other
  markup; card processing fee shown separately at checkout) in the pricing, Ace,
  and FAQ guides, the README, and the landing page. The landing page no longer
  describes retired native provider routes and marks memory as coming soon.
- Name the **Keys & subscriptions** access mode by its actual label in the docs,
  correct the `model`/`tools` alias direction and the NGC API key field name,
  restore the Mammouth custom-provider example under Custom providers, and refresh
  stale engineering notes (landing page path, release rehearsal workflow name).
- Align bundled skill instructions with their helpers: DrugBank loads only an
  explicitly provided licensed export and tolerates records without a primary
  id, BRENDA credentials come from the process environment, Zotero access is
  explicit-request guidance gated by Zotero's local-API setting, venue templates
  point at the real poster and schematic paths, Hugging Face Jobs drops a
  `--filter-method` flag that `generate-responses.py` does not accept, and Open
  Targets notes that its tests replay recorded fixtures.
- Keep an explicit Show/Hide reasoning-and-activity control, with its chevron
  and expanded state, while a turn is working; report request and retry status
  beside it, and pin the control inside the turn so a long trace stays
  collapsible from wherever the reader is.
- Label delegated work by what the runtime recorded: preparing until a child
  session exists, queued or running only once one does, and a delegation that
  failed to start kept distinct from a worker that failed, returned a partial
  result or reached its time limit.
- Offer the files a shell command or kernel changed as turn outputs, taken from
  the filesystem diffs recorded after each step and resolved like other file
  links, so nothing is guessed from command text.
- Present a turn that ended early as stopped, with the recorded reason (a Stop
  press, a named interruption, a wait the runtime gave up on, or a provider
  failure), the outputs kept and the operations left pending. Nothing is
  rolled back or resumed automatically.
- Back off desktop update polling after twenty reads, up to thirty seconds
  between reads, and stop polling a blocked restart until the user acts.
- Remove unused interface strings and the English placeholders copied into
  non-English locales, which now fall back to English. Keep onboarding copy
  host-neutral, bound the browser sign-in wait, and recognise loaded skills
  from their recorded metadata rather than the receipt title alone.
- Price Ace turns from the gateway's reported cost plus the funding fee instead
  of a token table, so managed models never show $0 while the pricing catalog
  loads; "Refresh options" now bypasses the pricing failure cooldown and the
  catalog read is bounded by one timeout.
- Refresh the Wallet after a managed turn settles rather than at the response
  headers, announce failed background account refreshes so "Refreshing…" cannot
  stick, and show the available balance (purchased balance less holds for turns
  in flight) beside the purchased balance in the Wallet panel.
- Poll the credential sync digest every 90 seconds and fetch the full payload
  only when it changes or every five minutes.
- Stop advertising PDF, audio and video inputs for Ace models, which the managed
  gateway cannot carry; an attached PDF becomes a note for the model instead of
  an error. Describe Ace pricing as the provider price plus the 5.5% funding fee
  with no other markup, use Wallet wording in empty-balance messages, and show
  the Fast mode rate next to the Fast toggle and in the Models panel.
- Record the 922,000-token input limit for the GPT-5.6 Sol, Terra and Luna
  routes and the GPT-6 Astra release date so the newest model gets its badge.
- Give delegated work a usable continuation contract: an omitted, empty or
  placeholder `session_id` starts one child, an invented, bare or foreign id
  fails before any child is created with the exact recovery (omit it, or reuse
  one of this session's real child ids), and every Task result and compacted
  handoff begins with the child session id to reuse.
- Recognise repeated tool failures with the same cause even when the model
  rewords its arguments: the second failure appends corrective guidance to the
  tool result and the third stops the turn, independently of access settings.
- Let a session that may overwrite a project file also move, delete and restore
  it: legacy sessions without a project-root grant no longer fail deletions with
  a bare `SessionFilesystemDeniedError`, and a real denial now names the
  operation, path, missing authority and recovery.
- Treat a second finalization of the same runtime run as idempotent and bind
  cancellation to the exact run, so a cancel that races normal settlement no
  longer logs a phantom active run and a stale cancel cannot abort a replacement.
- Emit one `tool_use` per part in `openscience run --format json` so a Harbor
  trial no longer fails with "duplicate event part" after context pruning
  republishes completed tool parts; name 2.0.78 as the first Harbor-compatible
  release and run the native Harbor trial on main in its own job.
- Continue past a model's output limit only while continuations make progress;
  two consecutive continuations with no completed tool result and no new text
  stop with a clear error that keeps the partial output. Scope the repeated-
  response guard to the current request so a recorded stop cannot re-fire on
  later prompts, and read only that request's messages for the repeated-call
  guard instead of streaming the whole session on every tool call.
- Estimate PDF attachments by page count rather than transport bytes, so a
  multi-megabyte scan no longer reads as hundreds of thousands of tokens and is
  refused before any request is sent.
- Retry a provider request whose connection failed before any response byte
  (refused, unresolved, or closed before headers) while no tool has started.
  Wait up to five minutes for response headers, disable that deadline for local
  runtimes (loopback or `.local` endpoints and the bundled local providers),
  and bound transient retries to five attempts with jittered backoff capped at
  one minute. Request timeouts and managed gateway verdicts remain terminal.
- Return a delegated child's final answer as the Task result instead of every
  text fragment it produced; the child session id in the result metadata still
  opens the full transcript.
- Route tool relevance and skill activation from the request's real prompts
  across its whole epoch, so synthetic continuations no longer hide the editing,
  Python and skill-enabled tools a long task needs.
- Request adaptive thinking by default for Claude Opus 4.7/4.8 and Opus and
  Sonnet 4.6.
- Journal delegated child sessions' events under the parent's runtime run and
  include their pending permissions and questions in the parent's snapshot.
- Add `compaction.recentImages` to configure how many recent images are sent
  in full with each request (default unchanged: 1).
- Fix Windows desktop startup failing with `spawn /bin/ps ENOENT` by limiting
  macOS updater process-identity checks to supervised update launches.
- Require Microsoft Artifact Signing for stable Windows desktop installers,
  including the bundled runtime and native libraries, and verify publisher,
  signature trust, and timestamps before publishing.
- Wait for scientific canary artifact delivery before validating a completed
  remote computation, while preserving bounded waits and resource cleanup.
- Start desktop onboarding with Synthetic Sciences sign-in and workspace selection,
  then continue to research project setup. A small Skip action allows local setup
  without an account; existing completed setups remain unchanged.
- Start packaged macOS workers without loading application configuration or
  migrating storage, and verify their gated startup and piped input in release smokes.
- Preserve optional/defaulted tool inputs in provider schemas and clarify inline
  page reads versus raw downloads. Distinguish completed subagent handoffs with
  failed attempts from unfinished work, retain empty first-turn recovery baselines,
  and show search failures, source links and filtering warnings in the trajectory.
- Keep successful skill loads visible in collapsed conversation activity with
  inspectable instructions and load details; distinguish searches and failures
  from actual loads. Give the Skill Library one scrolling list with fixed search
  and pagination controls, readable descriptions, and accurate partial counts.
- Remove short standalone headings from visible reasoning while retaining
  the complete prose. Rank skill discovery by query relevance and use an explicit
  search query to recover a guessed skill name without loading unrelated instructions.
- Forward attached CLI authentication, server-side agent selection, command files
  and effort. Delegated commands retain bounded uploaded files in durable task
  state and deliver them into the child's workspace. Explicit OpenRouter model
  blacklists remain authoritative, and blocked partial output is a failed turn.
- Preserve scientific connector errors and cancellation instead of reporting
  empty success; correct BindingDB identifier round trips and uncertain Modal
  cleanup. Label ligand-only energy scoring accurately, reject the unsupported
  reward-model training mode, and make incomplete venue validation explicit.
- Use one bounded skill search over names, descriptions, tags and capabilities;
  stabilize local override ordering, revalidate instructions on load, and retain
  instruction hashes with read-only bundle access. Keep existing scientific
  skills, explicit slash invocation and tool permissions.
- Keep missing measurements out of distributions, preserve unavailable CPU
  readings, label context proportions as estimates, mark failed trace captures
  partial, surface Wallet ledger failures, and report unavailable update checks.
- Remove the laboratory and private Slack demos, the static plugin catalog, and
  speculative provider-profile/Fusion plans. Working runtime, SDK, plugin,
  connector and reviewed skill-installation contracts remain available.
- Continue after a local tool result even when a provider labels its turn `stop`,
  so the model can use the result and produce its final answer. Preserve terminal
  handling for provider-executed tools, interrupted work and configured limits.
- Document actual Research prompt assembly and the source-verified OpenCode
  comparison, separating optional model guidance from required API compatibility.
- Align model workspace guidance with the session's actual isolated or project
  mode and remove the duplicated Research header from Codex requests. Harbor
  trials disable model-generated UI titles through existing configuration and
  explicitly label the limits of root-step usage accounting.
- Expose a detachable Research runtime with rich prompt inputs, durable request
  receipts, run-scoped cancellation, snapshot recovery, and idempotent decisions.
  Exact retries reconcile the existing run; an interrupted server never silently
  repeats scientific work. The Research composer uses the public runtime API.
- Add a headless build and owned SDK server lifecycle and a Python HTTP/SSE client. Plugins can
  return structured results and register project-scoped scientific connectors;
  cancellation and shutdown remove pending decisions and dispose extensions.
- Harden the Harbor 0.22.0 adapter: preserve native task working directories,
  verify executable identity, collect remote logs before checking completion,
  require a successful terminal event, and retain unknown/partial usage honestly.
- Add explicit project or isolated workspace selection at session creation and
  `run --workspace project`; the default remains isolated. Harbor requires project
  mode so relative tool paths use the native task directory, and rejects binaries
  without that capability. Removing a project-mode session preserves project files.

- Keep model-specific effort controls in the composer while Ace pricing loads,
  recover pricing after a failed initial fetch, and prevent older catalog reads
  from overwriting a newer refresh. Keep Fast gated by verified rates and offer
  a read-only options refresh without changing the selected model or access route.
- Add GPT-6 Astra and Claude Fable 5.1 with reviewed model-specific effort,
  context, tool, and pricing contracts. Keep existing composer selections and
  pins; distinguish native API, subscription, and managed access capabilities.
  Keep managed Fable 5.1 gated pending OpenRouter thinking-replay verification;
  native Anthropic support is independent.
- Show the current update's health-check progress instead of an earlier
  release's success banner, and continue polling until that update is verified.
- Preserve original paths in assistant Markdown links, prose, code, and copied
  responses. Opening an in-project report from chat no longer strips its project
  prefix or changes it into an outside-workspace path.
- Keep the reader's place when resizing the chat and file panes, including
  inside long paragraphs, without pulling a scrolled-up reader to the latest turn.
- Restore the classic 2.0.61–2.0.63 chat presentation: one saved reasoning/activity
  disclosure per turn, inline reasoning, and quiet tool rows without repeated
  timers or status rails. Keep live turns open on completion, anchor disclosure
  clicks in place, and preserve pending answers, approvals, failures, and final
  responses while activity is collapsed. Streaming and billing safeguards remain
  unchanged.
- Honor Stop even when it arrives just before retry backoff. Preserve the
  selected model context window through compaction and continuation, and include
  cached writes when assessing whether pruning made enough room.
- Recheck the current OAuth callback listener when two local processes connect
  simultaneously. Avoid stale pooled connections to a stopped runtime without
  accepting a different data profile or taking over another service's port.
- Keep the per-turn disclosure keyboard- and screen-reader-accessible, and retain
  its open or closed state across reloads. Ignore the obsolete global reasoning
  preference without resetting other settings. Display reasoning as plain prose,
  omit routine provider phase headings, and remove per-part thinking clocks that
  counted silence as reasoning. Keep original provider text and tool results intact.
- Remove the Context percentage selector and automatically compact at the usable
  model capacity with output headroom, following OpenCode's default. Legacy
  percentage preferences no longer override automatic context management.
- Restore unlimited waiting for an opened model response by default. Remove the
  recently introduced five-minute body-idle and ten-minute output-idle cutoffs;
  retain connection limits, explicit timeout overrides, Stop, and protections
  against retrying unknown paid outcomes.

- Use the Synthetic Sciences mark consistently in documentation, website and
  workspace favicons, workspace headers, model settings, and social previews.

- Rebuild the public documentation around current installation, Ace pricing,
  provider keys, local models, research workflows, and troubleshooting. Add
  Explore tools and Skills tabs with complete catalogs, usage guides, and
  source links, plus detailed project, scientific-viewer, and compute workflows.

- Update the homepage closing headline, simplify the photo wordmark, and add
  LinkedIn with external-link arrows to the footer’s Connect links.

- Keep readable provider reasoning and individual tool calls in chronological
  order when a turn is expanded, without Detailed/Compact modes or a global
  visibility toggle. Omit empty encrypted-only rows instead of repeating unavailable
  reasoning notices. Preserve readable OpenRouter reasoning when encrypted
  continuation metadata arrives in the same response.
- Open chat-linked documents already saved in a managed project's Project files
  through a read-only, server-verified preview. Recheck project/session identity
  and canonical containment for content and raw reads without granting the agent
  access to more folders or weakening symlink and cross-project restrictions.
- Use a turn's unique canonical write receipt for bare file links when available,
  show which file location a preview opened, and prevent streamed Markdown updates
  from opening both an old and a new target on one click. Unrecorded Bash writes
  are not guessed from command text or file modification times.
- Distinguish a content search with no matches from an invalid search or a
  cancellation. Keep provider error diagnostics without logging request bodies,
  conversation content, response bodies, or credentials retained by the SDK.

- Redesign openscience.sh around archival research photography, monochrome editorial
  sections, a moving institution strip, interactive workflow previews, detailed
  research skills, expandable database tiles, and an oversized OpenScience footer.
  Center desktop downloads and command-line installation in a matching download
  page. Alternate black and white homepage sections with a white workspace preview
  and separate black research-tools section, simplify navigation and copy,
  and add a searchable model-picker preview. Introduce Ace’s pay-as-you-go
  Wallet billing on the home page.

- Keep the saved model-access choice stable through delayed Wallet reads and
  account switches, without letting an old request overwrite the new account UI.
- Recover once when a retained conversation tail still exceeds the context limit
  after compaction; resume the actual request after its recovery summary without
  replaying unrelated provider failures.
- Restore BRENDA helper imports and its missing SOAP bridge; align Open Targets
  queries with the current public schema; support explicit licensed local DrugBank
  exports without silently attempting a download.
- Add an opt-in, read-only local Zotero library skill, with explicit query and
  response limits; document conservative Mammouth custom-provider chat setup
  without claiming native discovery or unverified tool capabilities.
- Replace brittle Ace source-text assertions with real rendered account/routing
  behavior tests, consolidate the sidebar-action harness without dropping its
  callback regression, and correct contributor and release-verification guidance.

## v2.0.71–v2.0.72 — 2026-09-05

### Changed

- Keep the composer focused while slash-command suggestions refresh, so loading
  skills cannot interrupt typing or drop part of a command.
- Bound silent model connections and stalled streams, preserve partial output,
  and stop without automatically replaying an uncertain paid request. Detailed
  reasoning and tool activity are visible by default, with a saved Compact option;
  errors keep their explanation when collapsed and cannot leave a stale retry spinner.
- Separate local preparation, gateway admission, response headers, and readable
  output timings so a silent connection is no longer presented as active thinking.
- Removed ~31 MB of never-loaded fonts and favicons, dead frontend and backend
  modules, duplicated helpers, and the tests that only asserted source text.
  `bun run check` and Fast CI now run the frontend unit suites too.
- `openscience web` explains when the workspace UI is not built into a source
  checkout instead of opening a broken tab.
- Fixed 62 dangling script and reference paths in bundled skills; the
  `scientific-schematics` generator is now addressed by its skill path.
- openscience.sh is a short page again: the hero, one product panel, how it
  works, the sources it searches, why it is safe to run, five questions.
- Every workspace font size now comes from the token scale (13px is named
  `--font-size-medium`; half-pixel sizes snapped to the nearest step), and the
  Models panel says what auto-reload does.

## v2.0.70 — 2026-09-04

Everything below shipped across v2.0.24 through v2.0.70. Per-release notes,
signed installers, and checksums are on [GitHub Releases](https://github.com/synthetic-sciences/OpenScience/releases);
the CLI is `@synsci/openscience` on npm.

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
