---
name: audit-benchmark-sources
description: Verify exact official benchmark repository pins, required files, dataset availability, public-subset scope, catalog freshness, and upstream drift without changing trusted revisions. Use when maintaining the OpenScience benchmark catalog, reviewing a benchmark update, preparing official runs, investigating source drift, or checking that a named integration still resolves to its published implementation.
---

# Audit Benchmark Sources

Audit the catalog outside the candidate-producing agent session. Treat a reachable pinned commit as reproducibility evidence and a changed upstream head as a review trigger, not permission to update the pin.

## Export the catalog

Stream the response from `GET /harness/benchmarks` into the auditor. When a local OpenScience server is running, for example:

```bash
curl --fail --silent http://127.0.0.1:4096/harness/benchmarks |
  python scripts/audit_sources.py - --output benchmark-source-audit.json
```

Use the actual server address for the environment. Do not reconstruct the catalog by scraping TypeScript. A saved response can be passed as the positional argument instead of `-`.

## Run the audit

```bash
python scripts/audit_sources.py benchmark-catalog.json \
  --output benchmark-source-audit.json \
  --workers 4 \
  --timeout 30 \
  --max-age-days 30
```

The auditor uses real `git` protocol operations. For every `official_open` or `official_subset` entry it:

1. fetches the exact pinned commit into an isolated temporary object store;
2. checks every catalog-declared `requiredPaths` entry at that commit;
3. resolves the remote default branch and reports whether its head changed;
4. probes a separately published dataset source without downloading the dataset; and
5. checks catalog age and public-subset cardinality.

Exit code `0` means every trusted pin and declared source remains verifiable. Exit code `1` means at least one pin, required path, remote head, or dataset source could not be verified. Exit code `2` means the catalog or arguments are invalid. Upstream drift and an old `checkedAt` value are review items, not failures, because silently following a moving branch would destroy reproducibility.

## Review drift

For each `upstream_changed` item:

1. inspect the official changes between `revision` and `headRevision`;
2. confirm the benchmark's task set, evaluator, environment, licenses, and reporting protocol;
3. rerun `verify-benchmark-launch` at the proposed revision;
4. update the catalog pin only in a reviewed code change with regenerated SDK types and tests; and
5. attach the audit and launch reports to the corresponding Atlas run.

Never edit pins from this script and never classify a fork as the official source. Keep `official_subset` entries out of held-out and release claims even when their public files remain reachable.

## Local fixture mode

Use `--allow-local` only for controlled tests against local Git repositories. Production audits accept HTTPS remotes and dataset sources only.
