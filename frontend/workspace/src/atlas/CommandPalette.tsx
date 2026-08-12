import { createSignal, createMemo, createEffect, type JSX, Show, For, onCleanup } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { uiStore } from "@/atlas/store/ui"
import { IconBolt, IconFile, IconFolder, IconMessageSquare, IconSearch } from "@/atlas/shared/Icon"
import { projectHref, resolveProjectRoute } from "@/utils/project-route"
import { projectName } from "@/pages/home-projects"
import { createProjectRequest } from "@/utils/openscience-fetch"
import { requestProjectSearch, type ProjectSearchHits } from "@/atlas/project-search"
import "./CommandPalette.css"

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
  highlight?: () => (() => void) | void
}

// Shape of GET /search — plain-text, case-insensitive substring matches
// scoped to the active project (capped at 20 per group server-side).
type Hits = ProjectSearchHits
const EMPTY: Hits = { sessions: [], messages: [], artifacts: [] }
const DEBOUNCE = 250
const REVEAL_TIMEOUT = 2000

function routeName(project: { worktree: string }) {
  const parts = project.worktree.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? "Current project"
}

function sentenceCase(value: string | undefined, fallback = "Commands") {
  const text = value?.trim() || fallback
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`
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
  const [searchError, setSearchError] = createSignal(false)
  const [searchRetry, setSearchRetry] = createSignal(0)
  const navigate = useNavigate()
  const params = useParams()
  const command = useCommand()
  const sync = useGlobalSync()
  const global = useGlobalSDK()
  const platform = usePlatform()
  let inputRef: HTMLInputElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: AbortController | undefined
  let clearHighlight: (() => void) | undefined
  let restoreFocus: HTMLElement | undefined
  let pendingRun: (() => void) | undefined

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
    searchRetry()
    const q = query().trim()
    const scoped = props.open && q.length >= 2 && active() !== undefined
    if (timer) clearTimeout(timer)
    inflight?.abort()
    if (!scoped) {
      setHits(undefined)
      setSearching(false)
      setSearchError(false)
      return
    }
    // Never present results from the previous query beneath a new search.
    // The aborted request cannot update state, while clearing here also covers
    // the debounce window before the replacement request starts.
    setHits(undefined)
    setSearching(true)
    setSearchError(false)
    timer = setTimeout(() => {
      const controller = new AbortController()
      inflight = controller
      requestProjectSearch(() => request("/search", { signal: controller.signal }, { q }))
        .then((data) => {
          if (controller.signal.aborted) return
          setHits(data)
          setSearching(false)
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setHits(EMPTY)
          setSearching(false)
          setSearchError(true)
        })
    }, DEBOUNCE)
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    inflight?.abort()
  })

  const goTo = (project: (typeof sync.data.project)[number]) => navigate(projectHref(project))
  const registered = createMemo<Cmd[]>(() => {
    const seen = new Set<string>()
    return command.options.flatMap((option) => {
      const id = option.id.replace(/^suggested\./, "")
      if (option.disabled || seen.has(id)) return []
      seen.add(id)
      const keybind = command.keybind(option.id)
      const description = option.description ? sentenceCase(option.description) : undefined
      const category = sentenceCase(option.category)
      return [
        {
          id: `command-${option.id}`,
          label: sentenceCase(option.title),
          hint: [category, description, keybind].filter(Boolean).join(" · ") || undefined,
          category: "Actions",
          run: () => command.trigger(option.id, "palette"),
          highlight: option.onHighlight,
        },
      ]
    })
  })

  const projects = createMemo<Cmd[]>(() => {
    if (active()) return []
    return sync.data.project.map((project) => ({
      id: `project-${project.id}`,
      label: projectName(project),
      hint: "Project workspace",
      icon: IconFolder,
      category: "Projects",
      run: () => goTo(project),
    }))
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
        hint: "Recent project session",
        icon: IconMessageSquare,
        category: "Recent sessions",
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
        label: s.title || "Untitled session",
        hint: "Project session",
        icon: IconMessageSquare,
        category: "Sessions",
        run: () => navigate(projectHref(scope.project, scope.directory, s.id)),
      })
    })
    data.messages.forEach((m) => {
      list.push({
        id: `message-${m.messageID}`,
        label: m.snippet,
        hint: `${sentenceCase(m.role)} message · ${titles.get(m.sessionID) ?? m.sessionID}`,
        icon: IconSearch,
        category: "Messages",
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
        hint: `${sentenceCase(a.kind)} · ${a.path}`,
        icon: IconFile,
        category: "Artifacts",
        run: () => uiStore.openFile(scope.directory, a.path),
      })
    })
    return list
  })

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim()
    const available = [...registered(), ...projects()]
    const base = q
      ? available.filter((item) => item.label.toLowerCase().includes(q) || item.hint?.toLowerCase().includes(q))
      : [...recent(), ...available]
    if (q && active()) return [...results(), ...base]
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

  const scope = createMemo(() => {
    const project = active()
    if (!project) return "All projects"
    return routeName(project.project)
  })

  const status = createMemo(() => {
    if (searching()) return "Searching…"
    if (searchError()) return "Search unavailable"
    const count = filtered().length
    return `${count} ${count === 1 ? "result" : "results"}`
  })

  const showStatus = createMemo(() => searching() || searchError() || query().trim().length > 0)

  const short = createMemo(() => active() !== undefined && query().trim().length === 1)

  createEffect(() => {
    const last = filtered().length - 1
    setHighlighted((current) => (last < 0 ? 0 : Math.min(current, last)))
  })

  createEffect(() => {
    clearHighlight?.()
    clearHighlight = undefined
    if (!props.open) return
    clearHighlight = filtered()[highlighted()]?.highlight?.() ?? undefined
  })

  createEffect(() => {
    if (!props.open || filtered().length === 0) return
    const id = `command-palette-option-${highlighted()}`
    queueMicrotask(() => document.getElementById(id)?.scrollIntoView({ block: "nearest" }))
  })

  createEffect(() => {
    if (!props.open) return
    command.keybinds(false)
    onCleanup(() => command.keybinds(true))
  })

  onCleanup(() => clearHighlight?.())

  const close = () => {
    setQuery("")
    setHighlighted(0)
    props.onClose()
  }

  const execute = (item: Cmd) => {
    pendingRun = item.run
    close()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // The retry action participates in the dialog focus trap. Let controls
    // other than the combobox handle their own keys instead of executing the
    // currently highlighted search result.
    if (event.target !== inputRef) return
    const last = filtered().length - 1
    if (event.key === "ArrowDown" && last >= 0) {
      event.preventDefault()
      setHighlighted((current) => (current >= last ? 0 : current + 1))
      return
    }
    if (event.key === "ArrowUp" && last >= 0) {
      event.preventDefault()
      setHighlighted((current) => (current <= 0 ? last : current - 1))
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    const item = filtered()[highlighted()]
    if (!item) return
    event.preventDefault()
    execute(item)
  }

  return (
    <Kobalte
      modal
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <Kobalte.Portal>
        <Kobalte.Overlay class="atlas-overlay command-palette__overlay" />
        <Kobalte.Content
          class="atlas-modal command-palette"
          role="dialog"
          aria-modal="true"
          aria-labelledby="command-palette-title"
          aria-describedby="command-palette-description"
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const active = document.activeElement
            restoreFocus = active instanceof HTMLElement && active !== document.body ? active : undefined
            inputRef?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (restoreFocus?.isConnected) restoreFocus.focus()
            const run = pendingRun
            pendingRun = undefined
            if (run) queueMicrotask(run)
          }}
        >
          <header class="command-palette__header">
            <Kobalte.Title id="command-palette-title" class="command-palette__sr-only">
              Command palette
            </Kobalte.Title>
            <Kobalte.Description id="command-palette-description" class="command-palette__sr-only">
              {active()
                ? "Search sessions, transcript messages, artifacts, and project actions."
                : "Open a project or run an available action."}
            </Kobalte.Description>

            <div class="command-palette__search" data-searching={searching() ? "true" : undefined}>
              <span class="command-palette__search-icon" aria-hidden="true">
                <IconSearch size={16} strokeWidth={1.5} />
              </span>
              <input
                ref={inputRef}
                aria-label={active() ? "Search this project" : "Search projects and actions"}
                role="combobox"
                aria-autocomplete="list"
                aria-controls="command-palette-results"
                aria-expanded="true"
                aria-activedescendant={filtered().length > 0 ? `command-palette-option-${highlighted()}` : undefined}
                value={query()}
                onInput={(event) => {
                  setQuery(event.currentTarget.value)
                  setHighlighted(0)
                }}
                placeholder={
                  active() ? "Search sessions, messages, files, and actions…" : "Search projects and actions…"
                }
                autofocus
              />
              <span class="command-palette__context" aria-hidden="true">
                <span class="command-palette__scope" title={scope()}>
                  {scope()}
                </span>
                <Show when={showStatus()}>
                  <span class="command-palette__context-separator">·</span>
                  <span class="command-palette__search-status">{status()}</span>
                </Show>
              </span>
            </div>
          </header>

          <div class="atlas-scroll command-palette__results-shell">
            <div
              id="command-palette-results"
              class="command-palette__results"
              role="listbox"
              aria-label="Commands and search results"
              aria-busy={searching()}
            >
              <For each={grouped()}>
                {(group) => (
                  <section class="command-palette__group" role="group" aria-label={group.category}>
                    <div class="command-palette__group-heading">
                      <span class="command-palette__group-title">{group.category}</span>
                    </div>
                    <div class="command-palette__options">
                      <For each={group.cmds}>
                        {(cmd) => {
                          const idx = () => filtered().indexOf(cmd)
                          const glyph = cmd.icon ?? IconBolt
                          return (
                            <button
                              class="command-palette__option"
                              type="button"
                              tabindex="-1"
                              id={`command-palette-option-${idx()}`}
                              role="option"
                              aria-selected={highlighted() === idx()}
                              onClick={() => {
                                execute(cmd)
                              }}
                              onMouseEnter={() => setHighlighted(idx())}
                            >
                              <span class="command-palette__option-icon" aria-hidden="true">
                                {glyph({ size: 15, strokeWidth: 1.5 })}
                              </span>
                              <span class="command-palette__option-copy">
                                <span class="command-palette__option-label">{cmd.label}</span>
                                <Show when={cmd.hint}>
                                  <span class="command-palette__option-hint">{cmd.hint}</span>
                                </Show>
                              </span>
                            </button>
                          )
                        }}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </div>
            <Show when={searching()}>
              <div class="command-palette__state command-palette__state--loading" role="status" aria-live="polite">
                <span class="command-palette__state-indicator" aria-hidden="true" />
                <span>Searching…</span>
              </div>
            </Show>
            <Show when={short() && filtered().length === 0}>
              <div class="command-palette__state" role="status" aria-live="polite">
                <span class="command-palette__state-copy">
                  <strong>Type one more character</strong>
                  <span>Project search starts after two characters.</span>
                </span>
              </div>
            </Show>
            <Show when={searchError() && !searching()}>
              <div class="command-palette__state command-palette__state--error" role="alert">
                <span class="command-palette__state-copy">
                  <strong>Search unavailable</strong>
                  <span>Project content could not be searched. Local actions are still available.</span>
                </span>
                <button type="button" onClick={() => setSearchRetry((value) => value + 1)}>
                  Retry
                </button>
              </div>
            </Show>
            <Show when={!searching() && !searchError() && !short() && filtered().length === 0}>
              <div class="command-palette__state" role="status" aria-live="polite">
                <span class="command-palette__state-copy">
                  <strong>No matches</strong>
                  <span>Try a session, message, file, or action.</span>
                </span>
              </div>
            </Show>
          </div>

          <footer class="command-palette__footer" aria-hidden="true">
            <span class="command-palette__footer-source">{active() ? "Local project search" : "OpenScience"}</span>
            <span class="command-palette__footer-spacer" />
            <Hint k="↑↓" l="Navigate" />
            <Hint k="↵" l="Open" />
            <Hint k="Esc" l="Close" />
          </footer>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

function Hint(props: { k: string; l: string }): JSX.Element {
  return (
    <span class="command-palette__hint">
      <kbd>{props.k}</kbd>
      <span>{props.l}</span>
    </span>
  )
}
