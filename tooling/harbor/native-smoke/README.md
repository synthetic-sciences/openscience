# Native Harbor conformance fixture

This is a tiny **zero-model-cost compatibility test**, not a scientific benchmark
or a measure of agent intelligence. It runs the actual candidate Linux OpenScience
binary through Harbor 0.22.0's installed-agent lifecycle, Docker task environment,
native instruction and working directory, log collection, and native verifier.
The loopback provider supplies a deterministic tool call with a `stop` finish
reason, then a final answer after receiving its result. The real OpenScience loop
must execute that tool once and continue despite the first finish label.
Reported provider token counts are
synthetic protocol fixtures. No inference service or real API key is used.

From the repository root, with the editable adapter installed in a Python 3.12+
environment containing Harbor 0.22.0:

```bash
python tooling/harbor/native-smoke/run.py \
  --binary /absolute/path/to/linux-x64-baseline/bin/openscience \
  --sha256 <expected-candidate-sha256> \
  --output /absolute/path/to/new-evidence-directory \
  --execute
```

Omit `--execute` to validate the pinned binary, native task/job schema, and actual
Harbor agent factory without starting Docker. The output directory must not exist;
the script never overwrites a previous attempt. The Python interpreter must be
from the environment that contains the `harbor` executable. It verifies the exact
Harbor version and never falls back to a host installation.

Execution requires a local Unix Docker engine and the Docker Compose plugin. The
task builds from a pinned official Python image for `linux/amd64` and installs
real `curl`, `git`, `bash`, and `coreutils` system dependencies. Building can download
the base image and Debian packages; the task container cannot reach external networks.
Apple Silicon requires Docker's x86 emulation. Native Linux x86 CI uses the same
fixture and binary target.

The native task's Compose file sets `network_mode: none`. This isolates container
networking at Docker, with loopback available for its provider. The task does not
exercise Harbor's separate phase egress sidecar or dynamic network policy. Its
Dockerfile sets `/workspace/harbor-native-fixture` as `WORKDIR`; the adapter's
optional `cwd` is deliberately omitted. The adapter's public `--workspace project`
option makes tool defaults use that directory instead of a private scratch directory.
An older binary without that option fails setup. No host project or credential directory
is mounted. The launcher creates an isolated home and forwards only Docker's
local endpoint, executable search path, optional temporary directory, and Docker
plugin discovery paths. The provider receives a named dummy key from the fixture
config; host model/provider credentials are not forwarded.

There is one native task, one attempt, one concurrent trial, and zero Harbor
retries. Harbor removes the trial container during normal cleanup and retains its
logs. It can remove the task image; Docker build cache may remain. The launcher
does not prune Docker resources. Preserve failures and inspect their logs before
deciding whether a corrected fixture needs another execution.

Harbor uploads `tests/test.sh` for the native verifier phase. The grader checks the
final JSON independently against `42`, verifies the tool and grader's actual task
working directory, and writes the native `reward.txt`. This toy uses Harbor's
shared verifier environment: it does **not** establish adversarial grader
isolation, protected research evaluation, or benchmark performance. Those remain
properties of each real native task and runner policy.

The launcher fails unless all of these hold:

- The installed binary matches the declared SHA-256.
- Exactly one native trial finishes without an exception and receives reward 1.
- The actual CLI JSON stream passes the adapter's completed-run contract.
- The collected ATIF passes Harbor's schema validator and contains one real bash
  call, while the provider sees its tool result before final completion.
- Exactly two provider requests occur: the tool turn and the final answer. UI
  title generation introduces no auxiliary requests in this headless fixture.
  A `stop` label accompanying the local tool call must not end the run early.
- Native grader evidence and Harbor's downloaded artifact record the expected
  output and working directory; the container reports x86_64, only loopback with
  the interface-up flag, and no usable IPv4/IPv6 default route. Inactive kernel
  tunnel interfaces are allowed; interface names alone do not prove isolation.

`manifest.json` records the image digest/platform, binary digest and trial policy.
`job.json`, the copied task, `harbor.log`, and `jobs/native-fixture/` retain the
inputs and native outputs. `conformance.json` is written only after every check
passes. The trajectory, raw JSONL, executable identity and provider request trace
are under the native trial's `agent/`; grader evidence and reward are under
`verifier/`. These artifacts prove this candidate's tested Docker contract, not
all releases, operating systems, environments, or future Harbor versions.
