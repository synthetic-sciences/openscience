import { createSignal, createMemo, createResource, createEffect, type JSX, For, Show } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { validateDirectoryPath } from "@/thesis/openDirectory"
import {
  IconFolder,
  IconChevronLeft,
  IconChevronRight,
  IconArrowRight,
  IconSearch,
  IconRefresh,
  IconHome,
} from "@/thesis/shared/Icon"

interface FolderEntry {
  name: string
  absolute: string
}

interface PickerProps {
  multiple?: boolean
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
          .filter((n: any) => n?.type === "directory" && !n.name.startsWith(".") && !n.ignored)
          .map((n: any) => ({ name: n.name as string, absolute: n.absolute as string }))
          .sort((a, b) => a.name.localeCompare(b.name))
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
    const valid = await validateDirectoryPath(abs)
    if (!valid) return
    setCwd(valid)
    setFilter("")
    setPathInput("")
  }

  const pick = (path: string) => {
    pushRecent(path)
    props.onSelect(props.multiple ? [path] : path)
    dialog.close()
  }

  const cancel = () => {
    props.onSelect(null)
    dialog.close()
  }

  const sidebarLinks = createMemo(() => {
    const h = home()
    const links: Array<{ label: string; path: string; key: string }> = [
      { label: "Home", path: h, key: "home" },
      { label: "Desktop", path: h + "/Desktop", key: "desktop" },
      { label: "Documents", path: h + "/Documents", key: "docs" },
      { label: "Downloads", path: h + "/Downloads", key: "dl" },
      { label: "Applications", path: "/Applications", key: "apps" },
    ]
    return links
  })

  const recents = createMemo(() => readRecents())

  return (
    <Dialog title="Open folder" size="large" transition>
      <div
        style={{
          display: "flex",
          gap: "12px",
          "min-height": "480px",
          "max-height": "560px",
        }}
      >
        {/* Sidebar */}
        <div
          style={{
            flex: "0 0 180px",
            display: "flex",
            "flex-direction": "column",
            gap: "14px",
            "border-right": "1px solid var(--color-border)",
            "padding-right": "10px",
            overflow: "auto",
          }}
        >
          <div style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
            <SectionLabel>favorites</SectionLabel>
            <For each={sidebarLinks()}>
              {(l) => <SidebarRow label={l.label} active={cwd() === l.path} onClick={() => goTo(l.path)} />}
            </For>
          </div>
          <Show when={recents().length > 0}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
              <SectionLabel>recent</SectionLabel>
              <For each={recents()}>
                {(p) => (
                  <SidebarRow
                    label={p.split("/").filter(Boolean).pop() ?? "/"}
                    sublabel={p.replace(home() + "/", "~/").replace(home(), "~")}
                    active={cwd() === p}
                    onClick={() => goTo(p)}
                    onDblClick={() => pick(p)}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Main pane */}
        <div
          style={{
            flex: 1,
            display: "flex",
            "flex-direction": "column",
            gap: "10px",
            "min-width": 0,
          }}
        >
          {/* Breadcrumbs */}
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "6px",
              padding: "6px 8px",
              background: "var(--color-bg-subtle)",
              border: "1px solid var(--color-border)",
              "border-radius": "4px",
              "flex-wrap": "wrap",
            }}
          >
            <button
              onClick={goUp}
              title="parent folder"
              style={navBtn(cwd() === "/" || cwd() === "")}
              disabled={cwd() === "/" || cwd() === ""}
            >
              <IconChevronLeft size={11} strokeWidth={1.5} />
            </button>
            <button onClick={() => goTo(home())} title="home" style={navBtn(false)}>
              <IconHome size={11} strokeWidth={1.5} />
            </button>
            <span style={{ width: "1px", height: "16px", background: "var(--color-border)" }} />
            <For each={crumbs()}>
              {(c, i) => (
                <>
                  <Show when={i() > 0}>
                    <span style={{ color: "var(--color-text-faint)" }}>/</span>
                  </Show>
                  <button
                    onClick={() => goTo(c.path)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      "font-family": FONT_MONO,
                      "font-size": "11px",
                      color: i() === crumbs().length - 1 ? "var(--color-text)" : "var(--color-text-muted)",
                      "font-weight": i() === crumbs().length - 1 ? 600 : 500,
                      padding: "2px 4px",
                      "border-radius": "4px",
                      transition: "background 120ms ease, color 120ms ease",
                    }}
                    onMouseEnter={(el) => {
                      el.currentTarget.style.background = "var(--color-accent-subtle)"
                      el.currentTarget.style.color = "var(--color-text)"
                    }}
                    onMouseLeave={(el) => {
                      el.currentTarget.style.background = "transparent"
                      el.currentTarget.style.color =
                        i() === crumbs().length - 1 ? "var(--color-text)" : "var(--color-text-muted)"
                    }}
                  >
                    {c.label}
                  </button>
                </>
              )}
            </For>
            <span style={{ flex: 1 }} />
            <button onClick={() => refetch()} title="refresh" style={navBtn(false)}>
              <IconRefresh size={11} strokeWidth={1.5} />
            </button>
          </div>

          {/* Filter */}
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "6px",
              padding: "6px 10px",
              border: "1px solid var(--color-border)",
              "border-radius": "4px",
              background: "var(--color-surface-solid)",
            }}
          >
            <IconSearch size={11} strokeWidth={1.5} />
            <input
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
              placeholder="filter folders…"
              autofocus
              style={{
                all: "unset",
                flex: 1,
                "font-family": FONT_MONO,
                "font-size": "12px",
                color: "var(--color-text)",
              }}
            />
            <span
              class="tab-fig"
              style={{
                "font-family": FONT_MONO,
                "font-size": "10px",
                color: "var(--color-text-faint)",
                "letter-spacing": "0.04em",
              }}
            >
              {filtered().length} {filtered().length === 1 ? "folder" : "folders"}
            </span>
          </div>

          {/* Always-visible "paste a path" — bypass for TCC-blocked dirs
              (macOS hides ~/Desktop from non-FDA processes, leaving the
              folder list empty). User pastes any absolute path here and
              we jump straight there. */}
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "6px",
              padding: "6px 10px",
              border: "1px dashed var(--color-border)",
              "border-radius": "4px",
              background: "var(--color-bg-subtle)",
            }}
          >
            <span
              style={{
                "font-family": FONT_MONO,
                "font-size": "10px",
                color: "var(--color-text-faint)",
                "letter-spacing": "0.08em",
                "text-transform": "uppercase",
              }}
            >
              go to
            </span>
            <input
              value={pathInput()}
              onInput={(e) => setPathInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void goToTyped(pathInput())
              }}
              placeholder="/Users/you/Desktop/bs-local · or paste any absolute path"
              spellcheck={false}
              style={{
                all: "unset",
                flex: 1,
                "font-family": FONT_MONO,
                "font-size": "11px",
                color: "var(--color-text)",
              }}
            />
            <button
              type="button"
              onClick={() => void goToTyped(pathInput())}
              disabled={!pathInput().trim()}
              style={{
                all: "unset",
                cursor: pathInput().trim() ? "pointer" : "not-allowed",
                padding: "3px 10px",
                "border-radius": "4px",
                background: pathInput().trim() ? "var(--color-surface-solid)" : "transparent",
                border: "1px solid var(--color-border)",
                "font-family": FONT_MONO,
                "font-size": "10px",
                color: "var(--color-text-muted)",
                opacity: pathInput().trim() ? 1 : 0.5,
              }}
            >
              go
            </button>
          </div>

          {/* Folder list */}
          <div
            class="thesis-scroll"
            ref={(el) => {
              // Reset scroll position whenever the user navigates so the new
              // folder always starts at the top instead of carrying the prior
              // scroll offset (which feels jumpy mid-navigation).
              createEffect(() => {
                cwd()
                el.scrollTop = 0
              })
            }}
            style={{
              flex: 1,
              "overflow-y": "auto",
              border: "1px solid var(--color-border)",
              "border-radius": "4px",
              background: "var(--color-surface-solid)",
              "min-height": "240px",
              position: "relative",
              // Slight desaturation while loading hints at activity without
              // unmounting the rows — feels much smoother than a full swap.
              opacity: entries.loading ? 0.55 : 1,
              transition: "opacity 120ms ease",
            }}
          >
            {/* Thin indeterminate loading bar across the top while fetching. */}
            <Show when={entries.loading}>
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: "2px",
                  overflow: "hidden",
                  "pointer-events": "none",
                  "z-index": 1,
                }}
              >
                <div
                  style={{
                    width: "30%",
                    height: "100%",
                    background: "linear-gradient(90deg, transparent, var(--color-accent), transparent)",
                    animation: "thesis-loading-slide 1.1s ease-in-out infinite",
                  }}
                />
              </div>
            </Show>
            <Show
              when={filtered().length > 0}
              fallback={
                <Show when={!entries.loading}>
                  <Show
                    when={!error()}
                    fallback={
                      <div
                        class="thesis-fade-in"
                        style={{
                          padding: "32px 24px",
                          "text-align": "center",
                          "font-family": FONT_SANS,
                          "font-size": "12px",
                          color: "var(--color-error)",
                          display: "flex",
                          "flex-direction": "column",
                          "align-items": "center",
                          gap: "10px",
                        }}
                      >
                        <span>couldn't read this folder</span>
                        <span style={{ color: "var(--color-text-faint)", "max-width": "360px", "line-height": 1.5 }}>
                          {error()}
                        </span>
                        <button
                          type="button"
                          onClick={() => void refetch()}
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            padding: "5px 12px",
                            "border-radius": "4px",
                            border: "1px solid var(--color-border)",
                            "font-family": FONT_MONO,
                            "font-size": "11px",
                            color: "var(--color-text)",
                          }}
                        >
                          retry
                        </button>
                      </div>
                    }
                  >
                    <div
                      class="thesis-fade-in"
                      style={{
                        padding: "32px 24px",
                        "text-align": "center",
                        "font-family": FONT_SANS,
                        "font-size": "12px",
                        color: "var(--color-text-faint)",
                        display: "flex",
                        "flex-direction": "column",
                        gap: "8px",
                      }}
                    >
                      <Show when={(entries() ?? []).length === 0} fallback={<span>nothing matches the filter</span>}>
                        <Show
                          when={
                            /\/Desktop$|\/Documents$|\/Downloads$/.test(cwd()) ||
                            cwd().endsWith("/Desktop") ||
                            cwd().endsWith("/Documents") ||
                            cwd().endsWith("/Downloads")
                          }
                          fallback={<span>this folder is empty · pick it with the button below</span>}
                        >
                          <span style={{ color: "var(--color-text)" }}>
                            macOS is blocking the listing of <code>{cwd().split("/").pop()}</code>
                          </span>
                          <span style={{ "max-width": "360px", "line-height": 1.5 }}>
                            To list this folder we'd need Full Disk Access for the
                            <code>openscience</code> binary. For now, paste the absolute path of the folder you want
                            into the <em>go to</em> bar above — OpenScience can still open any path you give it.
                          </span>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </Show>
              }
            >
              <For each={filtered()}>
                {(e) => <FolderRow entry={e} onDrill={() => drillInto(e)} onPick={() => pick(e.absolute)} />}
              </For>
            </Show>
          </div>

          {/* Footer */}
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              "padding-top": "4px",
            }}
          >
            <span
              style={{
                "font-family": FONT_MONO,
                "font-size": "10px",
                color: "var(--color-text-faint)",
                flex: 1,
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
              title={cwd()}
            >
              {cwd().replace(home(), "~")}
            </span>
            <button onClick={cancel} style={cancelBtn()}>
              cancel
            </button>
            <button
              onClick={async () => {
                const valid = await validateDirectoryPath(cwd())
                if (valid) pick(valid)
              }}
              title="open the current folder as a project"
              style={primaryBtn()}
            >
              <IconArrowRight size={11} strokeWidth={2} />
              open this folder
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function FolderRow(props: { entry: FolderEntry; onDrill: () => void; onPick: () => void }): JSX.Element {
  const [hover, setHover] = createSignal(false)
  return (
    <div
      role="button"
      tabindex="0"
      onClick={props.onDrill}
      onDblClick={props.onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onDrill()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${props.entry.absolute} · click to enter · double-click to open as project`}
      style={{
        cursor: "pointer",
        display: "flex",
        "align-items": "center",
        gap: "10px",
        padding: "8px 12px",
        "border-bottom": "1px solid var(--color-border)",
        background: hover() ? "var(--color-accent-subtle)" : "transparent",
        transform: hover() ? "translateX(2px)" : "translateX(0)",
        transition: "background 160ms ease, transform 160ms ease",
      }}
    >
      <IconFolder size={13} strokeWidth={1.5} />
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
          "font-family": FONT_MONO,
          "font-size": "12px",
          color: "var(--color-text)",
        }}
      >
        {props.entry.name}
      </span>
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation()
          props.onPick()
        }}
        title="open this folder as a project"
        style={{
          all: "unset",
          cursor: "pointer",
          padding: "2px 8px",
          "border-radius": "4px",
          "font-family": FONT_MONO,
          "font-size": "10px",
          "letter-spacing": "0.08em",
          "text-transform": "uppercase",
          color: "var(--color-text-muted)",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-solid)",
          opacity: hover() ? 1 : 0,
          transform: hover() ? "translateX(0)" : "translateX(4px)",
          "pointer-events": hover() ? "auto" : "none",
          transition: "opacity 160ms ease, transform 160ms ease",
        }}
      >
        open
      </button>
      <IconChevronRight
        size={11}
        strokeWidth={1.5}
        style={{
          opacity: hover() ? 1 : 0.5,
          transform: hover() ? "translateX(2px)" : "translateX(0)",
          transition: "opacity 160ms ease, transform 160ms ease",
        }}
      />
    </div>
  )
}

function SectionLabel(props: { children: JSX.Element }): JSX.Element {
  return (
    <div
      style={{
        "font-family": FONT_MONO,
        "font-size": "10px",
        color: "var(--color-text-faint)",
        "letter-spacing": "0.08em",
        "text-transform": "uppercase",
        padding: "4px 6px",
      }}
    >
      {props.children}
    </div>
  )
}

function SidebarRow(props: {
  label: string
  sublabel?: string
  active: boolean
  onClick: () => void
  onDblClick?: () => void
}): JSX.Element {
  return (
    <div
      role="button"
      tabindex="0"
      onClick={props.onClick}
      onDblClick={props.onDblClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onClick()
      }}
      style={{
        cursor: "pointer",
        display: "flex",
        "align-items": "center",
        gap: "8px",
        padding: "5px 8px",
        "border-radius": "4px",
        background: props.active ? "var(--color-bg-elevated)" : "transparent",
        border: props.active ? "1px solid var(--color-border-strong)" : "1px solid transparent",
        transition: "background 160ms ease, border-color 160ms ease, transform 160ms ease",
      }}
      onMouseEnter={(el) => {
        if (!props.active) el.currentTarget.style.background = "var(--color-accent-subtle)"
        el.currentTarget.style.transform = "translateX(2px)"
      }}
      onMouseLeave={(el) => {
        if (!props.active) el.currentTarget.style.background = "transparent"
        el.currentTarget.style.transform = "translateX(0)"
      }}
    >
      <IconFolder size={11} strokeWidth={1.5} />
      <div style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column" }}>
        <span
          style={{
            "font-family": FONT_MONO,
            "font-size": "11px",
            color: "var(--color-text)",
            "font-weight": props.active ? 600 : 500,
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          {props.label}
        </span>
        <Show when={props.sublabel}>
          <span
            style={{
              "font-family": FONT_MONO,
              "font-size": "10px",
              color: "var(--color-text-faint)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {props.sublabel}
          </span>
        </Show>
      </div>
    </div>
  )
}

function navBtn(disabled: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    width: "22px",
    height: "22px",
    "border-radius": "4px",
    color: "var(--color-text-muted)",
    background: "var(--color-surface-solid)",
    border: "1px solid var(--color-border)",
    opacity: disabled ? 0.4 : 1,
  } as JSX.CSSProperties
}

function cancelBtn(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    padding: "6px 12px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-surface-solid)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    color: "var(--color-text-muted)",
  } as JSX.CSSProperties
}

function primaryBtn(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    padding: "6px 14px",
    "border-radius": "4px",
    background: "var(--color-accent)",
    color: "var(--color-on-accent)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    "font-weight": 500,
    display: "inline-flex",
    "align-items": "center",
    gap: "6px",
  } as JSX.CSSProperties
}
