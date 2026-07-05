import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@synsci/util/encode"
import { DateTime } from "luxon"
import { useDialog } from "@synsci/ui/context/dialog"
import { FolderPicker } from "@/thesis/FolderPicker"
import { FdaBanner } from "@/thesis/FdaBanner"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useTheme } from "@synsci/ui/theme"
import { Wordmark } from "@/thesis/Wordmark"
import { AppHeader, HeaderIconButton } from "@/thesis/AppHeader"
import { AgentIcon } from "@/thesis/shared/AgentIcon"
import { toast } from "@/thesis/Toast"
import { ToastContainer } from "@/thesis/Toast"
import { DialogSettings } from "@/components/dialog-settings"
import { DisconnectedPanel } from "@/thesis/DisconnectedPanel"
import { uiStore } from "@/thesis/store/ui"
import { useGlobalKeys } from "@/thesis/useGlobalKeys"
import { CommandPalette } from "@/thesis/CommandPalette"
import { HelpOverlay } from "@/thesis/HelpOverlay"
import { projectPrefs } from "@/thesis/store/projectPrefs"
import { IconStar, IconStarFilled, IconTrash } from "@/thesis/shared/Icon"
import {
  IconArrowRight,
  IconClock,
  IconFolder,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSun,
} from "@/thesis/shared/Icon"
import { FONT_CODE, FONT_MONO, FONT_SANS, FONT_SERIF } from "@/styles/tokens"

/** 26px bordered icon button shared by the hover action clusters in grid cards and list rows. */
const ACTION_BUTTON: JSX.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  width: "26px",
  height: "26px",
  "border-radius": "4px",
  background: "var(--color-surface-solid)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text-faint)",
  transition: "all var(--duration-fast) var(--ease-standard)",
}

/**
 * Home page — Conductor-style project grid backed by openscience's GlobalSync.
 *
 * The new visual identity (OpenScience atom + Synthetic Sciences serif wordmark,
 * gradient mesh background, hover-lift cards, blue CTA) sits on top of the
 * unchanged data + navigation flow:
 *  - useGlobalSync.data.project for the recent projects list
 *  - useLayout.projects.open + server.projects.touch for "opened" tracking
 *  - navigate("/${base64(dir)}/session") to land in the working chat
 */
export default function Home(): JSX.Element {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const theme = useTheme()
  const homedir = createMemo(() => sync.data.path.home)
  const [filter, setFilter] = createSignal("")
  const VIEW_KEY = "thesis-projects-view-v1"
  const [view, setViewRaw] = createSignal<"grid" | "list">(
    (() => {
      try {
        return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"
      } catch {
        return "grid"
      }
    })(),
  )
  const setView = (v: "grid" | "list") => {
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {}
    setViewRaw(v)
  }

  // Favorites bubble to the top, hidden projects drop out, the rest sort by
  // last-updated. The sort is stable so within each band order is preserved.
  // OpenScience occasionally registers two project entries for the same worktree
  // (different IDs, same path); collapse those to the most-recently-updated
  // entry per worktree so each card shows once.
  const projects = createMemo(() => {
    const fav = projectPrefs.favorites()
    const hide = projectPrefs.hidden()
    const byWorktree = new Map<string, (typeof sync.data.project)[number]>()
    for (const p of sync.data.project) {
      if (!p.worktree || hide.has(p.worktree)) continue
      const existing = byWorktree.get(p.worktree)
      if (!existing) {
        byWorktree.set(p.worktree, p)
        continue
      }
      const cur = p.time.updated ?? p.time.created ?? 0
      const old = existing.time.updated ?? existing.time.created ?? 0
      if (cur > old) byWorktree.set(p.worktree, p)
    }
    return Array.from(byWorktree.values()).sort((a, b) => {
      const af = fav.has(a.worktree) ? 1 : 0
      const bf = fav.has(b.worktree) ? 1 : 0
      if (af !== bf) return bf - af
      return (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)
    })
  })

  const filtered = createMemo(() => {
    const q = filter().toLowerCase().trim()
    const all = projects()
    if (!q) return all
    return all.filter((p) => p.worktree.toLowerCase().includes(q))
  })

  function openProject(directory: string) {
    // Visiting a path also un-hides it, so a previously-deleted card
    // re-appears on the home grid as soon as the user opens it again.
    projectPrefs.unhide(directory)
    layout.projects.open(directory)
    server.projects.touch(directory)
    // Opening a folder (or a session) creates no Atlas state. The atlas CLI
    // handles projects and nodes on demand when the agent uses it.
    navigate(`/${base64Encode(directory)}/session`)
  }

  /**
   * "open folder…" / "+ new project" — pick a directory and open it.
   *
   * Path priority:
   *   1. desktop app (Tauri NSOpenPanel) — gives absolute paths native.
   *   2. web with showDirectoryPicker (Chromium) — opens the real OS
   *      Finder/Explorer dialog. The browser hides the absolute path
   *      for security so we resolve via /api/resolve-folder, which
   *      walks the user's home dirs on the dev server side and returns
   *      the matching absolute path. Disambiguation hint = the first
   *      child entry name we read from the picked directory handle.
   *   3. fallback — our in-app FolderPicker (openscience /file backed).
   */
  async function chooseProject() {
    function resolveResult(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) openProject(directory)
      } else if (result) {
        openProject(result)
      }
    }
    // Tauri desktop wrapper still uses the native NSOpenPanel — it returns
    // absolute paths directly and keeps the desktop app feeling native.
    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolveResult(result)
      return
    }
    // Browser: always use the in-app Finder-style FolderPicker for visual
    // consistency with the rest of the UI. The OS-native browser picker
    // (showDirectoryPicker / osascript dialog) is intentionally bypassed.
    // `lite` mode skips the modal backdrop and body scroll lock so the
    // picker glides in over the page instead of triggering a reflow.
    dialog.show(() => <FolderPicker onSelect={resolveResult} />, { onClose: () => resolveResult(null), lite: true })
  }

  const isDark = () => theme.mode() === "dark"
  const cycleScheme = () => theme.setColorScheme(isDark() ? "light" : "dark")
  useGlobalKeys({ onNew: () => void chooseProject() })

  return (
    <div
      class="thesis-root"
      style={{
        flex: 1,
        display: "flex",
        "flex-direction": "column",
        "min-height": 0,
        overflow: "hidden",
        background: "var(--color-bg)",
      }}
    >
      <ToastContainer />
      <HelpOverlay open={uiStore.helpOpen()} onClose={() => uiStore.setHelpOpen(false)} />
      <CommandPalette open={uiStore.paletteOpen()} onClose={() => uiStore.setPaletteOpen(false)} />
      <DisconnectedPanel />
      <AppHeader>
        <Wordmark size="md" />
        <span style={{ flex: 1 }} />
        <div
          style={{
            display: "inline-flex",
            "align-items": "center",
            gap: "6px",
            height: "32px",
            "box-sizing": "border-box",
            padding: "0 10px",
            "border-radius": "4px",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-solid)",
            "min-width": "240px",
          }}
        >
          <IconSearch size={12} strokeWidth={1.5} />
          <input
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            placeholder="search projects…"
            style={{
              all: "unset",
              flex: 1,
              "font-family": FONT_SANS,
              "font-size": "13px",
              color: "var(--color-text)",
            }}
          />
        </div>
        <FdaBanner />
        <button
          onClick={chooseProject}
          title="open folder (⌘O)"
          style={{
            all: "unset",
            cursor: "pointer",
            display: "inline-flex",
            "align-items": "center",
            gap: "6px",
            height: "32px",
            "box-sizing": "border-box",
            padding: "0 14px",
            "border-radius": "4px",
            background: "var(--color-accent)",
            color: "var(--color-on-accent)",
            "font-family": FONT_SANS,
            "font-size": "13px",
            "font-weight": 400,
            "box-shadow": "var(--shadow-sm)",
          }}
        >
          <IconPlus size={12} strokeWidth={2} />
          new project
        </button>
        <HeaderIconButton onClick={cycleScheme} title="toggle theme">
          <Show when={isDark()} fallback={<IconMoon size={13} strokeWidth={1.5} />}>
            <IconSun size={13} strokeWidth={1.5} />
          </Show>
        </HeaderIconButton>
        <HeaderIconButton onClick={() => dialog.show(() => <DialogSettings />)} title="settings">
          <IconSettings size={13} strokeWidth={1.5} />
        </HeaderIconButton>
        <button
          onClick={() => dialog.show(() => <DialogSelectServer />)}
          title={`server · ${server.name}`}
          style={{
            all: "unset",
            cursor: "pointer",
            display: "inline-flex",
            "align-items": "center",
            gap: "6px",
            height: "32px",
            "box-sizing": "border-box",
            padding: "0 10px",
            "border-radius": "4px",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-solid)",
            "font-family": FONT_MONO,
            "font-size": "10px",
            color: "var(--color-text-muted)",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              "border-radius": "50%",
              background:
                server.healthy() === true
                  ? "var(--color-success)"
                  : server.healthy() === false
                    ? "var(--color-error)"
                    : "var(--color-text-faint)",
            }}
          />
          {server.name}
        </button>
      </AppHeader>

      <main
        class="thesis-scroll"
        style={{
          flex: 1,
          "overflow-y": "auto",
          padding: "44px 32px 80px",
          "max-width": "1240px",
          margin: "0 auto",
          width: "100%",
          "box-sizing": "border-box",
        }}
      >
        <Show when={projects().length > 0} fallback={<EmptyHero onChoose={chooseProject} />}>
          <div
            style={{
              display: "flex",
              "align-items": "baseline",
              "justify-content": "space-between",
              gap: "14px",
              "margin-bottom": "16px",
            }}
          >
            <div style={{ display: "flex", "align-items": "baseline", gap: "9px" }}>
              <h1
                style={{
                  "font-family": FONT_SANS,
                  "font-size": "17px",
                  "font-weight": 700,
                  "letter-spacing": "-0.01em",
                  margin: 0,
                  color: "var(--color-text)",
                }}
              >
                Projects
              </h1>
              <span
                style={{
                  "font-family": FONT_MONO,
                  "font-size": "11px",
                  color: "var(--color-text-faint)",
                }}
              >
                {projects().length}
              </span>
            </div>
            <ViewToggle view={view()} onChange={setView} />
          </div>
          <Show
            when={filtered().length > 0}
            fallback={<NoProjectMatches query={filter()} onClear={() => setFilter("")} onChoose={chooseProject} />}
          >
            <Show
              when={view() === "grid"}
              fallback={
                <div
                  style={{
                    display: "flex",
                    "flex-direction": "column",
                    border: "1px solid var(--color-border)",
                    "border-radius": "4px",
                    overflow: "hidden",
                  }}
                >
                  <For each={filtered()}>
                    {(p, i) => (
                      <ProjectRow
                        worktree={p.worktree}
                        homedir={homedir()}
                        updatedAt={p.time.updated ?? p.time.created}
                        last={i() === filtered().length - 1}
                        isFavorite={projectPrefs.isFavorite(p.worktree)}
                        onOpen={() => openProject(p.worktree)}
                        onToggleFavorite={() => {
                          projectPrefs.toggleFavorite(p.worktree)
                          toast.info(projectPrefs.isFavorite(p.worktree) ? "favorited" : "unfavorited", p.worktree)
                        }}
                        onHide={() => {
                          projectPrefs.hide(p.worktree)
                          toast.info("removed from list", p.worktree)
                        }}
                      />
                    )}
                  </For>
                </div>
              }
            >
              <div
                style={{
                  display: "grid",
                  "grid-template-columns": "repeat(auto-fill, minmax(264px, 1fr))",
                  gap: "10px",
                }}
              >
                <For each={filtered()}>
                  {(p) => (
                    <ProjectCard
                      worktree={p.worktree}
                      homedir={homedir()}
                      updatedAt={p.time.updated ?? p.time.created}
                      isFavorite={projectPrefs.isFavorite(p.worktree)}
                      onOpen={() => openProject(p.worktree)}
                      onToggleFavorite={() => {
                        projectPrefs.toggleFavorite(p.worktree)
                        toast.info(projectPrefs.isFavorite(p.worktree) ? "favorited" : "unfavorited", p.worktree)
                      }}
                      onHide={() => {
                        projectPrefs.hide(p.worktree)
                        toast.info("removed from list", p.worktree)
                      }}
                    />
                  )}
                </For>
                <NewProjectCard onClick={chooseProject} />
              </div>
            </Show>
          </Show>
        </Show>
      </main>
    </div>
  )
}

function NoProjectMatches(props: { query: string; onClear: () => void; onChoose: () => void }): JSX.Element {
  return (
    <div
      style={{
        padding: "42px 20px",
        border: "1px dashed var(--color-border-strong)",
        "border-radius": "4px",
        background: "var(--color-surface-solid)",
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        gap: "12px",
        "text-align": "center",
      }}
    >
      <div style={{ "font-family": FONT_SERIF, "font-size": "24px", color: "var(--color-text)" }}>
        No matching projects
      </div>
      <div
        style={{
          "font-family": FONT_SANS,
          "font-size": "13px",
          color: "var(--color-text-muted)",
          "line-height": 1.5,
        }}
      >
        Nothing matched <code style={{ "font-family": FONT_CODE }}>{props.query}</code>.
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button type="button" onClick={props.onClear} style={emptyButton()}>
          clear search
        </button>
        <button type="button" onClick={props.onChoose} style={emptyButton(true)}>
          open folder
        </button>
      </div>
    </div>
  )
}

function emptyButton(primary = false): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    padding: "6px 12px",
    "border-radius": "4px",
    border: primary ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
    background: primary ? "var(--color-accent)" : "var(--color-bg-elevated)",
    color: primary ? "var(--color-on-accent)" : "var(--color-text)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    "font-weight": 400,
  }
}

function ProjectCard(props: {
  worktree: string
  homedir?: string
  updatedAt: number
  isFavorite: boolean
  onOpen: () => void
  onToggleFavorite: () => void
  onHide: () => void
}): JSX.Element {
  const [hover, setHover] = createSignal(false)
  const display = () => (props.homedir ? props.worktree.replace(props.homedir, "~") : props.worktree)
  const name = () => {
    const segs = props.worktree.split("/").filter(Boolean)
    return segs[segs.length - 1] ?? props.worktree
  }
  return (
    <div
      role="button"
      tabindex="0"
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          props.onOpen()
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      class="thesis-stagger"
      style={{
        cursor: "pointer",
        display: "flex",
        "flex-direction": "column",
        gap: "8px",
        padding: "13px 15px",
        background: hover() ? "var(--color-bg-elevated)" : "var(--color-surface-solid)",
        border: "1px solid var(--color-border)",
        "border-radius": "4px",
        transition: "border-color 140ms ease, background 140ms ease",
        "border-color": hover() ? "var(--color-border-strong)" : "var(--color-border)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "9px", position: "relative" }}>
        <FolderGlyph />
        <div style={{ flex: 1, "min-width": 0 }}>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "6px",
            }}
          >
            <span
              style={{
                "font-family": FONT_SANS,
                "font-size": "15px",
                "font-weight": 400,
                color: "var(--color-text)",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
                "min-width": 0,
                flex: 1,
              }}
            >
              {name()}
            </span>
            <Show when={props.isFavorite}>
              <span
                style={{
                  display: "inline-flex",
                  color: "var(--color-warning)",
                  "flex-shrink": 0,
                }}
                title="favorite"
              >
                <IconStarFilled size={12} />
              </span>
            </Show>
          </div>
          <div
            style={{
              "font-family": FONT_MONO,
              "font-size": "11px",
              color: "var(--color-text-faint)",
              "margin-top": "1px",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {display()}
          </div>
        </div>
      </div>

      {/* Hover-revealed action cluster — top-right corner */}
      <div
        style={{
          position: "absolute",
          top: "10px",
          right: "10px",
          display: "flex",
          gap: "4px",
          opacity: hover() || props.isFavorite ? 1 : 0,
          transform: hover() ? "translateY(0)" : "translateY(-4px)",
          transition: "opacity 160ms ease, transform 160ms ease",
          "pointer-events": hover() || props.isFavorite ? "auto" : "none",
        }}
      >
        <button
          type="button"
          title={props.isFavorite ? "unfavorite" : "favorite"}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleFavorite()
          }}
          style={{
            ...ACTION_BUTTON,
            color: props.isFavorite ? "var(--color-warning)" : "var(--color-text-faint)",
          }}
          onMouseEnter={(el) => {
            el.currentTarget.style.borderColor = "var(--color-border-strong)"
            if (!props.isFavorite) el.currentTarget.style.color = "var(--color-warning)"
          }}
          onMouseLeave={(el) => {
            el.currentTarget.style.borderColor = "var(--color-border)"
            if (!props.isFavorite) el.currentTarget.style.color = "var(--color-text-faint)"
          }}
        >
          <Show when={props.isFavorite} fallback={<IconStar size={12} strokeWidth={1.5} />}>
            <IconStarFilled size={12} />
          </Show>
        </button>
        <button
          type="button"
          title="remove from list"
          onClick={(e) => {
            e.stopPropagation()
            props.onHide()
          }}
          style={ACTION_BUTTON}
          onMouseEnter={(el) => {
            el.currentTarget.style.borderColor = "var(--color-error)"
            el.currentTarget.style.color = "var(--color-error)"
          }}
          onMouseLeave={(el) => {
            el.currentTarget.style.borderColor = "var(--color-border)"
            el.currentTarget.style.color = "var(--color-text-faint)"
          }}
        >
          <IconTrash size={12} strokeWidth={1.5} />
        </button>
      </div>
      <div style={{ flex: 1 }} />
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          "font-family": FONT_MONO,
          "font-size": "11px",
          color: "var(--color-text-faint)",
        }}
      >
        <span style={{ display: "inline-flex", "align-items": "center", gap: "5px" }}>
          <IconClock size={11} strokeWidth={1.5} />
          {DateTime.fromMillis(props.updatedAt).toRelative() ?? "—"}
        </span>
        <span style={{ flex: 1 }} />
        <Show when={hover()}>
          <span
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "4px",
              color: "var(--color-text)",
              "font-weight": 400,
            }}
          >
            open
            <IconArrowRight size={11} strokeWidth={1.5} />
          </span>
        </Show>
      </div>
    </div>
  )
}

function ViewToggle(props: { view: "grid" | "list"; onChange: (v: "grid" | "list") => void }): JSX.Element {
  const btn = (active: boolean): JSX.CSSProperties => ({
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    width: "28px",
    height: "26px",
    "border-radius": "4px",
    color: active ? "var(--color-text)" : "var(--color-text-faint)",
    background: active ? "var(--color-surface-solid)" : "transparent",
    border: active ? "1px solid var(--color-border)" : "1px solid transparent",
  })
  return (
    <div
      style={{
        display: "inline-flex",
        gap: "2px",
        padding: "2px",
        "border-radius": "4px",
        background: "var(--color-bg-subtle)",
        border: "1px solid var(--color-border)",
      }}
    >
      <button type="button" title="grid view" style={btn(props.view === "grid")} onClick={() => props.onChange("grid")}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.2" />
          <rect x="14" y="3" width="7" height="7" rx="1.2" />
          <rect x="3" y="14" width="7" height="7" rx="1.2" />
          <rect x="14" y="14" width="7" height="7" rx="1.2" />
        </svg>
      </button>
      <button type="button" title="list view" style={btn(props.view === "list")} onClick={() => props.onChange("list")}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
        </svg>
      </button>
    </div>
  )
}

function ProjectRow(props: {
  worktree: string
  homedir?: string
  updatedAt: number
  last?: boolean
  isFavorite: boolean
  onOpen: () => void
  onToggleFavorite: () => void
  onHide: () => void
}): JSX.Element {
  const [hover, setHover] = createSignal(false)
  const display = () => (props.homedir ? props.worktree.replace(props.homedir, "~") : props.worktree)
  const name = () => {
    const segs = props.worktree.split("/").filter(Boolean)
    return segs[segs.length - 1] ?? props.worktree
  }
  return (
    <div
      role="button"
      tabindex="0"
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          props.onOpen()
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: "pointer",
        display: "flex",
        "align-items": "center",
        gap: "10px",
        padding: "6px 14px",
        "border-bottom": props.last ? "none" : "1px solid var(--color-border)",
        background: hover() ? "var(--color-bg-elevated)" : "transparent",
        transition: "background 120ms ease",
      }}
    >
      <FolderGlyph />
      <span
        style={{
          "font-family": FONT_SANS,
          "font-size": "13px",
          "font-weight": 400,
          color: "var(--color-text)",
          "flex-shrink": 0,
        }}
      >
        {name()}
      </span>
      <Show when={props.isFavorite}>
        <span style={{ display: "inline-flex", color: "var(--color-warning)", "flex-shrink": 0 }}>
          <IconStarFilled size={12} />
        </span>
      </Show>
      <span
        style={{
          flex: 1,
          "min-width": 0,
          "font-family": FONT_MONO,
          "font-size": "11px",
          color: "var(--color-text-faint)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {display()}
      </span>
      <span
        style={{ "font-family": FONT_MONO, "font-size": "11px", color: "var(--color-text-faint)", "flex-shrink": 0 }}
      >
        {DateTime.fromMillis(props.updatedAt).toRelative() ?? "—"}
      </span>
      <div
        style={{
          display: "flex",
          gap: "4px",
          "flex-shrink": 0,
          opacity: hover() || props.isFavorite ? 1 : 0,
          "pointer-events": hover() || props.isFavorite ? "auto" : "none",
          transition: "opacity 140ms ease",
        }}
      >
        <button
          type="button"
          title={props.isFavorite ? "unfavorite" : "favorite"}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleFavorite()
          }}
          style={{
            ...ACTION_BUTTON,
            color: props.isFavorite ? "var(--color-warning)" : "var(--color-text-faint)",
          }}
          onMouseEnter={(el) => {
            el.currentTarget.style.borderColor = "var(--color-border-strong)"
            if (!props.isFavorite) el.currentTarget.style.color = "var(--color-warning)"
          }}
          onMouseLeave={(el) => {
            el.currentTarget.style.borderColor = "var(--color-border)"
            if (!props.isFavorite) el.currentTarget.style.color = "var(--color-text-faint)"
          }}
        >
          <Show when={props.isFavorite} fallback={<IconStar size={12} strokeWidth={1.5} />}>
            <IconStarFilled size={12} />
          </Show>
        </button>
        <button
          type="button"
          title="remove from list"
          onClick={(e) => {
            e.stopPropagation()
            props.onHide()
          }}
          style={ACTION_BUTTON}
          onMouseEnter={(el) => {
            el.currentTarget.style.borderColor = "var(--color-error)"
            el.currentTarget.style.color = "var(--color-error)"
          }}
          onMouseLeave={(el) => {
            el.currentTarget.style.borderColor = "var(--color-border)"
            el.currentTarget.style.color = "var(--color-text-faint)"
          }}
        >
          <IconTrash size={12} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

function NewProjectCard(props: { onClick: () => void }): JSX.Element {
  const [hover, setHover] = createSignal(false)
  return (
    <button
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      class="thesis-stagger"
      style={{
        all: "unset",
        cursor: "pointer",
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        gap: "6px",
        padding: "13px 15px",
        background: "transparent",
        border: hover() ? "1px dashed var(--color-text-faint)" : "1px dashed var(--color-border-strong)",
        "border-radius": "4px",
        color: hover() ? "var(--color-text)" : "var(--color-text-faint)",
        transition: "border-color 160ms ease, color 160ms ease",
      }}
    >
      <IconPlus size={15} strokeWidth={2} />
      <span style={{ "font-family": FONT_SANS, "font-size": "13px", "font-weight": 400 }}>new project</span>
    </button>
  )
}

function EmptyHero(props: { onChoose: () => void }): JSX.Element {
  return (
    <div
      class="thesis-fade-in"
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        gap: "20px",
        padding: "100px 24px 64px",
        "text-align": "center",
      }}
    >
      <AgentIcon size={56} animated={false} strokeWidth={1.0} />
      <h1
        style={{
          "font-family": FONT_SERIF,
          "font-size": "48px",
          "font-weight": 400,
          "letter-spacing": "-0.025em",
          "line-height": 1.1,
          margin: 0,
          color: "var(--color-text)",
        }}
      >
        Start a project
      </h1>
      <p
        style={{
          "font-family": FONT_SANS,
          "font-size": "15px",
          "line-height": 1.55,
          color: "var(--color-text-muted)",
          "max-width": "500px",
          margin: 0,
        }}
      >
        Pick a folder to work in — your sessions stay organized around it.
      </p>
      <div style={{ display: "flex", gap: "10px", "margin-top": "8px" }}>
        <button
          onClick={props.onChoose}
          style={{
            all: "unset",
            cursor: "pointer",
            display: "inline-flex",
            "align-items": "center",
            gap: "8px",
            padding: "12px 22px",
            "border-radius": "4px",
            background: "var(--color-accent)",
            color: "var(--color-on-accent)",
            "font-family": FONT_SANS,
            "font-size": "14px",
            "font-weight": 400,
            "box-shadow": "var(--shadow-md)",
          }}
        >
          <IconFolder size={14} strokeWidth={1.5} />
          open folder…
        </button>
      </div>
      <div
        style={{
          "font-family": FONT_MONO,
          "font-size": "11px",
          color: "var(--color-text-faint)",
          "letter-spacing": "0.06em",
          "margin-top": "16px",
        }}
      >
        ⌘K command palette · ? help
      </div>
    </div>
  )
}

function FolderGlyph(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{ "flex-shrink": 0, color: "var(--color-text-faint)" }}
    >
      <path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h4l1.8 2H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z" />
    </svg>
  )
}
