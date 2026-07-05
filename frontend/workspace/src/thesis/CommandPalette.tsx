import { createSignal, createMemo, type JSX, Show, For, onMount, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { useNavigate } from "@solidjs/router"
import { useDialog } from "@synsci/ui/context/dialog"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { base64Encode } from "@synsci/util/encode"
import { useGlobalSync } from "@/context/global-sync"
import { DialogSettings } from "@/components/dialog-settings"
import { FolderPicker } from "@/thesis/FolderPicker"
import { IconFolder, IconSearch, IconPlus, IconHome, IconSettings } from "@/thesis/shared/Icon"

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

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [highlighted, setHighlighted] = createSignal(0)
  const navigate = useNavigate()
  const dialog = useDialog()
  const sync = useGlobalSync()
  let inputRef: HTMLInputElement | undefined

  const goTo = (directory: string) => navigate(`/${base64Encode(directory)}/session`)

  const showInAppPicker = () => {
    dialog.show(
      () => (
        <FolderPicker
          onSelect={(result) => {
            const directory = Array.isArray(result) ? result[0] : result
            if (!directory) return
            goTo(directory)
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
      const segs = p.worktree.split("/").filter(Boolean)
      const name = segs[segs.length - 1] ?? p.worktree
      list.push({
        id: `proj-${p.id}`,
        label: name,
        hint: p.worktree,
        icon: IconFolder,
        category: "projects",
        run: () => {
          props.onClose()
          goTo(p.worktree)
        },
      })
    })

    return list
  })

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim()
    if (!q) return cmds()
    return cmds().filter((c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q))
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
        <div class="thesis-overlay" onClick={props.onClose} />
        <div
          class="thesis-modal thesis-fade-in"
          style={{
            top: "12vh",
            left: "50%",
            transform: "translateX(-50%)",
            width: "560px",
            "max-width": "92vw",
            "max-height": "70vh",
          }}
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
              padding: "12px 16px",
              "border-bottom": "1px solid var(--color-border)",
            }}
          >
            <span style={{ display: "inline-flex", color: "var(--color-text-faint)" }}>
              <IconSearch size={13} strokeWidth={1.5} />
            </span>
            <input
              ref={inputRef}
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value)
                setHighlighted(0)
              }}
              placeholder="search projects, sessions, actions…"
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
                "font-size": "10px",
                color: "var(--color-text-faint)",
                "text-transform": "uppercase",
                "letter-spacing": "0.08em",
              }}
            >
              {filtered().length} match{filtered().length === 1 ? "" : "es"}
            </span>
          </div>

          <div class="thesis-scroll" style={{ "overflow-y": "auto", "max-height": "52vh", padding: "6px 0" }}>
            <Show
              when={filtered().length > 0}
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
                        padding: "6px 16px",
                        "font-family": FONT_MONO,
                        "font-size": "10px",
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
                              padding: "8px 16px",
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
                                "font-size": "12px",
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
                                  "font-size": "11px",
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
              "font-size": "10px",
              color: "var(--color-text-faint)",
            }}
          >
            <Hint k="↑↓" l="navigate" />
            <Hint k="↵" l="select" />
            <Hint k="esc" l="close" />
            <span style={{ flex: 1 }} />
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
