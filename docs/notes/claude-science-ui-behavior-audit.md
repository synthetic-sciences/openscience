# Claude Science UI behavior audit

Observed on 2026-08-08 against these local reference surfaces:

- Project shell: `http://localhost:8765/projects/proj_41efbe3a56fc`
- Completed four-kernel reference: `http://localhost:8765/projects/proj_41efbe3a56fc/frames/4654d750-f605-4d90-a749-0d6a9ecf2615`
- Fresh-session reference: `http://localhost:8765/projects/proj_68013d68e83c`
- Comparison prompt: `start up multiple analysis jobs for the titanic dataset across 4 kernels`

This is a behavior index, not a request to reproduce Claude branding. It records the interaction contracts that make the science workflow legible and maps them to OpenScience.

## 1. Project shell and navigation

| Surface            | Claude Science behavior                                                                                           | OpenScience contract                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Project identity   | Back control and project name anchor the shell.                                                                   | Keep project identity at the top of the sessions rail.                                                         |
| Primary navigation | New, Search, Customize, Files, and Compute use one compact type scale and icon rhythm.                            | Use the same typography as the sessions rail for every primary item, including Customize and settings content. |
| Session list       | Sessions are grouped by time, have a readable activity state, and expose row actions without taking over the row. | Preserve session titles and activity dots; keep utility controls visually secondary.                           |
| Open work          | Multiple sessions remain open as tabs.                                                                            | Session tabs may change while the right inspector remains project-scoped and mounted.                          |
| Density            | Dividers, labels, and counters are quiet; content carries the emphasis.                                           | Avoid oversized settings type, heavy borders, or card-on-card decoration.                                      |

## 2. Right-side workspace

| Surface        | Claude Science behavior                                                                        | OpenScience contract                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Independence   | The right strip survives session changes and can contain Files, Compute, and opened artifacts. | Inspector state is project-scoped, not owned by the selected session.                  |
| Tabs           | Files, Compute, and opened files coexist as closable tabs.                                     | Files and Compute remain side by side with chat and keep their own open-tab state.     |
| Split/merge    | The strip can merge back to one tab row or remain split.                                       | Narrow layouts must collapse gracefully without changing the underlying project state. |
| Direct opening | Artifact cards have an explicit open-in-split action.                                          | Every promoted artifact has `Open beside chat`; no Browse button is required.          |

## 3. Conversation activity ledger

| Surface               | Claude Science behavior                                                                                                | OpenScience contract                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Progress grouping     | Steps are grouped into summaries such as “Ran 3 commands” or “Saved artifacts.”                                        | Routine reasoning may remain in Show steps, but scientific code, outputs, figures, artifacts, and remote results are promoted outside it. |
| Step labels           | Each operation has a task label and a compact result summary such as lines of output, figure count, or artifact count. | Tool headers state language, kernel, state, and useful output identity.                                                                   |
| Live state            | Background cells visibly move through queued/running/finished/failed states.                                           | Named kernels, commands, and remote jobs poll into Compute while the turn is running.                                                     |
| Failures              | Failures stay visible and are followed by a short diagnosis and retry.                                                 | Preserve failed code/output in chat; retries appear as later cards rather than replacing history.                                         |
| Narrative checkpoints | The agent explains handoffs: kernels ready, a plot needs correction, outputs are being saved.                          | Final answers summarize the completed tracks, key metrics, artifact location, and cleanup state.                                          |

## 4. Code and output cards

| Surface              | Claude Science behavior                                                                  | OpenScience contract                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Default presentation | A step opens into a language/environment header, source, and separate output control.    | Notebook and R cards auto-open so code is never hidden behind Show steps.                                                          |
| Source height        | Long source remains contained inside the operation instead of dominating the transcript. | Show exactly five code lines in a vertically and horizontally scrollable source window; retain the complete source in that window. |
| Output               | Text output is visually separated from source.                                           | Text output is open by default and independently scrollable.                                                                       |
| Figures              | Figures appear immediately after the cell that produced them.                            | Inline notebook images stay visible even when text output is collapsed.                                                            |
| Identity             | The environment name is always visible.                                                  | Show the stable named kernel (`env titanic-quality`, etc.) in each card.                                                           |
| Completion           | Stopped workers get a compact lifecycle receipt.                                         | Render `Kernel stopped` cards and keep the source/results above them.                                                              |

## 5. Compute

| Surface         | Claude Science behavior                                                                                      | OpenScience contract                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host strip      | Memory, CPU, live-kernel count, and running count are always visible.                                        | Host totals combine local kernels, shell commands, and remote jobs. Unknown metrics render as unavailable, never fabricated zeroes.                |
| Project ledger  | Work is grouped by owning session with a current-session marker.                                             | Compute aggregates every session in the project and does not reset when the selected session changes.                                              |
| Kernel row      | Language, state, age/cell count, activity label, RSS, CPU, and stop action form one dense row.               | Live rows show named kernel, state/recovery text, uptime, RSS, cores, and Stop.                                                                    |
| Job row         | Long-running/background work stays visible independently of chat scroll.                                     | Shell commands and Modal/GPU jobs are first-class rows with command/target, resources, duration, status, output, artifacts, cleanup, and cancel.   |
| Completed work  | Claude commonly leaves idle kernels visible.                                                                 | OpenScience intentionally stops finished kernels, then keeps up to five recent local completion rows so the trail remains without wasting compute. |
| Manual creation | Claude exposes environment setup as part of agent work, not a user kernel launcher in the completed session. | Do not expose manual kernel creation. Kernels start only when an agent executes work.                                                              |
| Cleanup         | Claude exposes stop/kill per kernel but may leave kernels idle.                                              | The research agent must stop every named kernel after outputs and artifacts are verified. Remote cleanup warnings remain visible.                  |

## 6. Files and artifacts

| Surface              | Claude Science behavior                                                                                                      | OpenScience contract                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Automatic collection | Generated files appear without a Browse step.                                                                                | `save_file` promotes files into the project artifact store automatically.                                    |
| Grouping             | Artifacts are grouped by session and show a count and relative time.                                                         | Files is project-wide, groups by session, and marks artifacts created by the active run.                     |
| Grid/list            | Images get thumbnails; CSV cards show dimensions/schema; reports show rendered content; grid and list layouts are available. | Figures preview inline, text/Markdown renders in chat, and existing Files previews retain grid/list support. |
| Actions              | Open in split, download, and more-actions controls are adjacent to each artifact.                                            | Chat provides `Open beside chat`; Files owns project-level artifact actions.                                 |
| Naming               | Artifacts use meaningful names and the final answer links the consolidated report.                                           | Blank summaries fall back to filename; the agent is prompted to provide descriptive non-empty titles.        |
| Versioning           | Saved outputs are durable products of the session.                                                                           | Artifact cards show kind, version, size, and checksum; overwrites create durable versions.                   |

## 7. Scientific result quality

The reference run does more than execute code:

1. Finds or fetches a reusable dataset and saves it as an artifact.
2. Splits one request into distinct analytical remits.
3. Starts multiple real environments concurrently.
4. Creates publication-style figures, visually inspects them, and corrects layout or data bugs.
5. Retries infrastructure/library failures with a safer implementation.
6. Saves figures, tables, and a consolidated Markdown report.
7. Ends with numerical findings, methods, caveats, and cross-track interpretation.
8. Runs a reviewer that can point to an unsupported visual claim without discarding the otherwise valid result.

OpenScience's research prompt now requires at least two decision-useful figures for tabular analysis when supported, inline display, output validation, descriptive artifact summaries, a consolidated result, and worker cleanup. The exact comparison run produced four figures, three promoted tables, one report, a visible sklearn failure and scipy retry, and four stop receipts.

## 8. Responsive behavior

- The inspector is a container, not a fixed desktop canvas.
- At medium widths, session headers wrap before data rows become illegible.
- At narrow widths, the primary identity occupies the first row; metrics and controls wrap beneath it.
- Code and logs scroll inside their cards instead of widening the conversation.
- Artifact previews use the available width and preserve aspect ratio.
- Controls remain reachable; labels may compress, but state and stop/cancel actions do not disappear.

## 9. Intentional OpenScience differences

- Finished kernels are stopped automatically rather than left idle. Recent completion rows preserve visibility without retaining memory.
- Manual kernel creation is removed. The execution ledger describes real work; it is not a launcher.
- Compute also includes shell subprocesses and Modal/GPU jobs, which the reference surface did not expose in this exact local run.
- Project-wide Files and Compute remain stable while sessions switch, matching the requested cross-session workspace model.

## 10. Acceptance checklist

- [x] Exact prompt starts exactly four named managed kernels.
- [x] Four kernel rows are visible in Compute during execution.
- [x] Python source and output remain visible in chat while working and after completion.
- [x] Source is auto-open but capped to a five-line scroll window.
- [x] Figures display inline beside their producing cells.
- [x] Saved report, tables, and figures auto-appear in Files.
- [x] Artifact titles are meaningful and previews open beside chat.
- [x] Failed analysis is visible and can be retried without losing history.
- [x] Every named kernel stops after result verification.
- [x] Recent completed local work remains visible in Compute.
- [x] Modal/GPU jobs have live and recent-result rows with resources, logs, artifacts, cancel, and cleanup state.
- [x] The right workspace remains project-scoped across session changes.
- [x] Compute and artifact cards adapt at narrow container widths.
