# Changelog

All notable changes to OpenScience are recorded here. The project follows
[semantic versioning](https://semver.org). Releases are cut from `main` via the
`publish` workflow and published to npm as
[`@synsci/openscience`](https://www.npmjs.com/package/@synsci/openscience); each
tagged release also ships native binaries for Linux, macOS, and Windows.

## Unreleased

### Added

- Added a pinned, inspectable protein-binder workflow skill that selects a
  supported BioNeMo path from the credentials and compute capabilities actually
  available, without pretending unavailable NVIDIA services are configured.
- Added a visible local-model settings surface and real Ollama context-window
  controls that create tuned `num_ctx` aliases through Ollama's native API.
- Added a conversation-first Research harness with bounded Normal and Ultra
  delegation, persistent Python and R analysis, governed remote compute, and a
  reproducible trajectory dashboard for harness evaluation.

### Changed

- Made the user-facing Research agent use the proven minimal collaborative
  prompt, lazy skills and MCP capabilities, and the same thin runtime for
  delegated specialists. Removed the mandatory research-contract and eager
  capability prose from ordinary work while preserving explicit tools,
  permissions, evidence, compute, and durable Results.
- Materialized a small request-local tool set on every Research turn, with
  loaded skills activating only their bounded scientific capabilities, and
  simplified delegation to level, worker model, and agent independence.
- Stopped bundling or offering Atlas through the OpenScience npm distribution
  and `synsci` launcher, including both graph-initialization slash-command
  skills, while preserving automatic native-binary installation.
- Replaced the retired Ace subscription copy with pay-as-you-go managed credits:
  one wallet for OpenRouter model usage and enhanced search, 20-credit reloads
  below a 5-credit balance, and no scheduled monthly top-up.
- Retired managed-compute billing and budget behavior while preserving local,
  SSH, scheduler, and other user-owned compute workflows. Deprecated 2.x config
  and SDK fields remain as inert compatibility shims for this patch release.
- Added Ask for approval, Approve for me, and Full access presets directly to
  the composer’s Research tools menu, with trusted Full access as the default
  for new local projects and explicit or managed restrictions preserved.
- Simplified the project sidebar, model and effort controls, chat typography,
  sent-message surfaces, and Compute into a quieter results-first workspace.
- Unified logical model names while keeping API-key and ChatGPT access routes
  explicit in both the composer and Settings.
- Let untrusted projects run routine terminal, kernel, shell, and local-compute
  work immediately inside the enforced native sandbox, while keeping project
  extensions, remote compute, package installation, and host execution behind
  explicit trust or stricter managed policy.

### Fixed

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
- Added coherent compute waiting and Modal image diagnostics, preserved active
  remote jobs during evaluator cleanup, and stopped trusted encrypted
  credential updates from aborting unrelated live sessions.
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
