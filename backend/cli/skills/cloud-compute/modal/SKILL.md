---
name: modal-serverless-gpu
description: Run governed Modal sandbox jobs with OpenScience's modal tool. Use for one-off CPU/GPU commands, explicit file uploads and captures, dependency provisioning, resource selection, approval, dispatch, and results. This skill does not install or invoke the Modal Python SDK or CLI.
category: cloud-compute
version: 4.0.0
author: Synthetic Sciences
license: MIT
tags: [Infrastructure, Serverless, GPU, Cloud, Modal, Sandboxes, Compute]
---

# Modal through OpenScience Compute

OpenScience uses Modal as a trusted control-plane provider. The agent prepares ordinary project files and calls the `modal` tool. The tool presents an exact paid-dispatch approval card, resolves credentials only after approval, creates the sandbox through OpenScience's JavaScript adapter, and returns status and logs.

This is different from developing a standalone Modal Python application. For the OpenScience path:

- Do not inspect `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, or `~/.modal.toml`.
- Do not install or import the Modal Python package.
- Do not run or recommend `modal run`, `modal deploy`, `modal serve`, or `modal setup`.
- Do not use `modal.App`, Modal decorators, functions, volumes, or Python SDK sandboxes.
- Do not ask for approval in chat. A chat response such as `yes` is not dispatch authorization; the `modal` tool owns approval.
- Do not send the user to recreate a job manually in Compute when the `modal` tool is available.
- Only claim dispatch, status, or completion reported by the tool or Compute job record.

## Availability

Use the current `<compute-capability>` system section as the authority:

- **Configured and enabled:** prepare files and call the `modal` tool.
- **Configured but disabled:** explain that new jobs are blocked until the user enables Modal in **Settings → Compute**.
- **Not configured:** direct the user to **Settings → Compute**. Never fall back to local credentials or CLI setup.

## Preparing a job

When the user asks to run work on Modal:

1. Create or update ordinary project files when useful. Prefer self-contained scripts that work in the configured image and under its network policy.
2. Call `modal` with the job name, ordinary command, explicit `uploads`, `outputs`, and `packages`, plus image/GPU/resources when needed.
3. The tool displays the exact app, image, packages, GPU, network, timeout, inputs, outputs, and paid-run warning. Wait for that approval; do not ask for a second confirmation in chat.
4. Report the status and log returned by the tool. The same job is visible under **Compute → Jobs**.

Commands execute inside the configured sandbox image. They are ordinary shell commands:

```text
python analysis.py
```

They are not Modal launch commands.

## CPU and GPU selection

Use GPU type `none` for CPU-only work. Do not request a GPU for small data processing, linear regression, or other CPU-sufficient jobs merely because Modal supports GPUs.

Common GPU starting points:

| Workload | Suggested GPU |
| --- | --- |
| CPU-only analysis | `none` |
| Small inference or CUDA smoke test | `T4` |
| Cost-conscious modern inference | `L4` |
| Medium training or inference | `A10G` or `L40S` |
| Large-model training | `A100-80GB` or `H100` |

Treat GPU prices and availability as provider-controlled and time-sensitive. Do not invent a precise cost or duration estimate.

## Inputs, outputs, and dependencies

Only files matching **Files to upload** are copied into the sandbox. Secrets, `.git`, `node_modules`, and `.openscience` are denied. List every required script, configuration file, and small data input explicitly.

Use **Files to capture** for outputs that must return to the project, for example:

```text
outputs/**/*.csv, outputs/**/*.png
```

The default image does not promise third-party Python packages. Put requirements such as `numpy==2.3.2` and `scikit-learn==1.7.1` in the tool's `packages` field. OpenScience installs them into an image layer before the sandbox starts; package installation is part of the signed approval plan and does not depend on runtime network access.

## Example tool call

For a CPU-only regression script already created at `linear_regression.py`:

```json
{
  "name": "Linear regression smoke test",
  "command": "python linear_regression.py",
  "uploads": ["linear_regression.py"],
  "outputs": ["outputs/results.json"],
  "packages": ["numpy==2.3.2", "scikit-learn==1.7.1"],
  "gpu": "none",
  "timeout_minutes": 10
}
```

## Standalone Modal SDK requests

If the user explicitly asks to author an independent Modal Python application, explain that it is a separate workflow outside governed OpenScience Compute. You may discuss architecture conceptually, but do not install the SDK, access credentials, execute Modal CLI commands, or imply that OpenScience's enabled provider authorizes that workflow. The legacy reference files in this skill directory are not execution instructions for OpenScience Compute.
