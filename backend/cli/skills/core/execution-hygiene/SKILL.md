---
name: execution-hygiene
description: Runs computations so they finish, reproduce and fit the machine that will re-execute them, detaching long jobs through compute_job instead of blocking or sleeping shells, checkpointing so reruns resume, fixing seeds and capping BLAS and OpenMP threads, streaming large tables with explicit dtypes, writing outputs atomically, logging every command with its exit code and rerunning the final pipeline from scratch under the target limits before finishing. Use for any analysis or pipeline that runs longer than a minute, reads files larger than memory, or will be re-executed on a machine with tighter CPU, memory, wall-clock or network limits than this one; a one-off shell command whose output is read immediately does not need it.
summary: "Detach, checkpoint, seed, cap threads, write atomically, rerun clean, log exit codes."
category: core
role: support
allowed-tools: [Read, Bash, python, compute_job]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Execution hygiene

A number that exists only in a terminal scrollback, or that came from a run on a machine
with more cores and memory than the one that will re-execute the pipeline, is not a
result yet. The habits below cost minutes and remove the two most common ways an analysis
fails after it "worked": it cannot be rerun, or it runs differently.

## Rules

1. **Detach anything that outlives a shell prompt.** A step that may exceed a few minutes
   goes through `compute_job start` (name, purpose, command, cwd, declared artifacts and
   checkpoint path). A job that settles within the dispatch's grace comes back in that step
   with its outcome, output tail and deliveries; a longer one wakes you when it ends, so go
   on with other work rather than `wait` on it, and read `compute_job logs` only when the
   tail is not enough. Never a shell `sleep` loop polling a PID or a file: blocked shells
   get killed with the session, the job record does not, and the job keeps its logs and
   exit code.
2. **Get a valid artifact on disk early, then improve it in place.** Produce the weakest
   complete version of every required output as soon as the pipeline can — a small run, a
   coarse grid, a simple baseline — then refine within the remaining budget. A crash, a
   timeout or a misjudged final step then costs quality rather than everything. Where
   several instances or cases each need an answer, divide the budget across them up front
   and keep a best-so-far for each rather than perfecting the first.
3. **Checkpoint and resume.** Persist progress at natural boundaries (per epoch, per chunk,
   per input file) under the declared checkpoint path, and make the entry point look for
   that state before starting. An interrupted rerun should do the remaining work, not all
   of it. Name checkpoints by step (`chunk_0042.parquet`), not by timestamp.
4. **Seed everything and cap every thread pool.** `random.seed(s)`,
   `np.random.default_rng(s)`, `torch.manual_seed(s)`, and `PYTHONHASHSEED=s` in the
   environment. Export `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, `OPENBLAS_NUM_THREADS` and
   `NUMEXPR_NUM_THREADS` before the interpreter starts (BLAS reads them at load time), and
   call `torch.set_num_threads(n)` inside; `threadpoolctl.threadpool_limits(n)` caps a
   BLAS that is already loaded. Two reasons: reductions change summation order with thread
   count, so bitwise-identical reruns need a fixed count; and a BLAS that spawns 64 threads
   inside a 2-CPU quota thrashes. On Linux read `len(os.sched_getaffinity(0))`, not
   `os.cpu_count()`, and check `/sys/fs/cgroup/cpu.max` and `memory.max` for the quota.
   Full GPU determinism needs `torch.use_deterministic_algorithms(True)` and
   `CUBLAS_WORKSPACE_CONFIG=:4096:8`; say when you accept nondeterminism instead.
5. **Stream large tables and declare dtypes.** `pd.read_csv` with `usecols=[...]`,
   `dtype={...}` and `chunksize=200_000`, aggregating per chunk; `np.load(path, mmap_mode="r")`
   or `np.memmap` for arrays; `pyarrow.parquet.ParquetFile(path).iter_batches(batch_size=...)`
   for Parquet; `polars.scan_csv` or `scan_parquet` for lazy pipelines. Inferred dtypes flip
   between chunks (an integer column becomes float once a missing value appears), so
   explicit dtypes make the read deterministic and usually cut memory several-fold.
6. **Write outputs atomically.** Write to a temporary file in the destination directory,
   flush and `os.fsync`, then `os.replace(tmp, final)`. The rename is atomic only on the
   same filesystem, which is why the temp file lives next to the target. A reader never
   sees a half-written CSV, and a crash leaves either the old file or the new one.
7. **Probe and provision the environment in the first minutes.** Before committing to a
   method, check what is actually installed (`python -c "import x"`, `which`, the venv's
   `pip list`, the compiler, the interpreter version) and whether the network is reachable.
   A container can ship an empty virtual environment, a language toolchain with no
   scientific stack, or a reader missing for the file format you were handed. Install what
   you need while you still can, pin it, and vendor anything a later offline step will
   need; if a package is unavailable, choose a method the environment supports rather
   than discovering the gap an hour in. A pinned version carries its dependencies'
   constraints: a Bioconductor package version belongs to one Bioconductor release,
   which belongs to one R series, so a named tool goes into its own environment
   (`micromamba create -n <tool> -c conda-forge -c bioconda <tool>=<version>`) rather
   than onto the system interpreter. A denied download or a failed install is a
   decision point, not a retry: fall back and disclose, or install another way. Note
   the probe result, since it decides the plan. Before writing your own version of
   something a supplied tool is supposed to do, show that the tool does not do it: list
   its plugins, modules or subcommands, read its help, run it on a case whose answer you
   know. Re-implementing by hand is the expensive branch and it is usually wrong here,
   because a grader built on that tool compares against the tool's output and not
   against yours; a failed download of the tool's own reference data is a reason to
   look for that data locally, not a licence to reconstruct the rules from memory.
8. **Target the environment that will re-execute, not this one.** Write down its CPU
   count, memory, wall-clock limit and whether it has network. Test under those limits:
   `taskset -c 0-1`, `ulimit -v`, `timeout 30m`, or a container with `--cpus` and
   `--memory`; run once with network disabled (`unshare -n` on Linux, or unset proxies
   and confirm nothing downloads). Pin dependency versions; no `pip install` or model
   download at run time when the target is offline; vendor small resources next to the
   code.
9. **Spend metered and single-use resources on a plan.** Some resources are consumed by
   calling them: a scoring or evaluation service with a quota, an experiment round, a
   fabrication or assay batch, a submission endpoint that accepts one answer, a paid API.
   Before the first call, find the limit, write down how many calls you get and what each
   one must buy you, and rehearse the call end to end against a local stub or a cheap case
   so the real one is not the first time the code path runs. Log every consumption with
   what it returned. Treat "one batch" as literally one; there is no rerun.
10. **Log commands with exit codes.** Scripts start with `set -euo pipefail`; each command
   that contributes to a reported number is appended to a run log with its exit code and
   duration (`cmd 2>&1 | tee -a run.log; echo "exit=${PIPESTATUS[0]}" >> run.log`). A
   silent failure in step three is the usual explanation for a wrong number in step nine.
11. **Rerun clean before finishing.** Delete derived outputs or use a fresh directory, run
   the final pipeline from raw inputs to final artifacts once more under the target limits,
   and compare with the numbers you are about to report. Time it. If it exceeds the
   budget, that is a defect to fix, not a footnote. Skip only when the run is measured in
   hours and say so.
12. **Never leave placeholders.** No `TODO` values, no `NaN` where a number is due, no empty
   files created to be filled later. When a value cannot be computed, the output states
   why in the place the value would appear, and the report says the same.

## Snippets

```python
import os, tempfile

def write_atomic(path: str, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".tmp-")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())  # rename alone does not force the bytes to disk
    os.replace(tmp, path)  # same filesystem, so the swap is atomic
```

```bash
# Thread caps must be exported before Python imports numpy or torch.
export OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 NUMEXPR_NUM_THREADS=2
export PYTHONHASHSEED=0
timeout 30m taskset -c 0-1 python pipeline.py --seed 0 2>&1 | tee -a run.log
echo "pipeline exit=${PIPESTATUS[0]}" >> run.log
```

## Workflow

- [ ] Target limits written down (CPU, memory, wall-clock, network).
- [ ] Seeds and thread variables set at the top of the entry point.
- [ ] Long step dispatched with `compute_job start`; artifacts declared; its wake awaited, not polled.
- [ ] Large inputs read in chunks with explicit dtypes; peak memory measured
      (`/usr/bin/time -v` on Linux, `resource.getrusage` in Python).
- [ ] Every output written through a temp file and `os.replace`.
- [ ] `run.log` holds each command with its exit code and duration.
- [ ] Clean end-to-end rerun under the target limits; numbers match the report.
- [ ] Every output file is non-empty and was parsed back once before delivery.

## Sources

- Python `os.replace` and `os.fsync`: https://docs.python.org/3/library/os.html
- pandas `read_csv` (`dtype`, `usecols`, `chunksize`): https://pandas.pydata.org/docs/reference/api/pandas.read_csv.html
- NumPy `memmap` and `load(mmap_mode=)`: https://numpy.org/doc/stable/reference/generated/numpy.memmap.html
- PyTorch reproducibility notes: https://pytorch.org/docs/stable/notes/randomness.html
- OpenMP environment variables (`OMP_NUM_THREADS`): https://www.openmp.org/spec-html/5.0/openmpch6.html
- threadpoolctl: https://github.com/joblib/threadpoolctl
- Linux cgroup v2 (`cpu.max`, `memory.max`): https://docs.kernel.org/admin-guide/cgroup-v2.html
- Bash `set` builtin and `PIPESTATUS`: https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html
