---
name: givemeanode-agent-compute
description: Operate GiveMeANode GPU nodes, batch jobs, storage, and rollout sandboxes through its connected MCP server with bounded spend, durable recovery, and explicit approval for paid or destructive actions.
category: cloud-compute
version: 1.0.1
author: Synthetic Sciences
license: MIT
tags: [Infrastructure, GPU Cloud, MCP, H100, Batch Jobs, Rollout Sandboxes]
---

# GiveMeANode through MCP

Use the configured `givemeanode` MCP connector. Do not install or invoke `gman`, call the HTTP API directly, or ask for a service token when the MCP tools are available. The connector owns OAuth; OpenScience's MCP permission boundary owns each tool invocation.

GiveMeANode is not currently a native `compute_job` target. Use its discovered MCP tools directly, and do not claim that a remote node or batch job is tracked, recoverable, or releasable through OpenScience's JobBroker.

## Start with live state

- Read the available MCP tools and the `gman://docs/llms.txt` resource before relying on remembered arguments. The service contract is versioned and `/preview` may evolve.
- Read `list_limits`, `get_billing`, relevant nodes/jobs, and the current published rate before proposing paid work. Never hard-code prices, availability, queue time, images, or limits. If role-scoped billing inspection is refused, surface that gap instead of assuming funds or headroom.
- In a shared workspace, pass a stable mission and inspect `yours`, `created_by`, and `same_mission` before stopping or deleting anything.

The exact locked rate and job cost ceiling arrive in the create/submit response, not from a separate quote operation. Before that mutation, show the current published estimate, the requested maximum duration, and the applicable workspace or organization cap. If the user has not authorized work with a price that is only locked on submission, do not submit it. Preserve the returned rate and cost ceiling in the handoff.

## Choose the right primitive

- Use an interactive node when work needs a persistent encrypted disk or repeated commands. Stopping parks the disk and stops billing; processes do not survive a stop.
- Use a batch job for unattended, queueable work with declared outputs, checkpoints, or sweeps. Prefer this over holding an idle node.
- Use a detached command for node work that may outlive one tool call. Retain its command ID and page logs by offset.
- Use rollout sandboxes for short-lived fork/snapshot workloads, not as a substitute for persistent training storage.

## Safe lifecycle

1. Inspect live limits, billing, existing resources, and the current tool schema.
2. Present one recommended shape with the current published rate, session minimum when applicable, an explicit maximum duration, and a stop condition. Mark the pre-submit cost as an estimate.
3. Let the MCP permission prompt authorize the exact paid mutation. Never interpret prose approval as permission to bypass it.
4. Open or attach a stable mission before the first create or submit, and pass it on related work so spend and evidence share one receipt.
5. Use a stable, request-specific node name or idempotency key. A batch job must also have a bounded `max_duration_minutes`, an explicit image or context, and a declared output path or destination. If a create/submit response is lost, read the existing node/job before retrying; never create a duplicate to resolve uncertainty.
6. For queued work, keep the same resource and poll at the provider-recommended cadence. Read `expires_at`, queue position, `blocked_on`, capacity notes, and `Retry-After`; do not tight-loop.
7. Refer to an existing provider-stored secret by name, such as `{secret: "wandb-prod"}`, instead of sending a literal secret through MCP arguments. Never place secret values in commands, filenames, logs, or chat.
8. Verify the requested scientific output, not merely a running resource or zero exit code.
9. Stop an interactive node as soon as the work is safely preserved. Cancel a batch job that is no longer useful. Report the final remote state, returned rate or cost ceiling, and available spend evidence.

Deletion is separate from stopping: `delete_node` destroys the persistent disk and must remain an explicit destructive action after outputs are verified. Do not delete storage, snapshots, connections, or teammate resources as routine cleanup.

## Recovery rules

- An MCP disconnect makes the tools unavailable but does not prove nodes, jobs, queue holds, or detached commands stopped. Reconnect, then read state.
- A lost synchronous `run_command` response is uncertain; inspect effects before replaying. Prefer detached commands when duplicate execution would be unsafe.
- Use `get_command` without waking a stopped node. A stopped node keeps files but loses processes.
- On 429, wait the exact `Retry-After`. Retry 500/temporary failures only when the operation is idempotent or current state proves no mutation landed.
- Preserve provider request IDs and actionable refusal messages in the handoff.

## Remote and CI sessions

Browser OAuth redirects to the machine running OpenScience. Over SSH or in CI, use a separately minted, workspace-scoped GiveMeANode service token only when the user has configured it as a connector header. Never mint, display, or copy that token on the agent's behalf.

## Sources of truth

- Connected resource: `gman://docs/llms.txt`
- Official documentation: <https://givemeanode.com/docs>
- Public service status: <https://status.givemeanode.com/>
