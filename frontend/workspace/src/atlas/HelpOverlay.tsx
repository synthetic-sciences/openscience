import { type JSX, Show, For, onMount, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "@/styles/tokens"
import { IconX } from "@/atlas/shared/Icon"
import { AgentIcon } from "@/atlas/shared/AgentIcon"

interface HelpOverlayProps {
  open: boolean
  onClose: () => void
}

const SECTIONS: Array<{ title: string; rows: Array<{ keys: string[]; label: string }> }> = [
  {
    title: "help.section.navigation",
    rows: [
      { keys: ["⌘", "K"], label: "help.action.commandPalette" },
      { keys: ["⌘", "N"], label: "help.action.openFolder" },
      { keys: ["?"], label: "help.action.openHelp" },
    ],
  },
  {
    title: "help.section.chat",
    rows: [
      { keys: ["↵"], label: "help.action.sendMessage" },
      { keys: ["⇧", "↵"], label: "help.action.newline" },
      { keys: ["/"], label: "help.action.skillMenu" },
      { keys: ["esc"], label: "help.action.closeModal" },
    ],
  },
  {
    title: "help.section.sessions",
    rows: [{ keys: ["dbl-click"], label: "help.action.renameSession" }],
  },
]

export function HelpOverlay(props: HelpOverlayProps): JSX.Element {
  const language = useLanguage()
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
        <div class="atlas-overlay" onClick={props.onClose} />
        <div class="atlas-modal" style={{ width: "560px", "max-width": "94vw" }} onClick={(e) => e.stopPropagation()}>
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
              {language.t("help.heading")}
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
            class="atlas-scroll"
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
                    {language.t(section.title)}
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
                          {language.t(row.label)}
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
