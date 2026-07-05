import { Component, For, Suspense, createMemo, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Dialog } from "@synsci/ui/dialog"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { useDialog } from "@synsci/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { SETTINGS_PANELS, SETTINGS_SECTIONS, DEFAULT_PANEL, findPanel, type SettingsPanelId } from "./settings/registry"
import { SettingsNavContext } from "./settings/nav"

// Scoped to the settings dialog only. Reshapes shared primitives (Switch,
// Select) into the soft, rounded, iOS-style language settings uses — and widens
// the modal when expanded — without touching global component CSS or tokens.
const SETTINGS_STYLES = `
.settings-dialog [data-component="switch"] [data-slot="switch-control"] {
  width: 38px;
  height: 22px;
  border-radius: 999px;
  padding: 0;
}
.settings-dialog [data-component="switch"] [data-slot="switch-thumb"] {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: none;
  margin: 0 3px;
  transform: translateX(0);
}
.settings-dialog [data-component="switch"][data-checked] [data-slot="switch-control"],
.settings-dialog [data-component="switch"][data-checked]:hover:not([data-disabled],[data-readonly]) [data-slot="switch-control"] {
  background-color: var(--color-text-interactive-base, var(--icon-strong-base));
  border-color: var(--color-text-interactive-base, var(--icon-strong-base));
}
.settings-dialog [data-component="switch"][data-checked] [data-slot="switch-thumb"] {
  transform: translateX(16px);
}
.settings-dialog [data-slot="select-select-trigger"] {
  border-radius: 4px;
}
[data-component="select-content"][data-trigger-style="settings"] {
  border-radius: 4px;
  padding: 4px;
}
[data-component="select-content"][data-trigger-style="settings"] [data-slot="select-select-item"] {
  border-radius: 4px;
}

/* ── Fixed modal frame ──────────────────────────────────────────────────────
   The settings modal is ONE size regardless of the active panel. The rail +
   header stay fixed; only each panel body scrolls inside this frame. Without
   the height:100% override the shared dialog content grows to fit its content,
   so the box jumps size between tabs — the fix is to pin content to the fixed
   container height and let panels manage their own internal overflow. */
[data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-container"] {
  width: min(calc(100vw - 32px), 880px);
  height: min(calc(100vh - 40px), 640px);
}
[data-component="dialog"]:has([data-slot="dialog-content"].settings-expanded) [data-slot="dialog-container"] {
  width: min(calc(100vw - 32px), 1200px);
  height: min(calc(100vh - 40px), 840px);
}
[data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-content"] {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
`

export const DialogSettings: Component = () => {
  const platform = usePlatform()
  const dialog = useDialog()

  // Browser-style history so back/forward chevrons are real navigation.
  const [history, setHistory] = createSignal<SettingsPanelId[]>([DEFAULT_PANEL])
  const [cursor, setCursor] = createSignal(0)
  const [expanded, setExpanded] = createSignal(false)

  const current = createMemo(() => findPanel(history()[cursor()]))
  const canBack = createMemo(() => cursor() > 0)
  const canForward = createMemo(() => cursor() < history().length - 1)

  const navigate = (id: SettingsPanelId) => {
    if (history()[cursor()] === id) return
    const next = history().slice(0, cursor() + 1)
    next.push(id)
    setHistory(next)
    setCursor(next.length - 1)
  }
  const back = () => canBack() && setCursor(cursor() - 1)
  const forward = () => canForward() && setCursor(cursor() + 1)

  return (
    <Dialog size="x-large" transition class="settings-dialog" classList={{ "settings-expanded": expanded() }}>
      <style>{SETTINGS_STYLES}</style>
      <div class="flex h-full w-full">
        {/* ── Left rail ── */}
        <nav class="flex flex-col justify-between w-[224px] flex-shrink-0 border-r border-border-weak-base bg-surface-base/30 py-3 px-2.5">
          <div class="flex flex-col gap-5 overflow-y-auto no-scrollbar pt-1">
            <For each={SETTINGS_SECTIONS}>
              {(section) => (
                <div class="flex flex-col gap-1">
                  <span class="px-2.5 pb-1 thesis-section-label">{section.label}</span>
                  <For each={SETTINGS_PANELS.filter((p) => p.section === section.id)}>
                    {(panel) => (
                      <button
                        type="button"
                        class="flex items-center gap-2.5 h-8 px-2.5 rounded-xs text-13-medium transition-colors text-left"
                        classList={{
                          "bg-surface-raised-base-active text-text-strong": current().id === panel.id,
                          "text-text-weak hover:text-text-strong hover:bg-surface-raised-base/60":
                            current().id !== panel.id,
                        }}
                        onClick={() => navigate(panel.id)}
                        aria-current={current().id === panel.id ? "page" : undefined}
                      >
                        <Icon name={panel.icon} size="small" class="flex-shrink-0" />
                        <span class="truncate">{panel.title}</span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
          <div class="flex flex-col gap-0.5 px-2.5 pt-2 text-text-weak">
            <span class="text-12-medium">OpenScience</span>
            <span class="text-11-regular">v{platform.version}</span>
          </div>
        </nav>

        {/* ── Right column ── */}
        <div class="flex flex-col flex-1 min-w-0">
          {/* Header */}
          <header class="flex items-center justify-between gap-2 min-h-[52px] px-3 border-b border-border-weak-base flex-shrink-0">
            <div class="flex items-center gap-1 min-w-0">
              <IconButton icon="arrow-left" variant="ghost" disabled={!canBack()} onClick={back} aria-label="Back" />
              <IconButton
                icon="arrow-right"
                variant="ghost"
                disabled={!canForward()}
                onClick={forward}
                aria-label="Forward"
              />
              <span class="text-14-medium text-text-strong truncate pl-1">{current().title}</span>
            </div>
            <div class="flex items-center gap-1 flex-shrink-0">
              <IconButton
                icon={expanded() ? "collapse" : "expand"}
                variant="ghost"
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded() ? "Collapse" : "Expand"}
              />
              <IconButton icon="close" variant="ghost" onClick={() => dialog.close()} aria-label="Close" />
            </div>
          </header>

          {/* Body */}
          <div class="flex flex-col flex-1 min-h-0 overflow-hidden">
            <Suspense
              fallback={
                <div class="flex flex-1 items-center justify-center text-13-regular text-text-weak">Loading…</div>
              }
            >
              <SettingsNavContext.Provider value={navigate}>
                <Dynamic component={current().component} />
              </SettingsNavContext.Provider>
            </Suspense>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
