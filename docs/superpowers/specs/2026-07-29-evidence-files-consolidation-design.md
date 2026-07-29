# Evidence and Files consolidation design

## Intent

Opening Evidence must never blank, reload, or destabilize the research
workspace. OpenScience will use three unambiguous concepts:

- **Files** are the local project inputs and outputs a researcher can open.
- **Evidence** is the recorded lineage between sources, runs, outputs, claims,
  and reviews.
- **Details** is contextual information about the currently open file.

This design keeps Evidence as a focused provenance surface. It does not put
every local file into the provenance graph or recreate the removed Artifacts
gallery.

## Approaches considered

### Selected: separate surfaces with one vocabulary

Keep the local filesystem in Files, the provenance graph in Evidence, and the
selected-file inspector in Details. Relabel ambiguous entry points and explain
the relationship in Evidence's empty state.

This is the smallest and clearest design. It remains usable in repositories
with thousands of local files while preserving the meaning of explicit
scientific lineage.

### Rejected: local files inside Evidence

Adding a Files/Lineage switch to the narrow Evidence pane would recreate the
removed Artifacts tab, duplicate the Files surface, and make large repositories
noisy and slow.

### Rejected: every file becomes evidence automatically

Converting all discovered files into provenance nodes would blur the difference
between “exists in the workspace” and “supports or was produced by a recorded
research step.” It would also require backend data-model and migration work
outside this UI batch.

## Information architecture

### Files

The Files tab remains the only browser for local project content. User-facing
counts and actions that currently say “artifacts” but open the filesystem are
renamed to “files.” The retired Artifacts gallery is not restored.

### Evidence

The right-pane Evidence tab remains a project provenance graph backed by the
existing `/provenance` API. Its node kinds remain unchanged for compatibility,
but the interface uses “outputs” where “artifacts” would be confused with the
old file browser.

The empty state says that no lineage has been recorded yet, that ordinary local
content remains available in Files, and that notebook runs or research agents
can record sources, runs, outputs, claims, and reviews.

### Details

The contextual inspector for the active file is presented as **Details**.
Internal component and API names continue to use `artifact` where that is the
established domain model; only ambiguous product-facing labels change.

## Evidence loading and refresh behavior

Evidence receives a pane-scoped Suspense boundary. Its initial request shows a
small loading state inside the right pane, but the header, session rail,
active document, composer, and other workspace state remain mounted and
visible.

The fixed 2.5-second polling loop is removed. Evidence loads on first visit and
can be refreshed explicitly. Returning to Evidence from another tool tab
triggers one refresh; hidden panes never poll in the background.

Successful data remains visible during a refresh. A refresh failure is rendered
inside Evidence with the previous graph retained when available. It never
escalates to the route-level loading screen.

## Components and boundaries

- `RightPane` owns the local loading boundary because it owns the lifecycle of
  Atlas, Evidence, Compute, and Terminal.
- `EvidenceGraph` owns provenance fetching, graph rendering, refresh, inline
  empty/error states, and evidence-specific terminology.
- `NewSessionView` owns the local file count on the research launchpad and
  labels it as Files.
- `ArtifactInspector` remains the implementation for contextual file metadata,
  while its visible entry point becomes Details.
- The unused `ArtifactGallery` implementation is removed; repository search
  confirms that no route imports it.

No Atlas gateway or backend API change is required.

## Failure handling

- Slow initial provenance requests show only the Evidence pane fallback.
- A failed initial request shows an inline Evidence error with a retry action.
- A failed refresh does not erase a previously loaded graph.
- An empty graph is a valid state, not an error.
- Closing or switching the right pane preserves other workspace state.

## Verification

Implementation starts with failing regression coverage:

1. A delayed real provenance response proves that opening Evidence keeps the
   session workspace visible and confines loading to the right pane.
2. Evidence browser coverage proves the empty state distinguishes Files from
   recorded lineage.
3. Request observation proves an open Evidence pane does not poll every 2.5
   seconds.
4. Launchpad coverage expects “files,” not “artifacts,” for the filesystem
   count.
5. Contextual-inspector coverage expects a Details entry point.

Then run:

- Focused frontend unit and Playwright tests.
- Frontend typecheck and production build.
- Full workspace Playwright regression.
- Backend Bun suite because the packaged application includes the server.
- Local packaged npm-test installation and browser inspection in light and
  dark themes.
- Console error and request checks while opening, closing, refreshing, and
  reopening Evidence.

## Branch and release contract

- All changes stay on `openscience/ui-changes` and its standing pull request.
- The pull request is not merged without a new explicit user instruction.
- No npm production or `latest` workflow is triggered.
- After the complete batch passes locally and in CI, publish one batched npm
  test-tag build, install it in the isolated test prefix, and verify the
  packaged localhost application.
