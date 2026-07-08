---
name: initialize-atlas-graph
description: "Create or link this repo's Atlas research graph so hypotheses, experiments, runs, and decisions are tracked. Use when the canvas says 'no graph for this project', when the user asks to initialize/set up Atlas, or before starting research that should be recorded."
category: research
allowed-tools: [Bash]
---

# Initialize the Atlas Research Graph

## Overview

An Atlas **project** is this repo's research graph — the root that hypotheses,
experiments, training/eval runs, evidence, and decisions hang off. Creating (or
linking to an existing) graph is a one-command, dedupe-safe operation. It is
keyed off the **git repo**, not the opened folder, so a subfolder or a fresh
clone at a different path resolves to the **same** graph.

Run this skill when:
- The canvas shows "no graph for this project" / the folder isn't linked yet.
- The user asks to "initialize", "set up Atlas", or "start tracking" research.
- You are about to begin research work that should be recorded.

## Steps

1. **(Optional) Confirm the CLI is authenticated.**
   ```bash
   atlas doctor --format=json
   ```
   If it reports unavailable/unauthenticated, tell the user to run
   `openscience login` — the graph cannot be created without a session.

2. **Create or link the graph** (idempotent — safe to re-run; returns the
   existing graph if one already exists):
   ```bash
   openscience project init --format=json
   ```
   On success this prints `{"project_id":"<id>"}` and writes `.openscience/project.json`
   at the repo root so the canvas links to it immediately.

   On failure it prints `project_id: null` plus an `error` kind (and `host`,
   `status`, `message` when known). Relay the fix that matches the kind — do
   NOT guess or tell the user to re-login for a network problem:
   - `"unauthenticated"` — no session, or the backend rejected the saved key.
     Tell the user to run `openscience login`.
   - `"unreachable"` — the Atlas backend at the printed `host` could not be
     reached (network/DNS error or 5xx). The user IS logged in; suggest checking
     connectivity and any `OPENSCIENCE_API_BASE`/`SYNSC_API_BASE` override, then
     retrying — not re-authenticating.
   - `"plan"` — authenticated, but the account has no active Atlas plan. Point
     the user at https://app.syntheticsciences.ai/cli (Plan tab); include the
     backend `message` if present.
   - `"backend"` — anything else; show the backend's `status`/`message` verbatim.

3. **Confirm to the user.** Report the `project_id` and tell them the graph now
   shows in the canvas (Atlas pane). From here, milestones are recorded against
   this graph as the work progresses.

## Notes

- **Idempotent & dedupe-safe:** re-running never creates a duplicate; it returns
  the same graph for the same repo.
- **Repo-rooted:** run it from anywhere inside the repo — it resolves to the git
  top-level.
- **Do not** hand-edit `.openscience/project.json`; let `openscience project init` manage
  it (use `openscience project merge` to pick a canonical root if duplicates exist).
