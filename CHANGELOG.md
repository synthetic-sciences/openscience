# Changelog

All notable changes to OpenScience are recorded here. The project follows
[semantic versioning](https://semver.org). Releases are cut from `main` via the
`publish` workflow and published to npm as
[`@synsci/openscience`](https://www.npmjs.com/package/@synsci/openscience); each
tagged release also ships native binaries for Linux, macOS, and Windows.

## Unreleased

### Added

- **The desktop app installs its command-line tool.** **Customize → General → Command line tool** links `~/.openscience/bin/openscience` to the app's own copy and adds that folder to your shell's startup file the way the standalone installer does, so `openscience` in a new terminal opens the running app. The row says whether the tool is installed and on your PATH, and shows the line to add when it is not. On every launch the app re-points a link of its own that names a moved or reinstalled bundle; it never creates a link you did not ask for and never replaces an `openscience` it did not create. `openscience uninstall` run from that link removes the link and the PATH line. The Linux AppImage runs from a temporary mount and cannot be linked, so the row says to use the standalone installer there; Windows is unchanged.

### Changed

- **The update notice offers only what this build can do.** Off macOS, and in an unpackaged build, there is no in-app download, so the launch notice no longer promises a one-press **Download and restart** it cannot honour. It says the release is available and offers **Download installer**, which opens the release page; the macOS app keeps the one press. Customize → General says the same thing as the notice, in its own words for its own button.
- **The folder picker works on Windows.** Drive letters, UNC shares and backslashes are understood everywhere the
  picker touches a path: the breadcrumbs, the parent-folder button, the typed path field, recents, and the label for
  the current folder. The macOS-only Applications shortcut and the Full Disk Access hint appear only on macOS.
- **A slower answer no longer wins.** The server dialog's health dots, the folder picker's navigation, and the
  composer's `@` and `/` menus ignore a reply that a newer request has overtaken, so Enter can no longer pick a row
  from the query you already replaced. While the `@` picker's file search is still running it says so, instead of
  saying there is nothing matching yet.
- **Time budgets restart with the request that sets them.** A second timed request measures from its own deadline and
  gets its own reminders instead of measuring from the session's first message and staying silent, and the "half the
  budget" reminder no longer arrives after the 85% one.
- **Parallel tool calls sent to Mistral stay distinct.** Identifiers were shortened to nine characters, which
  collapsed every call made in the same few seconds onto one identifier; each call now keeps its own.
- **Deliverable checks stay inside the approved output roots.** A named output that resolves outside the session's
  tool directory or the project, through `..` or a symlink, is reported as outside them rather than opened and
  validated, and an output spelled out as a full Windows or UNC path is no longer reduced to its bare file name and
  demanded in the project root.
- **Files opens where the work is.** The pane used to land on Project files, the managed project directory that is empty until something writes there, while the folders you connected sat behind **More**. It now opens on the folder this conversation works in — whichever the composer names, scratch included — keeps whatever you picked last, and gives connected folders their own tabs beside Project files (up to three; the rest stay in the menu). The location menu hangs from the trigger's right edge when the left edge would push it past the pane, so paths and access badges stay readable.
- **A connected folder can be disconnected from Files.** Every connected row in the Files location menu has a **Revoke** control. It names the folder and the access it ends, then revokes the grant across its scope and stops the kernels that mounted it; the pane moves to another location and forgets the one it lost. A failure says so and leaves the folder connected.
- **Files lists a working folder it did not connect.** A conversation delegated by another works in its lead's folder, and a folder approved for the whole installation can be the one a conversation writes in. Neither was a location the pane offered, so Files fell back to Project files and the folder actually being written in had no row at all. Both are now listed beside the folders connected here, with the same access badge, and the pane opens on whichever one the conversation works in. A folder inherited from a lead session is browsed from here but not revoked from here: that grant is the lead's to end.
- **Files waits for its location instead of flashing the project root.** With the right pane left on **Files**, the pane opens on the first paint of a conversation, before the folder it works in is known. It listed **Project files** — the managed project directory that is empty until something writes there — then showed the loader, then the working folder. It now shows the loader from the first paint and opens on the working folder. A conversation whose folders cannot be read, and a route with no conversation yet, still list the project root rather than waiting on an answer that is not coming.
- **A revoke from Files says how far it reaches.** The confirmation named the folder and the access it ends, so a folder approved for every project read exactly like one connected to this project alone. It now says whether this session, this project, or every project loses access to the folder, in the words **Customize → Permissions** uses for the same grant.
- **One loader for every loading screen.** The desktop splash, the workspace's route and session loading, first-run setup, the inspector, the Files list, Settings panels and the projects page all show the atom mark assembling itself with a caption that says what is happening ("Starting your local workspace", "Opening session", "Loading files"). It draws in the theme's own text colour on the app background, in light and dark, and the splash paints the colours the workspace is about to use (following the system appearance when the scheme is System) instead of a fixed dark page. Screen readers hear each caption as the mark's label. Small inline spinners in buttons and message rows are unchanged.
- **The Skills catalog waits on the same mark.** Loading the catalog showed a refresh glyph over "Fetching the latest catalog…"; it is now the atom mark captioned "Loading skills", like every other surface that waits.
- **Customize forms and sub-sections share one recipe.** The connector form, SSH host form, and Local models' SSH and direct-endpoint forms are the same bordered form card with 28px controls and right-aligned actions; the two Local models forms open from a row instead of sitting open. The rail names its groups (Account, Models, Research, System).
- **Every Customize tab reads like General.** One row grammar across all thirteen tabs: General's 12px medium title, one muted line beneath it, a 20px brand mark or glyph at the left where a row has one, and one control at the right. Tags, pills, counts, header buttons and monospace titles are gone; statuses are plain text and titles sit on the content's left edge.
- **Direct hosting for Ace OpenAI and Google models.** GPT-6 Astra, GPT-5.6 Sol/Terra/Luna, and graph embeddings use Azure. Gemini chat and Nano Banana Pro use Google's Gemini API. The gateway preserves existing model selections and applies the provider token rates plus the existing funding fee. Rates identify the host; Fast is unavailable on these routes. Nano Banana returns PNG. Direct API-key and ChatGPT connections remain available.
- **Compute approvals are bounded by time, not bound to one plan.** A Modal
  job used to ask on the SHA-256 of its exact plan, so "this session", "this
  project" and "always" each stored a grant nothing could match again and the
  next job, a different script, asked afresh; one waited overnight for its
  answer. A job now asks under a time allowance when you granted one and its
  timeout still fits beside the job time already dispatched there; otherwise
  it asks on its exact plan and offers an allowance beside it (four times the
  job, in whole hours, one to eight). Approving a study also grants an
  allowance equal to its hour budget for the refit and baselines that follow
  its runs. Full access asks once per allowance. The Permissions page names
  what each standing approval covers.
- **One request card.** Approvals came in three layouts and questions in a
  fourth. Every request now has the same shape: the kind as an eyebrow, the
  decision in one line, the facts you judge it by in one quiet line, the full
  plan behind **Details**, and Deny · Allow… · Allow once in the same order.
  A Modal card's scopes say what each adds; a study card keeps **Approve
  study** and gains a project scope; a hosted scientific request stays
  one-time.
- **Quieter errors.** A failed turn or tool keeps the neutral surface with a
  thin critical accent instead of a filled red box; the retry line leads with
  its state ("retrying (2) in 12s") and shortens the reason to one sentence,
  with the full text in the tooltip; the gateway's router code closes its
  message as a detail rather than interrupting the sentence.
- **Background workers are visible.** While a worker dispatched in the
  background is still running, the composer says so and that its report will
  start a new turn; the model is told to say the same when it ends a response.
- **`study reopen`.** A concluded, halted or paused study continues under the
  additional budget you agree to, with its runs, ideas, lessons and best run
  intact, instead of a second study that starts from nothing.
- **Large inputs by name.** The 100 MiB Modal staging limit now applies to
  what a glob or the default sweep picks up; a file named by its exact path
  (a checkpoint, a dataset) may be up to 2 GiB, 4 GiB in all, and the approval
  card lists it with its size and hash.
- **Tools that say more.** `compute_job artifacts` names the root its
  delivered paths are relative to and whether it is scratch or Project files;
  an interrupted `compute_job wait` says the job keeps running rather than
  "Tool execution aborted"; `generate_image` on Ace checks the Wallet before a
  render and reports the balance after; `read` returns a PDF's extracted text
  beside the attachment and an image's dimensions; `skill` answers a repeat
  load with a receipt; `webfetch` takes `select` paths for JSON and cuts an
  unselected document past 40k characters; `literature read` answers a query
  that matched nothing with the paper's section outline.
- **Study updates repeat their rules once.** The state travels whenever it
  changes; the loop's instructions once per study. The review gate names a
  worker that exists.

### Fixed

- **"Download installer" says what it does.** Where the app cannot stage an update itself (Windows, Linux, and an unpackaged build), the launch notice and Customize → General → Check for updates sat a **Download installer** button beside "Download in the background, then choose when to restart." Nothing downloads in the app there and there is no restart to choose: the button opens the releases page. Both now read "Get the installer from the releases page and reinstall to update.", with **Download installer**, **Later** and **What's new** unchanged. The macOS app, which does stage updates, keeps its own wording.
- **The desktop shell run from source starts cleanly.** Running `frontend/desktop` unpackaged against a sidecar built from source opened a working window and then put "OpenScience could not start" on the splash, every launch: the final startup check required the runtime to report the shell's own version, and a from-source runtime reports its build stamp instead. An unpackaged shell, or one pointed at a runtime with `OPENSCIENCE_DESKTOP_SIDECAR`, now checks that the runtime is live and writes the version it reports to stderr. The packaged app still accepts only the exact runtime version it shipped with, as does any launch that is proving a self-update. `frontend/desktop/README.md` has the steps.
- **A stopped server actually shuts down.** `openscience serve` and `openscience web` have a shutdown that drains connections, releases the runtimes a session left running and withdraws the local-server advertisement — and none of it ran. The modules that spawn kernels install their own SIGTERM and SIGINT hooks so a kernel can never outlive its parent, and those hooks ended the process first, on the spot, with 143. The server now owns the signal and those hooks defer to it, so Ctrl+C and `kill` stop the server in order and exit 0; kernels are still torn down on the way out, and a second signal still takes the immediate exit for anyone who has waited long enough. A runtime that will not release is a warning naming it rather than a fatal error, and the whole stop — not just the drain — is bounded, by the patience of whoever is waiting for it.
- **One composer menu at a time.** Tools, the working folder chip, the model picker and the effort picker were four separate menus that each only closed themselves, so opening one left the others open on top of each other. Opening any of them now closes whatever else is open, and the working folder menu closes on a click outside it like the rest.
- **"Updated to OpenScience X" is said once.** The desktop app replayed the
  post-update notice on every launch, because the stored update result was
  re-read at each start and nothing recorded that it had been shown. A served
  result is now acknowledged on disk, so the notice appears on the first healthy
  launch after an update and never again — dismissing it holds too. A failed
  update still reports itself until the next attempt.
- **"Updated to OpenScience X" is said once.** The notice belongs to the launch
  that proves an update healthy, which publishes it from memory; the installer
  then left a result file behind that a later launch read and said again, and
  Settings → General repeated it for as long as the file lasted. The installer
  now records that the notice was already shown when it writes that result, and
  the launch that does serve one — after a recovered update, which is shown for
  the first time — acknowledges it on disk. So it appears once and never again,
  and dismissing it holds. A failed update still reports itself until the next
  attempt.
- **A newer release is offered on launch, and installs in one press.** The
  startup notice now says "OpenScience X is available" whenever a newer stable
  release exists, even while the previous update's result is still on screen,
  where the download action used to be hidden entirely. Its primary action,
  **Download and restart**, downloads, verifies and restarts without a second
  press, keeping the pause-and-continue confirmation when agent turns are
  running; **Later**, **What's new** and **Cancel download** are unchanged.
  Settings → General → Check for updates reads the same state.
- **The CLI that comes with the desktop app knows where it lives.** Running `openscience` from a terminal while the app is open now opens a tab on the server the app already started, instead of a second server on port 4096; the app's sidecar advertises its port in the data root, and a record left by a process that is gone or a different version is ignored. `openscience upgrade` on that copy explains that the app updates it (Customize → General → Check for updates) instead of reporting a manual or dev install.
- **A second `openscience` reuses the first one's server again.** The check that a running server owns a matching workspace asked for `version.json` as an API call, which the server answers with a 404 before it serves any file from the bundle, so every launch started another server.
- **Files a worker leaves in its own scratch open from the lead's transcript.** The lead session now holds read access to each delegated child's workspace, so a report's side outputs (rendered pages, staged inputs, tool output files) open instead of failing silently.
- **One PDF viewer.** A saved Result's PDF shows its pager and zoom in the file header like every other file view, and the viewer's own bar, where it still appears inline in chat, matches that header.
- **A declined reload card is named.** When Ace pauses because the Wallet's card was declined, the message says so and points at the card update instead of "the last charge failed recently" or a reload that never completes.
- **Full access no longer asks for kernel package installs.** `pip install`
  through the shell ran without a card under Full access while the same
  install through the Python or R kernel asked on every plan; the prompt was
  an inconsistency, not a boundary, and is gone. Ask risky still asks for
  each exact change, and paid compute keeps its card. The card also names
  the packages ("Install pymupdf, pdfplumber in Python") instead of "the
  PYTHON environment".
- **The deliverables checklist stays anchored to your first request.** Every
  prompt carries an internal marker, so the anchor that filtered on it never
  saw an earlier message, and a background worker's report (arriving as a
  synthetic prompt) could define the checklist: fourteen paths it had
  audited, a shell variable and elided `...` prefixes among them, followed by
  two rounds of "produce the real file" and copies of sealed test labels in
  scratch. Synthetic parts never specify deliverables, and an abbreviated path
  is not a file.
- **A dispatch that dies before the command runs hands the idea back.** Two
  study starts seconds apart rewrote the tracking SDK in the shared root; the
  first run's Modal dispatch compared the file's size against its approval
  mid-rewrite, failed, and the one-run-per-idea rule consumed the idea. The
  SDK is left alone when its bytes match and otherwise appears whole; a job
  that fails in staging, approval drift or upload before its command ran
  returns the idea to the queue and stays outside the run budget.
- **Streaming no longer duplicates code blocks.** The copy button's frame was
  added to the live DOM after each render while the next parse arrived bare,
  and the frame was protected from discard, so every streamed update past a
  code block left one more stale copy (a 14k-character answer with three
  one-line blocks ended with fifty). The parsed side is framed first.
- **A prune inside the cache window clears only the shortfall.** The loop's
  capacity checks pruned every old result while the provider's prefix was
  warm, re-reading 143k tokens to reclaim 70k; they now clear what the budget
  needs, newest-eligible first.
- **Hosted Boltz-2 and OpenFold3 runs finish instead of ending in "status polling returned non-terminal HTTP 404".** NVIDIA's Boltz-2 NIM always answers `pae: null` and `pde: null` (deprecated in its JSON response), and OpenFold3 answers `iptm_score: null` for a single-chain input, which has no interface to score. The output schemas rejected both, so every completed result was discarded, no artifacts were written, and the run fell through to a status route that answers 404 for these synchronous NIMs. Both nulls now parse. A response NVIDIA marks fulfilled that still fails its output schema is reported as that, naming the offending fields (paths and types, never response values), and is no longer polled.

## v2.0.115 – v2.0.119 — 2026-09-17

### Changed

- **Simplified download page.** Removed the "Build with OpenScience" integrations section from openscience.sh/download.
- **Model access, rebuilt.** The Ace page's Model access card is five rows
  with one control each: Ace (state and Manage), Wallet (available amount and
  Add funds), Auto-reload (its rule and state), API key, and Preferred model
  access. The Authorization terms fold and its paragraph are gone; that
  contract is read and accepted in the browser consent flow. The routing
  options explain themselves on hover instead of in truncated sentences.
- **Auto-reload shows your workspace's own rule.** The threshold and amount
  come from the account rather than the public default, so a workspace set to
  reload $50 below $10 reads that way. Docs say the same.

### Changed

- **Model options say the rate once.** The popover no longer repeats the
  price under Fast mode, reassures about a context step that cannot happen,
  or footnotes the fee. One Rate line reflects the selections above, in the
  provider's own price (the Wallet's funding fee is named in the row's
  tooltip and added at billing), and a second quiet line appears only when
  the chosen context window can reach the long-prompt tier. Context windows
  are labelled by size (`272K`, `1.05M`).

### Changed

- **Settings, redesigned.** The dialog follows one grammar on every page:
  a title with a single quiet line, small muted section labels, bordered
  cards whose rows are divided by hairlines, copy on the left and one control
  on the right. Status is plain text (no pills or dots), logos and glyphs sit
  flat at one size, and every row action is the same small button. The rail
  reads as spaced groups without labels, ends in your account, and opens on
  General.
- **Ace has its own page.** Account (sign-in, workspace credentials, funding
  workspace) and Model access (Ace, Wallet, auto-reload, authorization terms,
  preferred model access) moved out of General and Models into **Ace**, laid
  out as rows. Data & privacy moved to the end of Permissions.
- **Network approves everything by default.** A fresh install reaches the web
  without a domain gate, with every curated service group already on so the
  gate starts from the full catalog if it is turned on later.
- **New icon set.** Lucide replaces Iconoir across the app: even 1.5px strokes
  on a 24px grid, one glyph per concept in the settings rail.

### Changed

- **Updated website attribution.** The shared footer names InkVell Inc. (dba Synthetic Sciences) and no longer displays the Apache 2.0 link.

- **A clearer OpenScience download page.** Desktop downloads are grouped by platform above the terminal install commands, with a shared footer for product, resource, and privacy links. The homepage workspace preview extends wider while patterned page gutters remain visible at every window size. Smoother spacing, complete mobile install commands, and a continuous sticky header keep the preview and surrounding content from looking clipped.

### Fixed

- **Waiting for the Wallet no longer ends the turn.** When a lead and its
  workers share a small Wallet, each request reserves its worst-case cost and
  the rest wait for those holds to settle; the wait was capped at five 15 s
  retries, so on a $7 Wallet with four workers a step gave up while the others
  were still finishing, with the card reading "needs $1.39 for this step; $0.09
  is available" although the Wallet held $6.81. The wait is now budgeted by
  time (ten minutes), and the card shows the gateway's explanation: what is
  held by requests in flight, and what auto reload is doing ("a reload is on
  its way", "did not run: this month's reload cap is reached", "the last
  automatic reload failed (card_declined)").

### Fixed

- **"Pause and restart" works from the update banner.** Choosing it while an
  agent was running failed with "No context found for instance" on the packaged
  app (found while updating an isolated v2.0.113 desktop with a turn in
  progress): the restart route runs outside any project instance, and turns
  belong to their instances. The pause now enters each live instance to stop
  its own turns; the plain refusal ("Finish active work before restarting")
  was unaffected. The regression test invokes the pause the way the route does.
- **Desktop starts about two seconds sooner.** Launch verified the running
  bundle twice: once shallow with the Gatekeeper assessment, then again deep
  with a second assessment while reconciling interrupted updates. Measured on
  an isolated packaged app, the two verifications were most of the five
  seconds between the process starting and the local runtime being spawned.
  Reconciliation now reuses the trust established at launch.

## v2.0.111 – v2.0.114 — 2026-09-17

### Changed

- **A busy Wallet no longer fails the turn.** When a lead and its workers ask
  the model at the same moment, each request reserves a hold; on a small Wallet
  the holds can add up to the whole balance and the next request was refused
  with "Available: $0.00 ... auto reload could not top it up" while the Wallet
  was far from empty. The gateway now reports the real amounts (balance, held
  by requests in flight, available) and marks that refusal retryable;
  OpenScience waits for its own requests to settle (15 s per attempt) and sends
  the request again instead of ending the step with an error. Auto reload's
  threshold is measured on spendable funds, so a Wallet whose balance is held
  by in-flight requests reloads when the person consented to it.
- **Slim Modal images get `libgomp1`.** LightGBM and several OpenMP-built wheels
  import `libgomp.so.1`, which `python:3.12-slim` does not ship; two study runs
  failed on it after their image built. When Python packages are installed onto
  a `-slim` image, one apt layer adds the library first.
- **Keys & subscriptions says what the Wallet still funds.** The Model access
  card and the Ace docs now state that in this mode the Wallet funds what your
  keys cannot: a model no key covers, web search without a Firecrawl key, and
  image generation; each such call is marked `funding: wallet` in the trace.
- **Figure loops in a worker.** The schematics skill says when to delegate: one
  figure is faster inline, two or more (or one while you still have text to
  write) are worth a background worker each, briefed with the component list,
  the threshold and the output path. Measured: a delegated 2K schematic took
  3.2 minutes while the lead wrote the caption in parallel.

### Fixed

- The study approval card's title and purpose ran together; it now uses the
  same layout as the other compute cards.
- The sidebar refetches its session list after the event stream reconnects and
  retries a failed list load once, so a rename or a new session cannot stay
  stale until reload.

### Added

- **Agents as in OpenCode.** Type `@` in the composer to hand a job to a worker
  directly (`@explore where is the split decided?`); the built-in workers are
  listed with a one-line summary and a worker can opt out with `hidden: true`.
  A configured primary agent is now selectable in the app: an agent chip
  appears beside the model control once a second primary exists, and `Tab` in
  an empty composer cycles them. A `general` worker joins the six built-in
  workers for briefs that fit no specialty. Agent `color` accepts theme colors
  (`accent`, `primary`, …) as well as hex, and `openscience agent create`
  writes `permission:` rules instead of the deprecated `tools:` map.

### Changed

- **Compaction rows say what happened.** The trace shows
  `Context compacted · 92K → 6.1K tokens` once a fold's sizes are known, and no
  longer shows the runtime's own "continue from the handoff" instruction as a
  row. A head whose own estimate exceeds the window goes straight to the
  reduced-fidelity summary instead of sending a request that can only overflow;
  a summary that could not be produced leaves no empty record; and a restart
  that pauses a summarizer no longer announces a compaction that did not happen.
- **Schematics get trimmed.** The schematics skill ships
  `scripts/trim_margins.py` and its finalize step runs it: an image model paints
  the whole 16:9 canvas, so a wide flowchart arrived with empty bands above and
  below it that would have wasted half a page.
- **`explore` asks for outside paths.** The read-only scout's wildcard deny
  also covered `external_directory`, so a dataset in `~/data` was refused
  outright; it now asks like the lead does. A denied tool call now says which
  permission and pattern were refused instead of dumping the ruleset as JSON.

### Fixed

- **The BioNeMo NIM adapters were unreachable from a session.** The
  `scientific_capability` tool, the one gateway to the ten hosted NVIDIA
  BioNeMo NIMs, had been dropped from the tool registry in the harness-core
  rewrite and never re-offered, so every "predict this with Boltz-2" ended in a
  guess about Modal secrets. It is registered again, offered to the biology and
  chemistry specialists and unlocked by the new `bionemo-nims` skill, which
  documents the hosted route (list, describe, plan, start, wait, artifacts; one
  approval per request) and, without a key, says exactly where to connect one.
- **Image generation retries a gateway hiccup.** A 502/503/504 from the image
  service (a Cloudflare page from the upstream proxy while it restarted) failed
  the figure and echoed the HTML into the transcript; the tool now retries once
  after two seconds and, if that fails too, reports the status in one plain
  sentence.
- **The Modal Volume bridge no longer picks a broken ambient Python.** The
  previous release accepted any system `modal` ≥ 1.1.2; an install whose
  `certifi`/`aiohttp` live only in the user site (invisible under `-I`) imports
  fine and then fails on the first block download, which is exactly what
  happened to a job's artifacts after a restart. The probe now imports what a
  download needs and falls back to the pinned `uv` runtime otherwise.

### Added

- **Ace API keys work like OpenCode Zen's.** Model access → Ace has _Use an API
  key_: paste a key from the dashboard's Settings → Keys and the gateway bills
  the workspace the key was created in, whether or not an account is signed in
  here and whichever organization it belongs to. The card labels the credential
  (`API key · Lab`), _Manage Ace_ opens that workspace's own billing page rather
  than the signed-in account's Personal wallet, and signing out forgets a pasted
  key on this device without revoking it for anyone else. A key pasted into
  Provider API keys is redirected there instead of refused. On the gateway, a
  "Personal" key is now pinned to the Personal workspace like every other key,
  and older unpinned keys resolve to their owner's Personal workspace at
  authentication, so a client that names that workspace is no longer locked out
  with 403 on every funded call.

### Changed

- **NVIDIA BioNeMo: the DiffDock route and the repo's front door.** The hosted
  DiffDock endpoint moved to `/v1/biology/mit/diffdock`; the old
  `/v1/molecular-docking/diffdock/generate` path answers 404 (NVIDIA's own
  reference page still prints it), so every DiffDock dispatch failed. README
  gains a BioNeMo section naming the ten NIM adapters and the Agent Toolkit the
  binder-design skill is adapted from; the capability map, service-credentials,
  molecular-research and genomics pages and the generated tool catalog now say
  which entries are BioNeMo NIMs and link the toolkit; the skill names the
  toolkit's canonical workflow paths.

- **Modal: current SDKs, working recovery, honest ceilings.** The JavaScript SDK
  moves 0.9.0 → 0.10.1 and the Python Volume bridge accepts any installed
  `modal` ≥ 1.1.2 (installing 1.5.5 when none is present). Recovery and release
  probe a recorded sandbox before trusting it — `sandboxes.fromId` stopped
  validating ids in 0.8.0, so a sandbox that had vanished was reported as
  "not found" instead of its durable volume being harvested — and the local
  channel is detached once a sandbox exits. Tool schemas stop advertising 128
  GPUs and 1,024 CPUs: 8 GPUs (4 for A10), 64 CPUs, 1 TB, with Modal's GPU
  names and the `H100:2` syntax in the descriptions and docs.

- **Compaction retries at reduced fidelity before giving up.** When the
  summarizer's own request overflows the window, one more attempt runs
  standalone with every tool result cut to 2,000 characters and media
  stripped; only if that overflows too is the turn too large to compact.

- **Workers inherit the lead's denials.** A session rule that denies a tool or
  gates a directory for the lead now travels to every worker it dispatches; a
  worker can never do what the person told the lead not to do.

- The delegation row names the worker's tool in flight (`Running · 2m 10s ·
Reading old paper`), and `autoresearch` says that `openscience_track` is the
  bundled tracking module, not a package to search for.

### Fixed

- **Restart to update no longer dead-ends on a running agent.** When agent turns
  are the only thing running, the update banner offers _Pause and restart_: each
  turn is paused under a named reason ("Paused to install an update"), its
  pending tool calls are closed with that reason, and the next process continues
  the turn where it stopped through the same path that resumes work after a
  crash. Terminals, kernels and MCP requests still have to finish first, and the
  refusal now lists them. On the desktop, a restart whose runtime handoff failed
  released nothing: Retry and Discard answered "already restarting" and Quit
  demanded proof of a disposal that never happened; the latch is now released,
  so the staged update can be retried, discarded, or the app quit normally.

- **Approving a study approves the study.** The approval card a study raises
  before its first remote run showed the exact-plan compute card with _Allow
  once_ as its primary action, which satisfied only the `create` call: the
  first `start` asked again, and a headless run waited on it. The study card
  now names the study, target, budget, concurrency and kill rule, and its
  primary action, _Approve this study_, grants the study's pattern for the
  session so every run inside the budget proceeds; _Only this request_ remains
  available.
- **A run's kill clock starts when its job starts.** A study run's record is
  written before dispatch, and dispatch waits on the approval card for as long
  as the person takes; the kill rule then measured from the record's creation
  and killed the first run of a study ("time budget reached (12 minutes)") six
  seconds after its Modal sandbox was requested. The clock now starts when the
  compute job is bound to the run.
- **A study's hour budget counts compute time.** `maxHours` and the
  `elapsed_hours` the `study` tool reports now run from the first run's start,
  not from the study's creation; the minutes spent writing the harness and
  waiting for the Modal approval no longer eat into the two hours the person
  agreed to.
- **The desktop starts several seconds sooner.** The running app's own
  signature was verified with `codesign --deep` on every launch before the
  splash could appear, re-checking hundreds of nested binaries; the running
  bundle is now verified shallow (its outer seal covers the nested code, and
  Gatekeeper assessed it at launch), while downloaded updates are still verified
  deep before installation.

## v2.0.106 – v2.0.110 — 2026-09-16

### Added

- **Image generation is a core capability with three routes.** `generate_image`
  renders Nano Banana Pro through Ace (the managed gateway's funded image
  endpoint, which the client had refused to use behind a stale "not proxied"
  comment) or the user's own Gemini key, and GPT Image 2 through the user's own
  OpenAI key (generations as JSON, edits and references as multipart). A
  personal OpenRouter key is no longer an image route. The billing mode picks
  the route as it does for chat, the environment line names the model and
  route in use, and the tool's receipts and errors name them too. The
  `schematics`, `figures`, `paper-writing` and `ml-paper-writing` skills now
  render every diagram, schematic and illustration with the tool and never fall
  back to hand-drawn TikZ, SVG or Graphviz; `generate-image` and
  `scientific-visualization` join the core skill index; the TikZ scaffold is
  gone.

- **Schematics render under publication standards, scored before they ship.**
  `generate_image` takes a `purpose`: `schematic` prepends the scientific-diagram
  framing adapted from K-Dense's scientific-schematics skill (white background,
  one sans-serif face, Okabe-Ito palette with one accent, one reading direction,
  labels verbatim, nothing invented, no figure numbers or captions inside the
  image) to every render, `illustration` frames a conceptual figure or graphical
  abstract, and `edit` keeps the instruction bare. The `schematics` skill is
  rebuilt on the K-Dense loop: a component-by-component description, a 1K
  render, a five-criterion score (accuracy, clarity, labels, layout, appearance)
  against the document's threshold (journal 8.5 down to slides 6.5), one
  critique-driven re-render, then the 2K final; its references carry the
  K-Dense publication standards and review guide. `generate-image` adopts their
  five-sentence prompt structure, and `scientific-visualization` is the current
  upstream release (v1.2) with its publisher profiles and the metadata, palette
  and export audit CLIs.

- **An explicit `/skill` is loaded by the loop, not requested of the model.**
  Typing `/scientific-visualization` had produced a system instruction to load
  the skill "before substantive work", which a model could and did skip in
  favour of a skill it judged closer. The loop now performs the load before the
  first step of the turn (one assistant wrapper carrying the completed `skill`
  tool call, marked `invoked`), so the instructions and the tools the skill
  unlocks are in place when the model reads the request. `/autoresearch` gets
  its `study` and `experiments` tools the same way.

- **The `@` picker reads like Cursor's.** Name first with the folder dimmed
  beside it, grouped under Recent and Files & folders, folder icons for
  directories, and a pane beside the list that draws the active row's place in
  the tree when the composer is wide enough. Browsing with nothing typed lists
  the project's top level (folders before files at each depth) instead of its
  deepest directories, and generated caches (`__pycache__`, `.ruff_cache`,
  `node_modules`, `.venv`, the study SDK) stay out of results unless the query
  names them.

- **The Context dialog shows the window, not a grid of sixteen numbers.** A
  headline says how full the window is and a segmented bar shows what fills
  it, with a legend of the recorded buckets; the exact counts sit in two cards
  (last request, session); custom instructions and raw messages fold away.

- **Model options has one shape on every route.** The effort ladder sits on a
  six-track grid that centres a short last row instead of leaving one option
  hanging; Speed is a heading with the Fast toggle and, where a route does not
  offer it, a note saying which route does. Each control carries its own price
  consequence in the popover's quiet secondary voice: under Fast, `2× the
standard rate · $4.22 in · $21.10 out /1M`; under the context cap, whether
  the long-context step is reached and what it costs; and a footer row states
  the rate in force (`Rate` or `Fast rate`) with its basis (Wallet rate with
  the funding fee, or a catalog estimate). Context caps read `272K` and
  `1.05M`; Codex GPT-5.6 models offer the same cap choices as their OpenAI
  siblings and Astra offers Fast on the direct OpenAI route as it does through
  Ace.

- **The Model access card is one header and two rows.** Ace's identity, status
  and one-line purpose on the left; the Wallet on the right as what is spendable
  now (`$700.50 available`, the held amount named only while turns hold funds)
  beside the one action that applies; an Auto-reload row with its On/Off state,
  the amount and threshold, a Manage in Wallet link and the authorization terms
  folded beneath; and Preferred model access as two radio rows whose fixed
  one-line consequences read side by side. Signed out, the card is the header
  row plus one sentence.

### Changed

- **A failed turn says what kind of failure it was.** The card carries a
  heading from the failure class (the model service did not answer, rate
  limited, credentials rejected, request too large, the request was rejected),
  the sentence to act on, and the HTTP status, gateway router code or edge
  request id set apart in mono type for a support report instead of inside the
  copy; `ROUTER_EXTERNAL_TARGET_CONNECTION_ERROR_CD8 sin1::…` no longer reads
  as the message.

- **A delegated worker is one row that opens its session.** The Task card no
  longer folds the worker's handoff behind a chevron: the row shows the job's
  title, the agent, its state and duration, and clicking it opens the worker's
  session where the transcript and handoff live. A worker waiting on a
  permission or question still surfaces the request under the row; files it
  saved appear as chips. The Task tool's `description` is now a one- to
  three-word title and names the child session as is.

- **Reports are checked page by page.** `paper-writing` and `ml-paper-writing`
  say how to place floats (`[t]`/`[tbp]`, sized to the width they need, no two
  floats stacked on a page with a sliver of text between them) and to render
  page thumbnails with `pdftoppm` into scratch and read them before shipping.

- `generate_image` receipts name the file relative to the project (or the
  session directory), never as a climb out of the session scratch.

### Fixed

- **A few large figures no longer kill a turn on Ace.** `read` attaches an
  image's bytes in full, and the only per-request limit was a count (20 recent
  images), so three 2K schematics made a 14 MB request that the managed
  gateway's edge proxy dropped with a bare `ROUTER_EXTERNAL_TARGET_CONNECTION_ERROR`
  502, and six retries of the same body burned two minutes before the turn died.
  Inline images are now budgeted in bytes per request as well: 2 MB on the Ace
  route, 12 MB on a provider's own API, filled newest-first and released by
  halves so the cached prefix stays put; an image over the route's cap is
  replaced by the resize nudge instead of shipped. The gateway's router codes
  are explained in the error instead of echoed. The schematics skill scores
  the 1K render and leaves the 2K file unread.

- Restored authenticated session trace delivery after the uploader was removed.
  Trace sharing is on by default for signed-in accounts, including user-owned
  routes, while preserving saved opt-outs. General settings now expose a device
  switch and delivery status. Records contain redacted prompts, responses, tool
  activity, and provider-reported usage; missing amounts remain unavailable.
  Retries retain event IDs and require matching server acknowledgements.

- **The context pill is measured against the window in use.** A tiered model
  such as GPT-5.6 is budgeted at its first pricing boundary (272K) unless the
  full window is chosen, and compaction fires against that cap, but the header
  pill and the dialog divided by the model's raw 1.05M maximum: 11% while the
  cap was nearly half used. Both now use the chosen or default cap and say
  when it sits below the model maximum.

- **Running out of Ace funds reads as a sentence, not a code.** The managed
  gateway's payment-required answer is a machine contract (`insufficient_balance`,
  cents, a recovery action); the turn showed it raw. It now says what is left,
  what the request reserves, and what to do: add funds or turn on auto reload,
  ask the workspace's billing manager, wait for the automatic reload that is
  already running, or raise the monthly usage limit, each with the Billing
  link.

- **Running out of Ace funds reads as a sentence, not a code.** The managed
  gateway's payment-required answer is a machine contract (`insufficient_balance`,
  cents, a recovery action); the turn showed it raw. It now says what is left,
  what the request reserves, and what to do: add funds or turn on auto reload,
  ask the workspace's billing manager, wait for the automatic reload that is
  already running, or raise the monthly usage limit, each with the Billing
  link.

- **A collapsed turn hides failures the agent recovered from.** Folded traces
  showed every failed edit and command in red while the turn was still working
  and after it had answered. A failure is the agent's to deal with while it
  works and part of the story once it has answered; collapsed, only a turn that
  stopped without an answer shows the failures of its final step, which are
  what stopped it. Pending requests and saved Results stay visible in every
  state.

## v2.0.105 — 2026-09-16

### Fixed

From a trace review of a ten-hour `/autoresearch` session on GPT-5.6 via
OpenRouter whose automatic compaction cost ten times a normal step and handed
the resumed turn the wrong objective:

- **A compaction summary reads the conversation from the cache again.** The
  summary request rendered the head of the transcript on its own, so the
  "last request" boundary that decides which replies replay their reasoning
  moved to the head's newest request, and every reply of the study loop
  replayed encrypted reasoning the conversation itself had never sent. The
  request's bytes diverged from the cached prefix right after the system
  prompt (12,784 cached of 166,071 input tokens, $0.495) and the summarizer
  paid for ~30K tokens of thinking it did not need. The head is now rendered
  against the whole conversation (same boundary, same image budget), so it is
  byte-identical to the prefix the previous step wrote.
- **The handoff is written for the request in progress.** The summary covers
  the head while the newest request stays verbatim in the tail, so a
  compaction during request N+1 summarized request N and wrote "Objective
  complete — report the result to the user and stop" while the live request
  waited below it, and the continuation repeated "if the Objective is already
  complete, stop". The summarizer is now told every request still waiting in
  the tail (as a bounded excerpt: the opening ask and closing lines, never an
  attached dataset) and that the newest is the Objective; the continuation
  names that request and no longer suggests stopping; and later compactions,
  which update the previous handoff, are told to replace an earlier Objective
  rather than preserve it.
- **The pinned request is the one the turn works from.** The compaction
  carrier pins one request verbatim ahead of every summary, but it matched
  only messages without turn identity, which no typed prompt has had since
  turns were recorded, so nothing was ever pinned; and it would have pinned
  the oldest request rather than the current one. It now pins the newest
  typed request when it is small enough to ride ahead of every later summary
  (8K tokens); a request rejected for size pins nothing, since reducing it is
  what the preflight compaction is for. The fixture that hid the dead
  predicate uses the production message shape.
- **Verbatim turns are the turns the person typed.** The tail kept "turns"
  that began at any user message, so two study reminders or worker wake-ups
  could be the whole verbatim tail while the request they belonged to was
  summarized away. A turn now begins where the person typed; runtime
  continuations extend it.
- **A missing tail anchor no longer drops the newest request.** When the
  message a summary's tail starts at is gone (an undo inside the tail, a
  migration), the model view fell back to the carrier onward, which is
  exactly the part of the transcript the newest request is not in. It now
  keeps the history from the previous compaction boundary in order, with the
  summary as its recap, and logs the malformed layout.
- **The summary message records the agent that wrote it.** On the shared
  path the handoff is produced under the conversation's own header, but the
  message was labelled `agent: compaction`, so the transcript and telemetry
  named a persona that never ran.
- **Work after an automatic compaction stays in its turn.** The workspace
  treated every compaction carrier as a turn of its own and rendered it only
  as the "context compacted" divider, so every reply the runtime's
  continuation drew after a mid-turn compaction (hours of study work, the
  pending Modal approval card, the final answer) had no turn to appear in and
  vanished from the transcript. An automatic carrier now folds into the turn
  it interrupted: the trace shows one grey "Context compacted" note where it
  fired, the turn's status line reads "Compacting context" while it runs, and
  the approval card renders where the reader is waiting. A manual `/compact`
  still draws its own boundary.

## v2.0.104 — 2026-09-16

### Changed

- **Every bundled skill names the people who wrote it.** 273 of the 366
  skills were taken from open collections and had been relabelled with this
  project as their author. Each now carries its original author and source
  in its frontmatter (`metadata.upstream*`), `backend/cli/skills/ATTRIBUTION.md`
  lists them all with upstream paths and licenses, and `NOTICE` and the
  README credit the sources: OpenCode, which inspired this project (MIT);
  K-Dense Inc.'s [Scientific Agent Skills](https://github.com/K-Dense-AI/scientific-agent-skills)
  and [Claude Scientific Writer](https://github.com/K-Dense-AI/claude-scientific-writer)
  (MIT; 180 skills); Orchestra Research's [AI Research Skills](https://github.com/Orchestra-Research/AI-Research-SKILLs)
  (MIT; 79 skills); Hugging Face's skills (Apache-2.0); Anthropic's document
  skills; the NVIDIA BioNeMo Agent Toolkit; pacsomatic; and the bundled fonts.
  Closes #613, which asked for the K-Dense entry.

## v2.0.103 — 2026-09-15

### Fixed

From a QA pass over a one-hour `/autoresearch` study on Modal (ten T4 runs,
three workers) on v2.0.102:

- **A grant that arrives no longer kills the session's running commands.**
  Every filesystem grant change stopped the session's processes, jobs and
  kernels so nothing would run under a stale authority set. That is right
  when a grant is revoked and wrong when one is added: a skill loaded in
  parallel with a shell command added its read grant and the command died
  with "User aborted the command"; a folder connected during a Modal run
  would have cancelled the run. Only a revoked or consumed grant stops
  processes now; an added one leaves them within bounds.
- **One automatic resubmit when the managed gateway reports no progress.**
  A worker died on `managed_request_timeout` after a 502: the gateway gave up
  waiting for the provider and, by design, refused a retry of the same
  request. The step is now sent once more as a new request (a fresh
  idempotency key) before the turn stops; the provider may bill the first
  copy if it finished late, which is cheaper than a halted study.
- **scikit-learn is part of the Python starter environment.** Both QA
  sessions lost tool calls to `ModuleNotFoundError: sklearn` in local smoke
  tests. New environments include it; existing ones gain it in place on the
  next start, without a rebuild that would discard what the person installed.
- Kill-criteria errors say that a NaN guard is unnecessary (non-finite values
  are never recorded as points), which is what the agent had tried to write.

## v2.0.102 — 2026-09-16

### Fixed

From a QA pass over one EDA-and-LaTeX-report session on v2.0.101:

- **A finished turn no longer looks broken by the failures it recovered
  from.** Once the answer is in, the collapsed turn shows the answer, saved
  Results and open requests; a bash exit 1 the agent fixed on the next step,
  a 403 from a docs page, or a bibliography validator that flagged one entry
  read inside the expanded trace, where they belong. While the turn is
  working, failures stay in view.
- **"Files written this turn" lists the deliverables.** A report the agent
  wrote under Project files from an isolated session resolved to nothing in
  the receipt check (the session held no grant for the project directory),
  so the footer showed the scratch page rasters and not `report.pdf`.
  Receipts, previews and Result saves of files under Project files now
  resolve through the project's own authority.
- **Tool rows name scratch and skill files by where they live.** A read of a
  page raster in session scratch showed `../../workspaces/prj_…/ses_…/…` and
  a skill asset `../../.cache/openscience/bundled-skills/<hash>/…`; they now
  read `scratch/report-page-01.png` and `skill:paper-writing/assets/…`.
- **Markdown inside link text renders.** `[**Report (PDF)**](report.pdf)`
  showed its asterisks.
- **`generate_image` is offered only when an image account is connected**,
  so loading the schematics skill on managed billing no longer adds a tool
  that can only fail, a tool-set change note, and a prompt-cache miss.
- Tool-set change notes list names plainly ("Tools added: query_pubmed")
  instead of a JSON array.

### Changed

- **Releases are about an hour faster.** The release rehearsal no longer
  stages fifteen packages on registry.npmjs.org and waits for the registry
  to commit them (twelve minutes on a good day, an hour on a bad one) before
  the gate jobs could install; every gate job now installs the exact
  candidate through a localhost registry serving the tarballs the workflow
  just built (`tooling/repo/candidate-registry.ts`), with the real resolver,
  platform selection and integrity checks. The rehearsal takes about eight
  minutes; npm is staged once, in the publish workflow.

## v2.0.101 — 2026-09-15

### Fixed

Failures traced through one EDA-and-LaTeX-report session that showed eleven
red rows in a single turn:

- **HTTPS from the managed Python environment works again.** The environment
  is built in a staging directory and moved into place, and the CA bundle
  path compiled into its OpenSSL still named the staging directory, so every
  request from `urllib`, `httpx` or `requests` without `certifi` failed with
  `CERTIFICATE_VERIFY_FAILED` (bibliography checks against Crossref included).
  Managed environments now set `SSL_CERT_FILE`, `SSL_CERT_DIR`,
  `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE` to their own bundle for shell
  commands, kernels and local compute jobs; a bundle the person configured
  themselves passes through unchanged.
- **`literature read` tries every open location and falls back to the
  abstract instead of erroring.** A publisher that answers 401 or 403 to a
  non-browser client behind OpenAlex's open-access flag ended the read with a
  bare "Request failed with status code: 403", four times in one turn until
  the repetition guard spoke. The read now tries arXiv, then each repository
  and publisher copy OpenAlex lists, and when all refuse it returns the
  abstract with the refusals named and a note not to retry the download.
- **The `bash` tool runs in bash.** It used the login shell, zsh on macOS,
  where `status` is a read-only variable; a script setting `status=$?` died
  with "read-only variable: status". Bash is used when installed, the login
  shell otherwise.
- **`artifact save_file` accepts a file under Project files from an isolated
  session.** The read tool treats the project directory as internal, but the
  artifact tool went through the session's grants alone and refused the
  report the agent had just written there ("No read access …"). It now uses
  the project's own authority for files inside the project directory.
- **A grant added while a shell command was being prepared no longer fails
  it.** The final authority check compared a hash that included the grant
  revision, so a parallel `read` of a new folder or a brokered download made
  a concurrent `bash`, compute launch or terminal command fail with
  "Execution authority changed … retry it". Trust, access mode, sandbox
  policy and any root the launch relied on still fail it; a widened grant
  does not.
- **Image generation availability is stated in the environment.** The
  schematics skill was loaded and `generate_image` called in a session with
  only managed billing, which does not route image models, so the call failed
  every time. The system prompt now says whether image generation is
  available and, when it is not, to draw schematics with TikZ, matplotlib or
  SVG and not call the tool.
- **Tool notices name the change.** The durable note that follows a skill
  load began "Tool availability changed for this request.", which is what the
  transcript showed three times in a row; the first line is now
  "Tools added: …" or "Tools removed: …".

## v2.0.100 — 2026-09-15

### Fixed

Findings from watching a one-hour autoresearch study run on Modal end to end:

- **The study SDK reaches Modal.** `openscience_track` is written under
  `.openscience/sdk` in the study root, and `.openscience` was on the Modal
  upload deny list, so every remote study run failed on its first import
  unless the agent wrote its own shim into the project. The SDK subtree is now
  carried (the rest of `.openscience` stays denied), an explicit upload list
  gets it added, and the study's ledger files (`study.md`, `ideas.md`,
  `results.tsv`, `lessons.md`) stay out of the manifest, so a ledger rewritten
  while a job waited for approval no longer fails the dispatch with "input
  changed after approval".
- **One approval per study.** A remote study is approved when it is created
  (the card names the runs, hours, GPU class and kill rule); its runs then
  dispatch under that approval instead of a digest-bound card each, which had
  the observed study waiting on clicks for 39 of its 60 minutes.
- **Studies root in Project files.** In an isolated session the study, its
  ledger, SDK and outputs went to session scratch and died with the
  conversation; they now go under Project files. A scratch copy the compute
  tool staged from the project is refreshed from the project on every later
  dispatch (outputs delivered into it are kept), so a run gets the code the
  study just changed rather than the first snapshot.
- **Phantom runs.** A `study start` the process died inside left a run
  "running" with no job for the study's life, holding a concurrency slot. The
  driver now fails such runs from a previous process and re-queues the idea,
  and `study record` closes one instead of insisting it is still running.
- **Working directories and uploads.** `study start` documents `cwd` (defaults
  to the study root), `uploads` and `artifacts` (relative to it); an explicit
  upload list that matches nothing is refused before dispatch instead of
  starting a sandbox with no files; a path given from the project root for a
  file inside the cwd is accepted.
- **Quieter transcript.** The study's status is appended when its state
  changes (status, baseline, best, directives), not when the model moves its
  own counts, and it reads `Study "…" is running: …` rather than leading with
  an identifier. `compute_job wait` no longer returns on every burst of log
  output; a chatty run cost nine round-trips of waiting in four minutes.
- `artifact save_file` takes a study run id or a compute job id as
  provenance; both had been refused as "Invalid provenance" because neither
  store wrote provenance nodes.
- Runs that died before logging a single point do not spend the study's run
  budget; the hour budget still bounds the waste.
- Tool rows without a dedicated renderer (`study`, `experiments`) show the
  receipt the tool wrote for itself instead of a bare tool name.
- Python run by the agent writes bytecode to OpenScience's cache rather than a
  `__pycache__` in the project, and plots render off-screen (`MPLBACKEND=Agg`).
- A server restart no longer strands a turn. At warmup, a lead the previous
  process left mid-turn picks its loop back up from the durable transcript
  (its orphaned Task call reads as interrupted, so the model re-plans), and a
  worker whose lead is gone is closed with the reason instead of reading
  "Running" for good. Sessions quiet for more than twelve hours wait for the
  person. Behind the `harness.durable-jobs` switch.
- The file header is one thin line: glyph, name, kind, then the active
  viewer's own controls (a PDF's pager and zoom, a table's row count) and the
  actions, instead of a two-line title block over a second toolbar. A narrow
  pane stacks the controls under the name.
- The `<core-skills>` index asks for the skill of each phase as it begins
  (figures before the first plot, schematics before a diagram, a writing skill
  before drafting) rather than "one skill for the task", which had the agent
  writing a figure-heavy LaTeX report with no skill loaded at all.
- Delegation postures match the composer: Off removes the Task tool, Auto
  leaves the choice to the model, High asks it to parallelize; the postures
  are now checked end to end at the provider boundary.
- An isolated session's environment says that relative paths resolve in its
  scratch and that a project file needs its full path; the agent had been
  spending its first steps finding out.

## v2.0.99 — 2026-09-15

### Fixed

- Harness status (a budget reminder, the study's state, a change in the offered
  tools) is appended to the transcript as a durable message the moment it
  changes, and nothing rides as an ephemeral tail of the request any more. The
  per-step `<system-reminder kind="status">` user message introduced in
  v2.0.97 pinned OpenAI's cache reads to the system prompt: the provider
  reuses a prefix only at the end of a message that is still there, so a
  request whose last message changed every step re-read the whole conversation
  each time. Measured on the managed route: cache reads stuck at 10.9K tokens
  with the tail, growing every step without it. The running spend and elapsed
  lines are gone from the model's view (the workspace shows them); the 50%/85%
  time reminders and the soft-ceiling reminder carry their figures.
- The deliverables check accepts an output in the project's files as well as
  in the tool directory. An isolated session's agent rightly writes durable
  outputs into the project; the check looked only in the session scratch,
  reported them missing twice, and sent the agent off to duplicate them.
- A worker's result arriving mid-turn no longer adds the "additional user
  messages arrived" system line (it is the runtime's message, not a person's),
  and a folder the agent reaches through a tool approval is no longer listed
  under connected folders. Both rewrote the cached system prompt mid-turn.
- The transcript keeps every answer a finished response ended with when the
  harness continues the turn (a deliverables check, a worker's result), rather
  than folding it away as narration under the final reply, and shows each
  harness message as one grey note so the reader sees why the agent went on.
- A search row (glob, grep, list) names the folder it searched, relative to
  the project ("./", "scripts/"), instead of that folder's parent; the live
  header reads "Waiting for your approval" or "Waiting for your answer" over a
  pending card instead of "Running … 6m 50s"; the copy affordance appears only
  for a finished answer, not under narration while the turn works.
- The `todowrite` contract asks for updates alongside the next tool call, not
  as a step of their own: a three-analysis turn spent five of its ten model
  round-trips on list updates.

## v2.0.98 — 2026-09-15

### Fixed

- Every request through the managed gateway failed with 422
  `unsupported_managed_request_option` in v2.0.97: the gateway validates
  request options against its own list and refused the `session_id` and
  `prompt_cache_key` routing keys added in that release. The keys now travel
  only on direct OpenRouter routes until the gateway accepts them.

## v2.0.97 — 2026-09-14

### Changed

- The harness is OpenCode's Build path with science in skills, agents, headers
  and switchable units. Tool visibility follows permissions: Research is offered
  a fixed default set and everything else is unlocked by a loaded skill's
  `allowed-tools` or an agent rule; keyword-based tool selection and the
  quick/direct/inspection routes are gone. `apply_patch` replaces `edit`/`write`
  for GPT-family models, `research_search` is offered only with a search
  provider, `question` only where a client can ask.
- Research takes a model-family header (`anthropic`, `gpt-astra`, `gpt`,
  `codex`, `gemini`, `default`) selected by wire model id, each carrying the same
  science sections: evidence and files, methods and deliverables (named outputs
  become a checklist that is checked before finishing; every clause of the
  question is binding; no placeholder values), manuscripts and figures.
- Agents are `research`, `plan`, `explore`, the specialists `ml`, `biology`,
  `physics`, `chemistry`, `data` (one template plus a domain skill index), and
  the internal `compaction`, `title`, `summary`. No built-in agent has a model;
  `agent.<name>.model`, `.variant` and `.skills` configure one. The `execute`,
  `task`, `write`, `critique`, `physics-critique` and `literature-review`
  profiles are retired; review is the `/review` command.
- The Task tool follows OpenCode's contract: `subagent_type` is an agent name,
  `task_id` resumes a worker, `subagent_depth` (default 1) bounds nesting,
  workers work in the lead's directory, results return in a `<task_result>`
  envelope (a failing worker returns its partial text as `<task_error>`), and
  `background: true` runs a worker detached and wakes the lead when it ends.
  There is no worker concurrency cap and no isolated worker workspace.
- Compaction pins the session's first user message verbatim ahead of every
  summary, adds Deliverables (verbatim) and Findings so far to the handoff, and
  never prunes `todowrite` results.
- `openscience run` gains `--delegation`, `--worker-model`, `--autonomy` and
  `--deadline`; under `--auto-approve` delegation stays on, worker events stream
  with a `parentID`, worker usage rolls into `done.children`, questions are
  answered with their recommended option and a denied tool call continues the
  loop.
- `/init` writes the project's research context (question, data, conventions,
  deliverables); `/review`, `/reproduce` and `/literature` are new commands;
  `/resume` and the research-contract, scientific-capability, batch, todoread and
  planwrite tools leave the model surface.

### Added

- Harness units behind `harness.<unit>` switches (all on): `redirect` (a tripped
  repetition guard becomes one strategy-change message), `deliverables`
  (mechanical checks of named outputs before the turn ends), `budget` (CPUs,
  memory and time budget in the environment, reminders at 50% and 85%), `cost`
  (spend so far and an optional soft ceiling), `headless-policy`,
  `durable-jobs`, `workers`. Plugins get two new hook points, `loop.before_finish`
  and `loop.guard`, plus `env.lines`. Only facts that hold for the whole session
  (compute) go into the system prompt; time used, spend, one-shot reminders and
  study state ride in a per-step status block at the tail of the request, so
  the provider's prompt cache survives every step (a spend figure in the system
  prompt was discarding the cached prefix on each step of a turn).
- Every OpenRouter request carries the session as its `session_id` (OpenRouter's
  sticky-routing key) and, for OpenAI models, as `prompt_cache_key`, so one
  session's steps reach the same upstream endpoint and the same cache. Left to
  the default routing hash, which every OpenScience session shares, a session
  saw its 200K-token prompt re-read at full price on nearly every step.
- A figure a tool returns (a `read` of a PNG, a rendered plot) now reaches
  transports whose tool results are strings only (OpenRouter, openai-compatible,
  the Copilot fork) as an image in a user message right after the result, with a
  pointer in the result. Those SDKs stringify anything else, so the base64 was
  billed as prompt text: one 500 KB PNG cost 170K input tokens on every step
  until it was pruned. Models that cannot view images get a one-line note.
- A tool call the provider SDK executes before the session has recorded its
  streamed placeholder now waits for that placeholder instead of minting its
  own part; a fast call no longer sorts ahead of the thought that produced it,
  which on the OpenRouter route had replayed the reasoning as a stray assistant
  message after the tool result.
- The public runtime event journal is written behind the bus instead of ahead
  of it: captures are placed in publish order and batched into one write per
  50 ms window, and a replay cursor waits for the pending captures before it
  reads. The journal used to be rewritten whole on every event before any
  subscriber saw it, which on a long session froze the workspace for minutes
  after a wave of worker events and then delivered them all at once.
- Old tool results are pruned only when the provider's prompt cache has gone
  cold (thirty minutes without a request) or when capacity requires it, no longer
  at the end of every turn. A prune rewrites earlier context, and the provider
  re-reads everything after the rewrite at full price, so a wake-up inside the
  cache window (a worker finishing, a study update) now keeps its prefix.
- Up to twenty recent images travel in full with each request (was one); past
  the cap the older half are released together, so a session with many figures
  rewrites its prefix once per ten figures rather than once per figure. The
  cap of one dated from when a figure's base64 was billed as prompt text.
- A model that prices long prompts in tiers budgets its context at the first
  pricing boundary by default (272K for GPT-6 Astra, where every input rate
  doubles), so the conversation compacts a little before the cliff; the model
  settings' **Full** option opts a model into its whole window, and the choice
  is stored per model. A session that ran on in the higher tier paid twice the
  rate on every step.
- The spend line the model reads counts its workers separately from its own
  calls (`Spent so far: $1.00 on this session's model calls … and $2.50 on its
workers`), the soft ceiling applies to the sum, and a study's cost budget
  counts the lead's workers. A delegating lead spends most of a study's money
  in its workers, and the earlier figure left them out.
- A summary request rides the conversation's own prefix: the same header,
  system blocks and tools (offered, not callable), the same rendering, then
  the handoff instruction as the one new message, so the provider serves the
  head from the cache the conversation wrote. A 240K-token compaction on
  Astra read at the full rate ($2.4) under the compaction agent's own header;
  it now reads at the cache rate. A configured `agent.compaction.model` that
  differs from the conversation's model keeps the standalone request.
- Reasoning is replayed only for the work since the person's last message, and
  OpenRouter's per-token `reasoning.summary` fragments never travel. One step's
  summary came back as 450 items and 50 KB, every tool call in the step
  carried the whole list, and GPT-5.6+ renders earlier turns' encrypted
  reasoning into context and bills it on every step: this session's requests
  were 57% replayed reasoning. A worker's result or a study update is not a
  turn boundary, so it does not disturb the cached prefix mid-work.
- A study whose wake-up the provider refused (an empty account, a rejected key)
  pauses with the refusal as its reason instead of knocking on the session
  every tick; resume it once the cause is fixed.
- The environment names the model's knowledge cutoff from the model catalog and
  the gap to today, and tells the model to look up the current generation before
  pinning a model, library version, baseline or protocol.
- A delegated worker can read and write in the lead's working directory even
  when that directory is the lead's private session scratch; its environment
  says whose directory it works in. The deliverables check no longer runs in a
  worker (a brief is the lead's instruction, not the user's specification) and
  no longer counts files a request says to read as outputs.
- A background worker's Task card stays live until the worker finishes and then
  shows the worker's real outcome and duration; its completion joins the turn
  that dispatched it instead of opening a headless second turn in the
  transcript, and the note on a result with failed tool calls is a count rather
  than a verdict.
- The transcript keeps one hierarchy: the agent's prose in bright text, and
  everything it did in grey rows beneath one header per turn (thoughts with
  their text when the provider shares it, files read, searches, commands,
  edits, delegations, questions). Rows and tool lines share one type size and
  colour; skill loads fold with the rest. Reasoning that streamed while you
  watched stays readable after it ends. The header is one plain line from the
  first second to the last: it names the call in flight ("Running pytest -q")
  while the turn works and "Worked for 4m 12s" when it is done.
- Enter while a response is running adds the message to the current turn
  instead of stopping the response; the send button is Stop and Escape still
  stops. The runtime API accepts a prompt during a live run as a follow-up
  that joins that run (same `runID`), and an exact retry of the follow-up
  replays it.
- A skill's tools stay on offer for as long as its text is in the model's
  context, across turns, instead of lapsing at the next request; the
  autoresearch, delegation and peer-review skills describe the current Task
  contract (`subagent_type`, `task_id`, `background`) rather than the retired
  `specialist` parameter and `execute`/`critique` profiles.
- The spend line survives a server restart: it is seeded from the transcript
  once per session, and says what it covers (this session's model calls, not
  workers or compute).
- An interrupted `question` says that nothing was chosen or recorded and to ask
  again; an interrupted read says nothing changed; only side-effecting tools
  keep the "inspect the current state" warning.
- `apply_patch` reports a formatter's rewrite as the changed line ranges rather
  than the whole diff (the UI keeps the diff); `todowrite` confirms with counts
  and the in-progress items instead of echoing the list.
- `compute_job` `targets` includes a readiness block: whether remote compute is
  configured, whether outbound network and downloads are permitted, which
  secret references a job can carry, and that chat provider keys are not
  forwarded into jobs.
- `recall`: search this session's earlier messages, tool results and saved tool
  outputs by regular expression, including turns compaction summarized away.
- The `execution-hygiene` core skill and eleven convention skills
  (statistics, Lean 4, Coq, cheminformatics definitions, structure analysis,
  patents, geoscience data, energy systems, astronomy inference, atomistic
  workflows, analysis reports), authored from public documentation with sources.
- Harbor adapter kwargs `delegation`, `worker_model`, `autonomy`, `deadline`;
  trajectories include worker steps and usage.

## v2.0.96 — 2026-09-13

### Added

- `literature`, one tool for papers. `search` runs a query against OpenAlex and
  arXiv together (or any named connectors), merges records of the same paper by
  DOI, arXiv id or title, ranks agreement first, and returns citable candidates
  with venue, citations, abstract, landing page and whether open full text
  exists, plus a per-source report. `read` takes a DOI, arXiv id, URL, local PDF
  or exact title, resolves the open full text, downloads it once into the
  session's paper cache, extracts page-addressed text with `pdftotext` or
  PyMuPDF, and returns the opening pages, a page range, or the passages matching
  a phrase; abstract-only and partial (scanned) texts are reported as such.

### Changed

- arXiv rate limits no longer stall a literature review. The API is tried once
  with a short deadline; after a `429` it is held for a cooldown and arXiv
  records come from OpenAlex (`10.48550/arXiv.<id>`) or the paper's abs page,
  marked `via`. A batch of parallel lookups now costs one failed API call.
- `science_search` and `science_fetch` failures carry structured diagnostics
  (`http_status`, `endpoint`, `attempts`, `retry_after_seconds`) and name the
  alternatives available right now instead of "retry shortly".
- The literature-review and research-lookup skills route through `literature`
  and size a review to the request: a quick review is two or three searches,
  three to five papers read, and the missing comparison named.

## v2.0.95 — 2026-09-13

### Added

- Science-benchmark campaigns over the existing headless Research loop: Harbor
  0.22.0 for Terminal-Bench Science, Terminal-Bench 4 science, and BiomniBench-DA
  50; native adapters for BixBench3 and ResearchClawBench. Bundled skills stay
  on unless `--ak skills=none`. See `evals/science-harness`.
- Autoresearch: a pane beside Files, Terminal and Compute with one tab per
  study, tracking metrics from every run. A script imports
  `openscience_track` (or `wandb`, shimmed) and logs numbers; inside a compute
  job the records ride the job log with no network or dependency, and land in a
  per-project SQLite store. A study reads as a score (best value and its move
  from the baseline), the climb across runs, the runs with a multi-run chart
  (shared hover, smoothing, log scale) and per-run configuration, summary and
  curves, then the queue, the lessons and the activity; local GPUs show in
  the bar.
- Studies: an autoresearch loop the agent drives with the `study` and
  `experiments` tools. One metric and direction, a baseline, a queue of ideas
  ranked by expected value, exactly one run per idea through the existing
  compute permissions, verdicts with analysis and lessons, kill criteria in
  plain words ("1 hour OR val_loss plateaus for 500 steps"), budgets by runs,
  hours, spend or target, and Pause, Resume, Halt and Write up beside the
  score. The driver follows each run, ends runs that break the criteria, and
  wakes the session with one "Study update" per batch of news, capped per
  hour; `study.md`, `ideas.md`, `results.tsv` and `lessons.md` are rendered
  into the working folder. An `autoresearch` skill carries the method.

- Core skills: fifteen research procedures authored for the Research agent and
  always on its index: `research-lookup`, `literature-review`, `brainstorming`,
  `hypotheses`, `reproduce`, `autoresearch`, `compute`, `delegation`, `figures`,
  `schematics`, `paper-writing`, `ml-paper-writing`, `citations`, `peer-review`
  and `sources`. Each is under 250 lines with a workflow, its checks and one
  level of references. `schematics` plans, styles from reference figures,
  renders with Nano Banana Pro and checks the image against the plan;
  `figures` ships a matplotlib style module and one reference per figure type;
  `citations` resolves every reference against Crossref, OpenAlex, arXiv or
  PubMed and ships a `.bib` validator. The retired K-Dense versions
  (`scientific-writing`, `citation-management`, `hypothesis-generation`,
  `scientific-schematics`, `venue-templates`, ...) resolve to their replacements.
- Specialists the agent can call: the Task tool's `specialist` takes `ml`,
  `biology`, `physics`, `chemistry` or the read-only `critique` reviewer. A
  specialist worker keeps the Research contract and gains its domain contract,
  the full index of its skill categories and its domain tools.
- Library sync: 46 more K-Dense scientific skills (`paper-lookup`,
  `database-lookup`, `experimental-design`, `statistical-power`, `nextflow`,
  `bulk-rnaseq`, `phylogenetics`, `molecular-dynamics`, `pkpd-modeling`,
  `pdf`, `docx`, `pptx`, `xlsx`, ...), 357 skills in total.
- `generate_image` takes `image_size` (1K, 2K, 4K) and up to 14
  `reference_paths`, and sends Gemini the documented `imageConfig` request.
- Autoresearch steering and loop discipline, after autoresearcherUI: a
  `steer` input on the study adds a standing directive that wakes the agent
  at once and stays in its study reminder until retired; the driver asks for
  more ideas when fewer than three are queued, for a change of kind after
  four runs without progress, and for a step-back review every six runs;
  `study create` requires a budget agreed for this study rather than one
  carried over; `study propose` rejects configurations already tried; and
  after a short run the agent is told to wait for it in the same turn rather
  than end the turn and be woken.

- Skill roots as an API, after the proposal in #608: `GET /settings/skills/paths`
  lists every directory feeding the catalog with the skills it won and lost,
  `POST` registers a local directory without a restart (scanned recursively,
  optionally persisted to `skills.paths` in the global or project config,
  missing or empty directories rejected, duplicates refused), `DELETE` removes
  it, `POST /settings/skills/reload` rescans, and `GET /skill/{name}/content`
  returns a skill's instructions for clients without filesystem access. A
  skill that shadows a same-named one now carries `shadows` with the losing
  paths, so a local edit that had no effect is explained.

### Removed

- Fusion, the delegation strategy that bound one persistent worker to the lead
  with per-turn handoff budgets. Workers are parallel only: a fresh child per
  Task call, on the Worker model from Customize → Models or the lead's model.
  The Workers switch in Tools, the Fusion badge and handoff count on task
  cards, the `delegation_strategy` preference and the binding store are gone;
  a stored `fusion` preference is ignored.

### Changed

- Reasoning runs deeper and shows more. The composer's effort defaults to
  **high** whenever a model offers it (the picker keeps every level), a worker
  running on the lead's model inherits that effort, and direct OpenAI, Azure and
  Codex OAuth requests for the GPT-5/GPT-6/o3/o4/codex families ask for
  `detailed` reasoning summaries instead of `auto`. A phase the provider kept
  private shows as a "Thought" row with its duration and nothing to open.
- The `/` menu is one list in the agent's own tiers. It opens on Core: `/plan`,
  `/goal`, the fifteen core skills in workflow order and `/compact`; pinned
  skills and the Session actions (`/stop` while a turn runs, `/init`,
  `/handoff`, `/checkpoint`, `/resume`) follow, then the whole library by
  subject. Typing filters everything at once, prefix matches first and core
  ahead on ties, with a library skill's subject on the right. Rows are one
  line: icon, name, purpose. The separate "Browse all skills" dialog is gone;
  the menu and Customize → Skills cover it.
- `/status`, `/context` and `/undo` are removed from the menu and the command
  catalog. The session header shows progress and context usage, and **Undo
  from here** on a finished response reverts a turn.
- Customize → Skills is organised the way the agent uses skills: Core first in
  workflow order, then the skills you wrote, installed or keep in the project
  (personal skills can be edited and deleted in place), then the library as
  folded shelves by subject with a per-shelf Activate all / Turn off all, and
  a Sources section listing every directory that feeds the catalog with the
  names that lost a collision. Views are All, Core, Library, Personal and
  Off; search is one flat list. Add skill gains "Add a local folder", which
  registers a directory of skills without a restart and can persist it to the
  global or project config. Badges, tags and the density toggle are gone; a
  prevailing ask-first permission reads once in the summary.
- A new session opens on the composer alone; the "What would you like to work
  on?" heading and starter buttons are gone.
- Delegation is scoped: a worker needs a clean boundary, a self-contained
  brief with a definition of done, and one worker per independent branch.
  Checking the lead's own output (compiling, reading the rendered pages,
  confirming a number or a reference) is never delegated, and a report on the
  session's own work is built from its evidence rather than a literature
  review. The header, the delegation reminder, the Task tool and the
  paper-writing skill all say so; built-in command descriptions are sentence
  case.
- A delegated worker is a closed line while it runs (title, agent, state,
  elapsed) and streams nothing; its handoff, outputs and **Open agent** appear
  when it finishes. The live operation list, activity groups, operation count
  and model provenance are gone from the card.
- Skills that declare `allowed-tools` unlock those tools for whichever agent
  loaded them; the biology database tools are no longer reserved for the
  biology agent.
- The composer no longer shows a separate Independence chip; Independence
  stays in Tools next to Delegation, where it was already set.

### Fixed

- Autoresearch, from the pre-release audit: `study start` refuses a run once
  the study's run budget is spent (live runs count, so parallel starts cannot
  overshoot it) and refuses to share a GPU when every local GPU already has a
  live run; a run whose compute job record disappears is marked failed after
  two minutes instead of holding its slot forever; a study wake that fails to
  reach the session keeps its news and spends neither the hourly cap nor the
  turn tally; dispatch failures no longer count against the run budget; the
  pane reads a study's complete run list from its overview rather than the
  project-wide cap, and its charts release their resize observers.
- A PDF opened from Results filled a fixed 560px box inside a scrolling pane,
  so a page showed clipped with blank space below it. The viewer now fills the
  pane and scrolls its pages itself, as in the Files tab.

## v2.0.94 — 2026-09-12

### Changed

- The default Research prompt now follows the shape of OpenCode's harness
  prompts: it tells the model how its output renders (narration between tool
  calls, the final message as the answer), then sets communication defaults,
  a bias to action, when progress updates are worth sending, when a question is
  worth asking, and what a final answer contains, before the scientific
  specifics. Skills load only when they change the work, workers only for
  independent work within the Delegation setting, and questions come one at a
  time with the recommended option first. Working-folder routing lives in the
  environment block, so the header no longer repeats it.

### Fixed

- Short provider and Modal SDK probes can finish immediately after durable process
  registration without being mistaken for failed launches. Failed scientific setup
  records its failed state and logs the exact archive-attestation rejection.
- Scientific canaries stay isolated from credential sync and unrelated environment
  installation when logging flags appear before their command. A failed canary
  preserves completed results and its error in the JSON report.
- Packaged startup shares one bundled-skill extraction per process and coordinates
  installation across processes. Failed extraction leaves no staging files, and a
  repaired cache becomes available without restarting the app.
- Custom slash commands sent immediately after opening a session wait for their
  catalog instead of being submitted as ordinary chat text.
- Scientific environment setup retries interrupted archive downloads and temporary
  upstream failures within its existing timeout, while retaining checksum verification.
- Local Jupyter notebooks, R Markdown, and Quarto files open as rendered documents
  with separate cells, saved outputs, and explicit Python/R execution in the session's
  local kernel. Source editing remains available; opening a file never runs its code.
- Session traces remain available when a search or scientific kernel returns a
  partial result, preserving that outcome instead of failing the entire trace.
- ACP editor integrations use stable session listing and resumption, and expose
  models and reasoning variants through session configuration with the updated SDK.
  Unsupported MCP-over-ACP connections return a clear error before creating a session.
- Research search and WebFetch no longer ask for redundant approval in Ask risky
  when the source is already allowed, including delegated literature work. New
  network hosts still require approval; explicit rules and Full access are respected.
  The literature group now includes ACL, OpenReview, and conference archives.
- Public retrieval can use another validated address when a host's first DNS
  address has no working network route, without replaying writes or certificate failures.
- Consecutive reasoning fragments share one expandable trace row, completed tool
  groups stay compact during long runs, and patch summaries count actual files.
  Image tools no longer claim a connected account when no provider was selected,
  or a generated file while the request is still running.
- File activity shows colored added/removed line counts for completed edits,
  writes, and patches, plus a net file-change summary for the turn.
- Citation exports in BibTeX and RIS formats open as text through WebFetch.
  Paper-writing guidance grounds drafts in literature, audits scope reductions,
  and verifies rendered pages; diagram work can proceed with editable local
  figures when an optional image provider is unavailable.
- Isolated runs use their configured home for global compatibility instructions
  and tilde-prefixed instruction paths.
- Desktop updates allow time for multiple project runtimes to stop, preserve
  disposal errors, and prevent polling from recreating disposed projects. Completed
  onboarding survives updates, including older setup revisions.
- Failed working-folder selections remain visible and can be retried. Research
  instructions now explicitly reuse the selected folder and require literature,
  evidence, and rendered-figure checks before delivering a manuscript.

## v2.0.93 — 2026-09-11

### Changed

- One body size across the conversation: the answer, the reasoning, the
  user's message, the composer and every trace row read at 14/21, with
  hierarchy carried by colour and weight. 12/18 is reserved for metadata such
  as durations, counts, paths and state marks. The reasoning previously sat a
  size below the answer and the composer's leading was a pixel short.
- Tool rows follow the recorded execution state. A call the model has not
  finished writing reads as the plain tool noun with a "Preparing" mark, not as
  "Reading" or "Finding relevant skills"; only a running call claims an
  activity. A call cancelled before it started is "Cancelled", not a failed
  lookup.
- Streaming Markdown no longer re-highlights every finished code block on each
  update. Highlights are cached per block, and a block still being written is
  rendered as plain code once it passes 2 KB until its fence closes. A response
  with two finished scripts and a third streaming cost 63 ms per update before
  and 2.6 ms after, which is the difference between a frozen and a responsive
  workspace while a long script streams.
- The managed Ace gateway's header wait is ten minutes, matching its body
  deadline. The gateway sends its response headers only once the upstream body
  begins (one request reported upstream headers at 3.1 s while the client saw
  them at 133 s), so a long silent think lands in the header wait.

## v2.0.92 — 2026-09-11

### Added

- Independence sits beside the model and effort chips in the composer, with a
  one-click menu (Interactive, Balanced, Independent) and one-line descriptions
  that match what each level does. It stays visible with delegation off, since
  it governs the lead's own questions.
- A turn that stopped because the provider stopped answering, or because the
  request timed out, offers "Send again": the same message goes out as a new
  request through the composer. Turns with attachments are put back for the
  user to re-attach and send.

### Changed

- Question cards are one form on the card's own surface: the question at the
  prose level, choices as rows with a radio mark, the model's "(Recommended)"
  suffix shown as a quiet tag, the free-text choice as one more row, and a real
  Dismiss button. A single question reads "Question · <its header>".
- The managed Ace gateway's idle deadline is ten minutes, the same as other
  remote endpoints. The gateway sends no keepalives while an upstream model
  thinks (healthy requests have gone 133 s from response headers to the first
  body byte), so five minutes could cut off deep reasoning.

### Fixed

- When pyright is not installed and cannot be downloaded, Python diagnostics
  stand down with one warning instead of starting a language server that exits
  at once and is reported as a crash on every new project.

## v2.0.90–v2.0.91 — 2026-09-10

v2.0.91 republishes the v2.0.90 source unchanged; two publish dispatches
landed on the same commit.

### Changed

- OpenScience is installed through the desktop app, npm (`@synsci/openscience`,
  `npx synsci`) or the standalone installer. The Homebrew tap is retired: the
  publish workflow no longer maintains a formula, and `openscience upgrade`
  no longer offers `brew` as an install method.

### Fixed

- Opening a project no longer stops its own kernels, terminals and compute jobs
  because of an authority change some other project never acknowledged. The
  durable authority record now names the last revision addressed to each
  project and the last addressed to all of them, so a watcher that finds a gap
  it cannot replay resyncs only when something in that gap was for it.
- Inference and Ace credential requests use fresh connections, avoiding Bun's
  reuse of unresponsive pooled sockets that could delay a simple reply for
  minutes before the gateway received it. Streaming, cancellation and the
  managed request's billing-safe idempotency policy are unchanged.
- OpenAI tools through OpenRouter explicitly preserve optional inputs. Searches
  no longer have to invent date bounds when none were requested; required
  fields and supplied filters still pass the same runtime validation.
- Local `sandbox:` result links and images open through the Files viewer,
  including generated plots and CSVs, instead of losing their destination
  during Markdown sanitization. File access remains checked by the backend.
- A finished turn kept a burst of one tool call inside a folded group with no
  header, so a lone write or command between two thoughts vanished from the
  trace. It renders as its own row again.

## v2.0.89 — 2026-09-10

### Changed

- A remote model stream that stops producing bytes is given up after ten
  minutes, and on the Ace gateway after five, instead of thirty. Keepalives and
  streamed private reasoning still reset the clock, so a thinking model is
  never cut off; a connection that died without closing no longer holds a
  worker for most of an hour.
- The task tool tells the lead that workers read its workspace but write only in
  their own, and a worker is told the same, so a brief no longer sends a worker
  to write where it cannot. When a worker stops on a provider error, the lead is
  told to finish that step itself rather than send the same brief to the same
  worker again.

- While a turn runs, its header reads as one calm word for what is happening:
  Thinking, or the activity of the tool that is running, beside the elapsed
  clock. Preparing, sending, waiting-for-output and quiet-stream phases no
  longer take turns on the line; the request detail ("No new output from
  openai/gpt-5.6-sol for 58s") sits in the tooltip, and only a retry countdown
  or a conflict wait still speaks for itself.
- A tool's body renders as a receipt: a loaded skill's SKILL.md and other
  tool output sit at the meta type level with headings brought down to it.

### Fixed

- A tool error whose class carries its facts only in structured data (a trust
  or authority refusal, a missing model, a failed MCP call) now reaches the
  model as those facts, not as the bare class name.
- A process that polled past a burst of its own authority changes (two folder
  grants inside one poll, a trust change next to a grant) no longer stops every
  kernel, terminal and compute job it owns to catch up: the record now names
  the process behind each recent change, and work this process already applied
  through its own bus is recognised as such. A gap holding another process's
  changes still earns the conservative stop-everything resync.
- The background credential sync waits up to 15 seconds for the account
  service instead of 8, so a slow afternoon no longer flaps the Settings
  indicator to "error" every minute.
- A refused file path now says why and what to do: which folders this session
  may read or write, and, for a lead's folder, that it is read-only here and
  files go back as saved artifacts. The bare error name a worker used to see
  sent it back into minutes of thought and the same denied write.
- The wallet balance check before an Ace request now waits up to 8 seconds
  instead of 3, so a slow afternoon at the account service no longer turns every
  step into a paused turn and a retry countdown.
- Stopping a turn now cancels the MCP tool call that is still running: OpenScience sends the protocol cancellation to the server instead of abandoning the request, ignores a reply that arrives afterwards, and releases the update lease the call was holding.
- The shell installer uses CPU flags exposed by Windows POSIX environments and defaults to the baseline archive when they are absent or unreadable, so x86-64 Windows hosts without confirmed AVX2 support avoid an optimized binary that dies with an illegal instruction.
- The global event stream the workspace subscribes to now buffers a bounded number of events per connection instead of growing the server's memory for as long as a browser tab stays stalled, and a tab that misses events re-hydrates on the next `server.connected` frame exactly as it does after a reconnect.
- Attaching a large file no longer discards workspace state you did not touch, and the composer now says the draft is not saved instead of losing it silently.

## v2.0.88 — 2026-09-10

### Added

- A conversation works in the project's connected read/write folder: relative
  paths the agent writes land there and stay, while caches and throwaway
  intermediates keep going to session scratch. The composer shows the working
  folder as a chip beside Tools, where a conversation can be pointed at another
  connected folder or at scratch. `session.create` accepts `workingRoot`, and
  `PUT /session/:id/filesystem/working-root` changes it later.
- Shell commands that need the network (`git push`, `gh`, `hf`, package
  installs, `curl`) ask once for their destination host and then run with the
  network and the same file confinement, using the GitHub login `gh` holds or a
  saved credential and the Hugging Face token. The Repository tab's push uses the
  same path. **Customize → Credentials** imports logins this computer already
  holds in one click, and a request card that asks for a login opens Credentials
  instead of inviting a paste into the chat.
- Short follow-ups such as "give me the abstract as LaTeX" run as quick tasks:
  no delegation posture, the model's low reasoning variant unless one was
  chosen, and a reminder to answer in one pass.

### Changed

- The activity trace reads like a log of work: one "Worked for 2m 3s" line
  folds the whole trace after a turn, and expanding it shows rows for each
  thought ("Thought 57s"), each burst of exploration ("Explored 4 files, ran 2
  commands"), each batch of edits, and each delegated agent, with narration in
  place. Rows stay mounted while folded, so a pending request or a draft answer
  survives the fold. Delegated agent rows lead with the task, name the agent
  quietly at the right, and show their state on a second line.
- Session outputs is one folded line ("3 files written this turn") that opens on
  demand.
- A stopped turn says so on its header line ("Stopped after 2m 3s") and nothing
  more; a stop the provider or a credential change caused keeps its reason as one
  quiet line. The "Stopped / Outputs kept / Left pending" card is gone; the error
  card keeps only its message.
- The trace sits on a 4px rhythm: 28px rows everywhere (nested tool rows
  included), narration with even margins, a clear breath before the answer, and
  chevrons that appear on hover. Finished tool rows are text-first; the glyph
  returns only while a call runs, waits, fails, or is cancelled.
- Delegated agent rows use one accent: only a failed worker or one waiting on the
  user is coloured; partial and cancelled outcomes read in words. The footer keeps
  the model and Fusion handoff, and its actions are real buttons.
- Worker sessions no longer offer a composer: the lead writes their brief and
  reads their handoff, and the page points back to the lead.
- Publishing stays with the lead: the task tool refuses a brief whose deliverable
  is a push, release, or upload, and workers are told so.
- A conversation that fails to load says so with a retry instead of posing as a
  new, empty session.
- The workspace speaks one colour vocabulary (`--color-*`), checked by a design
  contract; the migration also fixed hairlines that referenced an undefined
  alias and never rendered.
- The default theme is neutral grey in both schemes: dark backgrounds from
  `#191919` up, light from `#f7f7f7`, white-alpha hairlines, a light-grey brand
  surface instead of teal, and a muted slate only for links. Inline code is a
  quiet chip in the text colour rather than a green accent.
- Every trace row shares one type level (13/20, regular weight): the "Worked
  for" line, thought and burst rows, nested tool rows, agent rows and their
  details. Tool rows read as what happened ("Ran", "Read", "Searched", "Edited",
  "Wrote", "Fetched") and as what is happening while a call runs.
- The first-run setup is one quiet card: a small mark and step count, a title,
  one sentence, one action. No icon tiles, benefit cards, dots, or eyebrows;
  connection rows are plain logos with one control each. Three text styles from
  the shared scale, so every step reads the same.

### Fixed

- A compute job history one build cannot read no longer takes the whole server
  down. Credential teardown used to reject on the first unreadable
  `jobs.json`, and every request then failed with "Credential invalidation did
  not complete"; the unreadable history is preserved and skipped instead, and
  the inner handler errors are logged by name. The execution decision's new
  `scratch` field is optional so histories written by earlier builds keep
  parsing.
- A page served by a local OpenScience server no longer defers to a stored
  default server on another loopback port (a desktop sidecar or dev server that
  has since exited), which showed as "Failed to fetch" against a dead server.
- Production bundles no longer read `.env.local`, so a leftover file from the
  e2e harness cannot bake its throwaway server port into the embedded UI.

- A storage key listing that saw a sibling record vanish mid-scan (an atomic
  replace in flight) no longer reports the whole prefix as empty; it looks
  again, so a project's sessions cannot briefly disappear for one caller.

### Removed

- The desktop onboarding-operation endpoints and the `desktop_onboarding_operations`
  preference. Setup no longer creates projects, so nothing called them.

## v2.0.73–v2.0.87 — 2026-09-09

### Added

- New first-run setup, shown once to every install from this release on: a
  centered card with four steps. Account (required, browser sign-up/sign-in or a
  pasted key), Ace (recommended, opens billing and continues when Ace is on),
  connect your own models (ChatGPT / Codex, Anthropic, OpenAI, OpenRouter,
  Firecrawl keys, Modal detection, with provider logos and inline key entry),
  and done. Project creation moved to the Projects page, whose empty state now
  offers **New project**. The terminal install runs the same four steps inline
  the first time `openscience` starts (`openscience init` repeats them);
  scripted, CI, and restarted launches skip it.
- **Fusion**, an opt-in way to run delegated work: the model you selected stays
  the lead and hands substantial, well-specified work to one persistent worker
  on the configured Worker model, which is resumed for every execute task
  instead of a fresh child per handoff. Choose **Workers → Fusion** in the
  composer's Tools menu; the menu shows the lead/worker pair, task cards show
  the handoff number and lineage, the cost readout includes the worker's spend,
  and each turn is bounded to six handoffs. Publication and paid compute stay
  with the lead. Ordinary (Parallel) delegation is unchanged.

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
- Tighten the approval prompt: the action being approved is the headline with
  **Approval required** as the eyebrow above it, the controls are 24px
  (**Deny** · **Allow…** · **Allow once**), and the prompt no longer paints a
  second frame inside the warning border.
- Redesign the delegated-agent card in the conversation: one header row in the
  same voice as the tool rows around it (agent, task, status, duration, ops),
  a flat body hanging from an outcome-coloured rail instead of boxes inside a
  box, the worker's findings without the lead-facing session preamble, saved
  Results as openable chips, quiet footer metadata with **Open agent** and
  **N operations** as text actions, and a card that stays in place when the
  worker needs an approval or asks a question (status reads **Needs your
  approval**) rather than being swapped for a bare tool row.
- Stream shell output instead of buffering it (#564): the Bash tool redacts
  each completed run of lines once and writes everything past the 50 KiB /
  2,000-line preview straight into the owned output file, so a command that
  prints hundreds of megabytes no longer holds all of it in memory or rescans
  the whole history for secrets on every chunk; the live output card is
  refreshed on a timer rather than per chunk, and a secret split across two
  chunks or a multi-line private key is still redacted.
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

### Fixed

- Linux supervised commands inherit blocking output handles so high-volume
  native tools do not abort with `EAGAIN` when their output pipe fills.
- Oversized incomplete Bash output lines and private-key blocks are replaced
  with explicit redaction markers; provenance previews are redacted before
  clipping.
- Keep launcher CPU fallback confined to a read-only startup probe, respect
  scientific-source cooldowns without early retries, preserve special characters
  in local file links, and verify upgrades when the old versioned executable
  remains on disk.
- Stop a repeated tool call before it runs: the third identical call used to
  execute while its approval card was still showing, and a deny only ended
  the turn afterwards. The check now sits in front of the tool itself and
  honours the session's own permission rules.
- Keep only the answer that succeeded when a provider fails mid-stream and
  the request is retried; the half-written text of the failed attempt no
  longer stays in the transcript or in the model's context.
- Fork a compacted session with its verbatim tail intact and without
  re-finalizing a settled compaction; every message id the copy refers to
  (tail anchor, epoch, transaction, continuation, derived part ids) now moves
  with it.
- Let **Stop** reach a prompt that is waiting on an attachment permission card,
  keep a rename made while the title was being generated, and stop replaying
  slash-command notices (`/status`, `/stop`) to the model as assistant text.
- Write the replacement literally when the edit tool replaces every match:
  `$$`, `$&` and `$'` in the new text were expanded as replacement patterns.
- Replay Anthropic thinking blocks whose text the API omitted, and every
  `redacted_thinking` block, instead of dropping them; the API rejected the
  next turn of the tool loop as an edited thinking sequence.
- Answer 404/400 from `POST /session/:id/message` for an unknown session or
  model instead of an empty 200 body; honour the declared charset when the
  fetch tool decodes a page; validate the branch passed to the repository push
  route and push an explicit refspec so a field cannot carry git options; and
  ask the client to resync when the per-session event stream overflows,
  dropping part updates before status, finish, permission or question events.
- Save configuration as written: a `"permission": "allow"` string in
  `openscience.jsonc` made every later global write fail, and a JSON file
  gained every keybind default and agent default it never set. Patches now
  merge onto the raw file and touch only the keys that changed, and an MCP
  entry that only sets `enabled` shows as disabled or as missing its
  definition instead of vanishing from Settings.
- Deliver the final `done` line of `openscience run --format json` to a slow
  consumer (output is written through blocking writes, since `process.exit`
  discarded what the pipe had not taken), and say what the run is waiting for
  when a message was given but stdin is an open pipe.
- Leave the installed CLI alone when the data location is relocated or reset
  (`bin/` is machine state; a reset used to restore the binary copied at
  relocation time over an upgraded one), and refuse to recreate a recorded
  data location whose drive is not mounted instead of starting from an empty
  install.
- Keep the workspace up when the preferences request fails, clear a session's
  "working" state on reconnect when it finished while the stream was down,
  keep attachment bytes out of persisted drafts (one multi-megabyte image
  evicted every other saved workspace key and disabled persistence for the
  page), place the cursor correctly around conversation pills restored from
  history, remove pruned session state without throwing from the scroll
  timer, and stop a route-entry refresh from rolling live streamed text back
  to an older snapshot.
- Stop warning about a retained staging file after every successful save;
  native file errors now carry an error code like the fs module's.
- Stop showing a sent message twice in sessions created before 14 August 2026:
  the message id's time prefix wrapped that day, so the composer's optimistic
  copy sorted to the top of the transcript and stayed there until reload. The
  composer now proposes an id that sorts after the session's newest message,
  the same way the server does.
- Give a new session an empty state: the project name, a heading, and three
  starters that seed the composer, instead of a blank canvas.
- Show turn durations as `6m 10s` like the activity rows (was `6m, 10s`), let
  the effort chip show "Provider default" without truncation, use sentence
  case for remaining Title Case labels (Jump to latest, Manage result, Rename
  result, Skill library, Add server, Manage servers, Page not found), and route
  the recovery page's accent through the defined error colour token.
- Draw every interface icon on the 12/14/16/20 scale with one stroke weight
  (sizes of 11, 13, 15, 17 and 19 and seven stroke widths rendered slightly
  blurred next to each other), and keep the Files pane's location tabs and
  **More** menu on one row at narrow widths (inactive tabs collapse to their
  icons instead of the menu wrapping underneath).

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
