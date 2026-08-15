# Kernel execution and environments — design

Status: draft, ready for review
Date: 2026-08-08
Branch: `proto/kernel-package-install`

## Problem

A kernel cannot install a package. Three independent causes, each verified on an Arch box during
design, none of which the user can distinguish from the others:

```
$ which pip3                        → not found
$ python3 -m pip --version          → No module named pip
$ python3 -c "import site; ..."     → /usr/lib/python3.14/site-packages  writable=False
$ bwrap ... --unshare-net           → sandbox denies the agent shell all network
```

The host interpreter may ship without pip (Arch does), the sandbox denies network, and
site-packages is read-only under `--ro-bind / /`. `findPython` (`tool/notebook.ts:201`) probes only
for a working `--version`, so it happily boots an interpreter that cannot install anything, and the
failure surfaces as an opaque error that reads like a broken machine.

Two adjacent gaps found while investigating:

- **GPU is unreachable.** `--dev /dev` mounts a fresh minimal devtmpfs, so no `/dev/nvidia*` reaches
  the kernel. Verified: `nvidia-smi -L` inside the kernel's exact sandbox reports it cannot talk to
  the driver. Meanwhile `KernelStatus.resources` declares `gpu_percent` and `vram_bytes`
  (`science/kernel/registry.ts:99-100`) and `KernelCard.tsx:98-99` renders both — with **no sampler
  anywhere**, so every card shows "Unavailable" permanently.
- **`package_install` already exists as a capability** in `project/trust.ts:25` and
  `project/execution.ts:26`, with zero call sites. The slot was reserved and never filled.

## Governing principle

**Nothing is gated more strictly than arbitrary code execution unless it costs money.**

`tool/notebook.ts:590` runs arbitrary agent-authored Python in a persistent kernel and asks for
`permission: "bash"` with `always: ["python*"]` — a standing grant covering all future execution.
`bash.ts` is the same shape. `tool/modal.ts` is stricter (exact-plan digest, `always: []`, plus a
`spendFilter` strip at `permission/next.ts:165-171`) for exactly one reason, stated in the comment
there: **paid actions**.

An earlier draft of this design copied modal's contract. That was wrong — it would have made
installing a library stricter than running arbitrary code. Package installation costs nothing, so it
uses the ordinary contract.

## Current architecture

Five layers, unchanged by this spec except where noted.

```
NotebookTool / RKernelTool      agent-facing tool, permission gate
        ↓
KernelRuntime (registry.ts)     identity, persistence, provenance, authority
        ↓
KernelManager (per language)    process pool, idle reaping
        ↓
Kernel (PythonKernel/RKernel)   one child process, queue, wire protocol
        ↓
Sandbox.wrapArgv                bwrap / seatbelt confinement
```

Facts this design relies on:

- `KernelIdentity` is `{projectID, sessionID, name, language}`, hashed into a storage key at
  `registry.ts:135`. Arbitrary names are already supported end to end — `POST /kernels` takes one,
  provenance strips a `notebook:` prefix, the frontend strips it for display.
- `ExecutionAuthority.generation` (`project/execution.ts:95`) hashes trust, filesystem grants, and
  sandbox policy. A change tears down and reboots live kernels at `registry.ts:337`. It takes
  `{projectID?, sessionID, capability}` — **no kernel identity**, which constrains where env state
  can live (see below).
- `KernelProcessIdentity` (`science/kernel/process.ts`) captures pid + a platform start token and
  verifies both, guarding against pid reuse.

## Decisions

### Permission contract

|                        | Decision                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution              | Unchanged. `permission: "bash"`, `always: ["python*"]`.                                                                                                                                                                                                                                                                                 |
| Install                | `permission: "package_install"` — the capability already declared in `trust.ts` and `execution.ts`.                                                                                                                                                                                                                                     |
| Pattern                | A canonical command string: `install numpy pandas → default [pypi.org/simple]`. This is both what the card shows and what the permission system matches.                                                                                                                                                                                |
| `always`               | `["install*"]` — a standing grant offered on the card from the start. Mirrors `notebook.ts:590`, which shows the specific `"python (notebook)"` and stores the broad `"python*"`.                                                                                                                                                       |
| Card fires             | **On every install.** Allow-once approves that call and the next identical request prompts again; taking the broader grant runs subsequent installs without prompting. Friction is solved by the standing grant, not by exempting classes of install — no threshold to tune, and nothing enters an environment the user never saw once. |
| No digest              | The command string does the job. Change the env, packages, or index and it is a different string, so the prompt reappears for free — and unlike a sha256 it is readable on the card.                                                                                                                                                    |
| No `spendFilter` entry | Installs are not a paid action.                                                                                                                                                                                                                                                                                                         |

### Environments

|                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape          | First-class, named, **language-scoped**. A python env and an r env are separate objects sharing one interface — mirrors `KernelManager`: one contract, per-language backends.                                                                                                                                                                                                                                               |
| Conda          | Off the table. Claude-science gets language-neutral envs free because conda unifies python and R in one directory; venv/uv unifies nothing, so neutrality would buy conda's abstraction without conda.                                                                                                                                                                                                                      |
| Manifest       | The source of truth. `Global.Path.data/envs/<projectID>/<name>.json`.                                                                                                                                                                                                                                                                                                                                                       |
| Directory      | Derived, therefore cache. `Global.Path.cache/envs/<projectID>/<name>/`.                                                                                                                                                                                                                                                                                                                                                     |
| Kernel binding | A **property** of the registry entry, never part of `KernelIdentity` — adding it to the tuple rekeys every persisted record and orphans them.                                                                                                                                                                                                                                                                               |
| Staleness      | Compared at the **registry** level, not inside `ExecutionAuthority`, whose signature carries no kernel identity.                                                                                                                                                                                                                                                                                                            |
| Default        | A new kernel binds to `default` unless told otherwise. **The binding point is the tool, not the route** — `POST /kernels` was removed in #274/#275 and the agent now names kernels through the `kernel` parameter on `notebook`/`rkernel`, so `environment` belongs beside it, exactly as the reference carries `environment=` on every `python`/`bash`/`r` call. Reassignment is explicit, because it restarts the kernel. |
| Creation       | No approval card. It writes a directory in our own cache and runs stdlib code. The install card notes the env will be created. A `uv venv --python X` that downloads an interpreter adds a line to that card.                                                                                                                                                                                                               |

Kernel reads are free — the cache directory is readable under `--ro-bind / /`. Only the installer
needs a writable bind.

### Installer

**Ladder**, probed in order:

1. Existing env directory → use it
2. `Bun.which("uv")` → uv
3. `python3 -m venv` + ensurepip
4. Neither → fail with the exact remedy (`python3-venv` on Debian/Ubuntu, or install uv)

Verified: on a host whose `python3` has no pip, `python3 -m venv` still bootstraps pip 26.1.2 from
`/usr/lib/python3.14/ensurepip/_bundled/pip-26.1.2-py3-none-any.whl`, and it works **offline inside
`--unshare-net`**. uv is a fast path, never a requirement. Only the Debian/Ubuntu ensurepip split is
a genuine dead end.

Never auto-download uv. `compute/modal/volume.ts:112-116` is the house precedent: probe, use if
present, throw a remedy if not.

**Containment.** _Superseded — see "Network policy" below._ Earlier drafts specified a **separate**
install sandbox, network-enabled, because the kernel's was network-denied and only the installer
needed egress. The allowlist proxy removes that asymmetry: under one policy the kernel can reach
PyPI too, so there is no second sandbox. The install runs in the **same** sandbox as the kernel,
differing only in what is writable:

- egress via the allowlist proxy — identical to the kernel, not a relaxation
- writes confined to the env directory and a private `TMPDIR`
- a **writable package cache** bound in — without it pip disables its cache and every retry and
  rebuild re-downloads
- `kernelSensitivePaths()` masked to `/dev/null`
- `--unshare-pid`

Verified twice. A C-extension source build (`markupsafe --no-binary :all:`) completes inside this
sandbox, the compiler and headers arriving free on `--ro-bind / /`, with the credential mask holding
(`Permission denied` inside, real contents outside). And `pip install --only-binary :all: tqdm`
completes through the proxy with the same masks in place. An earlier claim that source builds would
break was reasoning, not evidence, and was wrong.

**Wheels-only (`--only-binary :all:`) is the default**, escalating to source builds on request. This
is a speed and reliability default, _not_ a security boundary — if bwrap contains agent Python at
import time it contains `setup.py` at install time.

### Install lifecycle

|                       | Decision                                                                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolution            | Approve the **request**; resolve versions after. The card shows unversioned names.                                                                                                                                                                                                                                     |
| Already satisfied     | Skip outright — no card, no install, no restart. Nothing privileged happens, so nothing needs approving.                                                                                                                                                                                                               |
| Dispatch              | **`wait: true` by default** — the install runs inline and returns its result, so a two-second install costs one turn. `wait: false` returns an exec id to poll, mirroring `modal.ts` → `compute_job`. No notification channel.                                                                                         |
| Verification          | After a successful install, import the installed names in the target env and report the versions. Catches an installer that exits 0 without producing a working module.                                                                                                                                                |
| Busy kernel           | **Queue** behind the running cell, display `queued behind <kernel>`, offer a cancel. A cell that lazily imports a submodule mid-install can load a half-written file, so this is correctness, not scheduling.                                                                                                          |
| Lock                  | **Per-env.** Other environments stay fully usable.                                                                                                                                                                                                                                                                     |
| Restart               | **Conditional on the change set** — see "Reopened by later evidence". Purely additive → no restart, namespace survives. Any removal, downgrade, or version change → restart every kernel bound to that env. Kernels on other envs are always untouched. Shared envs are enforced additive-only, so they never restart. |
| Reported failure      | **Nothing landed.** Modern pip builds every wheel before running the install phase, so a build failure aborts before anything is committed — verified: a failing package's cleanly-resolving dependency was downloaded and still not installed. Report the log and stop; there is no subset to keep or retry.          |
| Failure diagnosis     | Surface the **cause**, not pip's summary line. `ERROR: Failed building wheel for X` names the package; the `fatal error:` line above it names a missing system header, which usually means the install is unachievable in a sandbox and a pure-Python alternative is the answer.                                       |
| Wheels-only rejection | Translate it. `Could not find a version that satisfies the requirement X (from versions: none)` reads as "no such package" but means "no wheel for this policy". Say that, and offer the source-build escalation.                                                                                                      |
| Interruption          | Detach the installer (`detached: true`, no `--die-with-parent`) and **persist the lock with pid + start token**. On CLI start, reconcile: pid alive and token matches → still running; otherwise → unknown outcome.                                                                                                    |
| Unknown outcome       | New env → `rm -rf`. Existing env → mark dirty, rebuild from manifest.                                                                                                                                                                                                                                                  |
| No snapshots          | pip has no transactions, and `cp --reflink=always` fails on ext4 here — a pre-install snapshot is a full multi-GB byte copy. Rollback is env-level only.                                                                                                                                                               |
| Constraints           | Parse with a real PEP 508 parser. Splitting on `==` mishandles `numpy>=2.4`, extras, and markers.                                                                                                                                                                                                                      |
| Index credentials     | Strip before matching, redact on the card. They are env config, not part of the approved action.                                                                                                                                                                                                                       |

### Agent contract

`PackagePrompt.system()` (written, `src/package/prompt.ts`) injected unconditionally into the system
array at `session/prompt.ts:863`, exactly as `SystemPrompt.compute()` is today.

This is the mechanism that scales. 199 of 293 `SKILL.md` files mention `pip install`; 435 files do.
Editing them is neither necessary nor sufficient — the block pre-empts all of them, plus reference
files the skill tool never intercepts and third-party skills cloned from GitHub that this repo
cannot edit.

**No skill-level override.** `ComputePrompt.skill()` is a whole-document replacement, appropriate
only when the whole document is wrong — true of the modal skills, whose subject _is_ the governed
mechanism. Every package-mentioning skill is about a domain (docking, geopandas, pydicom) with
install as scaffolding; replacing them would destroy correct content to fix a preamble. Add an
override only if a skill appears whose subject is environment setup. None exists today.

**Refusal, not redirect — revised after the proxy landed.** This decision previously read "a shell
`pip install` must fail with a message naming `package_install`, not a DNS error", and rested on a
premise that is no longer true: that shell installs fail anyway, so the only job was replacing a
confusing error with a helpful one.

Under `network: "allowlist"` they succeed. Measured on this branch, inside the agent's own sandbox,
with no tool and no approval card:

```
python3 -m venv <workspace>/venv && <workspace>/venv/bin/pip install tqdm   →  4.70.0
```

The workspace is writable and pypi is allowlisted, so system site-packages being read-only stops
nothing — the agent just builds its own venv beside the project. The proxy did not create the
intent to bypass; it removed the accident that used to prevent it.

So the shell path has to be **refused**, not merely redirected, or the approval card is decorative:
an agent that never calls `package_install` never shows one. Requirements:

- Refuse in the bash tool, before execution, matching the installer invocations named in
  `PackagePrompt` — including `<path>/bin/pip`, `python -m pip`, and `uv pip`, which a bare
  `pip install` match misses. `tree-sitter-bash` is already a dependency and already used for
  command parsing, so this is a parse, not a regex over the command line.
- Fail with the same message the contract uses, naming `package_install`. The redirect's original
  value stands; it is now the message attached to a refusal rather than to a failure.
- Do **not** solve this by removing pypi from the allowlist. Notebook cells legitimately fetch from
  allowlisted hosts, and an allowlist that differs per tool is a second policy to keep consistent.
- Refusal is a contract boundary, not a security boundary. An agent determined to bypass it can
  vendor a wheel by hand over the same allowlisted egress. What refusal buys is that the _normal_
  path — the one every skill's `pip install` line leads to — arrives at the card. Treat it as
  governance, and do not claim more for it.

### GPU

|                  | Decision                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox.gpu`    | `"none" \| "nvidia"`, default `"none"`. When set, `bubblewrapArgs` emits `--dev-bind-try` for the nvidia node set.                               |
| Not `allowWrite` | Verified: `--bind-try` mounts `nodev` and NVML reports Insufficient Permissions. Only `--dev-bind-try` works. No config-only workaround exists.  |
| Authority        | Reuses `kernel`. The policy already hashes into `generation`, so flipping it reboots live kernels under the new rules.                           |
| Metrics          | `nvidia-smi --query-compute-apps=pid,used_gpu_memory` joins onto the process-group model in `metrics.ts`. Unavailable → omit the field, never 0. |
| Ordering         | GPU access **before** metrics. With the flag off no kernel can be a CUDA app, so a sampler shipped first reads zero by construction.             |

Orthogonal to `--unshare-net`: GPU grants compute without touching the network boundary.

## Reference implementation — Claude-science, as observed

Recorded from screenshots and a transcript of a live session, not from documentation or source. It
is the closest shipping analogue to this design, and several decisions above are either copied from
it or deliberately diverge. Treated as evidence of what works in practice, not as a specification.

### The sequence it runs

The user typed a direct imperative — _"Can you pip install numpy"_ — and it **did not install**.

1. **Probe first**, through `bash`. Two probe commands were captured verbatim; the scipy one is
   known only by its reported result:
   ```
   python -c "import numpy; print('numpy', numpy.__version__)"      → numpy 2.4.6
   ‹scipy probe — command not captured›                             → scipy 1.17.1
   python -c "import torch; print('torch', torch.__version__, '| cuda available:',
              torch.cuda.is_available())" 2>&1 || echo "NOT INSTALLED"
   ```
2. **Report and stop** when satisfied: _"numpy is already installed in the default python
   environment — version 2.4.6 — so there's nothing to install."_
3. **Volunteer the ambiguity unprompted** — a different project environment, or inside a Modal
   container image, are named as separate targets with different answers.
4. **Reason about placement out loud** before acting, only for the absent package: _"It's a
   heavyweight stack, and platform convention is to keep those out of the shared default env, so
   I'll put it in a dedicated environment rather than the default one."_
5. **Reason about hardware**: _"the local GPU isn't accessible from this sandbox, so a local install
   would be CPU-only torch (useful for development/testing; actual GPU training goes through
   Modal)."_ It then selects `pytorch-cpu` because of that, rather than installing the GPU build and
   failing later.
6. **Only then** emit the typed call.

### The call

```
mode            create
name            torch-cpu
python_version  3.13
packages        › 2 items      [pytorch-cpu, torchvision-cpu]
channels        › 1 item       [pytorch]
background      true
```

Typed parameters, not a shell string. The approval card renders them as a compact command line
rather than raw JSON:

```
create torch-cpu pytorch-cpu torchvision-cpu [channels: pytorch] [python=3.13]
```

Package names appear **unversioned**. No pins, no resolved set, no download size.

### A second trace — installing into an existing environment

Header: _"Ran 2 commands, set up an environment · 3 steps"_.

**Step 1 — batched probe**, one `bash` call, `ENV python`:

```
python -c "import PIL, sys; print('pillow', PIL.__version__)" 2>&1 | tail -1; \
python -c "import tqdm; print('tqdm', tqdm.__version__)" 2>&1 | tail -1; \
pip index versions tdm 2>&1 | head -3
```

```
pillow 12.3.0
ModuleNotFoundError: No module named 'tqdm'
tdm (0.1.0)
Available versions: 0.1.0
```

Several probes chained with `;`, each normalised with `2>&1 | tail -1` so a missing module returns a
one-line result rather than a traceback.

Note the third command: `tdm`, not `tqdm`. The typo resolved to a **real, unrelated package** and
returned its versions. Nothing was installed from it and the agent went on to install `tqdm`
correctly — but it is a live instance of the typosquat exposure that motivates sandboxing the
installer.

**Step 2 — the install call:**

```
environment  python
mode         install
packages     › 1 item      [tqdm]
use_pip      true
```

```
Installed via pip in 'python': tqdm
```

**Step 3 — post-install verification**, again through `bash`:

```
python -c "import tqdm, PIL; print('tqdm', tqdm.__version__); print('pillow', PIL.__version__)"
→ tqdm 4.70.0
  pillow 12.3.0
```

What this establishes that the first trace did not:

- **One tool, several modes.** `mode: create` and `mode: install` are the same tool. The first trace
  created a conda env with `channels` and `python_version`; this one installs with `use_pip: true`
  and no channels. That corroborates the two backends named in the lock message — **path-venv** and
  **conda-backed** — from a second, independent direction.
- **The installer backend is an explicit parameter**, not an internal choice. `use_pip: true` is on
  the call.
- **Install is synchronous by default.** No `background: true`, no `exec_id`, no notification — just
  a terse one-line result. Background is opt-in per call, so a two-second install stays inline and
  only long ones go async.
- **The default environment is named `python`.** Not "default". Weak but real evidence toward
  language-scoped naming.
- **Their agent shell has pip and network.** `pip index versions` reached the index from `bash`.
  So probe-first is a **policy choice there, not something a sandbox forces** — unlike here, where
  the shell has neither.
- **It verifies after installing** rather than trusting the installer's report.

**Not established by this trace:** no approval cards appear in it. Either none were shown, or an
earlier "Allow for chat" on `bash` covered steps 1 and 3 and the install card was not captured. The
absence is not evidence that installs go unprompted.

### Approval cards

One card of each kind was captured. What is on them:

|                | Probe                               | Mutate                                                  |
| -------------- | ----------------------------------- | ------------------------------------------------------- |
| Title          | "Run a shell command?"              | "Create conda environment torch-cpu?"                   |
| Chips          | `python` · `conda env`              | none visible                                            |
| Body           | the code, under a `Code` disclosure | the rendered command line, under a `Details` disclosure |
| Primary button | **Allow for chat**                  | **Allow once**                                          |
| Also           | dropdown chevron, `Deny`            | dropdown chevron, `Deny`                                |

**Not established:** whether "read-only persists, mutation does not" is a systematic policy. That is
one sample of each, and both buttons carry a dropdown — so the label shown is the default offered,
not necessarily the only scope available. The pairing is suggestive and matches how
`permission/next.ts` already separates paid from ordinary actions, which is why this spec adopts the
shape; it is not evidence that they enforce it.

### The dispatch response

```json
{ "status": "running", "exec_id": "94d34ecc-f441-4dd8-ab8e-00702bbee577", "message": "…" }
```

The message is the interesting artefact. Decomposed:

- **Async by default** for environment operations, returning immediately.
- **Permanent placeholder** — _"this placeholder is permanent"_. The tool result in the transcript
  never updates; the outcome arrives later as a `notifications[]` entry of type `cell_result`, via
  an explicit `wait_for_notification` or automatically at the start of a later turn.
- **No progress streaming** — _"Progress streaming (`exec_peek`) is not available for
  package/environment operations."_ Stated rather than faked.
- **Honestly leaky interrupt** — `host.exec_interrupt(exec_id)` gives _"real termination for a
  path-venv; for a conda-backed environment the wait is abandoned — lock released, subprocess
  continues detached."_ It tells the agent that cancel does not always cancel.
- **Per-environment lock, stated to the agent** — \_"do NOT run python, r, or `manage\__` in that
  environment until it finishes (its packages are being rewritten and **its kernel restarts on
  completion**). A different environment or bash is fine."\*

Two backends are named in that one sentence: **path-venv** and **conda-backed**.

`python, r, manage_*` also appear together under one environment's lock. Two readings fit equally
well: the environment genuinely hosts both languages (conda can), or the message is a generic
template listing every execution tool regardless of what this environment contains. **The
screenshots do not distinguish them**, and an earlier draft of this spec asserted the first as fact.

The language-scoped decision above does not rest on this either way — a venv cannot host R, which is
reason enough on its own.

### A third trace — the network model

Asked whether its sandbox has network, it reported:

> _"Yes — the sandbox has network access, but it's filtered through an **allowlist proxy** rather
> than being open."_

- **Reachable (200):** `pypi.org`, `eutils.ncbi.nlm.nih.gov`, `rest.uniprot.org`
- **Blocked at the proxy:** `example.com`, `www.google.com` — connection fails outright
- **Mechanics:** all outbound goes through an HTTP/HTTPS proxy, `*_proxy` env vars set. Direct DNS
  resolution returns nothing — name resolution happens _at the proxy_, so `getent hosts` is empty
  even for domains that work. Connectivity must be tested over HTTP, never ping or DNS.
- **Allowlisted classes:** scientific APIs and package registries — NCBI, Ensembl, UniProt, PDB,
  EBI, ChEMBL, arXiv, CRAN/Bioconductor, PyPI, conda, npm. Arbitrary browsing is not.
- **Adding a domain:** _"approval takes effect immediately without losing kernel state."_

This is categorically different from `--unshare-net`. Ours is binary — the kernel has all network or
none. Theirs is a **bounded** network: the kernel can reach the registries and data sources a
research tool actually needs, and cannot reach anywhere else. Because the policy lives in a proxy
rather than a namespace, changing it does not restart anything.

### A fourth trace — the four install routes

Asked how it installs packages, it enumerated:

**1. `manage_packages` — the durable path.** Writes into the environment's real site-packages and
survives kernel restarts. conda by default, pip with `use_pip=true`. Accepts version pins, and _in
dedicated envs_ git URLs, wheel URLs, and extras. Also `mode="uninstall"` and `mode="list"`.

> _"Installing does not restart the kernel — your variables and imports survive, and a new package
> is importable immediately. **Uninstalling does restart it.**"_

And the constraint that makes that safe:

> _"the shared default `python` and `r` envs are **additive-only**. They accept bare names with at
> most an exact `==` pin; URLs, VCS refs, and version ranges are rejected, and uninstall is blocked.
> Conda there also runs `--freeze-installed`, so an install can never disturb what's already
> present."_

**2. `manage_environments` — a dedicated env**, for anything that may later need removing or
re-pinning, and for heavyweight stacks:

```
manage_environments(mode="create", name="cheminfo", packages=["rdkit", "scikit-learn"])
```

Every subsequent `python`/`bash`/`r` call then carries `environment="cheminfo"`. Environments
present on that box: **`python`, `r`, `torch-cpu`, `compute-provider-modal`**.

It can also **register an existing venv from a granted host path**, working against the user's own
repo interpreter with editable installs rather than a managed copy.

**3. `pip install` inside a bash or python cell — ephemeral.** Gone when the kernel shuts down. And
worse in managed conda envs, where _"their site-packages are mounted read-only in the sandbox, so
`<env>/bin/pip install` reports success and writes nothing."_ A silent no-op, not an error.

**4. Remote and provider-side** — baked into the job's image on that side.

Stated default: `manage_packages` into a purpose-built env, reserving the shared `python` env for
small additive things like `tqdm`.

### What these two traces settle

- **Environments are language-scoped.** `python` and `r` are _separate environments_ on the same
  box. The earlier lock message naming `python, r, manage_*` together was a generic template listing
  execution tools, exactly as the alternative reading suggested — not evidence of neutrality. The
  hedge in this spec was correct and the question is now closed, in favour of the choice made here.
- **Adopting a user's existing venv is a real, shipped capability**, not a hypothetical. It was
  listed as an open product question in this design; the reference answers it.

### A fifth trace — two failure surfaces, neither partial

**Blocked before any build.** `pyaudio` into the shared `python` env returned a `manage_packages`
error, not a compiler one:

```
ERROR: Could not find a version that satisfies the requirement pyaudio (from versions: none)
```

The shared env is **wheel-only as well as additive-only**, so an sdist-only package is filtered out
of the candidate list and never reaches a build step. Nothing downloaded, nothing changed.

Note the message. `from versions: none` reads as _"this package does not exist"_ when it means
_"no wheel available for this policy"_. Under a wheels-only default that error will be common, and
raw is the wrong way to surface it.

**A real build failure**, reproduced in a throwaway venv with a C extension against a nonexistent
header:

```
Building wheel for brokenpkg (pyproject.toml): finished with status 'error'
  src/speed.c:2:10: fatal error: portaudio_that_does_not_exist.h: No such file or directory
  error: Command '['gcc', ...]' returned non-zero exit status 1
  note: This error originates from a subprocess, and is likely not a problem with pip
ERROR: Failed building wheel for brokenpkg
```

Read bottom-up: pip's own `ERROR:` names only _which_ package failed; the cause is the `fatal error:`
line, and it is a missing **system** header, not a Python dependency. That signature means an
OS-level `-dev` package is required, which in a sandbox usually means the install is not achievable
and a pure-Python alternative is the answer.

**The install was atomic.** `brokenpkg` was given a dependency on `six`, which installs cleanly as a
wheel. The log shows `Collecting six` — resolved and downloaded — yet:

|           | before                            | after       |
| --------- | --------------------------------- | ----------- |
| installed | packaging, pip, setuptools, wheel | _identical_ |

`six` was not left behind. Modern pip builds every wheel first and runs the install phase only after
all builds succeed, so a build failure aborts before anything is committed. The outcome is a clean
environment plus a log, never a half-installed one.

**Where partial state does arise**, per the same trace:

- a package that builds and installs fine but fails on **import** — wrong ABI, missing runtime `.so`
- a legacy `setup.py install` invoked directly
- an **interrupted** multi-package install, where earlier wheels already landed — and on conda,
  `host.exec_interrupt` abandons the wait while the operation continues detached

### A sixth trace — `mode="list"`, and the provider environment

**`list` returns structured data, not text:**

```
{ environment_name, package_count, packages: [...], python_version, history: [...] }
```

`packages` is `name==version` for **everything the solver knows about**. The shared `python` env
reports 168 entries, most of them native libraries and fonts — `libgcc`, `harfbuzz`, `xorg-libx11`,
`qt6-main` — with importable Python packages a minority.

_This is a bug in `src/package/prompt.ts` as first written_, which rendered the full package list
into the capability block on every request. Fixed: the block now shows only what was explicitly
requested, plus a `(+N deps)` count. A contract buried in font libraries teaches the agent nothing.

**`history` is the field that matters** — an ordered record of how the env was built:

```
create numpy, pandas<3, scipy, matplotlib, seaborn, pillow, socksio, pysocks (py3.11)
install pypdfium2==5.9.0 (pip)
install nbformat (conda)
install tqdm (pip)
```

Seed spec, then every mutation, each tagged with its backend — _"the fastest way to answer 'where
did this package come from, and was it conda or pip?', which matters because mixing the two in one
env is where dependency resolution tends to break."_

**This sharpens the manifest decision.** This spec says the manifest is the truth and the directory
is derived. A _flat package list_ cannot be replayed faithfully — order matters and backend matters.
An ordered, backend-tagged history can. Rebuild-from-manifest becomes replay-the-history, and the
same record answers the provenance question that was listed here as out of scope.

**`compute-provider-modal`** is infrastructure, not a workspace: 59 packages, history is one line
(`create python=3.11, pip`), payload is `modal==1.5.1` plus its gRPC and async plumbing. Nothing
scientific. It backs a `compute_provider` tool — _"the authenticated kernel where the Modal SDK is
pre-imported and wired to your token"_ — used for provisioning: building images, managing volumes,
inspecting workspace state. It **explicitly rejects `gpu=`**; job submission goes through a separate
path entirely.

That is a different boundary from the one in ADR-0001, which holds that credentials are _"never
added to a generic agent, shell, kernel, or job environment"_ and routes everything through a
trusted JS adapter. Theirs puts the credential **inside one dedicated, capability-restricted
kernel** that can provision but cannot dispatch paid work.

Worth noting because of a cost we already pay for our version: `compute/modal/volume.ts` exists —
a pinned Python bridge launched through `uv` — solely because the JS SDK cannot read Volumes and we
refused to have a credentialed Python environment. A capability-restricted provider env would make
that bridge unnecessary. Not a recommendation to change ADR-0001; a recorded alternative with a
known price on both sides.

### Isolation

The web UI is served on `:8000` behind a **single-use nonce** that expires in three minutes; sandbox
content is served separately on `:8001`. Remote access requires forwarding both.

### Mapping to this design

| Observed                                                                                  | This spec                                                                                                                                       | Why                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Probe before installing; report and stop when satisfied                                   | **Adopted** — skip outright, no card, no restart                                                                                                | Confirms the principle independently                                                                                                                                                                         |
| Unversioned names on the approval card                                                    | **Adopted** — approve the request, resolve after                                                                                                | Same trade                                                                                                                                                                                                   |
| Read-only grant persists, mutation grant does not                                         | **Adopted in shape**, on our own reasoning rather than theirs — the sample is one card each (see above)                                         | Matches how `permission/next.ts` already separates paid from ordinary actions                                                                                                                                |
| A shell probe to answer "is numpy present?"                                               | **Rejected** — the capability block carries the inventory, so nothing needs to run                                                              | Ours is a design choice about where inventory lives; why theirs probes is not observable                                                                                                                     |
| Typed parameters rendered as a command line on the card                                   | **Adopted** — the canonical command string is both the display and the permission pattern                                                       | Readable, and it doubles as the match                                                                                                                                                                        |
| Per-environment lock, named to the agent                                                  | **Adopted**, including surfacing it in the capability block                                                                                     | Directly copied                                                                                                                                                                                              |
| Kernel restarts on completion                                                             | **Adopted**                                                                                                                                     | Confirms always-restart                                                                                                                                                                                      |
| Install is **synchronous by default**, `background: true` opt-in per call                 | **Adopted — revises this spec.** Default `wait: true`, returning the result inline; long installs pass `wait: false` and get an exec id to poll | An earlier draft made every install async, which is wrong for the `tqdm` case: two seconds of work behind a dispatch-and-poll round trip. `modal.ts` already has exactly this flag with exactly this default |
| Async dispatch with an exec id, when asked for                                            | **Adopted**                                                                                                                                     | —                                                                                                                                                                                                            |
| Installer backend as an explicit call parameter (`use_pip: true`)                         | **Rejected** — the ladder picks it, and the choice is shown on the card                                                                         | The agent has no basis for choosing; the host does. Exposing it invites the agent to pick badly and adds a field that changes nothing it can reason about                                                    |
| Verify by importing after installing                                                      | **Adopted**                                                                                                                                     | Cheap, and it catches an installer that reports success without producing a working module                                                                                                                   |
| Batched probes in one shell call                                                          | **Not applicable** — the capability block carries the inventory, so there is nothing to probe                                                   | —                                                                                                                                                                                                            |
| Notification delivery (`wait_for_notification`, `cell_result`)                            | **Rejected** — dispatch returns an id and is polled, mirroring `modal.ts` `wait: false` → `compute_job`                                         | No notification channel exists here; polling already does                                                                                                                                                    |
| `python, r` under one environment lock — language-neutral, or a generic message template? | **Not adopted either way** — we are language-scoped                                                                                             | Decided on our own constraint: a venv cannot host R. Whether theirs is neutral is not established by the screenshots                                                                                         |
| Conda with channels                                                                       | **Rejected** — venv/uv ladder                                                                                                                   | Heavy dependency and a second solver; the ladder is verified and needs neither                                                                                                                               |
| Channels on the approval card                                                             | **Adopted as `index`**                                                                                                                          | A channel is where the code comes from — the same reason index belongs in the pattern                                                                                                                        |
| Interrupt that abandons the wait and leaks a subprocess                                   | **Rejected** — persist pid + start token and reconcile on startup                                                                               | Copy the honesty, not the leak. `KernelProcessIdentity` already does exactly this for kernels                                                                                                                |
| Combined create-and-install card                                                          | **Rejected** — no card for creating an empty env at all                                                                                         | Creating a directory in our own cache and running stdlib code is not privileged; a card that guards nothing devalues the ones that do                                                                        |
| Separate origin for sandbox content, nonce on the app                                     | **Deferred** — see Out of scope                                                                                                                 | Orthogonal; our `sandbox=""` iframe is stricter but blocks interactive output                                                                                                                                |
| No progress streaming for package operations                                              | **Accepted as a constraint**, not a goal                                                                                                        | If the closest analogue cannot do it, we should not promise it                                                                                                                                               |

## Reopened by later evidence

Three decisions above predate the network and install-routes traces and are contradicted or
weakened by them. Flagged rather than silently rewritten, because two were explicit user calls.

### 1. Restart policy — resolved: restart iff the change set is non-additive

Initially read as a contradiction: the reference does not restart on install, only on uninstall. On
asking what happens when a **downgrade** lands in a dedicated env, where ranges are accepted and
`--freeze-installed` is not in force, the answer was that it still does not restart:

> _"Install keeps the kernel alive, so you keep the stale module. Only `mode="uninstall"` restarts a
> kernel — and a downgrade goes through `mode="install"`, even though pip implements it internally
> as remove-then-reinstall. New files land in site-packages; your live interpreter never notices."_

So the reference has the hazard, and mitigates it with user discipline rather than mechanism. Its
own characterisation, from swapping a package's files under a running import:

|                                         | version | behaviour    |
| --------------------------------------- | ------- | ------------ |
| before disk change                      | 2.0     | v2           |
| after disk change, no reload            | 2.0     | v2           |
| submodule imported **after** the change | —       | **v1**       |
| after `importlib.reload`                | 1.0     | v1           |
| name bound via `from … import compute`  | —       | **still v2** |

**The hazard is mixed state, not staleness.** `sys.modules` caches only what was already imported.
Anything imported _later_ — a submodule, a lazy import inside a function, a dependency pulled in on
first use — reads the new files. The process ends up running 2.0's loaded modules beside 1.0's
freshly-loaded ones: a configuration neither version was tested in, failing in ways that do not
point back at the install.

Two consequences worth carrying:

- **`importlib.reload` is not a remedy.** It rebinds attributes on the module object, but names
  bound directly (`from torch import foo`) still point at the old function, and live instances keep
  their old classes. For compiled extensions it is worse — `torch._C` is a `.so` that CPython cannot
  unload, so reload reuses the loaded one. _"A torch downgrade is not recoverable in-process."_
  Restart is the only recovery; never offer reload as an alternative.
- A bytecode-cache trap they hit: same-second mtime plus unchanged byte length let the `.pyc` be
  considered valid, so the first reload returned the old version anyway. Real installs write fresh
  sizes and mtimes, but hand-edited files will hit it.

**This vindicates the always-restart call made here** — it eliminates by construction the hazard the
reference has to warn users about. But it overpays: a `tqdm` install discards a namespace for
nothing.

The rule that dominates both:

| Change set                                                            | Restart                                             |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| Purely additive — nothing existing replaced, removed, or re-versioned | **No.** No mix is possible, so nothing can go stale |
| Contains any removal, downgrade, or version change                    | **Yes**, unconditionally                            |
| Uninstall                                                             | **Yes**                                             |

Enforced additive-only on shared envs (their `--freeze-installed`) makes the common path _provably_
additive, so it never restarts, by construction rather than by inspection.

**Correction to an earlier draft of this table:** it said "restart only if a package being replaced
is already in `sys.modules`". That is wrong. A downgrade drags dependencies with it — if dependency
`B` was loaded as part of something else and the newly-installed `A` expects the older `B`, the mix
exists even though `A` itself was never imported. The trigger is the resolver's **whole change set**
containing anything non-additive, not an intersection with `sys.modules`.

**Approval consequence:** because the restart is now conditional, the card must say so _before_
approval — "this will replace numpy 2.3.4 with 2.2.0 and restart your kernel, discarding N
variables" — rather than the user discovering it afterwards.

**And it must escape the standing grant.** A user who accepted `install*` to stop being asked about
`tqdm` has not consented to losing a namespace mid-session. A non-additive change is destructive, so
it prompts even when a standing allow is in force — the same carve-out `spendFilter` already
implements for a different reason at `permission/next.ts:167-171`, so the mechanism exists.
Recommended, not yet confirmed.

### 2. Binary network policy — resolved, see "Network policy"

Flagged here as a weakness, then prototyped and settled. The allowlist proxy is enforceable with no
root, it collapses the separate install sandbox, and it bounds exfiltration to a fixed host set
rather than the whole internet. Moved into its own section above with the measurements; this entry
remains only as the record of where the question came from.

### 3. Keep-and-retry on partial install — premise withdrawn

An explicit decision here was that a partial install keeps what landed and retries the failed subset
under the same approval, with a discard action for a twice-failed subset. The prototype carries an
`outstanding` field for it.

**Build failures do not produce that state.** pip builds all wheels before installing any, so a
failed build commits nothing — demonstrated by a package whose clean wheel dependency was resolved
and downloaded and still absent afterwards. The premise was mine, not observed, and it was wrong.

The three real sources of partial state are already covered by decisions taken for other reasons:

| Source                                                  | Already handled by                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Interrupted mid-install                                 | Detach + reconcile; unknown outcome → rebuild from manifest        |
| Installs, then fails on import (bad ABI, missing `.so`) | The post-install import verification adopted from the second trace |
| Legacy `setup.py install`                               | Wheels-only default                                                |

So `outstanding`, the retry-the-subset path, and the discard action have no remaining use case.
Recommend dropping all three rather than carrying machinery for a state pip does not produce.

### 4. Silent-success on read-only site-packages

_"`<env>/bin/pip install` reports success and writes nothing."_ Our redirect-on-failure assumes a
shell install _fails_. Under a read-only mount it may exit 0 instead, which is worse than an error —
the agent believes it succeeded. The redirect must detect the no-op, not just the failure.

## Re-analysed against `main` @ `74ee13cd`

Three commits landed after this spec was drafted — #274 project-scoped inspector and kernel
lifecycle, #275 unified compute/results/artifact workflows, #276 minimised completed compute
results. `science/kernel/registry.ts` is **unchanged**, so the layer analysis above still holds.
Four things do move.

### Named kernels became agent-driven

`notebook` and `rkernel` now take `kernel` (a validated `[A-Za-z0-9][A-Za-z0-9._-]*` name, max 64)
and `action: "execute" | "stop"`. The tool description instructs the agent to issue several calls in
one response with distinct names for parallel analyses, to stop them when done, and — pointedly —
_"Never use shell subprocesses to imitate multiple kernels."_ A test asserts four named calls own
four live kernels concurrently.

`POST /kernels` was **removed**. Kernels are created implicitly by naming one.

Consequence for this spec: the environment binding must live on the **tool**, not the route. An
`environment` parameter beside `kernel`, which is exactly the shape the reference uses. Everything
else about binding — property not identity, registry-level generation, explicit reassignment — is
unaffected.

### `CommandRuntime` is the tracking primitive we were about to build

New at `science/command/registry.ts`, wired into `bash.ts`: every shell command registers with
`{id, projectID, sessionID, messageID, callID, description, command, process_id, started_at,
resources?}` and a `stop()` closure, and deregisters on exit. `list` / `owned(id, projectID,
sessionID)` / `stop` mirror `KernelRuntime` exactly. New routes `/commands` and
`/commands/:commandID/stop`.

An install is a long-running command, so this is the live half of install-job tracking, already
built and already consistent with the rest of the codebase. Use it rather than inventing a parallel
registry.

**But it is `new Map()` — in-memory only.** It does not survive a CLI restart, so the
detach-and-reconcile decision still needs its own persisted record with pid and start token.
`CommandRuntime` tracks what is running now; it cannot answer what was running before the crash.

### Project trust flipped to trusted-by-default

`ProjectTrust.status` inverted in #274: previously trusted only on an explicit persisted `trusted`
record, now trusted **unless** explicitly `revoked`. The tests were renamed to match — _"untrusted
project opens read-only…"_ became _"project code is enabled by default"_ — so this is deliberate,
not drift.

Consequence: `canExecuteProjectCode` is true by default, so the `project_untrusted` branch of
`ExecutionAuthority.decide` is now rare. This spec should stop treating project trust as a
meaningful gate on installation. The real gates are the permission card, the sandbox, and
`sandbox_unavailable`.

**One thing worth checking, not asserted.** The new condition is
`saved?.root !== canonical || saved.state !== "revoked"` → trusted. A record whose root no longer
matches evaluates the first clause true and yields _trusted_ even when its state is `revoked`.
Under the old code that case returned `revoked`. Whether a revoked project whose root moved should
re-trust silently is a question for whoever wrote #274; it may be intended, since a different root
is arguably a different project. Not tested here.

## Network policy — supersedes the separate install sandbox

`sandbox.network` is `"allow" | "deny"`. Deny (`--unshare-net`) is the default and locks kernels out
of PyPI, NCBI, UniProt, PDB and EBI — most of what a research tool is for. Allow is unrestricted
egress. Neither is what the product needs.

A spike on `proto/sandbox-allowlist-proxy` established a third state, enforced rather than advisory:

```
--unshare-net → TCP to any host, incl. the host's own 127.0.0.1   000  blocked
bind-mounted unix socket, same namespace                          PONG crosses
```

The socket is therefore the only route out, and a proxy on the far end decides what is reachable,
resolving names itself. No root, no `pasta`, no `nftables`.

```
kernel ─TCP→ shim (127.0.0.1:3128, in-ns) ─unix socket→ proxy (host) ─→ allowlisted host only
```

Measured inside the sandbox: `pypi.org` 200, `eutils.ncbi.nlm.nih.gov` 200,
`rest.uniprot.org/uniprotkb/P00533.json` 200, `example.com` and `www.google.com` denied, direct
egress with the proxy unset 000, and `getent hosts pypi.org` empty — the reference implementation's
own signature, reproduced. Then `pip install --only-binary :all: tqdm` succeeded through it with
credentials masked.

**Consequences for this spec:**

- The **separate install sandbox is deleted**. One policy covers kernel and installer.
- `sandbox.network` becomes three-state: `"deny" | "allowlist" | "allow"`, defaulting to
  `"allowlist"`. This is a **breaking change to a documented config key** and needs an ADR before
  anything is built on it.
- Proxy policy must stay **out** of the `generation` hash, so adding a domain takes effect without
  tearing down kernels — the property the reference advertises.
- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` join `SAFE_ENV_PREFIXES`; nothing reaches a kernel today.
- `Sandbox.wrapArgv` must compose the shim (`sh -c '<shim> & exec <cmd>'`) and bind the socket.

Not yet done in the spike: any product wiring, a config surface, per-project domains, macOS seatbelt,
audit logging, port policy on CONNECT. And the proxy pipes bytes after checking the authority — it
cannot see inside TLS, so host-level allowlisting is the boundary, not content inspection.

## Sequencing

Rewritten. The previous order predated the proxy spike, the rebase onto `74ee13cd`, and the
withdrawal of keep-and-retry; it was stale in four places.

**Phase 0 — independent, ships now.** No open questions, no dependencies on anything below.

1. `sandbox.gpu` flag emitting `--dev-bind-try`
2. GPU metrics sampler — **depends on 1**, since with the flag off no kernel can be a CUDA app
3. Three-way install diagnostics in `findPython`
4. Wire `PackagePrompt.system()` into the system array — harmless before the tool exists, because
   what it says about shell installs is already true

**Phase 1 — network policy.** Determines the shape of everything after it, so it goes first.

5. ADR: `sandbox.network` three-state, and the credential-boundary question raised by
   `compute-provider-modal` against ADR-0001
6. Proxy and shim into `src/sandbox/`, `Sandbox.wrapArgv` composition, `*_proxy` in the env
   allowlist, config surface, policy kept out of `generation`

**Phase 2 — environments.**

7. Environment store: ordered backend-tagged history as the manifest, directory under
   `Global.Path.cache`, per-env lock
8. `environment` parameter on `notebook`/`rkernel` beside `kernel`; `findPython` prefers the env;
   registry-level generation comparison

**Phase 3 — installation.**

9. `package_install` tool: canonical command-string pattern, `always: ["install*"]`, non-additive
   changes escaping the standing grant
10. Installer ladder, wheels-only default, message translation for both failure surfaces
11. `wait: true` default with `wait: false` dispatch; `CommandRuntime` for the live half plus a
    persisted pid + start token for reconcile-on-restart
12. Post-install import verification
13. R parity — `R_LIBS_USER` is already in the kernel env allowlist and `install.packages` always
    exists, so this is the simpler backend

## Not verified

Stated so nobody builds on them:

- **CUDA compute under `--dev-bind`.** `nvidia-smi -L` works; no kernel launch was tested.
- **macOS.** The seatbelt profile allows `file-write*` on all of `/dev` (`sandbox.ts:267`), so Metal
  may already work — untested. No install-sandbox profile has been written for seatbelt.
- **Whether the capability block beats an install-heavy skill.** The worst case is
  `chemistry/molecular-docking/SKILL.md` with 9 `pip install` mentions. Empirical, answerable only
  by running it. The sandbox and the redirect are the backstop.
- **The proxy at any scale.** _Partly resolved on `feat/sandbox-network-policy`._ Backpressure,
  bounded buffers, dial timeouts and a per-client state machine were built and measured after this
  was written; an 18 MB wheel now arrives byte-exact through a real sandbox in CI on both backends.
  What remains unverified is the original sentence's tail: **concurrency is still uncapped**
  (~64.7 KB per connection, no ceiling), there is no audit log, and behaviour under a slow or
  hostile upstream is untested. `pip install torch` at gigabyte scale still has not been run.
- **The proxy on macOS.** _Resolved._ Seatbelt has no namespace, so the design changed rather than
  transferred: the proxy listens on `127.0.0.1:<port>` and the profile narrows `network-outbound` to
  that one address, with a per-start secret in the proxy URL because every process on the machine
  shares one loopback. Verified against a real `sandbox-exec` in CI — allowlisted host 200, denied
  host refused, no direct route, no DNS, 18 MB byte-exact, and `pip install` through the
  authenticated proxy.
- **`sandbox.gpu` alongside the proxy.** Both change `wrapArgv`; they have never been composed.
  Still true — `sandbox.gpu` does not exist yet.
- **The release-mode shim.** In a compiled binary the binary is its own shim
  (`Installation.isLocal()` false). Verified once by hand against a `bun run build --single` build —
  a real `pip install` succeeded inside `--unshare-net` with the boundary intact — but every
  automated test runs under `bun run`, which takes the dev-bundle branch instead. Nothing keeps it
  working.

## Out of scope

- **Interactive kernel output on a second origin.** `NotebookView.tsx:764` renders kernel
  `text/html` in `<iframe sandbox="">`, which blocks scripts entirely — safe, but plotly and
  ipywidgets cannot render while `types.ts:47` advertises `application/vnd.plotly.v1+json`. A second
  listener composes with the cross-origin guard at `server.ts:143-154`. Own spec.
- **Windows.** `sandbox.ts:110-122` returns `"none"` for anything not darwin/linux, so install
  containment does not exist there — and today `enabled:true` + `available:false` +
  `onUnavailable:"error"` already denies the `kernel` capability outright on a platform that ships a
  binary. Pre-existing and larger than this spec.
- Uninstall and downgrade, cache pruning, env export/import, provenance for installs, env
  management UI, cross-session restart consent, headless approval.
