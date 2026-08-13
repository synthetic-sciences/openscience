# Compute, artifacts, provenance, and review

## Local execution

Use the session workspace for temporary work and granted folders for user data. Preserve raw inputs. Prefer named environments and record package versions. Persistent kernels are useful for exploration, but save a restartable script or notebook for durable results.

After a package install or kernel restart, assume in-memory state is gone. Recreate it from declared inputs. Do not use success in a dirty kernel as proof that the artifact is reproducible.

## Remote execution

Read host or provider instructions before submitting. The job record must include target, script, inputs, environment, resources, timeout, status, outputs, and cost metadata when applicable. Remote jobs run with the user's account outside the local sandbox; use least privilege.

Monitor every terminal state, not just success. Inspect retrieved outputs. For files left remotely, record exact paths and hashes when practical.

## Artifacts

Save durable outputs with descriptive stable filenames. Validate before saving: parse structured data, open notebooks, render reports, inspect figures, and load serialized models when practical. The execution log is the source of truth for what ran.

A minimum record for material work includes input references or hashes, code, parameters, seeds, environment, commands, warnings, failures, validation results, and reviewer findings.

## Review

Request the built-in reviewer for material claims and artifacts. It compares claims with the record but does not rerun the analysis or choose the best scientific method. Address findings. Pair review with executable tests, domain diagnostics, and a specialist when methodological judgment is needed.

Before handoff, check that every reported computation ran, every material citation supports its claim, identifiers and units are consistent, planned steps are complete or marked incomplete, artifacts open, and no credential or unauthorized data escaped into an output.
