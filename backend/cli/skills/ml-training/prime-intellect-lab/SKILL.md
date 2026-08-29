---
name: prime-intellect
description: Safely inspect Prime Intellect identity and plan compute or training workflows using the installed prime CLI and current official documentation.
category: ml-training
version: 2.0.0
author: Synthetic Sciences
license: MIT
tags: [Prime Intellect, GPU Compute, Training, Environments, CLI]
dependencies: [prime]
---

# Prime Intellect

Use this skill for Prime Intellect identity, compute, environment, and training workflows. Capabilities evolve quickly, so the installed CLI and current official documentation are authoritative. Do not claim that a product is private beta, generally available, or supported for a model unless the live documentation says so.

## OpenScience credential boundary

- A key saved in **Customize > Compute > Prime Intellect** is encrypted control-plane data. It is not exported into Bash, Task, notebooks, kernels, plugins, or MCP servers.
- Use `provider_compute` with `account`, `list_resources`, `resource_status`, or `list_availability` for live identity, pod, status, and availability reads. OpenScience owns the exact reviewed `prime` argv and isolated home/config directory.
- **Test connection** runs exactly `prime whoami` through the same broker.
- The saved key is admitted only when **Test connection** approves a root/admin-managed, non-writable `prime` executable. A normal user-owned pip, pipx, or Homebrew install remains credential-only and cannot be used by `provider_compute` until a managed/native adapter exists.
- OpenScience updates `last_used` only after the command succeeds.
- Never display or persist the key. The saved credential cannot create or terminate pods, disks, deployments, training, or environments; do not claim a generic agent shell is authenticated by dashboard storage.

## Current CLI contract

Inspect the installed client before relying on a subcommand:

```bash
prime --help
prime whoami
```

The first-party CLI identity check reads `PRIME_API_KEY`. Use the relevant command's `--help` immediately before planning an operation. Do not copy old `prime rl`, environment, pod, or training flags from historical examples without verifying them against the installed version and official docs.

## Workflow

1. Identify whether the user wants raw compute, an environment/evaluation workflow, or hosted training. These are different products and approval surfaces.
2. Inspect current account identity and entitlements with read-only commands.
3. Read the current command reference for the exact resource type. Confirm supported models, regions, accelerators, quotas, and pricing live.
4. For training, define the dataset boundary, evaluator or reward, held-out validation, termination condition, artifact destination, and maximum spend before launch.
5. Recommend one concrete configuration and label costs and runtimes as estimates.
6. Get explicit approval before provisioning compute, starting a paid job, publishing an environment, or deleting resources.
7. After a mutation, save the returned resource ID and reconcile state with a read-only list/status command. Never blindly retry after an ambiguous timeout.
8. Monitor through completion or cancellation, verify outputs, and stop idle compute. Ask separately before deleting durable artifacts.

Never present a successful identity check as proof that a model, accelerator, environment, or training feature is available. Never report training success from job state alone; inspect the requested artifacts and evaluation result.

## Sources of truth

- CLI introduction and command reference: <https://docs.primeintellect.ai/cli-reference/introduction>
- Product documentation: <https://docs.primeintellect.ai/>
- Installed command contract: `prime --help` and the relevant subcommand `--help`
- Current inventory and pricing: Prime Intellect's live UI or CLI output at the time of approval
