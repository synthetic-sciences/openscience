# Evidence and Files Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Evidence from blanking or repeatedly refreshing the workspace while giving Files, Evidence, and Details distinct product meanings.

**Architecture:** Keep the existing `/file/artifacts` and `/provenance` contracts. `RightPane` contains the Evidence lifecycle and initial loading boundary; `EvidenceGraph` retains the latest successful graph and refreshes only on explicit user activity; launchpad and inspector entry points use the simplified vocabulary.

**Tech Stack:** SolidJS, TypeScript, Bun, Playwright, Vite, existing OpenScience server and npm test-publish workflow.

## Global Constraints

- All changes stay on `openscience/ui-changes` and PR #238.
- Never merge the pull request without a new explicit user instruction.
- Never trigger npm production or the `latest` dist-tag.
- Files is the only local project browser.
- Evidence is only the `/provenance` lineage graph.
- Details is the contextual inspector for the active file.
- Hidden Evidence panes never poll.
- Initial loading and failures stay inside the right pane.
- No Atlas gateway or backend API change.
- Preserve the user's untracked `AUDIT.md` and `openscience-starters/`.

---

### Task 1: Evidence lifecycle regression and fix

**Files:**
- Modify: `frontend/workspace/e2e/evidence-graph.spec.ts`
- Modify: `frontend/workspace/src/atlas/RightPane.tsx`
- Modify: `frontend/workspace/src/atlas/EvidenceGraph.tsx`

**Interfaces:**
- Consumes: `uiStore.rightPaneTab(): RightPaneTab` and the existing `GET /provenance?directory=...` response.
- Produces: `EvidenceGraph(props: { active: boolean }): JSX.Element`.
- Produces: `[data-component="evidence-loading"]` as the pane-local initial state.

- [ ] **Step 1: Write the failing browser regressions**

Add tests that delay but do not replace the real provenance request, assert the
workspace remains mounted, and count requests after the first response:

```ts
test("keeps a slow Evidence load inside the inspector and does not poll", async ({ page, gotoSession }) => {
  const requests: string[] = []
  await page.route("**/provenance?**", async (route) => {
    requests.push(route.request().url())
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.continue()
  })
  await gotoSession()

  await page.getByTitle("evidence").click()
  await expect(page.locator(".session-workspace")).toBeVisible()
  await expect(page.locator(".session-right-pane [data-component=\"evidence-loading\"]")).toBeVisible()
  await expect(page.locator(".session-right-pane").getByText("evidence & lineage", { exact: true })).toBeVisible()
  await page.waitForTimeout(3_000)
  expect(requests).toHaveLength(1)
})
```

Extend the existing populated-graph test to switch Atlas → Evidence after the
first load and expect exactly one deliberate refresh.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd frontend/workspace
bun run test:e2e -- e2e/evidence-graph.spec.ts --workers=1
```

Expected: the session workspace disappears during the delayed response, the
pane-local loading selector is absent, or request count exceeds one because of
the 2.5-second interval.

- [ ] **Step 3: Contain first-load suspension in `RightPane`**

Import `Suspense` and `AsciiSpinner`, pass the active state, and wrap only
Evidence:

```tsx
<KeepAlive show={tab() === "evidence"} mounted={visited().has("evidence")}>
  <Suspense fallback={<EvidenceLoading />}>
    <EvidenceGraph active={tab() === "evidence"} />
  </Suspense>
</KeepAlive>
```

Add:

```tsx
function EvidenceLoading(): JSX.Element {
  return (
    <div
      data-component="evidence-loading"
      style={{ flex: 1, display: "flex", "align-items": "center", "justify-content": "center" }}
    >
      <AsciiSpinner size={10} label="loading evidence…" color="var(--color-text-faint)" />
    </div>
  )
}
```

- [ ] **Step 4: Replace polling with active-tab refresh and retained data**

Change the exported signature and imports:

```ts
import { For, Show, createEffect, createMemo, createResource, createSignal, on, type JSX } from "solid-js"

export function EvidenceGraph(props: { active: boolean }): JSX.Element {
```

Delete `setInterval`, `onCleanup`, and the timer cleanup. Use the latest
successful graph during refreshes, but perform one suspending read during the
initial load:

```ts
const data = createMemo(() => (graph.error ? graph.latest : (graph.latest ?? graph())))

createEffect(
  on(
    () => props.active,
    (active, previous) => {
      if (!active || previous !== false || graph.loading) return
      void graphApi.refetch()
    },
  ),
)
```

Replace all render and derived-state `graph()` reads with `data()` so a refresh
keeps the previous graph. The `graph.error` guard prevents an initial rejected
request from being thrown outside the inline error state.
Render an inline retry when `graph.error` exists:

```tsx
<Show when={graph.error}>
  <div role="alert" style={errorBox}>
    <span>Evidence could not refresh. The last available lineage is still shown.</span>
    <button type="button" style={primaryButton} onClick={() => void graphApi.refetch()}>
      retry
    </button>
  </div>
</Show>
```

For an initial request, keep the resource read inside the local Suspense
boundary; for a refetch, use `graph.latest`.

- [ ] **Step 5: Run the focused Evidence test and verify GREEN**

Run:

```bash
cd frontend/workspace
bun run test:e2e -- e2e/evidence-graph.spec.ts --workers=1
```

Expected: both Evidence tests pass, the session stays visible, and no background
poll request appears.

- [ ] **Step 6: Commit the lifecycle fix**

```bash
git add frontend/workspace/e2e/evidence-graph.spec.ts \
  frontend/workspace/src/atlas/RightPane.tsx \
  frontend/workspace/src/atlas/EvidenceGraph.tsx
git commit -m "fix: contain evidence loading"
```

---

### Task 2: Product vocabulary and dead gallery cleanup

**Files:**
- Modify: `frontend/workspace/e2e/research-launchpad.spec.ts`
- Modify: `frontend/workspace/e2e/artifact-inspector.spec.ts`
- Modify: `frontend/workspace/e2e/evidence-graph.spec.ts`
- Modify: `frontend/workspace/src/components/session/session-new-view.tsx`
- Modify: `frontend/workspace/src/atlas/RightPane.tsx`
- Modify: `frontend/workspace/src/atlas/EvidenceGraph.tsx`
- Delete: `frontend/workspace/src/artifacts/ArtifactGallery.tsx`

**Interfaces:**
- Consumes: existing `sdk.client.file.artifacts()` research-file list.
- Produces: user-facing “research files,” “Evidence,” “outputs,” and “Details” labels.
- Preserves: provenance node kind `artifact` and internal artifact inspector APIs.

- [ ] **Step 1: Write failing terminology contracts**

Update launchpad coverage:

```ts
await expect(launchpad.getByRole("button", { name: /research files$/ })).toBeVisible()
await expect(launchpad.getByRole("button", { name: /artifacts$/ })).toHaveCount(0)
```

Update the inspector helper:

```ts
await page.getByRole("button", { name: "file details", exact: true }).click()
```

Add empty Evidence assertions:

```ts
await expect(pane.getByText("No recorded lineage yet", { exact: true })).toBeVisible()
await expect(pane.getByText(/Local project content stays in Files/)).toBeVisible()
```

Add a populated Evidence assertion that the summary says `outputs`, while the
API payload continues to use `kind: "artifact"`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd frontend/workspace
bun run test:e2e -- \
  e2e/research-launchpad.spec.ts \
  e2e/artifact-inspector.spec.ts \
  e2e/evidence-graph.spec.ts \
  --workers=1
```

Expected: old “artifacts,” “Inspect,” “inspect artifact,” and empty Evidence
copy fail the new expectations.

- [ ] **Step 3: Apply the simplified labels**

In the launchpad:

```tsx
<Show when={!artifacts.loading} fallback="Scanning research files">
  {(artifacts.latest?.length ?? 0).toLocaleString()} research files
</Show>
```

In the open inspector tab:

```tsx
<TabBtn
  k="artifact"
  label="Details"
  Icon={IconAtom}
  active={artifactMode()}
  onClick={() => uiStore.setRightPaneMode("artifact")}
/>
```

In the collapsed rail:

```tsx
title="file details"
aria-label="file details"
```

In Evidence, keep `Kind = "artifact"` but render:

```tsx
<Score label="outputs" value={data()?.summary.kinds.artifact ?? 0} color={colors.artifact} />
```

Replace the empty copy with:

```tsx
<strong>No recorded lineage yet</strong>
<span>
  Local project content stays in Files. Notebook runs and research agents record sources, runs, outputs, claims, and reviews here.
</span>
```

- [ ] **Step 4: Remove the retired gallery**

Verify no import remains:

```bash
rg -n "ArtifactGallery" frontend/workspace/src frontend/workspace/e2e
```

Delete only:

```text
frontend/workspace/src/artifacts/ArtifactGallery.tsx
```

Run the same `rg` again and expect no matches.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
cd frontend/workspace
bun run test:e2e -- \
  e2e/research-launchpad.spec.ts \
  e2e/artifact-inspector.spec.ts \
  e2e/evidence-graph.spec.ts \
  --workers=1
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit the vocabulary cleanup**

```bash
git add frontend/workspace/e2e/research-launchpad.spec.ts \
  frontend/workspace/e2e/artifact-inspector.spec.ts \
  frontend/workspace/e2e/evidence-graph.spec.ts \
  frontend/workspace/src/components/session/session-new-view.tsx \
  frontend/workspace/src/atlas/RightPane.tsx \
  frontend/workspace/src/atlas/EvidenceGraph.tsx \
  frontend/workspace/src/artifacts/ArtifactGallery.tsx
git commit -m "feat: clarify files and evidence"
```

---

### Task 3: Full verification, PR update, and npm test package

**Files:**
- Modify only if verification exposes a regression.

**Interfaces:**
- Consumes: the complete branch state and GitHub `npm-test.yml` workflow.
- Produces: green application CI, an updated unmerged PR #238, and a verified `@synsci/openscience@test` package.

- [ ] **Step 1: Run static and build gates**

```bash
bun run typecheck
bun run build
git diff --check
```

Expected: exit code 0 for every command.

- [ ] **Step 2: Run the frontend and backend suites**

```bash
cd frontend/workspace
bun run test:e2e -- --workers=1
cd ../../backend/cli
bun test
```

Expected: all tests pass, apart from any already documented skips.

- [ ] **Step 3: Inspect the source localhost in the in-app browser**

Open the current local test server. Verify:

- Evidence opens without replacing `.session-workspace`.
- Empty Evidence explains Files versus lineage.
- Evidence refresh performs one request.
- Atlas → Evidence performs one deliberate request.
- Waiting at least five seconds produces no further provenance request.
- Details opens for a local scientific file.
- Light and dark themes have no clipping or illegible copy.
- Browser console has no new errors or warnings.

- [ ] **Step 4: Commit only fixes revealed by verification**

For each coherent correction:

```bash
git add <exact-tested-files>
git commit -m "fix: <specific observed regression>"
```

Repeat the affected focused test before continuing.

- [ ] **Step 5: Push the branch and inspect PR checks**

```bash
git push origin openscience/ui-changes
gh pr view 238 --json url,state,isDraft,mergeStateStatus,statusCheckRollup
```

Expected: PR #238 remains open and ready, application checks pass, and no merge
command is run. Report the existing history-wide Gitleaks failure separately
without changing its workflow.

- [ ] **Step 6: Dispatch one npm test publication**

Resolve the next pre-release version from npm and dispatch only:

```bash
gh workflow run npm-test.yml --ref openscience/ui-changes -f version=<next-test-version>
```

Watch the resulting run until every publish, packaged-E2E, and OS smoke job is
terminal:

```bash
gh run watch <run-id> --exit-status
```

- [ ] **Step 7: Install the test dist-tag in the isolated prefix**

```bash
mkdir -p "$HOME/.openscience-test-npm"
npm install -g --prefix "$HOME/.openscience-test-npm" @synsci/openscience@test synsci@test
PATH="$HOME/.openscience-test-npm/bin:$PATH" openscience --version
PATH="$HOME/.openscience-test-npm/bin:$PATH" synsci --version
```

Expected: both commands report the version published by the workflow.

- [ ] **Step 8: Start and inspect the packaged localhost**

Start the isolated package on a free port without stopping existing local
servers:

```bash
PATH="$HOME/.openscience-test-npm/bin:$PATH" openscience serve --port <free-port>
```

Use the in-app browser to repeat the Evidence, Files, Details, theme, request,
and console checks from Step 3.

- [ ] **Step 9: Reiterate if packaged behavior differs**

If any packaged-only issue appears, add a failing focused regression, implement
the smallest correction, rerun Tasks 1–3, push the branch, and dispatch one
new batched npm test build. Stop only after source and packaged behavior match.

- [ ] **Step 10: Final branch audit**

```bash
git status --short --branch
git log --format='%h %an <%ae> %s' origin/main..HEAD
gh pr view 238 --json url,state,isDraft,mergeStateStatus,statusCheckRollup
```

Expected: only the user's pre-existing untracked files remain, every new commit
uses Aayam Bansal's identity, PR #238 is unmerged, and npm `latest` is untouched.
