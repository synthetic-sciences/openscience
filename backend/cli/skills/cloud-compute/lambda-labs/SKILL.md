---
name: lambda-gpu-cloud
description: Safely inspect and operate Lambda Cloud GPU instances through the documented Cloud API and SSH, with explicit approval before billable or destructive actions.
category: cloud-compute
version: 2.0.0
author: Synthetic Sciences
license: MIT
tags: [Infrastructure, GPU Cloud, Lambda, Cloud API, SSH]
dependencies: [curl, ssh]
---

# Lambda Cloud

Use this skill for Lambda Cloud instance discovery and lifecycle planning. Do not invent a Lambda-native CLI: the supported automation contract used here is Lambda's documented HTTPS Cloud API.

## OpenScience credential boundary

- A key saved in **Customize > Compute > Lambda** is encrypted control-plane data. It is not exported into Bash, Task, notebooks, kernels, plugins, or MCP servers.
- Use `provider_compute` with `list_resources`, `resource_status`, or `list_availability` for live instance and capacity reads. `account` is the same reviewed instance-list request used by **Test connection**.
- **Test connection** must approve an administrator-managed, non-writable `curl` executable; the macOS system `/usr/bin/curl` satisfies that boundary. User-owned replacements are rejected.
- The bearer header is supplied to the approved `curl` over stdin, so the key is not placed in argv or a temporary file.
- OpenScience updates `last_used` only after the API returns success.
- Never print, log, persist, or put the key in a URL. The saved credential cannot launch, restart, terminate, or change resources; a generic shell is unauthenticated unless the user configured it separately.

## API contract

Use the current API reference before constructing a request:

- Base URL: `https://cloud.lambda.ai/api/v1`
- Authentication: `Authorization: Bearer <API key>`
- Response and request shapes: use the current endpoint schema from the official API documentation

For local user-managed authentication, avoid secrets in shell history. This read-only pattern keeps the header input out of argv:

```bash
printf 'Authorization: Bearer %s\n' "$LAMBDA_API_KEY" \
  | curl --fail-with-body --silent --show-error \
      --request GET \
      --url https://cloud.lambda.ai/api/v1/instances \
      --header 'accept: application/json' \
      --header @-
```

Do not run that command unless the shell was independently authenticated; a key saved in OpenScience is intentionally unavailable there.

## Operating policy

1. Confirm workload, GPU memory and count, region constraints, SSH key, filesystem needs, runtime estimate, and maximum budget.
2. Query current instance types, regions, capacity, quotas, and provider-displayed prices immediately before a recommendation.
3. Present one recommended configuration, the exact current quoted rate, and an estimated upper-bound cost.
4. Get explicit approval before launching, terminating, attaching or detaching storage, or changing any billable resource.
5. Make one mutation, retain its response identifier, then reconcile with a list request. Never blindly retry a timed-out launch.
6. Verify SSH and the intended workload after launch. Record the instance ID and public address without recording credentials.
7. Verify required outputs before termination. Treat persistent filesystems as separately durable and separately billable; never delete one without explicit approval.

Availability and pricing are live facts. Do not embed or repeat a hardcoded GPU catalog, region count, startup time, or hourly price.

## SSH handoff

Add the resulting host through **Customize > Compute > SSH**. Use the exact SSH username shown by Lambda, a literal private-key path with restrictive permissions, and a pinned host key. OpenScience never executes `ProxyCommand` or `Match exec` from imported SSH config.

## Sources of truth

- Cloud API: <https://docs.lambda.ai/public-cloud/cloud-api/>
- Cloud documentation: <https://docs.lambda.ai/public-cloud/>
- Current capacity and pricing: Lambda's live dashboard or API response at the time of approval
