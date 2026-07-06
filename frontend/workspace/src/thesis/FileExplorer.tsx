import { createSignal, createResource, createMemo, onCleanup, type JSX, For, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { centerTabs } from "@/thesis/store/centerTabs"
import { thesisAPI, type ThesisNode } from "@/thesis/api/thesis"
import {
  IconFolder,
  IconFile,
  IconRefresh,
  IconSearch,
  IconChevronLeft,
  IconChevronDown,
  IconArrowUp,
  IconLayoutGrid,
  IconHome,
  IconCpu,
  IconArchive,
} from "@/thesis/shared/Icon"

interface FileNode {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
  size?: number
  mtime?: number
}

const EXT_COLOR: Record<string, string> = {
  py: "#3776AB",
  ts: "#3178C6",
  tsx: "#3178C6",
  js: "#F7DF1E",
  jsx: "#F7DF1E",
  json: "#888892",
  yaml: "#CB171E",
  yml: "#CB171E",
  toml: "#9C4221",
  md: "var(--color-text-faint)",
  ipynb: "#F37626",
  parquet: "#50C878",
  rs: "#CE412B",
  go: "#00ADD8",
  pdf: "#E5484D",
  tex: "#3D6117",
  png: "#8B5CF6",
  jpg: "#8B5CF6",
  jpeg: "#8B5CF6",
  svg: "#E34F26",
}

const ext = (name: string): string => {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

const parentOf = (p: string): string => {
  const trimmed = p.replace(/\/+$/, "")
  const i = trimmed.lastIndexOf("/")
  if (i <= 0) return "/"
  return trimmed.slice(0, i)
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let val = bytes / 1024
  let u = 0
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024
    u++
  }
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[u]}`
}

function relativeTime(mtime?: number): string {
  if (!mtime) return ""
  const diff = Date.now() - mtime
  const s = Math.round(diff / 1000)
  if (s < 60) return "now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.ignored !== b.ignored) return a.ignored ? 1 : -1
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function ListGlyph(props: { size?: number }): JSX.Element {
  const s = props.size ?? 12
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <line x1="5" y1="4" x2="14" y2="4" />
      <line x1="5" y1="8" x2="14" y2="8" />
      <line x1="5" y1="12" x2="14" y2="12" />
      <circle cx="2.5" cy="4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Host file explorer. Navigates real directories via sdk.client.file.list
 * (the `directory` query param re-roots the backend Instance, so any absolute
 * path is browsable). Clicking a folder navigates in; clicking a file opens a
 * center-pane document tab. An "artifacts" toggle swaps in the project's
 * Atlas artifacts instead of the host filesystem.
 */
export function FileExplorer(): JSX.Element {
  const sdk = useSDK()
  const sync = useSync()

  const projectRoot = () => sync.project?.worktree || sync.data.path.directory || sdk.directory
  const home = () => sync.data.path.home || projectRoot()

  const [cwd, setCwd] = createSignal(projectRoot())
  const [history, setHistory] = createSignal<string[]>([])
  const [filter, setFilter] = createSignal("")
  // Debounced copy of `filter` that actually drives the (heavier) list filter,
  // so sorting/filtering the directory doesn't rerun on every keystroke.
  const [query, setQuery] = createSignal("")
  let filterTimer: ReturnType<typeof setTimeout> | undefined
  const setFilterDebounced = (v: string) => {
    setFilter(v)
    clearTimeout(filterTimer)
    filterTimer = setTimeout(() => setQuery(v), 110)
  }
  const clearFilter = () => {
    clearTimeout(filterTimer)
    setFilter("")
    setQuery("")
  }
  onCleanup(() => clearTimeout(filterTimer))
  const [view, setView] = createSignal<"list" | "grid">("list")
  const [mode, setMode] = createSignal<"host" | "artifacts">("host")
  const [pathDraft, setPathDraft] = createSignal(cwd())
  const [refreshKey, setRefreshKey] = createSignal(0)
  const [machineMenu, setMachineMenu] = createSignal(false)
  const [permissionError, setPermissionError] = createSignal<string | null>(null)

  // Keep the editable path bar synced to the current directory unless the user
  // is typing (they focus the input → onFocus stops the sync-through).
  let editing = false

  const navigate = (dir: string, push = true) => {
    const target = dir || "/"
    if (push && target !== cwd()) setHistory((h) => [...h, cwd()])
    setCwd(target)
    setPathDraft(target)
    clearFilter()
  }
  const goBack = () => {
    const h = history()
    if (!h.length) return
    const prev = h[h.length - 1]
    setHistory(h.slice(0, -1))
    setCwd(prev)
    setPathDraft(prev)
    clearFilter()
  }
  const goUp = () => navigate(parentOf(cwd()))

  const [entries] = createResource(
    () => [cwd(), refreshKey(), mode()] as const,
    async ([dir, , m]) => {
      if (m !== "host") return [] as FileNode[]
      setPermissionError(null)
      if (!dir) return [] as FileNode[]
      try {
        // Pass the params FLAT — the generated client maps `directory`/`path`
        // into the query string via buildClientParams; a `{ query: {...} }`
        // wrapper is silently dropped (no key matches), which sends neither
        // param and 400s. `directory` re-roots the backend Instance, letting us
        // browse any host directory (see server middleware + File.list).
        const res: any = await sdk.client.file.list({ directory: dir, path: "." })
        const data = res?.data ?? res
        return Array.isArray(data) ? (data as FileNode[]) : []
      } catch (err: any) {
        // throwOnError surfaces the response body (a plain-text HTTPException
        // message on macOS: "permission denied reading … — grant Full Disk
        // Access"). Detect that so the SPA can prompt for FDA instead of
        // silently showing an empty folder.
        const msg = String(err?.body?.message ?? err?.message ?? (typeof err === "string" ? err : "") ?? "")
        const status = err?.response?.status ?? err?.status ?? err?.statusCode
        if (status === 403 || /permission denied|full disk access/i.test(msg)) {
          setPermissionError(msg || "OpenScience cannot read this directory")
        }
        return [] as FileNode[]
      }
    },
  )

  // Sort once per directory load (stale-while-revalidate: `entries.latest`
  // keeps the previous folder's rows on screen while the next one fetches, so
  // navigating never blanks to an empty "loading…" flash). Filtering then runs
  // over the already-sorted list against the debounced query.
  const sorted = createMemo(() => sortNodes(entries.latest ?? []))
  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim()
    const rows = sorted()
    if (!q) return rows
    return rows.filter((n) => n.name.toLowerCase().includes(q))
  })

  const openFile = (node: FileNode) => centerTabs.openFile(cwd(), node.name)
  const onRowClick = (node: FileNode) => {
    if (node.type === "directory") navigate(node.absolute)
    else openFile(node)
  }

  const machineLabel = () => {
    const segs = home().split("/").filter(Boolean)
    return segs[segs.length - 1] || "This computer"
  }

  return (
    <div
      style={{
        flex: 1,
        "min-height": 0,
        "min-width": 0,
        display: "flex",
        "flex-direction": "column",
        overflow: "hidden",
      }}
    >
      {/* toolbar row 1: machine + toggles */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          padding: "10px 12px",
          "border-bottom": "1px solid var(--color-border)",
          "flex-shrink": 0,
        }}
      >
        <div style={{ position: "relative" }}>
          <button type="button" onClick={() => setMachineMenu((v) => !v)} style={machineBtn()}>
            <IconCpu size={13} strokeWidth={1.5} />
            <span style={{ display: "flex", "flex-direction": "column", "line-height": 1.15, "text-align": "left" }}>
              <span style={{ "font-size": "11px", color: "var(--color-text)" }}>This computer</span>
              <span style={{ "font-size": "10px", color: "var(--color-text-faint)" }}>{machineLabel()}</span>
            </span>
            <IconChevronDown size={11} strokeWidth={1.5} />
          </button>
          <Show when={machineMenu()}>
            <div onMouseLeave={() => setMachineMenu(false)} style={menuCard()}>
              <button
                type="button"
                style={menuRow()}
                onClick={() => {
                  navigate(home())
                  setMachineMenu(false)
                }}
              >
                <IconHome size={12} strokeWidth={1.5} />
                <span style={{ flex: 1, "text-align": "left" }}>Home</span>
              </button>
              <button
                type="button"
                style={menuRow()}
                onClick={() => {
                  navigate(projectRoot())
                  setMachineMenu(false)
                }}
              >
                <IconFolder size={12} strokeWidth={1.5} />
                <span style={{ flex: 1, "text-align": "left" }}>Project root</span>
              </button>
            </div>
          </Show>
        </div>

        <span style={{ flex: 1 }} />

        {/* host / artifacts pill toggle */}
        <div style={pill()}>
          <button type="button" style={pillBtn(mode() === "host")} onClick={() => setMode("host")}>
            <IconFolder size={11} strokeWidth={1.6} />
            files
          </button>
          <button type="button" style={pillBtn(mode() === "artifacts")} onClick={() => setMode("artifacts")}>
            <IconArchive size={11} strokeWidth={1.6} />
            artifacts
          </button>
        </div>

        {/* list / grid pill toggle */}
        <Show when={mode() === "host"}>
          <div style={pill()}>
            <button type="button" title="list" style={pillBtn(view() === "list")} onClick={() => setView("list")}>
              <ListGlyph size={12} />
            </button>
            <button type="button" title="grid" style={pillBtn(view() === "grid")} onClick={() => setView("grid")}>
              <IconLayoutGrid size={12} strokeWidth={1.6} />
            </button>
          </div>
        </Show>
      </div>

      <Show when={mode() === "host"} fallback={<ArtifactsPanel />}>
        {/* toolbar row 2: back / up / path bar / refresh */}
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "6px",
            padding: "8px 12px",
            "border-bottom": "1px solid var(--color-border)",
            "flex-shrink": 0,
          }}
        >
          <button
            type="button"
            title="back"
            disabled={!history().length}
            style={navBtn(!history().length)}
            onClick={goBack}
          >
            <IconChevronLeft size={13} strokeWidth={1.6} />
          </button>
          <button type="button" title="up" style={navBtn(false)} onClick={goUp}>
            <IconArrowUp size={13} strokeWidth={1.6} />
          </button>
          <div style={pathBar()}>
            <input
              value={pathDraft()}
              spellcheck={false}
              onFocus={() => (editing = true)}
              onBlur={() => {
                editing = false
                setPathDraft(cwd())
              }}
              onInput={(e) => setPathDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  editing = false
                  navigate(pathDraft().trim())
                  e.currentTarget.blur()
                }
                if (e.key === "Escape") {
                  setPathDraft(cwd())
                  e.currentTarget.blur()
                }
              }}
              placeholder="/absolute/path"
              style={{
                all: "unset",
                flex: 1,
                "min-width": 0,
                "font-family": FONT_MONO,
                "font-size": "11px",
                color: "var(--color-text)",
              }}
            />
          </div>
          <button type="button" title="refresh" style={navBtn(false)} onClick={() => setRefreshKey((k) => k + 1)}>
            <IconRefresh size={12} strokeWidth={1.6} />
          </button>
        </div>

        {/* search */}
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "6px",
            padding: "8px 14px",
            "border-bottom": "1px solid var(--color-border)",
            "flex-shrink": 0,
          }}
        >
          <IconSearch size={11} strokeWidth={1.5} />
          <input
            value={filter()}
            onInput={(e) => setFilterDebounced(e.currentTarget.value)}
            placeholder="filter this folder…"
            style={{
              all: "unset",
              flex: 1,
              "font-family": FONT_MONO,
              "font-size": "11px",
              color: "var(--color-text)",
            }}
          />
          <span style={{ "font-family": FONT_MONO, "font-size": "10px", color: "var(--color-text-faint)" }}>
            {filtered().length} items
          </span>
        </div>

        {/* body */}
        <div class="thesis-scroll" style={{ flex: 1, "min-height": 0, "overflow-y": "auto", "overflow-x": "hidden" }}>
          <Show when={!entries.loading || entries.latest} fallback={<div style={emptyMsg()}>loading…</div>}>
            <Show
              when={!permissionError()}
              fallback={
                <div
                  style={{
                    display: "flex",
                    "flex-direction": "column",
                    "align-items": "center",
                    gap: "8px",
                    padding: "40px 22px",
                    "text-align": "center",
                  }}
                >
                  <IconFolder size={20} strokeWidth={1.4} />
                  <div
                    style={{
                      "font-family": FONT_SANS,
                      "font-size": "13px",
                      "font-weight": 500,
                      color: "var(--color-text)",
                    }}
                  >
                    Can't read this folder
                  </div>
                  <div
                    style={{
                      "font-family": FONT_SANS,
                      "font-size": "12px",
                      color: "var(--color-text-faint)",
                      "line-height": 1.5,
                      "max-width": "320px",
                    }}
                  >
                    {permissionError()}
                  </div>
                  <button
                    type="button"
                    onClick={() => setRefreshKey((k) => k + 1)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      "margin-top": "2px",
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
              <Show when={filtered().length > 0} fallback={<div style={emptyMsg()}>empty folder</div>}>
                <Show when={view() === "list"} fallback={<GridBody nodes={filtered()} onClick={onRowClick} />}>
                  <ListBody nodes={filtered()} onClick={onRowClick} />
                </Show>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function ListBody(props: { nodes: FileNode[]; onClick: (n: FileNode) => void }): JSX.Element {
  return (
    <div>
      <div style={colHeader()}>
        <span style={{ flex: 1 }}>Name</span>
        <span style={{ width: "78px", "text-align": "right" }}>Size</span>
        <span style={{ width: "78px", "text-align": "right" }}>Modified</span>
      </div>
      <For each={props.nodes}>
        {(node) => {
          const c =
            node.type === "directory" ? "var(--color-text)" : (EXT_COLOR[ext(node.name)] ?? "var(--color-text-muted)")
          return (
            <button
              type="button"
              onClick={() => props.onClick(node)}
              title={node.absolute}
              style={row(node.ignored)}
              onMouseEnter={(el) => (el.currentTarget.style.background = "var(--color-accent-subtle)")}
              onMouseLeave={(el) => (el.currentTarget.style.background = "transparent")}
            >
              <span style={{ display: "inline-flex", color: c, "flex-shrink": 0 }}>
                <Show when={node.type === "directory"} fallback={<IconFile size={13} strokeWidth={1.5} />}>
                  <IconFolder size={13} strokeWidth={1.5} />
                </Show>
              </span>
              <span
                style={{
                  flex: 1,
                  "min-width": 0,
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                }}
              >
                {node.name}
              </span>
              <span style={cell()}>{formatSize(node.size)}</span>
              <span style={cell()}>{relativeTime(node.mtime)}</span>
            </button>
          )
        }}
      </For>
    </div>
  )
}

function GridBody(props: { nodes: FileNode[]; onClick: (n: FileNode) => void }): JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        "grid-template-columns": "repeat(auto-fill, minmax(108px, 1fr))",
        gap: "8px",
        padding: "12px 14px",
      }}
    >
      <For each={props.nodes}>
        {(node) => {
          const c =
            node.type === "directory" ? "var(--color-text)" : (EXT_COLOR[ext(node.name)] ?? "var(--color-text-muted)")
          return (
            <button
              type="button"
              onClick={() => props.onClick(node)}
              title={node.absolute}
              style={card(node.ignored)}
              onMouseEnter={(el) => (el.currentTarget.style.background = "var(--color-accent-subtle)")}
              onMouseLeave={(el) => (el.currentTarget.style.background = "var(--color-surface-solid)")}
            >
              <span style={{ display: "inline-flex", color: c }}>
                <Show when={node.type === "directory"} fallback={<IconFile size={22} strokeWidth={1.3} />}>
                  <IconFolder size={22} strokeWidth={1.3} />
                </Show>
              </span>
              <span
                style={{
                  width: "100%",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                  "text-align": "center",
                }}
              >
                {node.name}
              </span>
            </button>
          )
        }}
      </For>
    </div>
  )
}

// ── Artifacts (project Atlas graph) ────────────────────────────────
type ArtifactRow = { node: ThesisNode; artifact: { name?: string; kind?: string; uri?: string } }

function ArtifactsPanel(): JSX.Element {
  const sync = useSync()
  const sdk = useSDK()
  const directory = () => sync.project?.worktree || sync.data.path.directory || sdk.directory
  const [data] = createResource(directory, async (dir) => {
    try {
      const pid = (await thesisAPI.resolveProject(dir)).project_id
      if (!pid) return [] as ArtifactRow[]
      const tree = await thesisAPI.getGraphTree(pid)
      const rows: ArtifactRow[] = []
      for (const node of tree.nodes ?? []) {
        try {
          const res = await thesisAPI.listArtifacts(node.node_id)
          const items = Array.isArray(res) ? res : (res.artifacts ?? [])
          for (const a of items) rows.push({ node, artifact: a })
        } catch {}
      }
      return rows
    } catch {
      return [] as ArtifactRow[]
    }
  })
  return (
    <div class="thesis-scroll" style={{ flex: 1, "min-height": 0, "overflow-y": "auto", padding: "8px 4px" }}>
      <Show
        when={(data.latest ?? []).length > 0}
        fallback={
          <div style={emptyMsg()}>
            {data.loading ? "loading artifacts…" : "no artifacts yet · attach a file to seed one"}
          </div>
        }
      >
        <div style={colHeader()}>
          <span style={{ width: "60px" }}>Kind</span>
          <span style={{ flex: 1 }}>Name</span>
          <span style={{ width: "120px", "text-align": "right" }}>Node</span>
        </div>
        <For each={data.latest ?? []}>
          {(r) => (
            <div style={{ ...row(false), cursor: "default" }}>
              <span
                style={{
                  width: "60px",
                  "font-family": FONT_MONO,
                  "font-size": "10px",
                  color: "var(--color-text-faint)",
                  "flex-shrink": 0,
                }}
              >
                {r.artifact.kind ?? "—"}
              </span>
              <span
                style={{
                  flex: 1,
                  "min-width": 0,
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                }}
              >
                {r.artifact.name ?? r.artifact.uri ?? "?"}
              </span>
              <span style={{ ...cell(), width: "120px", color: "var(--color-text-muted)" }}>
                {r.node.title?.slice(0, 20) ?? r.node.slug_name ?? "—"}
              </span>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

// ── styles ─────────────────────────────────────────────────────────
function machineBtn(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    gap: "8px",
    padding: "5px 10px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-surface-solid)",
    "font-family": FONT_MONO,
    color: "var(--color-text-muted)",
  } as JSX.CSSProperties
}

function menuCard(): JSX.CSSProperties {
  return {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    "min-width": "170px",
    background: "var(--color-surface-solid)",
    border: "1px solid var(--color-border-strong)",
    "border-radius": "4px",
    "box-shadow": "var(--shadow-md)",
    padding: "5px",
    "z-index": 40,
  } as JSX.CSSProperties
}

function menuRow(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "flex",
    "align-items": "center",
    gap: "8px",
    width: "100%",
    "box-sizing": "border-box",
    padding: "7px 9px",
    "border-radius": "4px",
    "font-family": FONT_MONO,
    "font-size": "11px",
    color: "var(--color-text-muted)",
  } as JSX.CSSProperties
}

function pill(): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "2px",
    padding: "2px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-subtle)",
  } as JSX.CSSProperties
}

function pillBtn(active: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    gap: "5px",
    padding: "4px 9px",
    "border-radius": "4px",
    "font-family": FONT_MONO,
    "font-size": "11px",
    "font-weight": active ? 600 : 500,
    color: active ? "var(--color-text)" : "var(--color-text-muted)",
    background: active ? "var(--color-surface-solid)" : "transparent",
    "box-shadow": active ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
    transition: "all 120ms ease",
  } as JSX.CSSProperties
}

function navBtn(disabled: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    width: "28px",
    height: "28px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-surface-solid)",
    color: "var(--color-text-muted)",
    opacity: disabled ? 0.4 : 1,
    "flex-shrink": 0,
  } as JSX.CSSProperties
}

function pathBar(): JSX.CSSProperties {
  return {
    flex: 1,
    "min-width": 0,
    display: "flex",
    "align-items": "center",
    height: "28px",
    padding: "0 10px",
    "box-sizing": "border-box",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-elevated)",
  } as JSX.CSSProperties
}

function colHeader(): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "10px",
    padding: "6px 16px",
    "font-family": FONT_MONO,
    "font-size": "10px",
    "letter-spacing": "0.08em",
    "text-transform": "uppercase",
    color: "var(--color-text-faint)",
    "border-bottom": "1px solid var(--color-border)",
    position: "sticky",
    top: 0,
    background: "var(--color-bg-subtle)",
    "z-index": 1,
  } as JSX.CSSProperties
}

function row(ignored: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    "box-sizing": "border-box",
    display: "flex",
    "align-items": "center",
    gap: "10px",
    width: "100%",
    padding: "7px 16px",
    "font-family": FONT_MONO,
    "font-size": "12px",
    color: "var(--color-text-muted)",
    opacity: ignored ? 0.5 : 1,
    "font-style": ignored ? "italic" : "normal",
    transition: "background 120ms ease",
  } as JSX.CSSProperties
}

function cell(): JSX.CSSProperties {
  return {
    width: "78px",
    "text-align": "right",
    "font-family": FONT_MONO,
    "font-size": "10px",
    color: "var(--color-text-faint)",
    "flex-shrink": 0,
  } as JSX.CSSProperties
}

function card(ignored: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    "box-sizing": "border-box",
    display: "flex",
    "flex-direction": "column",
    "align-items": "center",
    gap: "8px",
    padding: "14px 8px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-surface-solid)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    color: "var(--color-text-muted)",
    opacity: ignored ? 0.5 : 1,
    transition: "background 120ms ease",
  } as JSX.CSSProperties
}

function emptyMsg(): JSX.CSSProperties {
  return {
    display: "grid",
    "place-items": "center",
    padding: "40px 20px",
    "font-family": FONT_MONO,
    "font-size": "11px",
    color: "var(--color-text-faint)",
    "text-align": "center",
  } as JSX.CSSProperties
}
