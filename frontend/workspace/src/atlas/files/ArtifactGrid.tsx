import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { ArtifactCard } from "./ArtifactCard"
import type { ThumbProps } from "./ArtifactThumb"
import { groupBySession, sortArtifacts, type Group } from "./artifact-groups"
import { readView, writeView, type View } from "./artifact-view"

export interface GridProps extends Omit<ThumbProps, "artifact"> {
  artifacts: StoredArtifact[]
  titles: Map<string, string>
  currentSession: string | undefined
  onOpen: (artifact: StoredArtifact) => void
  onRename: (artifact: StoredArtifact) => void
  onTrash: (artifact: StoredArtifact) => void
}

const age = (created: number) => {
  const minutes = Math.max(1, Math.round((Date.now() - created) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export function ArtifactGrid(props: GridProps): JSX.Element {
  const [view, setView] = createSignal<View>(readView())
  const [prefs, setPrefs] = createSignal(false)

  // Spread rather than mutate: readView() hands back the shared DEFAULT_VIEW
  // object itself whenever storage is empty or invalid, and writing through it
  // would rewrite the default for every later reader in the process.
  const apply = (next: Partial<View>) => {
    const merged = { ...view(), ...next }
    setView(merged)
    writeView(merged)
  }

  // One group with no label is how the flat A-Z case reuses the grouped render
  // path; the header is what disappears, not the list.
  const groups = createMemo((): Group[] =>
    view().sort === "created"
      ? groupBySession(props.artifacts, props.titles, props.currentSession)
      : [{ key: "all", label: "", artifacts: sortArtifacts(props.artifacts, "name"), newest: 0 }],
  )

  const card = (artifact: StoredArtifact) => (
    <ArtifactCard
      artifact={artifact}
      layout={view().layout}
      sizes={view().sizes}
      url={props.url}
      read={props.read}
      highlight={props.highlight}
      onOpen={props.onOpen}
      onRename={props.onRename}
      onTrash={props.onTrash}
    />
  )

  return (
    <div class="artifact-surface">
      <div class="artifact-toolbar">
        <span class="artifact-toolbar__count" data-artifact-count>
          {props.artifacts.length} {props.artifacts.length === 1 ? "artifact" : "artifacts"}
        </span>

        <button
          type="button"
          class="artifact-toolbar__sort"
          data-artifact-sort
          onClick={() => apply({ sort: view().sort === "created" ? "name" : "created" })}
        >
          {view().sort === "created" ? "Created ↓" : "Name ↓"}
        </button>

        <span class="artifact-toolbar__layout">
          <For each={["grid", "list"] as const}>
            {(layout) => (
              <button
                type="button"
                data-artifact-layout={layout}
                aria-label={layout === "grid" ? "Grid" : "List"}
                aria-pressed={view().layout === layout}
                onClick={() => apply({ layout })}
              >
                {layout === "grid" ? "▦" : "≡"}
              </button>
            )}
          </For>
        </span>

        {/* Its own glyph, not the card's: two identical triggers a few pixels
            apart meaning different things is the cost of having both menus. */}
        <button
          type="button"
          class="artifact-toolbar__prefs"
          data-artifact-prefs
          aria-label="View options"
          aria-expanded={prefs()}
          onClick={() => setPrefs(!prefs())}
        >
          ⚙
        </button>

        <Show when={prefs()}>
          <button
            type="button"
            class="artifact-menu__scrim"
            aria-label="Dismiss view options"
            onClick={() => setPrefs(false)}
          />
          {/* "Copy store path" was specified here and cut: the store lives under
              Global.Path.data, and the server's /path payload reports home,
              state, config, worktree and directory but never data, so any path
              this menu offered would be a guess. It needs a backend field first. */}
          <div class="artifact-menu artifact-menu--prefs" role="menu">
            <button type="button" role="menuitem" data-pref="sizes" onClick={() => apply({ sizes: !view().sizes })}>
              <span aria-hidden="true" class="artifact-menu__check">
                {view().sizes ? "✓" : ""}
              </span>
              Show file sizes
            </button>
          </div>
        </Show>
      </div>

      <Show when={props.artifacts.length > 0} fallback={<div class="files-empty">No artifacts saved yet.</div>}>
        <For each={groups()}>
          {(group) => (
            <>
              <Show when={group.label}>
                <div class="artifact-group" data-artifact-group>
                  <span class="artifact-group__name">{group.label}</span>
                  <span class="artifact-group__meta">
                    {group.artifacts.length} · {age(group.newest)}
                  </span>
                </div>
              </Show>
              <div
                class={view().layout === "grid" ? "artifact-grid" : "artifact-list"}
                {...(view().layout === "grid" ? { "data-artifact-grid": true } : { "data-artifact-list": true })}
              >
                <For each={group.artifacts}>{card}</For>
              </div>
            </>
          )}
        </For>
      </Show>
    </div>
  )
}
