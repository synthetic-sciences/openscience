---
name: run-benchmark-pilot
description: Preflight and execute a source-pinned OpenScience benchmark recipe as a sealed evaluator-owned pilot. Use when testing an official benchmark integration, replaying a public baseline, validating a native argv or Python API recipe, extracting benchmark metrics, or producing content-addressed stage, artifact, and score evidence before a held-out or release run.
---

# Run Benchmark Pilot

Execute only from the evaluator-owned environment. Keep the pilot manifest, runtime inputs, result directory, and receipt outside the candidate workspace.

## Materialize the exact recipe

1. Read `/harness/benchmarks` and require `recipe.status: source_verified`.
2. Materialize bindings with `POST /harness/benchmarks/:benchmark/recipe`.
3. Save the exact JSON response outside the official checkout.
4. Check out `source.repository` at its exact `source.revision`, install the declared environment without editing the checkout, and keep the tree clean.

Recipe v2 makes execution semantics machine-readable:

- Python methods name their prior-stage receiver and bind evaluator values to named parameters.
- Integer bindings become numeric Python kwargs.
- Returned artifacts name the exact produced value.
- File artifacts declare allowed match cardinality.
- JSON, JSONL-record, CSV, pickle-tuple, and text-ratio metrics use typed selectors.

## Build the pilot manifest

Create JSON outside the checkout:

```json
{
  "schemaVersion": 1,
  "workspace": "/evaluator/checkouts/official-benchmark",
  "resultsRoot": "/evaluator/pilots/run-17",
  "source": {
    "repository": "https://github.com/owner/official-benchmark",
    "revision": "40-character-lowercase-commit"
  },
  "recipe": "/evaluator/pilots/materialized-recipe.json",
  "timeoutSeconds": 3600,
  "runtime": {}
}
```

The `runtime` object must exactly match `recipe.runtime`:

- `json`: `{"kind":"json","artifact":"/evaluator/input.json","sha256":"64-hex"}`
- `python_object`: `{"kind":"python_object","source":"/evaluator/adapter.py","sha256":"64-hex","symbol":"build","kwargs":{}}`
- `callable`: `{"kind":"callable","source":"/evaluator/adapter.py","sha256":"64-hex","symbol":"predict"}`

Do not put credential values in the manifest. Export only the environment variables named by recipe stages.

## Preflight, then run

Run the deterministic script bundled with this skill:

```bash
python scripts/run_pilot.py preflight pilot.json --output preflight.json
python scripts/run_pilot.py run pilot.json --output receipt.json
```

Preflight fails unless:

- Git origin, clean state, and revision equal the official pin;
- recipe, binding, and launch-driver commitments are valid;
- every anchor, environment file, entrypoint, runtime artifact, and required environment variable exists;
- result storage is outside the checkout and initially empty; and
- no declared artifact already exists, preventing stale-output selection.

Execution never invokes a shell. It runs argv stages directly, preserves Python values across named API stages, requires every stage input/output, enforces artifact cardinality, hashes logs and artifacts, applies typed selectors, aggregates metrics, and writes a content-addressed receipt without secret values.

For a `python_object` runtime input, the content-addressed adapter source may import the clean benchmark checkout. This supports official extension protocols such as LABBench2 external runners without copying candidate code into, or dirtying, the pinned checkout.

## Promote evidence

Treat the pilot receipt as integration evidence, not an official held-out score. For a held-out or release run:

1. Use the pilot outputs to construct deterministic replay, artifact round-trip, and baseline artifacts.
2. Run `verify-benchmark-launch` against the same checkout, recipe, command, data, and evaluator bytes.
3. Bind its `benchmark-launch-v1` protocol before candidate execution.
4. Require passing launch, runtime-integrity, evaluator-qualification, and domain receipts for final promotion.

Stop on source drift, missing secrets, dirty checkout, ambiguous artifact matches, unsupported selector syntax, non-finite metrics, or any native-stage failure. Never patch benchmark semantics inside the pilot runner.
