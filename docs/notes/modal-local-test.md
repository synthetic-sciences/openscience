# Test Modal locally

## Build and launch

From the repository root:

```bash
bun run build --single
./backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience web . --print-logs
```

On another platform, use the matching directory under `backend/cli/dist/@synsci/`.

## Connect Modal

1. Create a token in Modal with `modal token new` if you do not already have one.
2. Open **Settings → Compute → Modal**.
3. If the panel reports that `~/.modal.toml` is ready, select **configure**. OpenScience records the file as the credential source and enables Modal without copying its token values.
4. If there is no usable active profile (or sole `[default]` profile), enter the token ID and secret separately, save them, and turn **Enable Modal** on.
5. Select **test connection**. A successful check reports the JavaScript SDK version.
6. Keep the default `python:3.12-slim` image, blocked network, and a short timeout for the smoke test.
7. Set **Concurrent jobs** to the maximum number of Modal sandboxes OpenScience may dispatch for this project at once.

OpenScience accepts Modal's active profile, or a sole `[default]` profile when no profile is marked active. The selected table must contain `token_id` and `token_secret`. Settings reports `absent`, `invalid`, or `ready` together with the resolved profile, environment, or parse error; it does not expose token values. The trusted adapter reads credentials only after Modal is enabled and only for Modal control-plane operations.

Saving a token manually is inert. Enabling Modal permits the trusted adapter to decrypt it. Regardless of credential source, the token is never added to agent, shell, kernel, or remote job environments. Turning Modal off blocks credential resolution, new plans, and dispatches; it does not silently terminate a run that was already approved.

## Agent dispatch boundary

The agent can prepare ordinary project files and call the provider-neutral `compute_job` tool with a Modal target, but it cannot approve its own run. A `yes` reply in chat is not dispatch authorization. The tool displays a one-run approval card where the app, image, Python packages, GPU, network policy, timeout, uploads, outputs, and paid-run warning are bound to a digest before **Dispatch** becomes available. The job then appears under **Compute → Jobs**; the user does not need to recreate it there.

If `uploads` is omitted, OpenScience stages safe ordinary files from the selected session workspace or `cwd`, excluding credential, cache, dependency, VCS, and other sensitive locations. Use explicit globs to narrow that snapshot. An explicit `uploads: []` means that the job needs no workspace files; an explicit forbidden or missing upload fails before dispatch.

Commands run inside the configured sandbox image. Use commands such as `python analysis.py`, list `analysis.py` under uploads, and provide third-party requirements in the tool's packages field. Do not use `modal run`, install the Modal Python SDK, or write a Modal-decorated application for this path; OpenScience's JavaScript adapter builds and governs the sandbox.

## Scientific capability boundary

The five packaged Python capabilities—SciPy, Matplotlib, scikit-learn,
Biopython, and RDKit—use `scientific_capability`, not an arbitrary
`compute_job` command. Their manifests bind an immutable Python image, exact
hashed dependency locks, one CPU, 2 GiB RAM, a bounded timeout, no uploads for
the built-in smoke, and no execution network. Those restrictions override a
more permissive project Modal configuration during dispatch and restart
recovery. The same tool owns status, logs, artifacts, validation, cancellation,
delivery retry, and release.

Use **Customize → Scientific tools** to distinguish declared support from the
current machine/provider state. Stored Modal credentials are shown as
configured, not ready, until bounded evidence exists. These capabilities remain
experimental until the installed release artifact passes its local and Modal
canaries; a source-tree smoke is useful preparation but not release evidence.

## Run the smoke job

Open a session in a trusted project, then open **Compute → Jobs → New job** and enter:

- Run location: `Modal`
- GPU type: `T4`
- Command:

  ```bash
  nvidia-smi && mkdir -p outputs && printf 'modal-smoke-ok\n' > outputs/modal-smoke.txt
  ```

- Under **Resources and reproducibility**, set a short time limit such as `10` minutes.
- Files to capture: `outputs/modal-smoke.txt`
- Files to upload: leave empty.

Select **Review command**. Verify the app, image, GPU, network policy, timeout, uploads, and paid-run warning. **Dispatch** is bound to that exact digest; changing any governed field requires another review.

A successful run should show `nvidia-smi` in the streamed log and copy `outputs/modal-smoke.txt` into the project with its checksum in **Captured outputs**.

To verify the project concurrency boundary, set **Concurrent jobs** to `1`, keep one run active, and attempt a second start. The second start should fail with a visible concurrency-limit error. It does not wait in a hidden queue; retry it after the first run settles.

Every governed job mounts a named per-job Modal Volume at `/workspace`. The volume name is recorded with the job without exposing the local project path. After the execution sandbox exits, OpenScience reads the command result and declared outputs directly through Modal's control-plane Volume API. It does not create a harvest sandbox. Normal completion deletes the Volume only after local delivery succeeds.

If local output delivery fails, the finished run remains visible with **Retry delivery**. That action reattaches to a live execution sandbox when necessary or reads the retained Volume directly; it does not rerun the approved command. **Clear finished** keeps the record until delivery succeeds or the retained resource is explicitly cleaned up.

To test cancellation, dispatch a job that writes a declared partial output and then sleeps, wait for it to become running, then select **Cancel job**. Modal should terminate the tagged sandbox, mark the job cancelled, collect any declared partial output already present, and retain the Volume. Use the explicit release action after inspecting or delivering the partial output; cancellation itself never deletes recoverable data.

If Modal does not confirm termination, the run remains visible with an explicit billing warning and a retry action. Finished records whose remote resource is unknown or still holds recoverable output are not removed by **Clear finished**.
