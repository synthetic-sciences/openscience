# Artifacts grid — design

Status: approved, ready for implementation planning
Date: 2026-08-05
Branch: `feat/artifacts-grid` (off `files-pane-redesign`)
Prototypes: [three treatments](https://claude.ai/code/artifact/45a9b0ab-a7fd-4d3f-a3d2-b3fab5808b1c) ·
[working grid](https://claude.ai/code/artifact/9758e7cd-ac67-4932-8fc0-bfd6d2a0452d) ·
[menu placement](https://claude.ai/code/artifact/b94bd684-27b7-436d-8e1e-f0010280fa4e)

## Problem

The Files pane shell shipped with artifacts as a placeholder. `FilesPane.tsx` flattens every
`StoredArtifact` into a `FileRow` — name, type, size, path — and hands it to `FileTable`, the same
component that lists a directory. The projection throws away `mimeType`, `sessionID`, `versionCount`
and `createdAt`: everything that distinguishes a saved artifact from a file.

Two consequences, both live today:

1. **A saved plot looks exactly like a saved CSV.** The one question a grid of artifacts should answer
   at a glance — _which of these is the figure?_ — needs a click per row.
2. **Clicking an artifact opens the wrong bytes.** The row carries `current.sourcePath`, the working
   file the bytes were captured _from_. Edit that file after capture and the pane shows the new
   content under the artifact's name; delete it and the pane shows a read error. The immutability the
   store exists to provide is not visible anywhere in this pane.

The second is a correctness defect, not a cosmetic one, and it is the reason this phase is not
optional polish.

## What already exists

Confirmed by reading, not assumed. This phase writes much less code than it first appears to need.

| Capability                       | Where it already lives                                                         |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Artifact snapshot, live-updating | `createArtifactsResource` — already mounted in `FilesPane.tsx:144`             |
| Immutable bytes over HTTP        | `GET /file/artifact-store/:id/raw` (`routes/file.ts:512`), typed and ETagged   |
| The artifact viewer              | `StoredArtifactView` — Preview / Versions / How made / Review                  |
| Opening it as a tab              | `uiStore.openSaved()` → `RightPane.tsx:389`                                    |
| Rename, move to trash            | `StoredArtifactView` "Manage" → `PATCH` and `DELETE`                           |
| Refresh after a change           | `openscience:artifacts-changed`, which the pane's resource already listens for |
| Syntax highlighting              | shiki, with a registered `OpenScience` theme (`ui/src/context/marked.tsx:22`)  |
| Extension → grammar map          | `LANG` in `FilePreview.tsx:56`                                                 |
| Session titles                   | `sync.data.session` — `sync` is already held at `FilesPane.tsx:115`            |

The review of `files-pane-redesign` found that `uiStore.openSaved` has no production caller left. The
viewer is not dead — it is reachable from elsewhere and renders correctly as a tab — but nothing in
the new pane routes to it. Wiring the grid to it is a function call, not new UI.

## Decisions

### Thumbnails: real content, never a stand-in

| Kind                                    | Treatment                                                            |
| --------------------------------------- | -------------------------------------------------------------------- |
| `image/*`                               | `<img loading="lazy">` against the raw route                         |
| text, code, Markdown, JSON, CSV ≤ 64 KB | first ten lines, syntax-tinted by shiki with the `OpenScience` theme |
| everything else, or > 64 KB             | the extension, set quietly in a bordered chip                        |

Abstract glyphs were prototyped and rejected on evidence: seeded from the filename, `train.py` and
`iris_classification.py` draw identically, as do a 28-byte `config.json` and a 20 KB `jobs.json`. The
glyph encodes only what the label already says.

Tinting is not a second highlighter. shiki is a dependency, the theme is registered, and `FilePreview`
already maps extensions to grammars — so the thumbnail's colors are the same `--syntax-*` values the
viewer shows when the card is opened.

There is **no `IntersectionObserver`**. Every byte is served by the local process off local disk;
`loading="lazy"` covers images, and a text preview is one small read. Deferring work that costs
nothing is complexity without a payer.

**Classification rule.** The store records `.py` files as `application/octet-stream` — verified in
the real store for both `train.py` and `iris_classification.py`. Dispatching on MIME type alone
renders every Python artifact as a binary chip. **The extension wins whenever the MIME type is the
generic byte stream.** Everything else dispatches on MIME type first.

### Grouping follows the sort

- **Created ↓** — grouped by session. The current session heads the list as "This session"; the rest
  are ordered by their newest artifact. A group header shows its count and the age of its newest
  member.
- **Name ↓** — one flat A→Z grid, no headers. Alphabetical order split across sections is harder to
  scan than the sections are worth.

A session with no title in the sync store falls back to its abbreviated id. It never invents a name.

### Two menus, two glyphs

- **Toolbar** (`⚙`) — view preferences: show file sizes.
- **Card** (`⋮`, on hover and on focus) — Open in tab, Download, Rename…, Move to trash.

Two store-location items were specified and both cut. "Reveal the store folder in a file manager"
has no `xdg-open` or equivalent route in the backend. "Copy store path" then failed on two counts:
the store lives under `Global.Path.data`, which the server's `/path` payload never sends
(`server.ts:381` sends home, state, config, worktree, directory), and the blobs are content-addressed
— `blobs/86/8d/868d02bc…` with no filename or extension — so the path leads to a directory in which
no artifact can be found by looking. The path a person actually wants, the file an artifact was
captured from, is already shown by the viewer as **Source file** (`StoredArtifactView.tsx:414`).

A card's meta line reads `2m ago`. With **Show file sizes** on it reads `2m ago · 1.2 KB`.

Clicking a card does exactly what **Open in tab** does; the menu item exists so the action is
discoverable beside the others, not because it differs.

The card menu mirrors the viewer's actions rather than deferring to it, so an artifact can be cleared
from the grid without opening it first. The two triggers carry **different glyphs**: two identical
`⋮` within 200px meaning different things is the one real cost of having both.

Rename opens a dialog through the existing `useDialog` host — the same host `FolderPicker` uses. A
150px card is not a text field.

### Card click opens the immutable version

`uiStore.openSaved(artifact)` — the existing viewer, as a tab beside Files. This is what fixes the
`sourcePath` defect: the viewer previews stored bytes and names their version, and its trash action
already dispatches `openscience:artifacts-changed`, so the grid refreshes itself.

### The pane opens on artifacts, and remembers where it was left

Artifacts are what a session produces, so they lead rather than the project tree. The picked source
is persisted under `openscience:files-source` and wins on the next mount — but only while it still
names a source that exists, so a revoked grant or a closed project falls back to artifacts rather
than rendering nothing.

### View state persists globally

One `localStorage` key holds sort, layout and the size toggle, validated on read the way
`ui.ts:287` validates the agent picker — a corrupt or hand-edited value falls back to the default
rather than rendering a broken toolbar. Default: `Created ↓`, grid.

Per-project state was rejected: no such habit has been observed, and it would cost a key per project
plus cleanup when projects disappear.

## Architecture

`ArtifactGrid` is a sibling of `FileTable` under `src/atlas/files/`, selected by source kind.
`FileTable` learns nothing about artifacts; the `stored()` projection at `FilesPane.tsx:232` is
deleted and the grid takes `StoredArtifact[]` directly.

Logic lives in pure modules so it tests without a DOM.

```ts
// artifact-groups.ts
export type Sort = "created" | "name"
export interface Group {
  key: string
  label: string
  artifacts: StoredArtifact[]
  newest: number
}

export function sortArtifacts(list: StoredArtifact[], sort: Sort): StoredArtifact[]
export function groupBySession(
  list: StoredArtifact[],
  titles: Map<string, string>,
  current: string | undefined,
): Group[]

// artifact-view.ts
export interface View {
  sort: Sort
  layout: "grid" | "list"
  sizes: boolean
}
export function readView(): View // validates; falls back to the default
export function writeView(view: View): void

// artifact-thumb.ts
export type ThumbKind = "image" | "text" | "binary"
export function thumbKind(version: StoredArtifactVersion): ThumbKind
export function thumbLanguage(filename: string): string // reuses FilePreview's LANG
```

`LANG` is currently a private `const` at `FilePreview.tsx:57`. Implementation exports it — or lifts
it into `artifact-thumb.ts` and has `FilePreview` import it back. Duplicating the map is not an
option: the thumbnail and the view it opens into must agree on what language a file is.

Components: `ArtifactGrid.tsx` (toolbar, groups, both layouts, empty state), `ArtifactCard.tsx`
(thumbnail, name, meta, menu) and `ArtifactThumb.tsx` (the three-way dispatch).

### Seams

`FilesPane` is mountable standalone for tests, which constrains what the grid may reach for:

| Need                  | Production                                             | Standalone harness       |
| --------------------- | ------------------------------------------------------ | ------------------------ |
| text bytes            | existing `transport()`                                 | injected transport       |
| image `src`, Download | `url(artifact, download?)` prop from `sdk.request.url` | stub                     |
| open an artifact      | `onOpen` prop → `uiStore.openSaved`                    | spy                      |
| rename dialog         | `useDialog`, already held by the pane                  | absent; menu item hidden |
| session titles        | `titles` prop from `sync.data.session`                 | fixture map              |

Text previews go through the transport the pane already injects. Two things need a URL string rather
than a `Response`: the `<img src>` and the Download item, which points at the raw route with
`download=true`. That is one seam serving both, not two.

A session id with no title renders as `ses_…` plus its last six characters — enough to tell two
untitled sessions apart, short enough for a group header at the docked width.

## Failure behaviour

The rule the Compute strip established holds: **a degraded pane is not an error page.**

| Failure                    | Behaviour                                          |
| -------------------------- | -------------------------------------------------- |
| Thumbnail fetch fails      | extension chip; nothing propagates                 |
| Highlighting throws        | plain mono text                                    |
| Artifact > 64 KB           | chip, and no fetch is issued at all                |
| Session title missing      | abbreviated session id                             |
| `localStorage` unavailable | in-memory defaults                                 |
| Artifact snapshot fails    | the pane's existing notice; the grid renders empty |

No thumbnail failure may reach the app-wide `ErrorBoundary`.

## Testing

- **Pure modules** — sorting, grouping, group ordering, the "This session" pin, view-state validation
  against corrupt input, and `thumbKind` on the real store's `application/octet-stream` Python case.
- **Components** — through the existing `ssrLoadModule` harness with an injected transport: layout
  and sort toggling, grouping appearing only under Created, the size toggle, both menus, the card's
  open call, and every failure row above.
- **Real binary** — the terminal step. Driving the running app is what caught three defects in the
  shell phase that no unit test could: the empty-artifacts guard, the unreachable Download button,
  and the stale search filter.

## Out of scope

Bulk selection, drag to a session, artifact search by content, version diffing in the grid, and
GPU/remote artifact sources. `FileTable`'s list layout is not refactored to share code with the
grid's list mode; if they converge, that is a later fold.
