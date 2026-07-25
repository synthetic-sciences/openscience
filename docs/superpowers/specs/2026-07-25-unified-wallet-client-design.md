# Unified Wallet OpenScience Client Design

**Status:** Approved in conversation; pending review of this committed specification.

## Context

OpenScience currently knows about Atlas, CLI, and unified balances. Recent code
prefers the CLI-only field because Atlas previously allowed managed services to
spend from a different pool. A superseded PR inverted that preference and
renamed the displayed balance to Atlas wallet.

The Atlas companion change replaces both interpretations with one canonical
wallet. OpenScience should become simpler without requiring older published
packages to update.

## Product Decisions

1. OpenScience displays one balance named **Credits**.
2. Managed OpenScience usage spends the same wallet as Atlas web and the future
   web agent.
3. OpenScience contains no Atlas-wallet or unified-pool product concept.
4. Existing Synsci and OpenScience npm releases remain compatible through the
   Atlas API.
5. Managed proxy calls are charged by Atlas settlement exactly once.

## Client Contract

The current client continues to use the stable Atlas routes:

- `GET /api/cli/balance` for admission and the fast balance check;
- `GET /api/credits` for account and transaction details;
- `GET|POST /api/cli/billing-mode` for BYOK/managed selection;
- `POST /api/cli/usage` for compatible usage reporting.

The Atlas backend returns the canonical wallet from the established CLI fields,
so older packages work unchanged.

The current package removes two-wallet assumptions:

- the balance helper is renamed around generic wallet credits;
- `balance_cents` is treated as canonical;
- `cli_balance_cents` and `unified_balance_cents` remain response fallbacks for
  old or mixed-version Atlas deployments;
- UI and command output say **Credits**, not Atlas wallet or CLI wallet;
- cycle-credit and Atlas-pool explanations are removed.

## Charging Boundary

For managed LLM calls, Atlas's proxy hold and settlement are the authoritative
charge. OpenScience sends usage metadata for compatibility and analytics but
does not independently debit the same model call.

BYOK and first-party OAuth calls remain outside the Synthetic Sciences wallet.
Their provider charges continue to go directly to the user.

The client invalidates or refreshes its cached balance after managed usage so
the visible amount follows the server-settled wallet.

## Backward Compatibility

No existing public route, authentication flow, API-key format, or required
response field is removed.

Published packages that call `/api/cli/balance`, `/api/cli/usage`, and
`/api/cli/billing-mode` continue working against the new Atlas backend. They do
not need a package update, local migration, new login, or new Supabase
configuration.

The current package also tolerates an older Atlas backend during rollout by
retaining response-field fallbacks. This makes repository deployment order
non-breaking.

## Interface

The Settings wallet panel and `openscience billing` show:

- one **Credits** amount;
- the current BYOK or managed mode;
- existing top-up and billing actions.

They do not show separate Atlas, CLI, cycle, or unified amounts. No client-side
fee or conversion math is performed.

## Testing

Implementation is test-first and covers:

1. Canonical `balance_cents` preference.
2. Fallbacks for older CLI and unified response fields.
3. A true zero balance remaining zero rather than falling through.
4. Cache invalidation after managed usage.
5. Stable request shapes for old Atlas CLI routes.
6. Credits naming in command and settings output.
7. BYOK and OAuth usage remaining unbilled by Synthetic Sciences.

Focused OpenScience tests run first, then `bun test` from `backend/cli` and the
relevant typecheck/build checks.

## Delivery

This work is delivered on `fix/unified-wallet` and through an unmerged pull
request coordinated with the Atlas pull request. All commits use Aayam Bansal's
configured Git identity and contain no co-author trailers.
