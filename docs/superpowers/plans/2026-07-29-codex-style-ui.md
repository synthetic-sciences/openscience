# Codex-style OpenScience UI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn OpenScience into a calm, Codex-style research workspace while preserving every research capability.

**Architecture:** Keep the existing SolidJS workspace, stores, routes, semantic
theme tokens, and tool components. Simplify the shell in reviewable batches:
first the navigation frame, then the start surface and conversation, then the
contextual research inspector and secondary workbenches. Progressive disclosure
replaces permanent chrome; no backend or Atlas changes are required.

**Tech Stack:** SolidJS, TypeScript, existing `@synsci/ui` primitives, CSS theme
tokens, Bun tests, Playwright browser tests.

## Global constraints

- Work only on `openscience/ui-changes`; keep one open PR and never merge it.
- Preserve sessions, files, skills, artifacts, Atlas, evidence, compute,
  terminal, settings, themes, and keyboard access.
- Do not add a UI framework, icon package, gradient, heavy shadow, or npm
  production release.
- Keep `AUDIT.md` and `openscience-starters/` untracked and untouched.
- Write and run the focused failing test before every production behavior change.
- Push cohesive batches after focused tests, typecheck, formatting, and browser
  verification pass.

---

### Task 1: Quiet workspace shell

**Files:**

- Modify: `frontend/workspace/src/pages/session.tsx`
- Modify: `frontend/workspace/src/atlas/AppHeader.tsx`
- Modify: `frontend/workspace/src/styles/atlas.css`
- Test: `frontend/workspace/src/pages/session-shell.test.ts`
- Test: `frontend/workspace/e2e/research-shell.spec.ts`

**Interfaces:**

- Consumes: `uiStore`, `centerTabs`, existing route parameters, and session CRUD
  callbacks.
- Produces: the same session route with a quieter header, rail, and document bar;
  no store or route signature changes.

- [ ] Write a source-contract test requiring semantic shell class names and
  proving the old repeated wordmark/header divider composition is absent.
- [ ] Run `bun test frontend/workspace/src/pages/session-shell.test.ts` and
  confirm it fails on the current shell.
- [ ] Replace the crowded header with the workspace title, rail toggle, command
  search, tools entry, and overflow actions.
- [ ] Restyle the session rail and document bar with flat surfaces, reduced
  border density, and sentence-case copy.
- [ ] Add Playwright coverage that creates a session and reaches Files, Skills,
  Settings, and the command palette from the simplified shell.
- [ ] Run the focused test, workspace typecheck, format check, and Playwright
  spec.
- [ ] Commit and push the shell batch to the permanent UI PR.

### Task 2: Focused new research surface

**Files:**

- Modify: `frontend/workspace/src/components/session/session-new-view.tsx`
- Modify: `frontend/workspace/src/components/session/research-launchpad.ts`
- Modify: `frontend/workspace/src/styles/atlas.css`
- Test: `frontend/workspace/src/components/session/research-launchpad.test.ts`
- Test: `frontend/workspace/e2e/research-launchpad.spec.ts`

**Interfaces:**

- Consumes: existing model state, starter creation endpoint, worktree selection,
  `centerTabs`, and `PromptInput`.
- Produces: the same starter/workflow actions through a compact progressive
  disclosure surface.

- [ ] Write failing tests for the compact primary actions and hidden detailed
  workflow catalog.
- [ ] Run the focused tests and confirm the missing compact surface is the
  failure.
- [ ] Put the research question, guidance, and composer first; collapse readiness
  into one actionable status.
- [ ] Replace starter and workflow card grids with concise rows and a “Browse
  workflows” disclosure.
- [ ] Verify starter creation, model-settings routing, worktree selection, and
  workflow prompt insertion in Playwright.
- [ ] Run focused tests, typecheck, format, and browser checks.
- [ ] Commit and push the start-surface batch.

### Task 3: Conversation and composer calmness

**Files:**

- Modify: `frontend/workspace/src/pages/session.tsx`
- Modify: `frontend/workspace/src/components/prompt-input.tsx`
- Modify: `frontend/workspace/src/styles/atlas.css`
- Test: `frontend/workspace/e2e/session-composer.spec.ts`

**Interfaces:**

- Consumes: the existing prompt submission, attachment, model, agent, effort,
  permission, and revert APIs.
- Produces: unchanged prompt behavior with a lower-noise control hierarchy.

- [ ] Add a failing browser test for the intended primary/secondary composer
  controls and keyboard behavior.
- [ ] Run the spec and confirm it fails on the current control hierarchy.
- [ ] Increase transcript whitespace and readable measure; remove decorative
  turn chrome that does not convey state.
- [ ] Keep attachment, model, and send visible; move lower-frequency controls
  behind one options control without changing their underlying actions.
- [ ] Verify submit, multiline entry, attachments, stop, undo/revert, model
  selection, and keyboard focus.
- [ ] Run browser regression, typecheck, and format.
- [ ] Commit and push the conversation batch.

### Task 4: Contextual research inspector

**Files:**

- Modify: `frontend/workspace/src/atlas/RightPane.tsx`
- Modify: `frontend/workspace/src/atlas/store/ui.ts`
- Modify: `frontend/workspace/src/styles/atlas.css`
- Test: `frontend/workspace/src/pages/session-shell.test.ts`
- Test: `frontend/workspace/e2e/research-inspector.spec.ts`

**Interfaces:**

- Consumes: existing right-pane tabs, artifact context, terminal command queue,
  and persisted width.
- Produces: one collapsed Tools affordance and the unchanged tab implementations
  when expanded.

- [ ] Add failing tests that require the inspector to start closed and expose one
  collapsed Tools control.
- [ ] Run the tests and verify the current multi-icon rail causes the failure.
- [ ] Replace the icon stack with one quiet Tools entry while keeping automatic
  artifact and terminal opening.
- [ ] Simplify the expanded tab/header treatment and preserve resize,
  persistence, close, and overlay behavior.
- [ ] Verify Atlas, Evidence, Compute, Terminal, artifact inspection, and mobile
  dismissal in Playwright.
- [ ] Run focused tests, typecheck, format, and browser regression.
- [ ] Commit and push the inspector batch.

### Task 5: Secondary workbench polish

**Files:**

- Modify: `frontend/workspace/src/atlas/FileExplorer.tsx`
- Modify: `frontend/workspace/src/atlas/SkillsPage.tsx`
- Modify: `frontend/workspace/src/components/dialog-settings.tsx`
- Modify: `frontend/workspace/src/styles/atlas.css`
- Test: relevant existing file, skills, settings, and science viewer E2E specs.

**Interfaces:**

- Consumes: existing file, skill, settings, notebook, manuscript, data, and
  scientific visualization APIs.
- Produces: visually consistent secondary surfaces with unchanged domain logic.

- [ ] Add the smallest failing contract for each surface before changing it.
- [ ] Flatten unnecessary cards, normalize headings and toolbars, and improve
  empty/loading/error states.
- [ ] Verify `.ipynb`, `.xyz`, PDB/SDF, genomic, data-table, manuscript, and
  artifact flows remain usable from the simplified shell.
- [ ] Check desktop/mobile and light/dark visual states plus console errors.
- [ ] Run the complete workspace browser suite, typecheck, format, builds, and
  smoke checks.
- [ ] Commit and push the polish batch; keep the PR open and unmerged.
