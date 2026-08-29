/**
 * Browsable skills popover for the composer. Lists every available skill
 * (from the live `sync.data.skill` store) grouped by category/origin, with
 * search and full descriptions. Picking one prefills `/<name> ` into the
 * prompt — the same invoke convention as the inline slash autocomplete.
 */
import { createSignal, createMemo, onMount, onCleanup, For, Show, type JSX } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { useDialog } from "@synsci/ui/context/dialog"
import { Icon } from "@synsci/ui/icon"
import { useSync } from "@/context/sync"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { IconSearch } from "@/atlas/shared/Icon"
import { skillCatalogSnapshot } from "./skill-permissions"
import { skillIconFor } from "./skill-icon"
import "./skills-browser.css"

const SKILL_LIBRARY_INITIAL_ROWS = 60
const SKILL_LIBRARY_ROW_BATCH = 60

interface SkillRow {
  name: string
  description: string
  location: string
  origin?: "default" | "installed" | "user" | "project"
  category?: string
  tags?: string[]
  entry?: boolean
}

function originOf(skill: SkillRow): string {
  if (skill.origin) return skill.origin
  if (skill.location.includes("installed-skills")) return "installed"
  return "default"
}

function sentence(value: string) {
  const text = value.trim()
  if (!text) return text
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`
}

export function SkillsBrowser(props: { onPick: (name: string) => void; onClose: () => void }): JSX.Element {
  const sync = useSync()
  const [query, setQuery] = createSignal("")
  let panelRef: HTMLDivElement | undefined

  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (panelRef && !panelRef.contains(e.target as Node)) props.onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    // Defer so the click that opened the popover doesn't immediately close it.
    setTimeout(() => document.addEventListener("pointerdown", onDown), 0)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown)
      document.removeEventListener("keydown", onKey)
    })
  })

  const groups = createMemo(() => {
    const all = skillCatalogSnapshot((sync.data.skill ?? []) as SkillRow[], {
      permission: sync.data.config.permission,
    }).allowed
    const q = query().trim().toLowerCase()
    const filtered = q
      ? all.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            (s.description ?? "").toLowerCase().includes(q) ||
            (s.tags ?? []).some((t) => t.toLowerCase().includes(q)),
        )
      : all
    const map = new Map<string, SkillRow[]>()
    for (const s of filtered) {
      const label = s.category || originOf(s)
      const arr = map.get(label) ?? []
      arr.push(s)
      map.set(label, arr)
    }
    return Array.from(map.entries())
      .map(([label, items]) => ({ label, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })

  const total = createMemo(() => groups().reduce((n, g) => n + g.items.length, 0))

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        right: 0,
        "margin-bottom": "6px",
        "max-height": "380px",
        display: "flex",
        "flex-direction": "column",
        background: "var(--color-surface-solid)",
        border: "1px solid var(--color-border-strong)",
        "border-radius": "4px",
        "box-shadow": "var(--shadow-md)",
        overflow: "hidden",
        "z-index": 40,
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          padding: "8px 10px",
          "border-bottom": "1px solid var(--color-border)",
        }}
      >
        <span
          style={{
            "font-family": FONT_MONO,
            "font-size": "10px",
            "letter-spacing": "normal",
            color: "var(--color-text-faint)",
          }}
        >
          Skills
        </span>
        <span
          class="tab-fig"
          style={{ "font-family": FONT_MONO, "font-size": "10px", color: "var(--color-text-muted)" }}
        >
          {total()}
        </span>
        <input
          autofocus
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search skills…"
          style={{
            all: "unset",
            flex: 1,
            "font-family": FONT_SANS,
            "font-size": "12px",
            color: "var(--color-text)",
            padding: "3px 10px",
          }}
        />
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close skills"
          title="Close (Esc)"
          style={{
            all: "unset",
            cursor: "pointer",
            color: "var(--color-text-faint)",
            "font-family": FONT_MONO,
            "font-size": "13px",
            padding: "0 4px",
          }}
        >
          ×
        </button>
      </div>

      <div class="atlas-scroll" style={{ "overflow-y": "auto", padding: "6px" }}>
        <Show
          when={total() > 0}
          fallback={
            <div
              style={{
                padding: "18px 10px",
                "text-align": "center",
                "font-family": FONT_MONO,
                "font-size": "11px",
                color: "var(--color-text-faint)",
              }}
            >
              No matching skills
            </div>
          }
        >
          <For each={groups()}>
            {(group) => (
              <div style={{ "margin-bottom": "6px" }}>
                <div
                  style={{
                    padding: "6px 8px 3px",
                    "font-family": FONT_MONO,
                    "font-size": "10px",
                    "letter-spacing": "normal",
                    color: "var(--color-text-faint)",
                  }}
                >
                  {sentence(group.label)}
                </div>
                <For each={group.items}>
                  {(skill) => (
                    <button
                      type="button"
                      onClick={() => props.onPick(skill.name)}
                      class="atlas-skill-row atlas-skill-row--popover"
                    >
                      <span
                        style={{
                          "font-family": FONT_SANS,
                          "font-size": "13px",
                          "font-weight": "var(--font-weight-medium)",
                          color: "var(--color-text)",
                        }}
                      >
                        /{skill.name}
                      </span>
                      <Show when={skill.description}>
                        <span
                          style={{
                            "font-family": FONT_SANS,
                            "font-size": "12px",
                            color: "var(--color-text-muted)",
                            "line-height": 1.45,
                            display: "-webkit-box",
                            "-webkit-line-clamp": "2",
                            "-webkit-box-orient": "vertical",
                            overflow: "hidden",
                          }}
                        >
                          {skill.description}
                        </span>
                      </Show>
                      <Show when={(skill.tags ?? []).length > 0}>
                        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px", "margin-top": "2px" }}>
                          <For each={(skill.tags ?? []).slice(0, 5)}>
                            {(tag) => (
                              <span
                                style={{
                                  "font-family": FONT_MONO,
                                  "font-size": "10px",
                                  color: "var(--color-text-faint)",
                                  background: "var(--color-accent-subtle)",
                                  padding: "1px 5px",
                                  "border-radius": "4px",
                                }}
                              >
                                {tag}
                              </span>
                            )}
                          </For>
                        </div>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

/**
 * Central skill-library modal. Shown through the app dialog system
 * (`dialog.show(() => <SkillLibraryDialog … />)`) as a proper centered
 * library window — search + grouped skill rows. Picking a skill fires
 * `onPick(name)` and closes the dialog; the caller decides what "pick"
 * means (the right pane prefills `/<name> ` into the composer).
 */
export function SkillLibraryDialog(props: { onPick: (name: string) => void; initialQuery?: string }): JSX.Element {
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal(props.initialQuery ?? "")
  const [visibleRows, setVisibleRows] = createSignal(SKILL_LIBRARY_INITIAL_ROWS)

  const matches = createMemo(() => {
    const all = skillCatalogSnapshot((sync.data.skill ?? []) as SkillRow[], {
      permission: sync.data.config.permission,
    }).allowed
    const q = query().trim().toLowerCase()
    return (
      q
        ? all.filter(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              (s.description ?? "").toLowerCase().includes(q) ||
              (s.tags ?? []).some((t) => t.toLowerCase().includes(q)),
          )
        : all
    ).toSorted(
      (a, b) => (a.category || originOf(a)).localeCompare(b.category || originOf(b)) || a.name.localeCompare(b.name),
    )
  })

  const visible = createMemo(() => matches().slice(0, visibleRows()))
  const groups = createMemo(() => {
    const map = new Map<string, SkillRow[]>()
    for (const s of visible()) {
      const label = s.category || originOf(s)
      const arr = map.get(label) ?? []
      arr.push(s)
      map.set(label, arr)
    }
    return Array.from(map.entries())
      .map(([label, items]) => ({ label, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })

  const total = createMemo(() => matches().length)
  const shown = createMemo(() => visible().length)
  const hasMore = createMemo(() => shown() < total())

  const revealMore = () => setVisibleRows((value) => Math.min(total(), value + SKILL_LIBRARY_ROW_BATCH))
  const handleScroll = (event: Event) => {
    if (!hasMore()) return
    const target = event.currentTarget as HTMLElement
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 240) revealMore()
  }

  const pick = (name: string) => {
    props.onPick(name)
    dialog.close()
  }

  return (
    <Dialog title="Skill Library" size="large" transition>
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "12px",
          width: "min(680px, 82vw)",
          "min-height": "440px",
          "max-height": "64vh",
        }}
      >
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            padding: "8px 10px",
            border: "1px solid var(--color-border-strong)",
            "border-radius": "4px",
            background: "var(--color-bg)",
          }}
        >
          <IconSearch size={13} strokeWidth={1.5} />
          <input
            autofocus
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setVisibleRows(SKILL_LIBRARY_INITIAL_ROWS)
            }}
            placeholder="Search skills…"
            aria-label="Search the skill library"
            style={{
              all: "unset",
              flex: 1,
              "font-family": FONT_SANS,
              "font-size": "14px",
              color: "var(--color-text)",
              padding: "3px 10px",
            }}
          />
          <span
            style={{
              "font-family": FONT_MONO,
              "font-size": "11px",
              "letter-spacing": "normal",
              color: "var(--color-text-faint)",
            }}
          >
            Skills: {shown() === total() ? total() : `${shown()} of ${total()}`}
          </span>
        </div>

        <div
          class="atlas-scroll"
          onScroll={handleScroll}
          style={{
            flex: 1,
            "min-height": 0,
            "overflow-y": "auto",
            display: "flex",
            "flex-direction": "column",
            gap: "14px",
            "padding-right": "2px",
          }}
        >
          <Show
            when={total() > 0}
            fallback={
              <div
                style={{
                  padding: "40px 10px",
                  "text-align": "center",
                  "font-family": FONT_MONO,
                  "font-size": "12px",
                  color: "var(--color-text-faint)",
                }}
              >
                No matching skills
              </div>
            }
          >
            <For each={groups()}>
              {(group) => (
                <div style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "8px",
                      padding: "0 4px 6px",
                      "border-bottom": "1px solid var(--color-border)",
                      "margin-bottom": "4px",
                      "font-family": FONT_MONO,
                      "font-size": "11px",
                      "letter-spacing": "normal",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    <span style={{ flex: 1 }}>{sentence(group.label)}</span>
                    <span>{group.items.length}</span>
                  </div>
                  <For each={group.items}>
                    {(skill) => (
                      <button
                        type="button"
                        onClick={() => pick(skill.name)}
                        class="atlas-skill-row atlas-skill-row--dialog"
                        aria-label={`Use the ${skill.name} skill`}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: "32px",
                            height: "32px",
                            display: "grid",
                            "place-items": "center",
                            "border-radius": "var(--radius-sm)",
                            background: "var(--color-accent-subtle)",
                            color: "var(--color-text-muted)",
                          }}
                        >
                          <Icon name={skillIconFor(skill)} size="small" />
                        </span>
                        <span style={{ display: "flex", "min-width": 0, "flex-direction": "column", gap: "3px" }}>
                          <span
                            style={{
                              "font-family": FONT_MONO,
                              "font-size": "14px",
                              "font-weight": "var(--font-weight-medium)",
                              color: "var(--color-text)",
                            }}
                          >
                            /{skill.name}
                          </span>
                          <Show when={skill.description}>
                            <span
                              style={{
                                "font-family": FONT_SANS,
                                "font-size": "13px",
                                color: "var(--color-text-muted)",
                                "line-height": 1.5,
                                display: "-webkit-box",
                                "-webkit-line-clamp": "2",
                                "-webkit-box-orient": "vertical",
                                overflow: "hidden",
                              }}
                            >
                              {skill.description}
                            </span>
                          </Show>
                          <Show when={(skill.tags ?? []).length > 0}>
                            <span style={{ display: "flex", "flex-wrap": "wrap", gap: "4px", "margin-top": "2px" }}>
                              <For each={(skill.tags ?? []).slice(0, 6)}>
                                {(tag) => (
                                  <span
                                    style={{
                                      "font-family": FONT_MONO,
                                      "font-size": "11px",
                                      color: "var(--color-text-faint)",
                                      background: "var(--color-accent-subtle)",
                                      padding: "1px 6px",
                                      "border-radius": "4px",
                                    }}
                                  >
                                    {tag}
                                  </span>
                                )}
                              </For>
                            </span>
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
            <Show when={hasMore()}>
              <button type="button" class="atlas-skill-browser__more" onClick={revealMore}>
                Show more skills
              </button>
            </Show>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
