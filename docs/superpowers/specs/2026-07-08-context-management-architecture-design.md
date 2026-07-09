# Context Management Architecture — Design & Roadmap

- **Status:** Draft (approved for Phase 1)
- **Created:** 2026-07-08
- **Owner:** KB
- **Related:** [[2026-07-07-auto-compaction-context-window-design]] (the reactive compaction this supersedes/extends), `backend/cli/src/session/{compaction,processor,prompt,message-v2}.ts`
- **Prior art studied:** `~/codes/claude-code`, `~/codes/opencode`, `~/.hermes/hermes-agent` (deep source reads, 2026-07-08)

---

## 1. Problem & motivation

Auto-compaction at 75% works, but it treats the symptom, not the disease. Observed failures:

1. **Re-catch-up loop.** After compaction the agent re-reads every file to rebuild state and immediately re-overflows — a compact → catch-up → compact cycle that never makes progress. (Partially mitigated by the new self-contained `handoff.md` summary, but still fundamentally reactive.)
2. **Image bloat → premature compaction.** Reading figures/screenshots injects multi-MB base64 that is re-shipped every turn, filling the window fast and triggering full LLM compaction over what is really disposable media.
3. **Reactive-only.** We only act at a threshold, and the only action is the most expensive, most lossy one — an LLM summary generated under pressure (task-drift risk, cost, latency).

**Thesis:** compaction is the *last resort*, not the strategy. The strategy is to keep the working context lean by default so compaction is rare and, when it happens, near-free. openscience has two assets the reference tools lack — **a multi-agent runtime** (subagents) and **durable on-disk research artifacts** (`methodology.md`, `research-state.md`, `handoff.md`) — and the best design leans on both.

---

## 2. Goals / non-goals / principles

### Goals
- G1. An image-heavy or tool-heavy session does **not** trigger compaction from disposable content (media, stale tool output).
- G2. When compaction does happen it is **cheap** (ideally no LLM call) and the resumed agent continues from a self-contained handoff **without re-reading**.
- G3. Heavy context (large files, broad searches, figure/vision analysis, literature) is **isolated in subagents** — only distilled results reach the main window.
- G4. Durable state lives on disk as addressable artifacts; the window is a **curated view**, not a growing log.
- G5. Everything is measurable — we can see context composition and compaction frequency over time.

### Non-goals
- Not changing the provider/model routing (that is [[2026-07-08-context-management-architecture-design]]-adjacent but separate).
- Not building a vector DB / embeddings store (FTS + references are sufficient; revisit later).
- Not a rewrite — each phase is independently shippable behind the existing `compaction` config surface.

### Principles — the hierarchy of context actions (cheapest/least-lossy first)
1. **Don't put it in context** — delegate to a subagent; keep a reference/handle on disk.
2. **Evict losslessly** — content on disk, pointer in context (`<persisted-output>`); strip re-shippable media.
3. **Reduce deterministically** — dedupe identical outputs, 1-line tool summaries, truncate args. Zero LLM cost.
4. **Compress (LLM)** — only when 1–3 can't hold the budget. Anchored/incremental, structured.
5. **Reactive backstop** — provider overflow error → compact-and-retry (already shipped).

An action at level N should only run when levels < N can't keep us under budget.

---

## 3. Prior art (distilled)

Convergent across all three references:

| Mechanism | claude-code | opencode | hermes |
|---|---|---|---|
| Flat image token estimate (never base64 len) | 2000 | 2000 | 1500–1600 |
| Strip historical media after compaction | `[image]` | `stripMedia` | `_strip_historical_media` |
| Image resize before send | 2000px/5MB, JPEG ladder | 2000px/5MB | 4MB reactive |
| Anchored/incremental summary (update, not regen) | partial-compact | `<previous-summary>` | `_previous_summary` |
| Head + tail verbatim, summarize middle; force last user msg into tail | ✓ | ✓ (turn/token split) | ✓ (issue #10896) |
| Deterministic pre-summary prune (dedupe, 1-line, protect skills) | micro-compact | `prune` | `_prune_old_tool_results` |
| Tool-output spill-to-disk + read-back handle | `<persisted-output>` | truncate dir | `/tmp/hermes-results` |
| Lazy skills (index only, body on invoke) | ✓ | ✓ | ✓ |
| Cache-safe (freeze system/memory/skills; breakpoints) | ✓ | ✓ | frozen snapshot |
| Circuit breaker / anti-thrash | 3 fails | — | ineffective-count + cooldown |

Novel, worth stealing:
- **claude-code:** disk-backed **Session Memory** used as the summary *before* any LLM call (compaction with zero API call); server-side `clear_tool_uses_20250919`; re-read **dedup stub**.
- **hermes:** **context references with a hard % budget** (`@file`/`@url`→LLM-summary/`@git:N`, 0.25 soft / 0.50 hard-refuse); **frozen self-curating disk memory** (`MEMORY.md`, cache-safe); **`on_pre_compress` hook**; **`session_search`** (FTS5 over all past transcripts, zero LLM cost).
- **opencode:** reasoning fidelity across model switches + Anthropic signature preservation — **already shipped in openscience**.

---

## 4. Current state (openscience)

- **Have:** reactive auto-compaction @75% with the negative-`usable` + `!summary` auto-resume fixes; `prune()` (clears old tool outputs to `[Old tool result content cleared]`, drops attachments) — but **post-compaction only** and **image-blind**; `<persisted-output>` tool-result storage (harness); structured self-contained **`handoff.md`** summary + `/handoff`; reasoning replay + signature handling.
- **Lack:** flat image token accounting in prune; `stripMedia` on the summary request; historical-media stripping; image resize; pre-compaction prune; dedupe; anchored/incremental summary; continuous handoff maintenance; delegation-by-default; reference-based file access; relevance-based eviction.

---

## 5. Target architecture

Four pillars, mapped to the action hierarchy:

**Pillar A — Delegate-first (level 1).** Context-heavy work runs in subagents; only distilled results return. This is the single biggest lever and is uniquely available to openscience. Figure/vision analysis, large-file processing, broad searches, and literature review become subagent tasks by default.

**Pillar B — Continuous handoff/memory (levels 2 & 4).** `handoff.md` is maintained *incrementally* (cheap background pass after significant steps), so it is always current and self-contained. Compaction becomes "drop the log, keep `handoff.md`" — no panic LLM summary — and the re-catch-up loop becomes structurally impossible. The same artifact serves compaction summary + inter-agent handoff + durable memory.

**Pillar C — Reference-based working set (levels 2 & 3).** Content (files, images, tool outputs, datasets) lives on disk as addressable artifacts; the window holds system prompt + memory/handoff snapshot + current task + recent working set. Re-reads dedup to a stub; media strips to a placeholder.

**Pillar D — Relevance-aware retention (level 3).** Evict by relevance (was the artifact re-referenced?) rather than pure recency; protect the working set, evict touch-once items.

---

## 6. Phased roadmap (tracking)

**Legend:** ☐ not started · ◐ in progress · ☑ done · ⊘ dropped

| ID | Phase | Task | Level | Size | Status |
|----|-------|------|-------|------|--------|
| P0.1 | Instrument | Per-turn context-composition telemetry (tokens by type: text/image/tool/reasoning/skills/system) | — | S | ☑ |
| P0.2 | Instrument | Compaction telemetry: frequency, trigger source, tokens reclaimed per mechanism | — | S | ☑ |
| **P1.1** | **Stop bleed** | **Flat image token estimate in `prune` (~1600/image attachment)** | 3 | S | ☑ |
| **P1.2** | **Stop bleed** | **Strip historical media — replace base64 in all-but-newest image with `[image stripped]`** | 2 | S | ☑ |
| **P1.3** | **Stop bleed** | **`stripMedia` option on `toModelMessages`, passed by the compaction summary request** | 2 | S | ☑ |
| **P1.4** | **Stop bleed** | **Run `prune` BEFORE full compaction; only LLM-summarize if still over threshold** | 3→4 | M | ☑ |
| P2.1 | Reduce | Dedupe identical tool outputs (hash) → `[Duplicate tool output — see more recent call]` | 3 | M | ☑ |
| P2.2 | Reduce | Replace old tool outputs with 1-line tool-aware summaries (`[bash] ran X → exit 0, 47 lines`) | 3 | M | ☑ |
| P2.3 | Reduce | Truncate oversized tool-call args inside valid JSON | 3 | S | ☑ |
| P2.4 | Reduce | Oversized-image guard → **delegate-resize nudge** (agent resizes in its own sandbox; no harness codec). Byte-size trigger; dims already caught by read.ts | 1 | M | ☑ |
| P2.5 | Reduce | Circuit breaker: stop after N consecutive ineffective (<10%) compactions | 4 | S | ☑ |
| P3.1 | Handoff | Anchored/incremental summary — feed prior `handoff.md` back, "update not regenerate" | 4 | M | ☐ |
| P3.2 | Handoff | Head+tail protection: keep system + first-N and recent tail verbatim; force last user msg into tail | 4 | M | ☐ |
| P3.3 | Handoff | Background maintenance pass — refresh `handoff.md` after significant steps (aux/cheap model) | 4 | L | ☐ |
| P3.4 | Handoff | Compaction uses a current `handoff.md` directly (no LLM call when fresh) | 1 | M | ☐ |
| P4.1 | Delegate | Delegate-by-default heuristics: large reads / broad greps / literature → subagent; distilled result returns | 1 | L | ☐ |
| P4.2 | Delegate | Vision subagent for figure/image verification — image stays on disk, finding returns as text | 1 | M | ☐ |
| P4.3 | Delegate | `<persisted-output>` spill emits a "delegate to explore subagent, don't read the full file" hint | 1 | S | ☐ |
| P5.1 | Reference | Read-time file-read dedup (claude-code `FILE_UNCHANGED_STUB` model): mtime-cache re-reads, keep the OLDER full copy, stub the NEWER/current read with a BACKWARD "unchanged, still current" ref | 2 | M | ☐ |
| P5.2 | Reference | Context references `@file`/`@folder`/`@url`/`@git` with 0.25 soft / 0.50 hard budget | 2 | L | ☐ |
| P5.3 | Reference | Relevance-based retention — protect re-referenced artifacts, evict touch-once | 3 | L | ☐ |
| P5.4 | Reference | `session_search` (FTS5 over past transcripts) — recall on demand, zero LLM cost | 1 | L | ☐ |

Sizes: S ≤ ½ day · M ≈ 1–2 days · L ≈ 3+ days / needs its own mini-spec.

### Phase acceptance criteria
- **P0** ☑ — a debug view (or log line) shows the token breakdown by content type each turn; compaction events record what fired them and how much each mechanism reclaimed.
  - *Shipped:* `MessageV2.composition()` (pure, deterministic, mirrors `toModelMessages` accounting — pruned tool parts count their cleared placeholder so a prune visibly shrinks the breakdown). `SessionTelemetry` (`src/session/telemetry.ts`) defines two always-on bus events (auto-streamed to clients via the `BusEvent` registry) with a paired DEBUG log line: `session.context` (`{system,text,reasoning,tool,skills,image}` + `images` + `total`, emitted per turn before the model call) and `session.compaction` (`{trigger: proactive|overflow|manual, mechanism: prune|summary, before?, after?, reclaimed}`, one per reclaim mechanism). `trigger` threaded through `CompactionPart → create → process`. `skills` bucket = `skill`/`artifact` tool calls; the skill *catalog* lives in `system` (not separately isolated — future refinement). Live-verified: `session.context total=8740 system=1514 text=7226 …` fired on a real `--bare` turn.
- **P1** *(the immediate fix)* — an image-heavy session (read 10 figures) does not trigger compaction from image accumulation; once an image is superseded its base64 is gone from later requests; the compaction summary request contains no base64.
- **P2** ☑ — the LLM summary fires markedly less often; when it does, cheap reduction ran first and reclaimed measurable tokens; a runaway session cannot spin on doomed compactions.
  - *Shipped (P2.1/2/3/5):* deterministic reduction ladder in `message-v2.ts`, applied to pruned/superseded tool parts and kept in lockstep with `composition()`:
    - **P2.2** `toolSummary()` — a pruned tool output renders a 1-line tool-aware stand-in (`[bash] npm test → cleared (3 lines)`) instead of the blunt `[Old tool result content cleared]`.
    - **P2.3** `truncateArgs()` — a pruned tool call's oversized string args are capped at 200 chars (`…[+N chars]`) inside valid JSON; live calls keep full args.
    - **P2.1** `supersededOutputs()` — a later tool output byte-identical to an EARLIER call collapses to a back-ref (lossless; the EARLIEST copy keeps the body; skips small outputs and parts with attachments). **Structurally fixed** after a live test: the original keep-*newest* design stubbed the *older* read, so the model saw "first read = stub, later read = full body" and misread it as the file having mutated between reads — the compaction summary then amplified it into a false "something is regenerating the data" warning. A wording-only fix (adding an "UNCHANGED" assertion) was **insufficient** (re-test still reported "content differed between reads") — the model perceives two visibly different renders regardless of the stub text. Root cause = *which* copy is stubbed. Prior-art: **hermes** = same keep-newest flaw (`context_compressor.py:853`); **opencode** = no dedup (prompt discourages re-reads); **claude-code** = keep-OLDER, backward ref, `FILE_UNCHANGED_STUB` — immune. Fix: flipped `supersededOutputs` to **keep-older** (stub the later re-read), backward-pointing wording (`[Duplicate read omitted — byte-for-byte identical to an earlier read of the same tool in this conversation; the content is UNCHANGED. Refer to that earlier copy.]`). Self-healing under pruning: compacted parts are excluded, so when the kept earliest copy is pruned the next occurrence renders full again — no dangling pointer, no content loss. (claude-code's *read-time* mtime variant remains the **P5.1** target for the file-read-specific case; this render-pass flip achieves the same model perception and covers all tools.)
    - **P2.5** circuit breaker (`compaction.ts`) — `noteCompaction`/`breakerTripped`/`resetBreaker`; 3 consecutive <10% reclaims stop proactive compaction for the session (reactive overflow path remains the backstop); fed by both prune + summary.
  - **P2.4 (delegate-resize)** — instead of a harness image codec (blocked: the CLI ships native cross-platform binaries, no `sharp`/`photon` in tree), the harness *never ships* an oversized image. `oversizedImageNudge()` substitutes an actionable nudge telling the agent to resize the source file — visible in the preceding read/attach — in its own bash/python sandbox and re-read the smaller copy (hermes' runtime-Pillow model, relocated to the agent). Closes a real **correctness gap**: a 5–32MB image clears `read.ts`'s 32MB/8000px checks then 400s on the provider's per-image 5MB cap. Applies to user file parts + tool attachments, overrides `keepRecentImages`; `composition()` counts the nudge as text. v1 triggers on byte size; pixel-dimension oversize is already caught at read time by `read.ts`. Live-verified: a real 6MB read returned the exact nudge, no 400.
- **P3** — compaction produces no visible re-catch-up; a fresh session started from `handoff.md` continues the task correctly; when `handoff.md` is current, compaction makes no summarization API call.
- **P4** — during heavy exploration the main window stays roughly flat while a subagent's window absorbs the tokens; figure verification never puts base64 in the main loop.
- **P5** — the main window is a curated view: files/outputs are handles fetched on demand; re-reads don't re-inject content; retained set tracks the active task, not recency.

---

## 7. Telemetry / success metrics

Track before/after each phase (P0 enables these):
- **Compaction frequency** — compactions per 100 turns (target: ↓↓).
- **Median context utilization at compaction** — should trend toward "compaction is rare and late," not "early and often."
- **Tokens reclaimed by level** — how much by strip/prune/dedupe (levels 2–3) vs LLM summary (level 4). Goal: most reclamation is levels 2–3.
- **Re-catch-up incidence** — turns spent re-reading immediately after a compaction (target: ~0).
- **Image token share** — % of window from media (should stay bounded regardless of figures read).
- **LLM-summary rate** — fraction of compactions that required an actual summarization call (target: ↓ toward 0 as P3 lands).

---

## 8. Risks & mitigations
- **Delegation changes agent behavior** (P4) — could over-delegate or lose context the main agent needs. Mitigate: heuristics + thresholds (only delegate above a size/breadth bar), keep the distilled result rich, gate behind config, roll out per-tool.
- **Background handoff maintenance cost** (P3.3) — an extra cheap-model call per significant step. Mitigate: debounce (only on meaningful state change), small aux model, cap frequency; measure the token cost vs the compaction cost it avoids.
- **Stripping media too aggressively** — an agent may need to re-view an image. Mitigate: keep the newest image(s), leave an on-disk handle + `[image stripped — read <path>]` so it can re-fetch.
- **Relevance heuristic wrong** (P5.3) — evicts something still needed. Mitigate: conservative (only evict clearly touch-once, old, non-skill); the on-disk handle means eviction is recoverable, not destructive.
- **Prune before compact hides a real overflow** (P1.4) — if prune reclaims just enough to dodge compaction but context keeps climbing. Mitigate: re-check threshold after prune; the reactive overflow-error backstop still catches the hard case.

---

## 9. Open questions / decisions
- Q1. **RESOLVED** — per-session `.openscience/handoffs/<sessionID>.md`: one writer per file, so parallel sessions/subagents never clobber (no shared mutable `latest.md` — that reintroduces cross-talk; "latest" is a read-time `ls -t`, not a written file). Dir self-ignores via a `*` `.gitignore`. `/handoff <path>` overrides with an explicit file.
- Q2. Should the background handoff pass (P3.3) be a subagent or an inline aux-model call? *(Subagent = isolation; inline = simpler/cheaper.)*
- Q3. Delegation policy (P4.1) — automatic (harness decides) vs advisory (prompt tells the agent to delegate)? Start advisory (low-risk), measure, then automate.
- Q4. Do we adopt Anthropic's server-side `clear_tool_uses` for the managed path, or keep client-side control? *(Client-side is provider-agnostic; server-side is free but Anthropic-only.)*

---

## Appendix — file map (where each phase lands)
- P1.1, P1.4, P2.*, P3.* — `backend/cli/src/session/compaction.ts` (`prune`, `process`, budget), `backend/cli/src/session/prompt.ts` (loop ordering).
- P1.2, P1.3, P5.1 — `backend/cli/src/session/message-v2.ts` (`toModelMessages`, add `stripMedia`, historical-media strip, dedup stub).
- P2.4 — new `backend/cli/src/util/image.ts` (resizer; check for an existing sharp/photon dep first).
- P4.* — `backend/cli/src/agent/` (subagent config), tool-output storage hints, a `vision`/`explore` subagent.
- P5.2, P5.4 — new preprocessing (context references) + `backend/cli/src/storage/` (FTS index over sessions).
- P0.* — `backend/cli/src/session/processor.ts` / `status.ts` (telemetry).
</content>
