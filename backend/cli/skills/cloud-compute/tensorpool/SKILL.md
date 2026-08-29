---
name: tensorpool-gpu-cloud
description: Safely inspect and operate TensorPool GPU clusters and jobs using the current tp CLI, with explicit approval before any billable or destructive action.
category: cloud-compute
version: 2.0.0
author: Synthetic Sciences
license: MIT
tags: [Infrastructure, GPU Cloud, TensorPool, Clusters, Jobs, SSH]
dependencies: [tensorpool]
---

# TensorPool GPU Cloud

Use this skill for TensorPool cluster, job, and storage workflows. Treat provider availability, instance names, quotas, and prices as live data: inspect them at execution time and never rely on values copied into a skill.

## OpenScience credential boundary

- A key saved in **Customize > Compute > TensorPool** is encrypted control-plane data. It is not exported into Bash, Task, notebooks, kernels, plugins, or MCP servers.
- Use **Test connection** in that screen for the reviewed read-only check. OpenScience runs exactly `tp --no-input me` in an isolated process and marks `last_used` only if it succeeds.
- Never print, echo, persist, or ask the user to paste a saved key into chat.
- A generic agent shell can use `tp` only when the user has independently authenticated that shell. Do not claim dashboard storage authenticated the shell.

## Current CLI contract

Install and inspect the installed CLI rather than guessing its version:

```bash
python -m pip install tensorpool
tp --help
tp --no-input me
```

The first-party CLI reads `TENSORPOOL_KEY`. The read-only identity check is `tp --no-input me`.

Safe discovery commands include:

```bash
tp cluster list
tp job list
tp storage list
```

Before using any other command, run its current `--help`. CLI flags can change independently of this bundled skill.

## Operating policy

1. Confirm the intended workload, region or placement constraints, GPU count, runtime estimate, storage needs, and maximum budget.
2. Inspect current inventory and provider-displayed cost immediately before proposing a resource.
3. Show one recommended configuration and its current quoted cost. Label estimates as estimates.
4. Get explicit user approval before cluster creation, job submission, resizing, attaching billable storage, or any other mutation.
5. After launch, record the provider resource identifier, selected type, creation time, and the exact command used.
6. Monitor to a terminal state. Download or verify required outputs before cleanup.
7. Get confirmation before deleting persistent storage. Stop or delete idle compute promptly after the requested work finishes.

Never infer that an empty list means a provider outage; report the exact CLI result. Never retry a billable mutation blindly after a timeout—first list resources and reconcile whether the first request succeeded.

## SSH handoff

When a cluster exposes SSH, add it through **Customize > Compute > SSH**. Prefer a pinned host key, a literal private-key path with restrictive permissions, and a validated ProxyJump when required. OpenScience does not evaluate `ProxyCommand` or `Match exec` from user SSH config.

## Sources of truth

- CLI and product documentation: <https://docs.tensorpool.dev/>
- Installed command contract: `tp --help` and the relevant subcommand `--help`
- Current inventory and pricing: TensorPool's live dashboard or CLI output at the time of approval
