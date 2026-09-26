---
name: submitted-code
description: Writes code that survives being re-executed by someone else on inputs you never saw, targeting the grader's or collaborator's runtime rather than your own, with one self-contained entry point using only the libraries the specification names, no reliance on packages you installed or files you cached during development, no network, no sibling imports, no state carried between calls, output written only where the contract says, and a rehearsal that reruns the artifact from a clean directory as an unprivileged process on mutated inputs within the stated time and memory caps. Use whenever the deliverable is a program, module, model file or callable that a verifier, reviewer, pipeline or colleague will run on hidden or future data; a script you run once yourself to produce a table does not need it.
summary: "Self-contained entry point, declared libraries only, stateless, time-boxed; rehearse on mutated inputs in a clean sandbox."
category: core
role: support
allowed-tools: [Read, Bash, python, compute_job]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Submitted code

Code that produces the right answer on your machine and fails on the grader's is the most
expensive kind of wrong: the science was right and the score is zero. The asymmetry is
simple. You developed with everything you installed, every file you had staged, your
working directory, your thread count and your Python. Whoever re-runs your artifact has
the base image, the inputs the contract names, a clean directory and a timer.

Write for that second environment from the first line.

## The contract to extract first

Before writing the entry point, read the specification and write down, as a checklist:

- **Entry point**: exact path, file name, function or CLI signature, argument order and
  types, return type. A function that must return a plain list does not return a NumPy
  array; a CLI that must accept a path does not also require a flag you invented.
- **Libraries you may rely on**: only what the specification or the base environment
  names. Everything else is unavailable at re-execution even if `pip install` succeeded
  for you during development.
- **Inputs**: which paths are passed in, which are read-only, and what may differ from
  the examples you were given (size, layout, identifiers, parameter ranges, number of
  cases).
- **Outputs**: exact paths, formats and whether extra files in that directory are
  tolerated.
- **Limits**: wall clock and CPU per call or per case, memory, thread count, whether the
  network exists, and which user the process runs as.

## Rules

1. **One self-contained artifact.** The entry point imports the standard library, the
   declared third-party libraries and nothing else of yours. No sibling modules, no
   helper file next to it, no configuration or parameter file unless the contract lists
   it, no data file you wrote during development. If constants were fitted, embed them
   as literals in the file.
2. **Nothing you installed counts.** Treat every dependency you added during development
   as absent. If a method needs a package the environment does not have, either implement
   the part you need directly or choose a method the environment supports; note the choice
   in the write-up.
3. **No network, no side channels.** No downloads, no sockets, no subprocesses spawning
   compilers or fetching data, no `ctypes` loading of libraries you built, no reads
   outside the arguments you were given, no writes outside the declared output path.
   Sandboxes commonly block these outright, and a blocked call ends the run.
4. **Stateless and deterministic.** Each invocation stands alone: no cached globals from
   a previous call, no reliance on invocation order, no temporary files left behind. Seed
   every random draw from a seed the contract supplies or a fixed constant, and keep the
   computation reproducible across runs.
5. **Frugal with threads and memory.** Assume one or two cores and the stated memory, not
   your machine. Cap BLAS and OpenMP threads inside the artifact
   (`OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, `MKL_NUM_THREADS`) rather than relying on
   the caller, and stream large inputs instead of loading them whole.
6. **Fit the per-call budget with headroom.** Time the slowest realistic case and aim for
   a fraction of the cap; a pure-interpreter loop that is correct but two times over the
   limit scores the same as a wrong answer. Where the limit forces it, vectorize, precompute
   a table, or write the hot kernel in a compiled language the environment already has.
   When the requirement is *relative* — within some factor of a reference implementation,
   or better than a named baseline — time that reference yourself on the same machine and
   treat the ratio as part of correctness, not as polish.
   When the real inputs exist only at evaluation — data supplied through a callback, an
   oracle linked in by the grader, a hidden file — and an accuracy bar must be met on
   them, the headroom is not idle safety margin, it is the only time anyone ever computes
   on the real problem. Any setting you freeze during development (a resolution, a step
   count, an iteration cap) was chosen against cases you made up. Put the convergence
   check inside the artifact: solve at increasing settings, compare successive answers on
   the real inputs, stop when the change is well under the bar or when a clock the code
   keeps itself says the budget is nearly spent, and return the finest answer reached.
7. **Respect declared prohibitions literally.** A specification that bans a library, a
   module, a language feature or a class of tactic is often enforced by a scan that runs
   before your code does, so a single banned import fails the work outright however good
   the result. Collect the ban list with the rest of the contract and grep your final
   artifact for each item, including indirect imports pulled in by a helper.
8. **Fail informatively inside the contract.** Raise the exception type the specification
   names, or return the documented sentinel; never exit the process, never print to stdout
   when the contract expects a return value, and never swallow an error into a plausible
   wrong answer.

## Rehearsal before you finish

Passing on the example inputs is necessary and never sufficient. Rehearse:

1. **Clean copy.** Copy only the artifact (and the files the contract names) into an empty
   temporary directory, and run it from there with the pinned interpreter. Anything that
   breaks here was a hidden dependency on your workspace.
2. **Mutated inputs.** Rerun on inputs you perturb yourself: renamed identifiers, shuffled
   row order, a different size or geometry, a case at the edge of the stated parameter
   range, an input with a legal but unseen structure. Generalizing beyond the visible case
   is the point of the exercise.
3. **Restricted process.** Run it as a subprocess with a wall-clock timeout, reduced
   threads, the network unavailable and, where the platform allows, an unprivileged user
   and a read-only input directory. Measure peak memory.
4. **Repeat.** Run it twice on the same input and compare the outputs byte for byte, or
   within the stated tolerance, to catch order and seeding bugs.

Record what you rehearsed and the measured time and memory alongside the deliverable, so
the reviewer sees the artifact was tested against its contract and not only against the
example.
