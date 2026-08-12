import { createSignal, createMemo, createResource, createEffect, type JSX, For, Show } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { Button } from "@synsci/ui/button"
import { Icon, type IconProps } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { validateDirectoryPath } from "@/atlas/openDirectory"
import "./FolderPicker.css"

interface FolderEntry {
  name: string
  absolute: string
  type: "file" | "directory"
}

interface PickerProps {
  multiple?: boolean
  kind?: "folder" | "file"
  title?: string
  onSelect: (result: string | string[] | null) => void
}

const RECENT_KEY = "thesis-folder-picker-recents-v1"

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, 8) : []
  } catch {
    return []
  }
}

function pushRecent(path: string) {
  try {
    const cur = readRecents()
    const next = [path, ...cur.filter((p) => p !== path)].slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {}
}

/**
 * Finder/Explorer-style folder picker:
 *   - left sidebar with quick-link shortcuts (Home, Desktop, Documents,
 *     Downloads, Applications) plus recents
 *   - main pane with breadcrumbs + folder list
 *   - single click drills in, "open this folder" picks the cwd
 *
 * Backed by openscience's /file endpoint, which walks the real filesystem
 * and returns absolute paths.
 */
export function FolderPicker(props: PickerProps): JSX.Element {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const dialog = useDialog()

  const home = () => sync.data.path.home || "/"
  const [cwd, setCwd] = createSignal(home())
  const [filter, setFilter] = createSignal("")
  const [pathInput, setPathInput] = createSignal("")
  const [error, setError] = createSignal<string>()

  const [entries, { refetch }] = createResource(
    () => cwd(),
    async (dir): Promise<FolderEntry[]> => {
      setError(undefined)
      try {
        const res: any = await sdk.client.file.list({ directory: dir, path: "." } as any)
        const data = res?.data ?? res
        const list = Array.isArray(data) ? data : []
        return list
          .filter(
            (n: any) =>
              (n?.type === "directory" || (props.kind === "file" && n?.type === "file")) &&
              !n.name.startsWith(".") &&
              !n.ignored,
          )
          .map((n: any) => ({
            name: n.name as string,
            absolute: n.absolute as string,
            type: n.type as "file" | "directory",
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1
            return a.name.localeCompare(b.name)
          })
      } catch (err) {
        // Surface the failure instead of masking it as an empty folder — an
        // empty list and a failed listing are very different states.
        setError(err instanceof Error ? err.message : String(err))
        return []
      }
    },
  )

  // Use `entries.latest` so we keep the previously-rendered rows visible
  // while a new directory is being fetched. Without this the list briefly
  // empties on every navigation, which read as a "whole page refresh".
  const filtered = createMemo(() => {
    const q = filter().toLowerCase().trim()
    const list = entries.latest ?? entries() ?? []
    if (!q) return list
    return list.filter((e) => e.name.toLowerCase().includes(q))
  })

  const crumbs = createMemo(() => {
    const path = cwd()
    const h = home()
    const segs: Array<{ label: string; path: string }> = []
    if (h && (path === h || path.startsWith(h + "/"))) {
      segs.push({ label: "~", path: h })
      const tail = path === h ? "" : path.slice(h.length + 1)
      if (tail) {
        const parts = tail.split("/")
        let acc = h
        for (const p of parts) {
          acc = acc + "/" + p
          segs.push({ label: p, path: acc })
        }
      }
    } else {
      segs.push({ label: "/", path: "/" })
      const parts = path.replace(/^\/+/, "").split("/").filter(Boolean)
      let acc = ""
      for (const p of parts) {
        acc = acc + "/" + p
        segs.push({ label: p, path: acc })
      }
    }
    return segs
  })

  const goUp = () => {
    const cur = cwd()
    if (cur === "/" || cur === "") return
    const i = cur.lastIndexOf("/")
    setCwd(i <= 0 ? "/" : cur.slice(0, i))
    setFilter("")
  }

  const drillInto = (e: FolderEntry) => {
    if (e.type === "file") {
      pick(e.absolute)
      return
    }
    setCwd(e.absolute)
    setFilter("")
  }

  const goTo = (path: string) => {
    setCwd(path)
    setFilter("")
  }

  /** Resolve `~` / relative segments and jump there. */
  const normalizeTyped = (raw: string) => {
    const trimmed = raw.trim().replace(/\/+$/, "")
    if (!trimmed) return ""
    if (trimmed === "~") return home()
    if (trimmed.startsWith("~/")) return home() + trimmed.slice(1)
    if (!trimmed.startsWith("/")) return (cwd() === "/" ? "" : cwd()) + "/" + trimmed
    return trimmed
  }

  /** Resolve `~` / relative segments, verify it exists, and jump there. */
  const goToTyped = async (raw: string) => {
    const abs = normalizeTyped(raw)
    if (!abs) return
    const valid = await validateDirectoryPath(sdk.url, abs)
    if (!valid) return
    setCwd(valid)
    setFilter("")
    setPathInput("")
  }

  const pick = (path: string) => {
    const recent = props.kind === "file" ? path.slice(0, path.lastIndexOf("/")) || "/" : path
    pushRecent(recent)
    props.onSelect(props.multiple ? [path] : path)
    dialog.close()
  }

  const cancel = () => {
    props.onSelect(null)
    dialog.close()
  }

  const sidebarLinks = createMemo(() => {
    const h = home()
    const links: Array<{ label: string; path: string; icon: IconProps["name"] }> = [
      { label: "Home", path: h, icon: "home" },
      { label: "Desktop", path: h + "/Desktop", icon: "layout-grid" },
      { label: "Documents", path: h + "/Documents", icon: "file" },
      { label: "Downloads", path: h + "/Downloads", icon: "download" },
      { label: "Applications", path: "/Applications", icon: "folder-tree" },
    ]
    return links
  })

  const recents = createMemo(() => readRecents())

  return (
    <Dialog
      title={props.title ?? (props.kind === "file" ? "Choose a file" : "Choose a folder")}
      size="large"
      class="folder-picker-dialog"
      transition
    >
      <div class="folder-picker">
        <aside class="folder-picker__sidebar" aria-label="Folder locations">
          <div class="folder-picker__sidebar-group">
            <SectionLabel>Favorites</SectionLabel>
            <div class="folder-picker__sidebar-list">
              <For each={sidebarLinks()}>
                {(location) => (
                  <SidebarRow
                    label={location.label}
                    icon={location.icon}
                    active={cwd() === location.path}
                    onClick={() => goTo(location.path)}
                  />
                )}
              </For>
            </div>
          </div>
          <Show when={recents().length > 0}>
            <div class="folder-picker__sidebar-group">
              <SectionLabel>Recent</SectionLabel>
              <div class="folder-picker__sidebar-list">
                <For each={recents()}>
                  {(path) => (
                    <SidebarRow
                      label={path.split("/").filter(Boolean).pop() ?? "/"}
                      sublabel={path.replace(home() + "/", "~/").replace(home(), "~")}
                      icon="folder"
                      active={cwd() === path}
                      onClick={() => goTo(path)}
                      onDblClick={() => (props.kind === "file" ? goTo(path) : pick(path))}
                    />
                  )}
                </For>
              </div>
            </div>
          </Show>
        </aside>

        <section class="folder-picker__main" aria-label="Folder browser">
          <nav class="folder-picker__location" aria-label="Current folder">
            <div class="folder-picker__navigation">
              <button
                type="button"
                class="folder-picker__icon-button"
                onClick={goUp}
                aria-label="Parent folder"
                title="Parent folder"
                disabled={cwd() === "/" || cwd() === ""}
              >
                <Icon name="arrow-up" size="small" />
              </button>
              <button
                type="button"
                class="folder-picker__icon-button"
                onClick={() => goTo(home())}
                aria-label="Home folder"
                title="Home folder"
              >
                <Icon name="home" size="small" />
              </button>
            </div>
            <span class="folder-picker__location-divider" aria-hidden="true" />
            <div class="folder-picker__breadcrumbs">
              <For each={crumbs()}>
                {(crumb, index) => (
                  <>
                    <Show when={index() > 0}>
                      <span class="folder-picker__breadcrumb-separator" aria-hidden="true">
                        <Icon name="chevron-right" size="small" />
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="folder-picker__breadcrumb"
                      data-current={index() === crumbs().length - 1 ? "true" : undefined}
                      aria-current={index() === crumbs().length - 1 ? "location" : undefined}
                      onClick={() => goTo(crumb.path)}
                      title={crumb.path}
                    >
                      {crumb.label}
                    </button>
                  </>
                )}
              </For>
            </div>
            <button
              type="button"
              class="folder-picker__icon-button folder-picker__refresh"
              onClick={() => void refetch()}
              aria-label="Refresh folder"
              title="Refresh folder"
            >
              <Icon name="refresh" size="small" />
            </button>
          </nav>

          <div class="folder-picker__tools">
            <label class="folder-picker__field folder-picker__search">
              <Icon name="magnifying-glass" size="small" />
              <span class="folder-picker__visually-hidden">Filter this folder</span>
              <input
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                placeholder={props.kind === "file" ? "Filter files and folders…" : "Filter folders…"}
                autofocus
                autocomplete="off"
              />
              <span class="folder-picker__count tab-fig" aria-live="polite">
                {filtered().length} {filtered().length === 1 ? "item" : "items"}
              </span>
            </label>

            {/* Keep the path field always available. macOS can hide Desktop,
                Documents, and Downloads from directory listings even when an
                explicitly entered path remains valid and usable. */}
            <form
              class="folder-picker__field folder-picker__path-field"
              onSubmit={(event) => {
                event.preventDefault()
                void goToTyped(pathInput())
              }}
            >
              <Icon name="folder-tree" size="small" />
              <span class="folder-picker__field-label">Path</span>
              <input
                value={pathInput()}
                onInput={(e) => setPathInput(e.currentTarget.value)}
                aria-label="Go to path"
                placeholder="/Users/you/research or ~/research"
                spellcheck={false}
                autocomplete="off"
              />
              <button type="submit" class="folder-picker__go" disabled={!pathInput().trim()}>
                Go
              </button>
            </form>
          </div>

          <div
            class="folder-picker__list atlas-scroll"
            classList={{ "folder-picker__list--loading": entries.loading }}
            aria-busy={entries.loading}
            ref={(el) => {
              createEffect(() => {
                cwd()
                el.scrollTop = 0
              })
            }}
          >
            <Show when={entries.loading}>
              <div class="folder-picker__loading" role="progressbar" aria-label="Loading folder">
                <span />
              </div>
            </Show>
            <Show
              when={filtered().length > 0}
              fallback={
                <Show when={!entries.loading}>
                  <Show
                    when={!error()}
                    fallback={
                      <div class="folder-picker__empty folder-picker__empty--error atlas-fade-in" role="alert">
                        <Icon name="alert-circle" size="normal" />
                        <strong>Couldn’t read this folder</strong>
                        <p>{error()}</p>
                        <button type="button" class="folder-picker__retry" onClick={() => void refetch()}>
                          Retry
                        </button>
                      </div>
                    }
                  >
                    <div class="folder-picker__empty atlas-fade-in">
                      <Show when={(entries() ?? []).length === 0} fallback={<span>Nothing matches the filter.</span>}>
                        <Show
                          when={
                            /\/Desktop$|\/Documents$|\/Downloads$/.test(cwd()) ||
                            cwd().endsWith("/Desktop") ||
                            cwd().endsWith("/Documents") ||
                            cwd().endsWith("/Downloads")
                          }
                          fallback={
                            <span>
                              {props.kind === "file"
                                ? "This folder does not contain any files."
                                : "This folder is empty. You can still choose it below."}
                            </span>
                          }
                        >
                          <strong>
                            macOS is blocking the listing of <code>{cwd().split("/").pop()}</code>
                          </strong>
                          <p>
                            To list this folder, the <code>openscience</code> binary needs Full Disk Access. For now,
                            paste the absolute path of the folder you want into the path field above. OpenScience can
                            still open a path you provide explicitly.
                          </p>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </Show>
              }
            >
              <For each={filtered()}>
                {(e) => (
                  <PickerRow
                    entry={e}
                    onOpen={() => drillInto(e)}
                    onPick={() => pick(e.absolute)}
                    pickingFile={props.kind === "file"}
                  />
                )}
              </For>
            </Show>
          </div>

          <footer class="folder-picker__footer">
            <span class="folder-picker__current-path" title={cwd()}>
              <Icon name="folder" size="small" />
              {cwd().replace(home(), "~")}
            </span>
            <div class="folder-picker__footer-actions">
              <Button type="button" size="normal" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Show when={props.kind !== "file"}>
                <Button
                  type="button"
                  size="normal"
                  variant="primary"
                  onClick={async () => {
                    const valid = await validateDirectoryPath(sdk.url, cwd())
                    if (valid) pick(valid)
                  }}
                  title="Choose the current folder"
                >
                  Use this folder
                  <Icon name="arrow-right" size="small" />
                </Button>
              </Show>
            </div>
          </footer>
        </section>
      </div>
    </Dialog>
  )
}

function PickerRow(props: {
  entry: FolderEntry
  onOpen: () => void
  onPick: () => void
  pickingFile: boolean
}): JSX.Element {
  const folder = () => props.entry.type === "directory"
  return (
    <div class="folder-picker__row" data-kind={props.entry.type}>
      <button
        type="button"
        class="folder-picker__row-open"
        onClick={props.onOpen}
        onDblClick={() => (folder() ? props.onPick() : undefined)}
        title={folder() ? `${props.entry.absolute} · open folder` : `${props.entry.absolute} · choose this file`}
      >
        <Icon name={folder() ? "folder" : "file"} size="small" />
        <span class="folder-picker__row-name">{props.entry.name}</span>
        <Show when={folder()} fallback={<span class="folder-picker__pick-label">Choose</span>}>
          <span class="folder-picker__row-chevron" aria-hidden="true">
            <Icon name="chevron-right" size="small" />
          </span>
        </Show>
      </button>
      <Show when={folder() && !props.pickingFile}>
        <button type="button" class="folder-picker__choose" onClick={props.onPick} title="Choose this folder">
          Choose
        </button>
      </Show>
    </div>
  )
}

function SectionLabel(props: { children: JSX.Element }): JSX.Element {
  return <span class="folder-picker__section-label">{props.children}</span>
}

function SidebarRow(props: {
  label: string
  sublabel?: string
  icon: IconProps["name"]
  active: boolean
  onClick: () => void
  onDblClick?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      class="folder-picker__sidebar-row"
      data-active={props.active ? "true" : undefined}
      onClick={props.onClick}
      onDblClick={props.onDblClick}
    >
      <Icon name={props.icon} size="small" />
      <span class="folder-picker__sidebar-copy">
        <span class="folder-picker__sidebar-label">{props.label}</span>
        <Show when={props.sublabel}>
          <span class="folder-picker__sidebar-sublabel">{props.sublabel}</span>
        </Show>
      </span>
    </button>
  )
}
