import { createSignal, createMemo, createEffect, type JSX, Show, For, onMount, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@synsci/ui/context/dialog"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { DialogSettings } from "@/components/dialog-settings"
import { FolderPicker } from "@/atlas/FolderPicker"
import { uiStore } from "@/atlas/store/ui"
import {
  IconBookOpen,
  IconCpu,
  IconFile,
  IconFolder,
  IconMessageSquare,
  IconSearch,
  IconPlus,
  IconHome,
  IconSettings,
} from "@/atlas/shared/Icon"
import { projectHref, resolveProjectRoute } from "@/utils/project-route"
import { projectHint, projectName } from "@/pages/home-projects"
import { createProjectRequest } from "@/utils/openscience-fetch"
import { URLS } from "@/config/urls"

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

interface Cmd {
  id: string
  label: string
  hint?: string
  icon?: (p: { size?: number; strokeWidth?: number }) => JSX.Element
  category: string
  run: () => void
}

// Shape of GET /search — plain-text, case-insensitive substring matches
// scoped to the active project (capped at 20 per group server-side).
interface Hits {
  sessions: Array<{ id: string; title: string }>
  messages: Array<{ sessionID: string; messageID: string; role: string; snippet: string }>
  artifacts: Array<{ path: string; name: string; kind: string }>
}

const EMPTY: Hits = { sessions: [], messages: [], artifacts: [] }
const DEBOUNCE = 250
const REVEAL_TIMEOUT = 2000

function routeName(project: { worktree: string }) {
  const parts = project.worktree.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? "Current project"
}

// The transcript renders data-message-id anchors; after navigating to the
// session the target may not be mounted yet, so retry for up to ~2s.
function reveal(messageID: string) {
  const deadline = Date.now() + REVEAL_TIMEOUT
  const attempt = () => {
    const node = document.querySelector(`[data-message-id="${CSS.escape(messageID)}"]`)
    if (node) return node.scrollIntoView({ block: "center", behavior: "smooth" })
    if (Date.now() > deadline) return
    setTimeout(() => requestAnimationFrame(attempt), 100)
  }
  requestAnimationFrame(attempt)
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [highlighted, setHighlighted] = createSignal(0)
  const [hits, setHits] = createSignal<Hits>()
  const [searching, setSearching] = createSignal(false)
  const navigate = useNavigate()
  const params = useParams()
  const dialog = useDialog()
  const sync = useGlobalSync()
  const global = useGlobalSDK()
  const platform = usePlatform()
  let inputRef: HTMLInputElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: AbortController | undefined

  // The palette mounts on both the home page (no project) and project pages,
  // so the active project comes from the route rather than the SDK context.
  const active = createMemo(() => resolveProjectRoute(params.dir, sync.data.project))
  const request = createProjectRequest({
    baseUrl: () => global.url,
    fetch: () => platform.fetch ?? fetch,
    directory: () => active()?.directory ?? "",
    projectID: () => active()?.projectID,
  })

  createEffect(() => {
    const q = query().trim()
    const scoped = props.open && q.length >= 2 && active() !== undefined
    if (timer) clearTimeout(timer)
    inflight?.abort()
    if (!scoped) {
      setHits(undefined)
      setSearching(false)
      return
    }
    setSearching(true)
    timer = setTimeout(() => {
      const controller = new AbortController()
      inflight = controller
      request("/search", { signal: controller.signal }, { q })
        .then((res) => (res.ok ? (res.json() as Promise<Hits>) : EMPTY))
        .then((data) => {
          if (controller.signal.aborted) return
          setHits(data)
          setSearching(false)
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setHits(EMPTY)
          setSearching(false)
        })
    }, DEBOUNCE)
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    inflight?.abort()
  })

  const goTo = (project: (typeof sync.data.project)[number]) => navigate(projectHref(project))
  const openDirectory = (directory: string) => {
    void sync.project
      .resolve(directory)
      .then(goTo)
      .catch(() => undefined)
  }

  const showInAppPicker = () => {
    dialog.show(
      () => (
        <FolderPicker
          onSelect={(result) => {
            const directory = Array.isArray(result) ? result[0] : result
            if (!directory) return
            openDirectory(directory)
          }}
        />
      ),
      { onClose: () => {}, lite: true },
    )
  }

  const openFolderPicker = async () => {
    props.onClose()
    // Always use the in-app FolderPicker for visual consistency with the
    // rest of the UI — see the same reasoning in pages/home.tsx.
    showInAppPicker()
  }

  const cmds = createMemo<Cmd[]>(() => {
    const list: Cmd[] = []
    const scope = active()

    if (scope) {
      list.push({
        id: "new-session",
        label: "New session",
        hint: "⌘N",
        icon: IconPlus,
        category: "commands",
        run: () => navigate(projectHref(scope.project, scope.directory, "new")),
      })
      list.push({
        id: "open-files",
        label: "Open project files",
        hint: "Current project",
        icon: IconFile,
        category: "commands",
        run: () => uiStore.openContext("files"),
      })
      list.push({
        id: "compute-monitor",
        label: "Compute monitor",
        hint: "Current project",
        icon: IconCpu,
        category: "commands",
        run: () => uiStore.openContext("kernels"),
      })
      list.push({
        id: "documentation",
        label: "Open documentation",
        hint: "syntheticsciences.ai",
        icon: IconBookOpen,
        category: "commands",
        run: () => platform.openLink(URLS.site),
      })
      return list
    }

    list.push({
      id: "new-project",
      label: "Open folder…",
      hint: "Click-to-navigate folder picker",
      icon: IconPlus,
      category: "actions",
      run: openFolderPicker,
    })
    list.push({
      id: "open-settings",
      label: "Settings",
      hint: "Models · keys · MCP · appearance",
      icon: IconSettings,
      category: "actions",
      run: () => {
        props.onClose()
        dialog.show(() => <DialogSettings />)
      },
    })
    list.push({
      id: "back-home",
      label: "Back to projects",
      hint: "Return to the project grid",
      icon: IconHome,
      category: "actions",
      run: () => {
        props.onClose()
        navigate("/")
      },
    })

    sync.data.project.forEach((p) => {
      list.push({
        id: `proj-${p.id}`,
        label: projectName(p),
        hint: projectHint(p),
        icon: IconFolder,
        category: "projects",
        run: () => {
          props.onClose()
          goTo(p)
        },
      })
    })

    return list
  })

  const recent = createMemo<Cmd[]>(() => {
    const scope = active()
    if (!scope) return []
    const [store] = sync.child(scope.directory, { projectID: scope.projectID })
    return [...store.session]
      .filter((session) => !session.parentID && !session.time?.archived)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, 5)
      .map((session) => ({
        id: `recent-${session.id}`,
        label: session.title || "New session",
        hint: "Session",
        icon: IconMessageSquare,
        category: "recent sessions",
        run: () => navigate(projectHref(scope.project, scope.directory, session.id)),
      }))
  })

  // Search hits reuse the Cmd shape so the existing flat-list selection model
  // (highlight index, arrow keys, enter) spans the new groups unchanged.
  const results = createMemo<Cmd[]>(() => {
    const data = hits()
    const scope = active()
    if (!data || !scope) return []
    const titles = new Map(data.sessions.map((s) => [s.id, s.title]))
    const list: Cmd[] = []
    data.sessions.forEach((s) => {
      list.push({
        id: `session-${s.id}`,
        label: s.title,
        hint: "open session",
        icon: IconMessageSquare,
        category: "sessions",
        run: () => navigate(projectHref(scope.project, scope.directory, s.id)),
      })
    })
    data.messages.forEach((m) => {
      list.push({
        id: `message-${m.messageID}`,
        label: m.snippet,
        hint: `${m.role} · ${titles.get(m.sessionID) ?? m.sessionID}`,
        icon: IconSearch,
        category: "messages",
        run: () => {
          navigate(projectHref(scope.project, scope.directory, m.sessionID))
          reveal(m.messageID)
        },
      })
    })
    data.artifacts.forEach((a) => {
      list.push({
        id: `artifact-${a.path}`,
        label: a.name,
        hint: a.kind,
        icon: IconFile,
        category: "artifacts",
        run: () => uiStore.openFile(scope.directory, a.path),
      })
    })
    return list
  })

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim()
    const base = q
      ? cmds().filter((c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q))
      : [...recent(), ...cmds()]
    return [...base, ...results()]
  })

  const grouped = createMemo(() => {
    const map = new Map<string, Cmd[]>()
    filtered().forEach((c) => {
      const arr = map.get(c.category) ?? []
      arr.push(c)
      map.set(c.category, arr)
    })
    return Array.from(map.entries()).map(([category, cmds]) => ({ category, cmds }))
  })

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!props.open) return
      if (e.key === "Escape") {
        e.preventDefault()
        props.onClose()
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setHighlighted((h) => Math.min(filtered().length - 1, h + 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setHighlighted((h) => Math.max(0, h - 1))
      } else if (e.key === "Enter") {
        e.preventDefault()
        const cmd = filtered()[highlighted()]
        if (cmd) {
          cmd.run()
          props.onClose()
          setQuery("")
          setHighlighted(0)
        }
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  return (
    <Show when={props.open}>
      <Portal>
        <div class="atlas-overlay" onClick={props.onClose} />
        <div
          class="atlas-modal atlas-fade-in command-palette"
          role="dialog"
          aria-modal="true"
          aria-label="command palette"
          onClick={(e) => e.stopPropagation()}
          ref={(el) => {
            requestAnimationFrame(() => inputRef?.focus())
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "10px",
              padding: "13px 16px",
              "border-bottom": "1px solid var(--color-border)",
            }}
          >
            <span style={{ display: "inline-flex", color: "var(--color-text-faint)" }}>
              <IconSearch size={13} strokeWidth={1.5} />
            </span>
            <input
              ref={inputRef}
              aria-label={active() ? "Search this project" : "Search projects and actions"}
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value)
                setHighlighted(0)
              }}
              placeholder={active() ? "Search this project…" : "Search projects and actions…"}
              autofocus
              style={{
                all: "unset",
                flex: 1,
                "font-family": FONT_MONO,
                "font-size": "13px",
                color: "var(--color-text)",
              }}
            />
            <span
              style={{
                "font-family": FONT_MONO,
                "font-size": "11px",
                color: "var(--color-text-faint)",
                "text-transform": "uppercase",
                "letter-spacing": "0.08em",
              }}
            >
              {active() ? routeName(active()!.project) : `${filtered().length} matches`}
            </span>
          </div>

          <div class="atlas-scroll" style={{ "overflow-y": "auto", "max-height": "52vh", padding: "6px 0" }}>
            <Show
              when={filtered().length > 0 || searching()}
              fallback={
                <div
                  style={{
                    padding: "32px",
                    "text-align": "center",
                    "font-family": FONT_MONO,
                    "font-size": "11px",
                    color: "var(--color-text-faint)",
                  }}
                >
                  no matches
                </div>
              }
            >
              <For each={grouped()}>
                {(group) => (
                  <div>
                    <div
                      style={{
                        padding: "7px 16px 5px",
                        "font-family": FONT_MONO,
                        "font-size": "11px",
                        "letter-spacing": "0.08em",
                        "text-transform": "uppercase",
                        color: "var(--color-text-faint)",
                      }}
                    >
                      {group.category}
                    </div>
                    <For each={group.cmds}>
                      {(cmd) => {
                        const idx = () => filtered().indexOf(cmd)
                        return (
                          <button
                            onClick={() => {
                              cmd.run()
                              props.onClose()
                              setQuery("")
                              setHighlighted(0)
                            }}
                            onMouseEnter={() => setHighlighted(idx())}
                            style={{
                              all: "unset",
                              cursor: "pointer",
                              display: "flex",
                              "align-items": "center",
                              gap: "10px",
                              width: "100%",
                              "box-sizing": "border-box",
                              "min-height": "40px",
                              padding: "9px 16px",
                              background: highlighted() === idx() ? "var(--color-accent-subtle)" : "transparent",
                              transition: "background 120ms ease",
                            }}
                          >
                            <Show when={cmd.icon}>
                              <span
                                style={{
                                  display: "inline-flex",
                                  color: "var(--color-text-faint)",
                                }}
                              >
                                {cmd.icon!({ size: 12, strokeWidth: 1.7 })}
                              </span>
                            </Show>
                            <span
                              style={{
                                "font-family": FONT_MONO,
                                "font-size": "13px",
                                color: "var(--color-text)",
                                overflow: "hidden",
                                "text-overflow": "ellipsis",
                                "white-space": "nowrap",
                              }}
                            >
                              {cmd.label}
                            </span>
                            <Show when={cmd.hint}>
                              <span style={{ flex: 1 }} />
                              <span
                                style={{
                                  "font-family": FONT_SANS,
                                  "font-size": "12px",
                                  color: "var(--color-text-faint)",
                                  overflow: "hidden",
                                  "text-overflow": "ellipsis",
                                  "white-space": "nowrap",
                                  "max-width": "260px",
                                }}
                              >
                                {cmd.hint}
                              </span>
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                )}
              </For>
              <Show when={searching()}>
                <div
                  style={{
                    padding: "10px 16px",
                    "font-family": FONT_MONO,
                    "font-size": "11px",
                    "letter-spacing": "0.08em",
                    color: "var(--color-text-faint)",
                  }}
                >
                  searching…
                </div>
              </Show>
            </Show>
          </div>

          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "12px",
              padding: "8px 16px",
              "border-top": "1px solid var(--color-border)",
              background: "var(--color-bg-subtle)",
              "font-family": FONT_MONO,
              "font-size": "11px",
              color: "var(--color-text-faint)",
            }}
          >
            <Hint k="↑↓" l="navigate" />
            <Hint k="↵" l="select" />
            <Hint k="esc" l="close" />
            <span style={{ flex: 1 }} />
            <span style={{ "letter-spacing": "0.04em" }}>local search</span>
            <span style={{ "letter-spacing": "0.04em" }}>⌘K</span>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

function Hint(props: { k: string; l: string }): JSX.Element {
  return (
    <span style={{ display: "inline-flex", "align-items": "center", gap: "4px" }}>
      <kbd
        style={{
          "font-family": FONT_MONO,
          "font-size": "10px",
          padding: "0 4px",
          border: "1px solid var(--color-border)",
          "border-radius": "4px",
          color: "var(--color-text-muted)",
        }}
      >
        {props.k}
      </kbd>
      <span>{props.l}</span>
    </span>
  )
}
