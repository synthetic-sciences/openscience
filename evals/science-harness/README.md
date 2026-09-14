# Core Research harness on native science benchmarks

OpenCode's Terminal-Bench path is the same shape as ours: wrap the product CLI
as a Harbor installed agent, keep native tasks and graders in Harbor, and freeze
the executable rather than a prompt filename. The adapter lives in
[`tooling/harbor`](../../tooling/harbor). This directory is the campaign layer
on top of that adapter.

The loop is not forked. `openscience run --auto-approve --workspace project`
is the harness. Harbor 0.22.0 owns images, limits, verifiers, and ATIF for the
Harbor lanes. BixBench3 and ResearchClawBench keep their native runners.

## Skills

**Default: bundled skills on.** Research already indexes the fifteen core
skills and loads bodies on demand. That is the product. OpenCode has skills
but no always-present index; stripping ours would measure a different agent.

`--skills none` sets `OPENSCIENCE_DISABLE_BUNDLED_SKILLS` and is a labeled
ablation, not the primary score. Task-provided Harbor skills still copy in.
`--auto-approve` still disables delegation. Remote/account tools stay denied.

## Prepare this machine

```bash
python evals/science-harness/prepare.py
```

That downloads Harbor datasets, freezes TB4 science IDs, clones the
ResearchClawBench, BixBench3 and DrugDiscoveryBench runners, and writes
`status.json` (gitignored, no secrets) with a `need_from_you` list. It does not
score anything.

Harbor trials need a Linux `openscience` binary, not the host Darwin install:

```bash
bun run --cwd backend/cli build --headless --target linux-x64-baseline
```

The artifact is `backend/cli/dist/headless/@synsci/openscience-linux-x64-baseline/bin/openscience`.

## Benches

| Bench                      | Runner                               | Pin                                                                                                                |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `terminal-bench-science`   | Harbor 0.22.0                        | `terminal-bench-science/terminal-bench-science@v0.1`                                                               |
| `terminal-bench-4-science` | Harbor 0.22.0                        | `terminal-bench/terminal-bench@4.0.0`, `metadata.category == "Science"` IDs in `tb4-science-tasks.json` (14 of 66) |
| `biomni-bench-50`          | Harbor 0.22.0                        | Hugging Face `phylobio/BiomniBench-DA` revision in `datasets.json`                                                 |
| `drugdiscoverybench`       | Harbor 0.22.0 (upstream pins 0.13.1) | `scaleapi/DrugDiscoveryBench` clone, 82 tasks, rubrics from the gated HF dataset                                   |
| `bixbench3`                | Inspect AI / GCP                     | `EdisonScientific/BixBench3` v1.0.0; OpenScience replaces the ReAct solver                                         |
| `researchclawbench`        | ResearchClawBench                    | `InternScience/ResearchClawBench`; `adapters/researchclaw.py` is the agent cmd                                     |

Do not average these metrics. Do not mix TB4 science with Terminal-Bench-Science
or with the historical TB3 Science 15.

## Protocol that matches the public leaderboards

- **Attempts.** Terminal-Bench-Science, Terminal-Bench 4, BiomniBench-DA and
  DrugDiscoveryBench all report the mean of **3 trials per task**. `run.py`
  defaults `--attempts 3` (Harbor `--n-attempts`); `--attempts 1` is a smoke run,
  not a score.
- **Effort.** Leaderboard rows run their harness at maximum reasoning effort
  (Claude Code `max`, Codex `xhigh`). Pass the model's top reasoning setting with
  `--variant` and keep `--effort` (the harness loop setting) in the identity.
- **Cost.** Harbor sums `cost_usd` per trial. The adapter reports observed
  root-session usage even for timed-out or errored attempts, flagged
  `usage_complete=false` in the ATIF trajectory, so a Pareto point never omits
  spent tokens.
- **Judge credentials** go to the verifier only: `run.py` reads the bench's
  `judge_env` names (`GEMINI_API_KEY` for Biomni, `JUDGE_BASE_URL` /
  `JUDGE_API_KEY` / `JUDGE_MODEL` for DrugDiscoveryBench) from the host and
  passes them as Harbor `--ve`. They never enter the agent environment.
- **Environment.** The Terminal-Bench leaderboards ran on Modal. Docker on an
  Apple-silicon Mac emulates amd64 and skews the 8-hour task budgets; use
  `--env modal` (or a Linux x86 host) for scored runs.
- **Other harnesses' per-task results.** Public Harbor Hub jobs expose per-task
  rewards (`harbor auth login`, then `harbor hub job tasks <job-id>`). The TB4
  science delta uses those rows filtered to the frozen 14 IDs; nothing is
  re-run.

## Print the Harbor command (no spend)

```bash
python evals/science-harness/campaign.py argv \
  --bench terminal-bench-science \
  --model anthropic/claude-opus-5 \
  --binary /absolute/path/to/linux/openscience
```

## Run (spends money)

```bash
python evals/science-harness/run.py \
  --bench terminal-bench-science \
  --model anthropic/claude-opus-5 \
  --binary /absolute/path/to/linux/openscience \
  --binary-sha256 <sha256> \
  --n-concurrent 4
```

`--skills none` is the ablation. `--limit 1` is a smoke subset (`--n-tasks`). `--dry-run`
prints the runner command (secrets redacted) and writes
`jobs/<job-name>.identity.json` without launching. Each run gets its own Harbor
job name (`<bench>__<model>__<skills>__<utc-stamp>`).

### Terminal-Bench 4 science subset

Harbor Hub does not take `domain=science` as a dataset alias. Download 4.0.0,
then freeze IDs from `task.toml` metadata:

```bash
python evals/science-harness/campaign.py freeze-tb4 --dataset-dir /path/to/tb4
```

A campaign refuses to start until `tb4-science-tasks.json` lists those IDs.

### BiomniBench-DA public 50

Accept the dataset licence, then:

```bash
hf download phylobio/BiomniBench-DA --repo-type dataset \
  --revision e1c8ca5e11a620087bc48d97888eb69176a1f235 \
  --local-dir evals/science-harness/datasets/biomni-bench-50
```

Pass `--dataset-path` to that directory. Export `GEMINI_API_KEY` on the host;
`run.py` forwards it to the verifier only.

### DrugDiscoveryBench

`prepare.py` clones `scaleapi/DrugDiscoveryBench`. The 82 task directories ship
with empty rubrics; after the gated
[`ScaleAI/DrugDiscoveryBench`](https://huggingface.co/datasets/ScaleAI/DrugDiscoveryBench)
access is approved, fill them in and pull the 23 GB trial image:

```bash
cd evals/science-harness/datasets/drugdiscoverybench
python scripts/populate_rubrics.py
docker pull ghcr.io/scaleapi/drugdiscoverybench:1.0.0-lightweight
```

Then `--bench drugdiscoverybench --dataset-path .../drugdiscoverybench/benchmark/tasks`
with `JUDGE_BASE_URL`, `JUDGE_API_KEY`, `JUDGE_MODEL` exported (verifier only;
their runs used an OpenAI-compatible judge). Upstream pins Harbor 0.13.1; the
identity records that we ran the same `task.toml` files under 0.22.0. The image
bakes an egress proxy that blocks Scale domains and disables native web tools
for every harness, so `webfetch`/`research_search` are equally constrained.

### ResearchClawBench

`prepare.py` writes `evaluation/agents.openscience.json`; copy it over
`evaluation/agents.json`. The entry is:

```json
{
  "openscience": {
    "label": "OpenScience (Synthetic Sciences)",
    "icon": "S",
    "cmd": "python3 /abs/path/evals/science-harness/adapters/researchclaw.py -p <PROMPT> -w <WORKSPACE>"
  }
}
```

Their runner substitutes `<PROMPT>` with the prompt **text** (`"$(cat
INSTRUCTIONS.md)"`), not a path, so `-p` takes text; `--prompt-file` exists for
manual runs. The adapter prints one `{"model": ...}` line first because their
`_detect_model` scans the first 50 stdout lines for it. Keep the label: their
board already lists an unrelated "Open Science" (`ai4s-research/open-science`).
Set `OPENSCIENCE_BENCH_MODEL` and put `openscience` on `PATH`. Their judge
stays in `evaluation/.env`.

### BixBench3

Use their VM, image, proxy, and grader. In the agent container, install the
Linux binary and swap Inspect `solver=bixbench3_agent()` for
`openscience_bixbench3_agent` from `adapters/bixbench3.py`. That is a
whole-system comparison, not a matched-scaffold copy of their five-tool ReAct
loop.

Two things differ from the reference solver and must be handled before a
scored run. The reference agent's model calls leave from the Inspect host; ours
leave from inside the sandbox, which sits on an `internal` Docker network behind
their Squid allowlist. The model provider host (for example `api.openai.com`)
has to be added to the case `network_policy.base_allow_domains`, and the sandbox
`HTTPS_PROXY` must be honoured by the binary. Their 5,000-message cap applies to
the Inspect loop, not to our process; only the 24 h wall clock carries over.

## What this is not

Passing adapter unit tests or a Harbor dry-run is not a scientific score.
Protected graders and hidden papers are not inputs to the agent.
