import { type JSX, Show, For, onMount, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "@/styles/tokens"
import { IconX } from "@/thesis/shared/Icon"
import { AgentIcon } from "@/thesis/shared/AgentIcon"

interface HelpOverlayProps {
  open: boolean
  onClose: () => void
}

const SECTIONS: Array<{ title: string; rows: Array<{ keys: string[]; label: string }> }> = [
  {
    title: "navigation",
    rows: [
      { keys: ["⌘", "K"], label: "command palette" },
      { keys: ["⌘", "N"], label: "open folder / new project" },
      { keys: ["?"], label: "open this help" },
    ],
  },
  {
    title: "chat",
    rows: [
      { keys: ["↵"], label: "send message" },
      { keys: ["⇧", "↵"], label: "newline in composer" },
      { keys: ["/"], label: "skill menu" },
      { keys: ["esc"], label: "close modal" },
    ],
  },
  {
    title: "sessions",
    rows: [{ keys: ["dbl-click"], label: "rename a session" }],
  },
]

export function HelpOverlay(props: HelpOverlayProps): JSX.Element {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.open) props.onClose()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  return (
    <Show when={props.open}>
      <Portal>
        <div class="thesis-overlay" onClick={props.onClose} />
        <div class="thesis-modal" style={{ width: "560px", "max-width": "94vw" }} onClick={(e) => e.stopPropagation()}>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "10px",
              padding: "16px 20px",
              "border-bottom": "1px solid var(--color-border)",
            }}
          >
            <AgentIcon size={20} strokeWidth={1.5} animated={true} />
            <span
              style={{
                "font-family": FONT_SERIF,
                "font-size": "22px",
                "letter-spacing": "-0.01em",
                color: "var(--color-text)",
              }}
            >
              keyboard shortcuts
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={props.onClose}
              style={{
                all: "unset",
                cursor: "pointer",
                color: "var(--color-text-faint)",
                display: "inline-flex",
                padding: "4px",
              }}
            >
              <IconX size={14} strokeWidth={1.5} />
            </button>
          </div>
          <div
            class="thesis-scroll"
            style={{
              padding: "20px 24px",
              "max-height": "70vh",
              "overflow-y": "auto",
              display: "flex",
              "flex-direction": "column",
              gap: "20px",
            }}
          >
            <For each={SECTIONS}>
              {(section) => (
                <section style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                  <div
                    style={{
                      "font-family": FONT_MONO,
                      "font-size": "10px",
                      "letter-spacing": "0.08em",
                      "text-transform": "uppercase",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    {section.title}
                  </div>
                  <For each={section.rows}>
                    {(row) => (
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "10px",
                          padding: "4px 0",
                        }}
                      >
                        <div style={{ display: "flex", gap: "3px", "min-width": "92px" }}>
                          <For each={row.keys}>
                            {(k) => (
                              <kbd
                                style={{
                                  "font-family": FONT_MONO,
                                  "font-size": "10px",
                                  padding: "2px 6px",
                                  border: "1px solid var(--color-border)",
                                  "border-bottom-width": "2px",
                                  "border-radius": "4px",
                                  background: "var(--color-bg-subtle)",
                                  color: "var(--color-text-muted)",
                                }}
                              >
                                {k}
                              </kbd>
                            )}
                          </For>
                        </div>
                        <span
                          style={{
                            "font-family": FONT_SANS,
                            "font-size": "13px",
                            color: "var(--color-text-muted)",
                            flex: 1,
                          }}
                        >
                          {row.label}
                        </span>
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
