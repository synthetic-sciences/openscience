# ADR 0001: Modal compute uses a trusted control plane

Status: accepted

## Context

The earlier Modal experiment combined settings UI, agent instructions, provider credentials, execution, result transfer, and teardown. In that shape, connecting a provider injected its credential into the OpenScience process and generic agent subprocesses. A disabled UI toggle therefore could not be a security boundary: the agent could still discover and use the credential directly.

Modal also has more state than a single job status can express. Execution may time out while partial outputs are still deliverable, delivery may fail after successful execution, and a remote resource may need to remain alive while it holds the only recoverable copy of an output.

## Decision

OpenScience integrates Modal as a governed compute provider behind two provider-neutral boundaries:

- `ComputeSettings` owns provider availability, credential resolution, image identity, policy, and capability checks.
- `ComputeJobs` owns approval, dispatch, durable ownership, execution, output delivery, cancellation, recovery, and teardown.

The provider adapter is trusted control-plane code. Agent-controlled code is an untrusted data plane.

The following rules are mandatory:

1. Saving a credential does not enable a provider.
2. A disabled provider never resolves credentials and never constructs a provider client.
3. Provider credentials are resolved only for an approved dispatch, an explicit lifecycle operation on an owned job (recovery, cancellation, delivery retry, or resource release), or an explicit control-plane browse of the user's Modal Volumes, inside the trusted adapter. Merely opening settings, listing settled jobs, or answering an availability question does not resolve them. They are never added to a generic agent, shell, kernel, or job environment.
4. The agent may call the first-class `modal` tool, but it cannot authorize dispatch. The tool must show a one-run paid-dispatch approval whose digest still matches its command, inputs, image, packages, resources, timeout, network policy, and output contract. Credentials resolve only after this approval.
5. Job inputs are explicit snapshots. The remote job does not inherit arbitrary host files, environment variables, or credentials.
6. Provider resources carry durable OpenScience ownership metadata. Recovery and teardown verify that ownership before acting.
7. Execution, output delivery, and resource state are tracked independently. A resource cannot close while it holds the only recoverable output unless the user explicitly abandons that recovery path.
8. Existing `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `interrupted` statuses remain a compatibility projection while clients migrate to the richer lifecycle.

Modal job files live in a named per-job Volume mounted at `/workspace`, not only in the execution container filesystem. The public JavaScript SDK does not expose direct Volume reads, so a pinned Python control-plane bridge uses `Volume.listdir` and `Volume.read_file` after the execution sandbox exits. The bridge never creates a Function or Sandbox. Successful delivery deletes the Volume; failed delivery, unconfirmed cancellation, or an unknown remote resource retains the job record and recovery identity.

Delivery recovery is an explicit lifecycle operation. It reads the already-computed result from the owned sandbox or Volume, retries local validation and delivery, and releases provider resources only after delivery succeeds. It never reruns the paid command.

## Modal SDK baseline

Use the official JavaScript SDK, pinned as `modal` 0.9.0, for Sandbox creation, explicit client credentials, streaming logs, filesystem transfer, tags, reattachment, and cancellation. Use the official Python SDK, pinned as `modal` 1.1.4, only for control-plane Volume listing and reads that the JavaScript SDK does not expose. The Python bridge is embedded in the compiled binary and launched through `uv` when a compatible system Python is unavailable. Provider-specific SDK objects remain private to the Modal adapter.

Both SDK versions are exact pins. Dependency updates must be reviewed as adapter migrations: run the Modal adapter, Volume bridge, lifecycle recovery, approval, type-check, and single-binary build suites before changing either pin. The bridge uses isolated Python mode, removes ambient Python path and startup variables, and accepts a system installation only when its reported version exactly matches the pin.

## Consequences

Connecting Modal is intentionally inert until it is enabled. Turning it off blocks new credential resolution even if a credential remains encrypted on disk. Existing jobs keep their recorded ownership and recovery state so disabling a provider does not silently destroy recoverable work.

This introduces a small compatibility layer in `ComputeJobs`, but it prevents provider details and ambiguous lifecycle transitions from spreading through routes, UI, and agent prompts.
