---
name: vast-ai-gpu-cloud
description: Safely inspect and operate Vast.ai marketplace instances with the vastai CLI, live offer data, and explicit approval before paid or destructive actions.
category: cloud-compute
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Infrastructure, GPU Cloud, Vast.ai, Marketplace, SSH]
dependencies: [vastai]
---

# Vast.ai GPU Cloud

Use this skill for Vast.ai marketplace discovery and instance operations. Offers, reliability attributes, locations, bandwidth, storage, and prices are live marketplace data; query them immediately before recommending anything.

## OpenScience credential boundary

- A key saved in **Customize > Compute > Vast.ai** is encrypted control-plane data and is not exported to agent shells, notebooks, kernels, plugins, or MCP servers.
- Use `provider_compute` with `account`, `list_resources`, or `resource_status` for live account and instance reads. OpenScience selects only `vastai show user --raw`, `show instances --raw`, or one exact `show instance <id> --raw` invocation.
- **Test connection** uses the same boundary for exactly `vastai show user --raw`.
- The saved key is admitted only when **Test connection** approves a root/admin-managed, non-writable `vastai` executable. A normal user-owned pip, pipx, or Homebrew install remains credential-only and cannot be used by `provider_compute` until a managed/native adapter exists.
- `last_used` changes only after that command succeeds.
- Never print or persist the key. The saved credential cannot search/accept offers or start, stop, destroy, copy, or change instances; a generic shell needs independent user-managed authentication.

## Current CLI contract

```bash
vastai --help
vastai show user --raw
vastai show instances --raw
```

Use `vastai --help` and the exact subcommand's `--help` before constructing marketplace filters or mutations. Do not rely on remembered filter fields or create flags.

## Marketplace policy

1. Confirm GPU memory/count, disk, bandwidth, reliability, verification requirements, location, runtime, interruption tolerance, and maximum budget.
2. Query live offers. Preserve the provider's exact offer ID and quoted terms.
3. Recommend one offer and explain the material reliability and interruption tradeoffs. Do not optimize on hourly price alone.
4. Get explicit approval before accepting an offer, creating or destroying an instance, changing storage, or interrupting a workload.
5. After creation, reconcile by instance ID before retrying any ambiguous request.
6. Verify SSH and workload health; do not treat an instance state alone as proof the job succeeded.
7. Copy and verify required outputs before destruction. Ask separately before deleting durable volumes or templates.

Never hardcode prices or claim availability. Never automatically switch to a different offer after approval; changed offer terms require a new recommendation and approval.

## SSH handoff

Add the instance in **Customize > Compute > SSH** with the provider-reported username/address and a pinned host key. Use a literal key path with restrictive permissions. OpenScience ignores executable SSH configuration such as `ProxyCommand` and `Match exec`.

## Sources of truth

- CLI authentication: <https://docs.vast.ai/cli/authentication>
- Documentation: <https://docs.vast.ai/>
- Installed contract: `vastai --help` and the relevant subcommand `--help`
- Offers and pricing: live Vast.ai query at the time of approval
