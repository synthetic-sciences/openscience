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

## Benches

| Bench | Runner | Pin |
| ----- | ------ | --- |
| `terminal-bench-science` | Harbor 0.22.0 | `terminal-bench-science/terminal-bench-science@v0.1` |
| `terminal-bench-4-science` | Harbor 0.22.0 | `terminal-bench/terminal-bench@4.0.0`, science-domain IDs in `tb4-science-tasks.json` |
| `biomni-bench-50` | Harbor 0.22.0 | Hugging Face `phylobio/BiomniBench-DA` revision in `datasets.json` |
| `bixbench3` | Inspect AI / GCP | `EdisonScientific/BixBench3` v1.0.0; OpenScience replaces the ReAct solver |
| `researchclawbench` | ResearchClawBench | `InternScience/ResearchClawBench`; `adapters/researchclaw.py` is the agent cmd |

Do not average these metrics. Do not mix TB4 science with Terminal-Bench-Science
or with the historical TB3 Science 15.

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

`--skills none` is the ablation. `--limit 1` is a smoke subset. `--dry-run`
prints the runner command and writes `jobs/identity.json` without launching.

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

Pass `--dataset-path` to that directory. Keep the rubric judge key off the
agent environment.

### ResearchClawBench

Add to `evaluation/agents.json`:

```json
{
  "openscience": {
    "label": "OpenScience",
    "icon": "S",
    "cmd": "python3 /abs/path/evals/science-harness/adapters/researchclaw.py -p <PROMPT> -w <WORKSPACE>"
  }
}
```

Set `OPENSCIENCE_BENCH_MODEL` and put `openscience` on `PATH`. Their judge
stays in `evaluation/.env`.

### BixBench3

Use their VM, image, proxy, and grader. In the agent container, install the
Linux binary and swap Inspect `solver=bixbench3_agent()` for
`openscience_bixbench3_agent` from `adapters/bixbench3.py`. That is a
whole-system comparison, not a matched-scaffold copy of their five-tool ReAct
loop.

## What this is not

Passing adapter unit tests or a Harbor dry-run is not a scientific score.
Protected graders and hidden papers are not inputs to the agent.
