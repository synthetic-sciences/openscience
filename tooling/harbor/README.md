# OpenScience for Harbor

An installed-agent adapter for **Harbor 0.22.0**. Harbor owns the task image,
instruction, working directory, agent user, phase network policy, resource and
time limits, verifier, and scoring. This package installs and invokes OpenScience
and converts its root-session event log to ATIF. It does not replace the native
benchmark runner or supply an evaluator.

The dependency is pinned to the version tested here. Moving Harbor `main`, older
0.13 task integrations, and future versions need their own conformance checks;
they are not covered by this package's compatibility claim.

## Check the adapter without running a benchmark

From the repository root:

```bash
uv run --project tooling/harbor --extra test python -m pytest tooling/harbor/tests
```

These tests use the real Harbor package, its installed-agent execution helpers,
error classification, and ATIF model/validator. A deterministic local executable
emits a recorded fixture; separate host and environment log directories exercise
the log-transfer boundary. They make no model calls and start no containers,
verifiers, or benchmark jobs. Passing them proves these adapter contracts, not a
benchmark score or every environment provider's behavior.

For a compiled Linux candidate, the [native conformance fixture](native-smoke/README.md)
runs one real Docker/Harbor task using a deterministic loopback provider and native
grader. It checks the actual binary, tool execution, working directory, reward,
and collected ATIF without a model service. This is a separate, explicit container
test; it is not part of the unit tests above or a scientific benchmark.

## Run a native task

This example is a real evaluation invocation and can spend money. Use the native
task and approved model, environment, limits, and retry settings for your study:

```bash
uv run --project tooling/harbor harbor run \
  --path /path/to/native-task \
  -a openscience_harbor.agent:OpenScienceAgent \
  -m provider/model \
  --ak binary=/absolute/path/to/compatible-linux-candidate \
  --ak binary_sha256=<expected-sha256>
```

The executable must support `run --workspace project`. Setup checks the public
CLI help and fails before task execution if that option is absent. The released
2.0.77 binary predates this option; it is not compatible with this adapter's native
workspace contract. After a compatible release ships, `--ak version=<exact-release>`
can replace the local binary arguments. This source change does not publish a release.

For a registered dataset, use Harbor's dataset arguments in place of `--path`.
Keep benchmark-specific task preparation, network restrictions, protected grading
credentials, and score aggregation in the native runner. Existing integrations
that pin another Harbor version should keep that pin until separately migrated.

`-m provider/model` uses Harbor's model connection handling to select the provider
key and configured base URL. The adapter does not collect grader credentials or
copy the host environment wholesale. Explicit `extra_env`, config overlays, task
MCP servers, and skills are trusted runner inputs: the adapter is not a policy
sandbox for arbitrary runner configuration. `--auto-approve` permits local task
tools, so Harbor's environment isolation remains essential.

### Options (`--ak key=value`)

| Option               | Use                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | Exact compatible release (a leading `v` is accepted). Required unless `binary` is set. Must support `run --workspace project` and `--auto-approve`; setup checks the workspace option.                                                                               |
| `binary`             | Existing host path to a Linux OpenScience executable to upload. Captures its SHA-256 before setup; rejects changed files and upload mismatches. Useful for local builds or an offline agent install. System dependencies must already exist for fully offline setup. |
| `binary_sha256`      | Optional expected SHA-256 for `binary`; mismatch fails before setup.                                                                                                                                                                                                 |
| `cwd`                | Optional absolute directory inside the task environment. Omit to preserve the task image's native working directory.                                                                                                                                                 |
| `variant`            | Provider-specific reasoning effort (`high`, `max`, `minimal`; model-dependent).                                                                                                                                                                                      |
| `effort`             | Research effort, `normal` or `ultra`.                                                                                                                                                                                                                                |
| `agent`              | Primary agent; OpenScience defaults to `research`.                                                                                                                                                                                                                   |
| `openscience_config` | JSON overlay deep-merged over the adapter's headless defaults. Can override those defaults; use only an approved configuration.                                                                                                                                      |

## Installation and run contract

For releases, the adapter fetches `install` from the requested OpenScience Git
tag, invokes it with the same version, and forces checksum verification on. The
installer selects the platform variant and verifies its release checksum. The
adapter then checks the installed version and records the executable's SHA-256.
A Git tag/release checksum is release selection and integrity evidence, not an
independent signature or an immutable source attestation.

For local binaries, upload and installation use the same version/digest checks.
If `version` is supplied with `binary`, the executable must report that version;
otherwise its reported version is recorded. `openscience-identity.json` captures
requested version, installed version, SHA-256, and installation source. Setup
ensures `curl`, `bash`, `coreutils`, and `git` through Harbor's dependency helper.

The run writes a separate headless config, copies declared task skills (including
dotfiles), registers task MCP servers and the selected model, and invokes:

```bash
openscience run --format json --auto-approve --workspace project --model <provider/model> [options] -- '<native instruction>'
```

Harbor's execution helper preserves the native agent user and applies `pipefail`
to the log pipeline. The instruction is shell-quoted without adding benchmark
hints. Explicit project workspace mode makes relative file tools and default bash
execution use the task directory. Starting the CLI there alone is insufficient:
ordinary new OpenScience sessions default to an isolated scratch workspace. The
project directory remains task-owned and must not be deleted by session cleanup.
The adapter adds no trajectory-import capability; Harbor's resume support
uses OpenScience's `--continue` in the existing environment and session data.

Defaults disable auto-update, LSP downloads, project config discovery, environment
bootstrap, and OpenScience's nested sandbox. The task container supplies isolation.
The existing `agent.title.disable` configuration is set to `true` to avoid model
calls for session and message UI labels. Research execution, compaction, skills,
and file-diff summaries are unchanged. An approved `openscience_config` overlay
can re-enable titles; interactive OpenScience keeps its existing defaults.
Default permissions deny account-dependent and remote-compute tools
(`research_search`, `atlas`, `atlas_write`, `remote_compute`, `modal`,
`provider_compute`, `compute_job`). These defaults are not a general egress policy.

## Logs, failure, and accounting

The default environment artifact paths are:

| Path                                        | Contents                                            |
| ------------------------------------------- | --------------------------------------------------- |
| `/logs/agent/openscience.txt`               | Raw JSONL event stream with merged stderr.          |
| `/logs/agent/openscience-identity.json`     | Installed executable identity.                      |
| `/logs/agent/openscience/data`              | OpenScience session state and copied task skills.   |
| `/logs/agent/openscience/config`            | Headless configuration.                             |
| `<Harbor trial agent logs>/trajectory.json` | Validated ATIF v1.7 generated after log collection. |

These paths follow Harbor's `environment_logs_dir` if customized. Task outputs
remain in the task workspace; they are not automatically relocated into logs.
The logs and session state can contain prompts, tool output, and research data.

A successful process is followed by an explicit remote log download **before**
`run()` returns. Success requires exactly one final `done` event with status
`completed`, exit code zero, a consistent root session, balanced model steps,
and no session `error`. Missing, stale, or truncated logs cannot imply success.
Nonzero process exits use Harbor's native classification; event-level failures
raise `NonZeroAgentExitCodeError`. The adapter does not retry: Harbor's job retry
policy governs retries. On process failure or timeout, Harbor's normal cleanup
and log synchronization retain available diagnostics.

ATIF keeps user text, agent text, reported reasoning, tool calls, and observations,
including tool errors and work from unfinished steps. It deduplicates repeated
part IDs for conversion, while duplicate events cannot pass the completion check.
Input totals include uncached input, cache reads, and cache creation; reasoning
tokens are recorded separately without adding them again to output tokens.
Explicit reported zero is retained; absent usage stays unknown. Interrupted or
inconsistent runs retain observed root usage under `final_metrics.extra` and do
not claim complete totals. Cost values are OpenScience's **catalog estimates**,
not verified provider charges; zero may indicate unavailable model pricing.

`extra.usage_complete` refers only to recorded root-agent steps, as declared by
`usage_components` and `excluded_usage`. It does not establish whole-trial billing
completeness: unrecorded auxiliary model calls and external tool/compute charges
are outside this trace. Compare quality against independently reconciled total
trial cost and elapsed time, retaining failed attempts and any retries. Do not
use an ATIF catalog estimate alone to claim a cost-performance frontier.

`--auto-approve` disables built-in delegation in the supported CLI. The event
contract contains root-session events only. If a `task` call nevertheless
appears, the converter flags it and withholds whole-run totals; it never invents
child trajectories. Conversion/schema or artifact-write failures are surfaced,
not silently counted as valid trajectories.

The source contract is `backend/cli/src/cli/run-events.ts`. A passing adapter run
still needs the native verifier to determine whether the scientific task succeeded.
