# Synthetic Sciences managed credits

This document supersedes the retired Ace and Ace+ subscription design. Those
plans, bundled research quotas, hosted-research entitlements, and managed
compute resale are not current products.

## Current contract

- Managed usage is pay as you go. Buying **20 credits adds $20 of wallet
  value**; there is no subscription or scheduled monthly top-up.
- One credit is $1 of wallet value shared by managed LLM calls and enhanced
  research search. Usage is debited at underlying provider cost plus a 2%
  service margin.
- Managed LLM calls route through OpenRouter. OpenScience does not resell
  compute.
- The payment-processing fee is shown separately before checkout.
- Auto-reload adds 20 credits when the balance falls below 5. Users can change
  the reload amount or disable auto-reload in Billing.
- Basic search, local models, user-owned provider keys, eligible ChatGPT/Codex
  access, and user-owned local/SSH/scheduler compute remain available without
  managed credits.

## Legacy-account migration

- Stop creating or renewing the retired subscriptions.
- Carry each legacy customer's remaining purchased balance into the wallet
  one-for-one. Carry still-valid promotional value without converting it into
  purchased cash or extending its original expiry.
- Treat legacy plan and entitlement identifiers only as migration inputs and
  audit history; they must not unlock current product capabilities.
- Preserve the append-only ledger and idempotency keys so a migration cannot
  double-credit a wallet.
- Keep existing cards available for the user's chosen auto-reload settings,
  but do not enroll a previously disabled card in auto-reload without consent.

## Release gates

- Checkout, Billing, CLI help, README, docs, and generated bundles describe
  only the pay-as-you-go contract above.
- A package smoke test proves the native OpenScience binary installs without
  the discontinued Atlas package or launcher.
- No public API or settings surface offers managed compute.
- A migration test covers purchased balance, unexpired promotional value,
  expired promotional value, duplicate webhook delivery, and rollback.
