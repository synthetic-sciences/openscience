# Experiments and studies

How metric tracking and the autoresearch loop are built, and where to change
them. User-facing behaviour is documented in
`frontend/docs/src/content/openscience/autoresearch.mdx`.

## Shape

```text
training script ──openscience_track──▶ marked stdout lines ──▶ job log
                                                                 │
                     Tracker.Follower (offset + partial line) ◀──┘
                                 │
                           Experiments store (SQLite per project)
                                 │                      ▲
        StudyDriver tick (3 s) ──┤                      │ study / experiments tools
   follow, settle, kill, budget, │                      │ (agent)
   wake the session              ▼                      │
                        Bus events ──▶ /experiments routes ──▶ Autoresearch pane
```

- `backend/cli/src/experiments/index.ts`: the `Experiments` namespace. One
  `bun:sqlite` file per project under `<data>/experiments/<projectID>.sqlite`
  with `study`, `idea`, `run`, `point`, `event` tables. Every mutation publishes
  a Bus event (`experiment.run.updated`, `experiment.run.points`,
  `experiment.study.updated`, `experiment.idea.updated`,
  `experiment.study.event`), which the global SSE forwards and the SDK types.
  Headline and delta are derived here: the study metric's summary value, else
  its last logged value; delta is signed so positive always means better.
- `sdk.ts`: the Python SDK as a string constant (`PYTHON`) plus the `wandb`
  shim (`WANDB_SHIM`). `materialize()` writes both into
  `<cwd>/.openscience/sdk/` so they travel with the job to any target;
  `wrap()` prefixes the command with the exports the script needs
  (`PYTHONPATH`, `OPENSCIENCE_RUN_ID`, `OPENSCIENCE_TRACK_TRANSPORT=stdout`,
  `CUDA_VISIBLE_DEVICES` for a GPU slot).
- `tracker.ts`: the record schema (`init`, `log`, `summary`, `finish`,
  `artifact`), the `@@openscience.track ` line parser, `strip()` for log
  readers, and `Follower`, which reads a growing log from its last offset.
  `ComputeJobs.log()` strips tracking lines, so neither people nor the model
  see them; `ComputeJobs.logPath()` gives the follower its file.
- `kill.ts`: free-text kill criteria. Clauses split on `OR`, commas,
  semicolons, newlines and sentence periods; verbs and objects are stripped
  ("Kill any run after 2 minutes." reads as "2 minutes"). Rules: time, steps,
  plateau (with or without a metric; none means the study metric), threshold
  with a window. Unparsed clauses are returned, and `study create` refuses
  them rather than dropping a rule silently.
- `gpu.ts`: `nvidia-smi` inventory with a 4 s cache; `slots()` is one slot
  per GPU or a single CPU slot.
- `driver.ts`: `StudyDriver`. Per project, a 3 s interval ticks every live
  study: poll followers, settle runs whose jobs ended (`finished`, `failed`,
  `cancelled`, or `killed` when a rule fired), apply kill criteria and cancel
  through the broker, read session spend for cost budgets, render the ledger,
  then wake the study's session with one coalesced "Study update" message
  when it is idle. Wake-ups are capped at 12 per hour (budget messages
  bypass the cap); an idle session with free slots and queued ideas is
  nudged at most once per 4 minutes. `resumeAll()` runs from the project
  warmup so studies survive restarts. Every external effect has a seam in
  `configure()` for tests.
- `ledger.ts`: renders `study.md`, `ideas.md`, `results.tsv`, `lessons.md`
  into the study root from the store. Nothing parses them back.

## Why stdout, not HTTP

Local compute jobs run under the host sandbox, which denies every socket on
macOS and Linux. A tracker that needs a port would silently lose metrics on
the most common target. Marked lines on stdout work everywhere the job log
does: local, SSH (the broker streams stdout to the local log), and Modal (the
log arrives when the run completes, so Modal metrics are not live). HTTP
ingest (`/experiments/ingest/*`) exists for scripts outside a job: kernels,
notebooks, or a user's own process on the same machine.

## Tools

- `study` (`src/tool/study.ts`): `create`, `status`, `propose`, `start`,
  `record`, `drop`, `conclude`. `start` writes the SDK into the job cwd,
  wraps the command, creates the run, then dispatches through
  `ComputeJobTool.execute` so the compute permissions and plan digest are
  the ordinary ones; the job id is bound to the run afterwards. One live
  study per session (`studyForSession`).
- `experiments` (`src/tool/experiments.ts`): `runs`, `keys`, `series`,
  `compare`. Read-only (`PASSIVE` risk); `study` is `CONTAINED`.
- Both are offered to Research agents when the request reads like a study
  (`ToolSelection.relevant`) and always while the session drives a live
  study (`SessionPrompt` adds them to the activated set). The study reminder
  in `SessionPrompt.insertReminders` carries the rules and the current state
  (baseline, best, live, queue, budget, lessons) on every request.

## Pane

`frontend/workspace/src/atlas/AutoresearchPane.tsx` is a right-pane tab
(`autoresearch`) beside Files, Terminal and Compute, with one tab per study.
It reads `/experiments/*` and refetches on the `experiment.*` events
(debounced; points at 1 s). `experiments/MetricChart.tsx` holds two
dependency-free SVG charts: `HillClimbChart` (every run in order, the
best-so-far step line through kept runs, the baseline as a reference) and
`MetricChart` (training curves with shared hover, smoothing and log scale).
Pause, Resume and Halt call `/experiments/studies/:id/:action`; Write up
prefills the composer. Runs outside any study are listed only in the empty
state; the pane is about studies.

## Tests

`backend/cli/test/experiments/`: store, kill criteria, tracker against a real
Python process, the driver through its seams, the tools, and one real
sandboxed local compute job whose metrics travel the whole path. The shard
weight lives in `tooling/repo/test-shards.ts`.
