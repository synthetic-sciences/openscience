---
name: acceptance-checks
description: Turns the acceptance criteria a task states into executable checks and runs them against the finished outputs before delivering, rather than trusting that a correct-looking analysis satisfies them; rehearses the hidden condition when the grader scores unseen instances from a described family; treats a stated formula, update rule or predicate as the oracle to implement first; so that every stated path, schema, unit, rounding rule, ordering, tolerance, threshold, named method and version, prescribed heading and self-consistency formula becomes a small test, any checker the task ships is run as the exit criterion, derived quantities are recomputed from the primitives, and conventions such as units, signs, coordinate frames and code tables are transcribed into named functions with hand-checked cases. Use whenever a task states how the result will be judged mechanically, ships a validation script, or specifies output formats and tolerances; a report a reader grades needs only its headings and files checked once, and free-form exploration with no stated criteria does not need it.
summary: "Turn stated criteria into runnable tests; when the grader scores unseen instances, synthesise the described family and measure transfer; a stated formula or update rule is the oracle to implement first; run any shipped checker; verify conventions before delivering."
category: core
role: support
allowed-tools: [Read, Bash, python, Grep, Glob]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Acceptance checks

Most specified work is judged mechanically: a script opens your files, reads named
columns, compares numbers to tolerances and stops at the first violation. When a task
tells you how it will be judged, it has handed you the test suite. Write it down, run it,
and only then deliver.

The failure this prevents is not sloppiness. It is a correct analysis delivered with a
column named `sample` where the specification said `sample_id`, an angle in degrees where
radians were required, or a fraction that sums to 0.999 where exactly one was expected.

When the output is a report a person or a model will read and grade (a trace, a
write-up with prescribed headings), there is no mechanical judge to anticipate. The
whole check is that the prescribed headings and files exist and that the numbers in
the prose match the tables and the answer file: five lines, run once at the end. Do
not build the report from a generator script, write validators that count its code
blocks, or scan it for placeholder words; none of that is graded, and the minutes go
to the analysis the grader does read. For such a task the rest of this skill does not
apply.

## Build the check list from the specification

Read the instruction and every file it points to — schema, README, format description,
grading notes, example output, validation script — and extract:

- **Paths and files**: exact absolute paths, file names, which directory, whether extra
  files are allowed there, and whether a real file is required (not a symlink or a
  directory).
- **Structure**: column names and their order, key sets, array shapes and dtypes, index
  columns, required rows or identifiers, sort order, header text, encoding, delimiter.
- **Values**: units, scale factors, sign conventions, coordinate frames, allowed
  vocabularies and code tables, ranges, and how missing values are expressed.
- **Templates and example strings**: when the format shows a string ("`<a>; <b>; <c>`",
  an example row, a bracket notation), the separator with its spaces, the case, the
  bracket style and the field order are the format. Build the string from the template
  and compare it byte for byte with the example; `a;b` is not `a; b` to an exact match.
- **Number formatting**: decimal places, significant figures, and whether trailing zeros
  must be kept — `0.250` and `0.25` are the same number and different strings, and a
  checker that counts significant figures or matches a notation pattern rejects the
  second. Format with an explicit format string rather than by printing a float.
- **Numeric criteria**: tolerances (absolute or relative), thresholds, metrics and their
  exact definitions, how ties are broken, whether every case must pass or a mean suffices.
- **Self-consistency**: statements of the form "the totals must equal", "the fractions
  sum to one", "the reported value must match the file", "the durations follow from the
  timestamps".
- **Named methods**: the tool, version, language, contrast direction, filter, reference
  build and feature universe the task prescribes. When the reference numbers come from a
  specific pipeline, the method is part of the contract: a valid alternative shifts scale
  and row membership and is scored as wrong. Run the named tool at the named version;
  where that is impossible, disclose the substitute and its known differences in the
  methods file rather than swapping silently.
- **Judged text**: when a reader or a rubric grades the written trace or report alone,
  the check list includes every prescribed heading verbatim, one numbered step with its
  code and its intermediate number for each clause of the question, and named entities
  where the question names them. What is not in the text did not happen.

## The grader you cannot see

Most graded work is scored on instances you never see: further systems drawn from a
described family, held-out packets, unseen plates and layouts, a private test set, a
hidden condition the instruction describes but does not ship. The visible data are
development data; the number is transfer. Three rules follow.

- **Rehearse the hidden condition.** When the instruction describes the family the
  grader draws from — parameter ranges, noise model, grid sizes, layouts, class
  balance, conventions — build instances from that description yourself, with the
  stated generator or an honest imitation of it, run your method on them and measure
  the error the grader will measure. Tune on the visible packet alone and you have
  measured nothing; a method that reproduces the visible episodes to machine precision
  and fails the first unseen system is the commonest way a good run scores zero. Where
  the family cannot be synthesised, hold out from the visible data the way the grader
  holds out (different samples, same process) and report that number, not the fit.
- **The stated formula is the oracle.** When the instruction states a discrete update,
  a mask rule, a scoring formula, a predicate, a normalisation or a functional, implement
  it verbatim as its own function before anything else, confirm it reproduces every
  reference value the task ships, and grade every candidate with it. A method that fits
  the data without passing the stated formula is wrong by construction, however good the
  residuals look. Where a `SPEC.md`, a schema or an API contract exists, one test per
  clause precedes the implementation.
- **Cover the corners of every stated range.** A described family comes with
  ranges (a speed in [0.8, 1.2], counter lengths 1 to 8, a threshold at 0.2–0.8 of
  another); the grader's instances sit anywhere in them, including the ends. Your
  constructed suite samples every range at both ends and in the middle, in
  combination, and the awkward combinations (the shortest counter with the highest
  threshold, the smallest grid with the longest horizon) are the ones to keep.
- **A graded entry point never raises.** When the grader imports your function and
  calls it on its own inputs, an exception is a zero for that instance and often for
  the run; a fallback answer (the best feasible fit, the nearest valid state, the
  default branch) can still pass most gates. Every graded function catches its own
  failure paths, returns a valid object of the stated shape, and logs the fallback,
  and your rehearsal includes inputs built to trigger those paths.
- **Every gate, every packet, every rare class.** "All gates must pass", macro-averaged
  F1 and per-packet floors mean the worst case is the score. Name the rare classes and
  the hardest packet before you start, and check them separately at the end; a method
  that is right on average and wrong on one of them has failed.
- **A rehearsal that fails the gate is not done.** When your own constructed cases
  miss the stated threshold on any case and budget remains, the failing case is the
  case the grader holds: keep going. Change the method family rather than the tuning
  (a worker per candidate method on the same constructed suite, best max-error wins),
  and stop only when every constructed case clears the gate with margin or the
  budget is spent. Reporting "98 of 101 cases pass" with hours left is the same
  score as reporting none.
- **An undisclosed bar has no early finish.** When the pass condition is a comparison
  you cannot run — at or below a reference total the grader holds, faster than a
  reference by a factor you cannot time, within a margin of a hidden baseline — a
  result that is merely correct is not yet a result, and "cannot be confirmed here"
  is not a reason to stop. The time budget is the stopping rule: profile where the
  metric is spent, take the largest term, change the algorithm before its constants,
  and keep going while the remaining time can still move the number. Report the
  metric's trajectory (what it was, what it is now) rather than that it is unverified.
- **A written protocol is computed before it is looked at.** When labels follow a
  protocol (class definitions, precedence rules, edge cases) over measured series or
  images, turn each criterion into a computed feature first — the drop rate, the
  timing, the residual, the presence of an outlet, whatever the protocol names — and
  label by the rules from those features; use visual review to settle the cases the
  features leave ambiguous, not to label from scratch. Eyeballing hundreds of frames
  is the least reliable and most expensive reading there is, and it is where the
  rare classes get lost.
- **Audit before every irreversible step.** Advancing a stage, submitting a decision,
  locking a trajectory, finalising an environment: the contract's rules and the
  shipped self-check are run on that step *before* it is taken, because the audit you
  run afterwards can only report what you can no longer amend. A run that finds its
  own violations after locking has the same score as one that never looked.
- **A graded directory holds exactly the outputs.** When the grader reads a directory,
  every file in it is part of the submission: a plot, a log, a notes file, a copy of the
  instruction or a stray temp file can fail a strict gate ("no other files", a file count,
  a recursive scan for the benchmark's canary line). Keep scratch work elsewhere, list the
  directory before finishing, and remove what the instruction did not ask for.
- **When wrong findings cost points, precision is the method.** A score that subtracts
  for unsupported or decoy findings (a false alarm, an extra row, an acute finding the
  images do not show) is lost by reporting everything plausible. Report a finding only
  when a named, reproducible signal supports it above the noise you measured on cases
  where nothing is wrong; state the clean result when that is what the data show.
- **A scarce oracle is spent like money.** When checks against the real system are
  limited (a probe budget, a submission count, a paid query quota), exhaust the offline
  checks first, spend one probe per failure class rather than per instance, re-verify a
  fix on the class it was meant for, and keep a reserve for the final configuration:
  the run that ends with the budget gone and the target "unverified" has spent it on
  the wrong things.
- **Labels judged against an expert are labelled twice.** Two independent annotators
  and your adjudication from the protocol (see `delegation`); one reader's blind spots
  are scored at full weight.

## Rules

1. **One script, run last.** Put the checks in a single script that takes the output
   directory and prints one line per check with pass or fail. Run it as the final step
   before you report. Keep it with the work; it is evidence. An edit to any output
   after the script ran voids that run: run it again and report only the numbers from
   the final run. A spot check on one case, or a schema check, is not the script; the
   number you report for a file is the number measured on the file as it is now.
2. **Run the shipped checker.** If the task provides a validator, linter, policy check,
   self-test or example runner, running it successfully is the exit criterion, not an
   optional extra. Read what it actually checks; it usually names conventions the prose
   glossed over.
3. **The check runs as the grader will.** A fresh process, the environment's default
   settings and backends, the untouched model or schema definitions, the files as they
   are on disk. When the artifact fails under those conditions, the artifact changes.
   A check that was adjusted until it passed (a backend disabled, a tolerance widened, a
   case skipped) is not a check, and the grader will not have made the same adjustment.
4. **Recompute derived values from the primitives.** Any number you report that follows
   from another output — a total, a ratio, a duration, a goodness-of-fit, a count — gets
   recomputed by the check script from the files themselves, with the definition the task
   gave, not the value your pipeline remembered.
5. **Transcribe conventions into named functions with tests.** Unit conversions, scale
   factors, frame rotations, code lookups, rounding rules: each becomes a small function
   with a hand-worked case you verified against the specification. Conventions asserted
   only in a comment are the ones that silently invert a sign. An option the task pins on
   a tool (`No_Collapse`, a seed, a metric, a normalisation) also fixes the preprocessing
   that option governs: do not perform by hand what the option turns off, and do not
   tidy the supplied table (deduplicate, average, drop) unless the task says to — with one
   exception that is not tidying: what the tool's input format itself requires. A format
   that needs unique identifiers gets them, resolved in the tool's input only and by a rule
   you state (keep the canonical record, say), never in your own statistics; a tool that
   accepts a malformed input with a warning has not validated it, it has made a choice for
   you that you did not read.
   Where the task names what to hand a named tool — these columns, this matrix, this file —
   hand it exactly that, and do not transform it first because the field usually would.
   That reading governs the tool's input and nothing else. A statistic you compute
   yourself still follows its own convention, so the same task routinely wants the
   supplied columns fed to the tool *and* the transform applied to the test you run by
   hand (intensities, for instance, are compared on the log2 scale whoever computes them);
   a literal reading carried into your own statistic is how a heteroscedastic t-test on
   raw intensities halves a gene set. Where the two readings change a graded answer,
   compute both, keep the one each step's own words select, and report the other.
6. **Check the boring properties.** Existence, non-emptiness, parseability, no `NaN` or
   infinities where finite numbers are required, no placeholder text, no duplicate
   identifiers, row counts, complete coverage of the required cases, and files written
   where they were asked for rather than beside them. Deliverables are real files, not
   symlinks into a scratch directory, and they hold results rather than copies of the
   task description, your notes or logs. Where the output location is specified, leave
   nothing else in it.
7. **Match the strictness to the statement.** If the task says exact, compare exactly; if
   it gives a tolerance, compare within it and report the margin. Knowing you passed by a
   hair is information worth having before you deliver. When the task defines a word —
   a "run" has flight phases and alternating single stance with no double support, a
   "converged" fit has a stated tolerance — every clause of that definition is an
   assertion on the output, because the grader encodes it that way; a dynamics residual
   or a distance target does not stand in for the gait the task described.
8. **Treat a partial pass as a failure when the criteria are conjunctive.** Where several
   thresholds, instances, cases or scenes must all clear, five of six is the same as none:
   keep working on the ones that fail rather than reporting the ones that pass. The
   stopping rule is every criterion cleared with margin, not an output that looks
   plausible. Say which criterion is closest to its bound when you finish.
9. **Answer exactly the set the criterion asks for.** When the task says every instance,
   all findings or one row per case, enumerate candidates systematically and check the
   count; when extras are penalized, drop the ones you cannot support. Hedging costs
   twice over: a vague, generic or deliberately empty answer is scored as wrong, and an
   unsupported extra can cancel a correct one. Where a selection rule is stated ("the
   largest consistent set", "the closest match"), apply it mechanically and record the
   alternatives you rejected. A qualifier on what you are asked to list is a filter on
   what you ship, not a description of what you found: an item your own annotation
   places outside the requested kind is dropped however genuine it is, and every count
   you report is taken after that exclusion. Read your own category column against the
   request's words before writing the set out — a field in your own output that
   contradicts the request's qualifier is a check you did not run.
10. **When a criterion is ambiguous, satisfy both readings if you can**, and say which you
   assumed. Where both are impossible, state the interpretation you chose and why.

## Reporting

Keep the check output with the deliverables and summarize it in one line: what was
checked, what passed, and any margin that was uncomfortably small. If a check fails and
you cannot fix it in the time available, say exactly which criterion fails and by how
much rather than delivering silently.
