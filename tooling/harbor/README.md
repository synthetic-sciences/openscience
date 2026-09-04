# OpenScience for Harbor / Terminal-Bench

A [Harbor](https://www.harborframework.com) installed agent that runs OpenScience
headlessly inside a task container and records an ATIF trajectory.

## Run Terminal-Bench 2

```bash
uv run --with harbor --with-editable tooling/harbor \
  harbor run -d terminal-bench/terminal-bench-2 \
    -a openscience_harbor.agent:OpenScienceAgent \
    -m anthropic/claude-opus-4-8 \
    --ak version=2.0.70 \
    -n 4
```

`-m provider/model` selects the model; Harbor resolves that provider's API key
and base URL from the host environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, ...) and passes them through unchanged. Retries follow
Harbor's normal rules, e.g. `--max-retries 3 --retry-include ApiRateLimitError`.

### Options (`--ak key=value`)

| Option               | Use                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | Release to install with the pinned root `install` script (required unless `binary` is set). Must be a release that ships `openscience run --auto-approve` (>= 2.0.70). |
| `binary`             | Host path to an `openscience` Linux binary to upload instead of downloading (offline task networks, local builds).                                                     |
| `variant`            | Provider-specific reasoning effort (`high`, `max`, `minimal`; model-dependent).                                                                                        |
| `effort`             | Research effort, `normal` or `ultra`.                                                                                                                                  |
| `agent`              | Primary agent, default `research`.                                                                                                                                     |
| `openscience_config` | JSON overlay deep-merged into the headless `openscience.json`, e.g. `'{"experimental":{"continue_loop_on_deny":true}}'`.                                               |

## What the adapter does

- **Install** (`setup` phase): ensures `curl`, `bash`, `coreutils` (for `stdbuf`),
  and `git`, then runs the project's own installer pinned to `version`, which
  picks the glibc/musl and baseline variant, verifies `checksums.txt`, and
  installs to `~/.openscience/bin`:

  ```bash
  curl -fsSL https://openscience.sh/install | bash -s -- --version <version> --no-modify-path
  ```

- **Run**: writes `$OPENSCIENCE_CONFIG_DIR/openscience.json` with
  `sandbox.enabled=false`, `permission {"*": "allow"}` plus denies for the
  tools that need a Synthetic Sciences account or paid remote compute
  (`research_search`, `atlas`, `atlas_write`, `remote_compute`, `modal`,
  `provider_compute`, `compute_job`), the task's MCP servers, and the model
  registration; copies the task's skills directory into
  `$OPENSCIENCE_DATA_DIR/user-skills`; then executes, with `cwd=/app`:

  ```bash
  openscience run --format json --auto-approve --model <provider/model> [--variant ...] [--effort ...] [--agent ...] [--continue] -- '<instruction>' \
    2>&1 </dev/null | stdbuf -oL tee /logs/agent/openscience.txt
  ```

  with `OPENSCIENCE_DATA_DIR=/logs/agent/openscience/data`,
  `OPENSCIENCE_CONFIG_DIR=/logs/agent/openscience/config`,
  `OPENSCIENCE_DISABLE_AUTOUPDATE=1`, `OPENSCIENCE_DISABLE_LSP_DOWNLOAD=1`,
  `OPENSCIENCE_DISABLE_PROJECT_CONFIG=1`, and
  `OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP=1`. Everything OpenScience writes
  stays under `/logs/agent`, which Harbor collects with the trial.

- **Errors**: after the run, any `error` event or a non-zero `done.exitCode`
  raises `NonZeroAgentExitCodeError`, so Harbor's error classification and
  `--max-retries` apply. Exit codes: `1` provider/agent error, `2` usage or
  configuration error (unknown model, no provider), `3` stopped by a rejected
  permission or question.
- **Trajectory**: `populate_context_post_run` converts the JSON lines into
  `trajectory.json` (ATIF v1.7): a `user` step from the `user` event, one agent
  step per `step_start`/`step_finish` pair carrying text, `reasoning_content`,
  tool calls with their observations (failed calls keep their error text), and
  per-step token/cost metrics summed into `final_metrics` and the Harbor
  `AgentContext`.

The event contract the converter reads is frozen in
`backend/cli/src/cli/run-events.ts` and documented under "Headless and
container runs" on the Sessions docs page.

## Known limitations

- A fresh-session instruction under 320 characters that opens with `what`,
  `how`, `why`, `explain`, `compare`, or `define` and names no work gets a
  direct, tool-free answer (the Research agent's conversational route). Task
  instructions normally contain work verbs; if one does not, wrap it with a
  `prompt_template_path`.
- Delegation is off under `--auto-approve`, so the trajectory has no
  `subagent_trajectories`.
- Harbor from PyPI (0.22) and Harbor `main` differ in how agents declare
  options and capabilities; the adapter supports both.

## Tests

```bash
cd tooling/harbor
uv run --with pytest --with harbor python -m pytest
```

`tests/test_trajectory.py` runs the converter against a stream captured from a
real `openscience run --format json --auto-approve` turn
(`tests/fixtures/openscience.jsonl`) and, when Harbor is installed, validates
the result with Harbor's trajectory validator. `tests/test_agent.py` checks the
command, config, and environment the agent assembles.
