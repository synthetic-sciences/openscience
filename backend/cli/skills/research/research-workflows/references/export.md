# Workflow: export

<invocation>
$ARGUMENTS
</invocation>

## Admission contract

Resolve the exact source artifact or session result, audience, format, destination, and whether the package is archival, publication-ready, machine-readable, or a lightweight handoff. Infer conventional defaults only when they do not change disclosure, portability, or destructive behavior.

## Package design

Create the smallest self-contained package that preserves:

- title, scope, generated files, and immutable artifact versions;
- code revision, dirty-state caveat, data identities, licenses, and access boundaries;
- environment and dependency specification, hardware-sensitive settings, seeds, and configuration;
- exact reproduction commands and expected outputs;
- verification ledger, failed or inconclusive checks, limitations, and provenance links;
- checksums for material files when practical.

Reuse existing export or publication paths. Preserve source files and never overwrite an existing destination without explicit authorization.

## Procedure

1. Inventory candidate files and exclude credentials, tokens, environment secrets, private absolute paths, caches, temporary checkpoints, unrelated large files, and hidden kernel state.
2. Resolve every manifest entry to a file that exists. Materialize notebook-only logic into a rerunnable script or mark the portability gap.
3. Generate the target format and a concise README or manifest. Keep claims aligned with the source and verification state.
4. Save important outputs as durable Results before packaging when they are not already versioned.
5. Validate each output independently: parse structured files, open documents, inspect archive membership, execute a dry-run or minimal reproduction command when safe, and compare checksums or key counts.
6. Inspect the final package for secret-like content and machine-specific paths. Do not label it reproducible when required inputs are absent.

## Terminal condition

Return exactly one state:

- `EXPORTED`: every required file exists, validates, and the package meets the declared contract.
- `PARTIAL EXPORT`: a usable package exists with named missing or unvalidated components.
- `NOT EXPORTED`: no trustworthy package was produced.

Report the destination, inventory, validation performed, provenance anchors, and portability gaps. Do not silently omit failures or inconclusive checks.
