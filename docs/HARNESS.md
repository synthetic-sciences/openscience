# Scientific harness manifests

OpenScience records the effective model-facing harness before every assistant inference attempt. The
record is local, deterministic, and safe to compare across research runs. It exists to answer
a practical scientific question: did a result change because the research method improved, or
because the model, prompt, instructions, or available tools changed underneath it?

The design keeps model-visible execution attributable to durable state and replays runtime
invariants from that state instead of inferring them from logs. It uses OpenScience's existing
session, tool, provider, permission, and artifact systems without a second orchestration runtime.

## Effective composition

Each provider request records a versioned manifest containing:

- agent profile and mode;
- assistant message, parent request, and retry attempt identities;
- final routed provider and model;
- hashes of the assembled system prompt and optional instructions;
- the sorted tool names and hashes of their descriptions and input schemas;
- one fingerprint over the complete manifest.

Prompt and instruction content is never copied into the trace. Hashes make drift observable
without turning a research trace into another store of private context.

The manifest is captured after model routing, prompt transforms, and tool selection. This is
the composition the model actually receives, not an earlier configuration intention.
Background title and summary calls are excluded so they cannot appear as scientific harness
changes.

## Replayed invariants

The session trace replays manifests, inference records, and tool calls into three checks:

1. `composition_integrity` verifies every fingerprint, requires unique and sorted tool
   contracts, and rejects missing, duplicate, or out-of-order retry attempt identities.
2. `inference_attribution` requires every recorded inference to resolve to its exact final
   attempt, provider, model, and parent request manifest.
3. `tool_attribution` requires every observed tool call to have been present in that exact
   final attempt's manifest.

The report is invalid when any check fails. A failed check does not silently disappear into an
aggregate score; it includes the affected message or tool identities for inspection.

## Composition transitions

When consecutive manifests differ, the trace records which dimensions changed:

- profile;
- mode;
- provider;
- model;
- system prompt hash;
- instruction hash;
- tool contracts.

A stable report used one effective composition. A non-stable report is not automatically bad,
but it remains visible as a potential confounder instead of treating all turns as equivalent.

## Trajectory fingerprint

The report also derives a deterministic trajectory fingerprint from the ordered composition
fingerprints, provider/model routes, and observable tool names, input hashes, and outcomes.
Message IDs, timestamps, prompt content, hidden reasoning, and tool output content are excluded.

The fingerprint is useful for detecting exact harness-and-tool trajectory matches, regression
fixtures, and repeated failures. It is not a scientific quality score and does not claim that
two different fingerprints imply meaningfully different conclusions.

## Runtime completion invariants

Research runs also fail closed around completion:

- a genuine model output-limit finish receives at most two durable continuation turns before the
  session reports an error instead of silently accepting partial work;
- terminal permission prompts distinguish a denied action that should be worked around from a
  rejection that makes the run unsuccessful;
- sandboxed scientific tools keep caches beneath the writable session workspace; and
- Bash and Zsh pipelines use `pipefail`, so a failed analysis cannot be hidden by `tail`, `tee`, or
  another successful downstream formatter.

## Non-goals

- No external agent harness is installed or invoked.
- No second orchestration, artifact, memory, or candidate-search subsystem is introduced.
- No prompt content or hidden reasoning is retained.
- No composition change is automatically promoted as an improvement.
