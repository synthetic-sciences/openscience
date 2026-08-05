import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { ArtifactCard } from "./ArtifactCard"
import type { ThumbProps } from "./ArtifactThumb"
import { groupBySession, sortArtifacts, type Group } from "./artifact-groups"
import { readView, writeView, type View } from "./artifact-view"
import { age } from "./ago"

export interface GridProps extends Omit<ThumbProps, "artifact"> {
  artifacts: StoredArtifact[]
  titles: Map<string, string>
  currentSession: string | undefined
  /** Set while the pane's search box is filtering, so an empty grid can say why. */
  filtered?: boolean
  onOpen: (artifact: StoredArtifact) => void
  onRename: (artifact: StoredArtifact) => void
  onTrash: (artifact: StoredArtifact) => void
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

  // Each field gets its own memo. Reading view().sort inside the grouping memo
  // subscribed it to the whole object, and apply() always writes a fresh one, so
  // toggling layout or file sizes rebuilt every Group -- which made <For>
  // recreate every card and re-read every artifact's bytes.
  const sort = createMemo(() => view().sort)
  const layout = createMemo(() => view().layout)
  const sizes = createMemo(() => view().sizes)

  // One group with no label is how the flat A-Z case reuses the grouped render
  // path; the header is what disappears, not the list.
  const groups = createMemo((): Group[] =>
    sort() === "created"
      ? groupBySession(props.artifacts, props.titles, props.currentSession)
      : [{ key: "all", label: "", artifacts: sortArtifacts(props.artifacts, "name"), newest: 0 }],
  )

  const card = (artifact: StoredArtifact) => (
    <ArtifactCard
      artifact={artifact}
      layout={layout()}
      sizes={sizes()}
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
          onClick={() => apply({ sort: sort() === "created" ? "name" : "created" })}
        >
          {sort() === "created" ? "Created ↓" : "Name ↓"}
        </button>

        <span class="artifact-toolbar__layout">
          <For each={["grid", "list"] as const}>
            {(option) => (
              <button
                type="button"
                data-artifact-layout={option}
                aria-label={option === "grid" ? "Grid" : "List"}
                aria-pressed={layout() === option}
                onClick={() => apply({ layout: option })}
              >
                {option === "grid" ? "▦" : "≡"}
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
            <button type="button" role="menuitem" data-pref="sizes" onClick={() => apply({ sizes: !sizes() })}>
              <span aria-hidden="true" class="artifact-menu__check">
                {sizes() ? "✓" : ""}
              </span>
              Show file sizes
            </button>
          </div>
        </Show>
      </div>

      <Show
        when={props.artifacts.length > 0}
        fallback={
          // "No artifacts saved yet." is false when a search simply matched
          // nothing, and the count beside it already says 0.
          <div class="files-empty">
            {props.filtered ? "No artifacts match this search." : "No artifacts saved yet."}
          </div>
        }
      >
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
                class={layout() === "grid" ? "artifact-grid" : "artifact-list"}
                {...(layout() === "grid" ? { "data-artifact-grid": true } : { "data-artifact-list": true })}
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
