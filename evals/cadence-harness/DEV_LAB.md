# Thin Research dev lab

This lab runs source directly and keeps its projects, config, credentials, cache, state, and trajectories outside the release install. It never copies credentials from the normal OpenScience profile and `bun --no-env-file` prevents repository `.env` files from becoming a hidden credential source.

## Start once

From this worktree, save the lab's model credential through the interactive provider flow. Pasting it interactively keeps it out of shell history and writes it only to the lab data root:

```bash
bun evals/cadence-harness/dev-lab.ts auth
```

Then run the backend and workspace in separate terminals:

```bash
bun evals/cadence-harness/dev-lab.ts server
bun evals/cadence-harness/dev-lab.ts workspace
```

The backend defaults to `127.0.0.1:4196`; the workspace defaults to `127.0.0.1:4444`. `OPENSCIENCE_DEV_PORT`, `OPENSCIENCE_DEV_ROOT`, and `OPENSCIENCE_DEV_MODEL` may override those defaults without storing a secret value in this repository.

## One trajectory at a time

```bash
bun evals/cadence-harness/dev-lab.ts run P11
bun evals/cadence-harness/dev-lab.ts run P15
bun evals/cadence-harness/dev-lab.ts run P21
bun evals/cadence-harness/dev-lab.ts run P23
bun evals/cadence-harness/dev-lab.ts run P24
```

Every invocation creates one isolated campaign below `~/.openscience-dev/researchagent-test/campaigns`. It refuses to run if the listening backend's source SHA or worktree fingerprint differs from the current checkout. The health identity also records the exact backend process run ID, so a stale server on the same port is visible in every trajectory.

New harness projects are archived immediately, so evaluation work does not populate Home's active project list even if a run is interrupted. Their files and sessions remain available in Archived and campaign evidence. Existing projects are never identified, archived, or deleted by name.

The runner has a transport timeout and a scoped permission policy. It does not impose arbitrary model-call, tool-call, child-agent, or cost budgets. Optional diagnostic ceilings are available as `--max-events`, `--max-tool-calls`, and `--max-child-agents`; they are off unless explicitly supplied. Resource constraints written in a prompt remain authoritative. Direct MCP, raw Modal, external-directory, and environment-mutation permissions remain denied; Modal work must go through the trusted `compute_job` capability.

Use `bun evals/cadence-harness/dev-lab.ts paths` to inspect the active non-secret paths and URLs.
