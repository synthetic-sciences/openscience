---
name: modal-serverless-gpu
description: Run approved CPU or GPU work through OpenScience compute_job on the user's configured Modal account. Use for isolated scientific scripts, dependency provisioning, durable outputs, logs, status, cancellation, and recovery. Never invoke the Modal SDK or CLI directly.
category: cloud-compute
version: 5.0.0
author: Synthetic Sciences
license: MIT
tags: [Infrastructure, Serverless, GPU, Cloud, Modal, Sandboxes, Compute]
---

# Modal through `compute_job`

Modal is an OpenScience compute target, not an agent-controlled SDK. Prepare ordinary workspace files and call `compute_job` with target `{ kind: "modal" }`. The JobBroker owns credentials, the reviewed dispatch card, sandbox lifecycle, logs, cancellation, recovery, and output delivery.

## Contract

- Read `<compute-capability>` for the configured/disabled/unconfigured state. Do not probe availability by launching work.
- Never inspect Modal credentials or `~/.modal.toml`; never install or invoke the Modal Python SDK or CLI.
- Commands are ordinary shell commands inside `/workspace`, such as `python analysis.py`.
- The `packages` list builds Python dependencies into the reviewed image before execution. Pin important versions.
- With no `cwd`, omitted `uploads` stages safe ordinary files from session scratch. With a `cwd`, it stages from that directory. Pass explicit globs to narrow inputs; pass `uploads: []` only when the job needs no workspace files.
- Declare every output needed after the run in `artifacts`. Undeclared files are not delivered.
- Use GPU `none` for CPU work. Choose GPU count, CPU, memory, and timeout from the workload; do not invent price or duration guarantees.
- Network `none` is the safe default. Use unrestricted network only when the command genuinely needs remote access and the approval card shows it.
- Refer to stored secrets only by symbolic name. Never place secret values in commands, files, prompts, logs, or plans.
- The `compute_job` card is the authorization boundary. Do not request a second prose approval or treat chat text as dispatch authorization.

## Workflow

1. Prepare a reproducible script and small inputs in session scratch.
2. Call `compute_job` with `action: "plan"` when parameters still need inspection, otherwise `action: "start"`.
3. Include a clear name, purpose, command, target, packages, resources, upload selection, and artifact globs.
4. After approval, use the returned job ID for status, logs, artifacts, cancellation, delivery retry, or release. Do not create a duplicate job merely because a long job is still running.
5. Report only states and outputs returned by `compute_job`. Preserve failures and uncertainty.

Example shape:

```json
{
  "action": "start",
  "name": "Fit robustness models",
  "purpose": "Run the preregistered analysis and preserve tables and figures.",
  "command": "python analysis.py",
  "target": { "kind": "modal" },
  "uploads": ["analysis.py", "data/*.csv"],
  "artifacts": ["outputs/**/*.csv", "outputs/**/*.png"],
  "packages": ["numpy==2.3.2", "statsmodels==0.14.5"],
  "gpu": "none",
  "resources": { "time_minutes": 30 }
}
```

If the provider reports a control-plane interruption, keep the same job ID and inspect status later. A transient inability to reattach is not evidence that the remote computation failed. Cancel or release only when the user requests it or the scientific workflow explicitly requires it.
