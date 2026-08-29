---
name: runpod-gpu-cloud
description: Safely inspect and operate RunPod resources with runpodctl, live product data, and explicit approval before paid or destructive actions.
category: cloud-compute
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Infrastructure, GPU Cloud, RunPod, Pods, SSH]
dependencies: [runpodctl]
---

# RunPod GPU Cloud

Use this skill for RunPod identity, Pod, and related compute workflows. RunPod product surfaces and CLI commands evolve; distinguish Pods from Serverless and verify the current command reference for the requested product.

## OpenScience credential boundary

- A key saved in **Customize > Compute > RunPod** is encrypted control-plane data and is not exported to Bash, Task, notebooks, kernels, plugins, or MCP servers.
- Use `provider_compute` with `account`, `list_resources`, `resource_status`, or `list_availability` for live account, Pod, Pod-detail, and GPU availability reads. OpenScience owns the exact reviewed `runpodctl` argv.
- **Test connection** uses the same boundary for exactly `runpodctl user`.
- The saved key is admitted only when **Test connection** approves a root/admin-managed, non-writable `runpodctl` executable. A normal user-owned Homebrew or manual install remains credential-only and cannot be used by `provider_compute` until a managed/native adapter exists.
- OpenScience updates `last_used` only after the command succeeds.
- Never print or persist the key. The saved credential cannot create, start, stop, restart, update, delete, transfer, or change resources; dashboard storage does not authenticate a generic agent shell.

## Current CLI contract

```bash
runpodctl --help
runpodctl user
```

Use the installed `runpodctl` help and current official docs to select the current read-only list/status command, then again before constructing any mutation. Do not reuse remembered Pod create, Serverless, registry, or storage flags.

## Operating policy

1. Confirm the product surface, GPU memory/count, cloud type or reliability needs, region, image, disk/volume, ports, runtime estimate, interruption tolerance, and maximum budget.
2. Query current inventory and provider-displayed pricing immediately before a recommendation.
3. Present one recommended configuration and the exact live quoted terms. Label total cost as an estimate.
4. Get explicit approval before creating, starting, stopping, resizing, terminating, or changing storage or endpoints.
5. After mutation, retain the resource ID and reconcile with a read-only list/status command. Never blindly retry an ambiguous launch.
6. Verify the actual workload and requested artifacts; a running Pod or ready endpoint is not proof of scientific success.
7. Stop idle billable resources. Verify outputs before termination and ask separately before deleting persistent storage.

Never hardcode GPU types, prices, regions, availability, or startup times. Never silently substitute a different cloud type or offer after approval.

## SSH handoff

For an SSH-capable Pod, add the provider-reported connection in **Customize > Compute > SSH**. Pin the host key and use a literal identity path with restrictive permissions. OpenScience does not execute `ProxyCommand` or `Match exec` from user SSH config.

## Sources of truth

- runpodctl overview: <https://docs.runpod.io/runpodctl/overview>
- RunPod documentation: <https://docs.runpod.io/>
- Installed command contract: `runpodctl --help` and the relevant subcommand `--help`
- Inventory and pricing: RunPod's live UI or CLI output at the time of approval
