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
.settings-dialog {
  font-family: var(--font-family-sans);
  font-feature-settings: var(--font-family-sans--font-feature-settings, normal);
  background: var(--background-base);
  color: var(--text-base);
}
.settings-dialog h2,
.settings-dialog h3,
.settings-dialog h4 {
  font-family: inherit;
  letter-spacing: -0.01em;
}
.settings-dialog button,
.settings-dialog input,
.settings-dialog select,
.settings-dialog textarea {
  font-family: inherit;
  text-transform: none;
}
.settings-dialog .atlas-section-label,
.settings-section-label {
  color: var(--text-weak);
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.01em;
  line-height: 16px;
  text-transform: none;
}
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
  border-radius: 9px;
}
[data-component="select-content"][data-trigger-style="settings"] {
  border-radius: 10px;
  padding: 5px;
}
[data-component="select-content"][data-trigger-style="settings"] [data-slot="select-select-item"] {
  border-radius: 7px;
}

/* ── Fixed modal frame ──────────────────────────────────────────────────────
   The settings modal is ONE size regardless of the active panel. The rail +
   header stay fixed; only each panel body scrolls inside this frame. Without
   the height:100% override the shared dialog content grows to fit its content,
   so the box jumps size between tabs — the fix is to pin content to the fixed
   container height and let panels manage their own internal overflow. */
[data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-container"] {
  width: min(calc(100vw - 32px), 960px);
  height: min(calc(100vh - 40px), 720px);
  overflow: hidden;
  border: 1px solid var(--border-base);
  border-radius: 16px;
  background: var(--background-base);
  box-shadow: 0 24px 80px color-mix(in srgb, #000 36%, transparent);
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

.settings-layout {
  display: flex;
  width: 100%;
  height: 100%;
}
.settings-nav {
  width: 206px;
  flex: 0 0 206px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 14px 10px;
  border-right: 1px solid var(--border-weak-base);
  background: var(--background-strong);
}
.settings-nav__sections {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-top: 4px;
  overflow-y: auto;
  scrollbar-width: none;
}
.settings-nav__sections::-webkit-scrollbar {
  display: none;
}
.settings-nav__section {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.settings-nav__label {
  padding: 0 7px 6px;
  color: var(--text-weaker);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}
.settings-nav__item {
  min-width: 0;
  min-height: 34px;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  padding: 4px 7px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
  color: var(--text-weak);
  text-align: left;
  transition: background 120ms ease, color 120ms ease;
}
.settings-nav__item:hover {
  background: var(--surface-raised-strong);
  color: var(--text-strong);
}
.settings-nav__item[data-active="true"] {
  background: var(--surface-raised-strong);
  color: var(--text-strong);
  box-shadow: none;
}
.settings-nav__item:focus-visible {
  outline: 1px solid var(--text-strong);
  outline-offset: -2px;
}
.settings-nav__footer {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 9px 0;
  color: var(--text-weak);
}
.settings-main {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  background: var(--background-base);
}
.settings-main__header {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-weak-base);
  flex-shrink: 0;
}
.settings-main__title {
  min-width: 0;
  overflow: hidden;
  padding-left: 4px;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-page-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  width: min(100%, 800px);
  flex-direction: column;
  gap: 12px;
  padding: 24px 32px 18px;
  background: linear-gradient(to bottom, var(--background-base) 84%, transparent);
}
.settings-page-header__inner {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.settings-page-header h2 {
  display: none;
}
.settings-page-header p {
  max-width: 660px;
  color: var(--text-weak);
  font-size: 13px;
  line-height: 1.5;
}
.settings-page-body {
  display: flex;
  width: min(100%, 800px);
  flex-direction: column;
  gap: 26px;
  padding: 2px 32px 48px;
}
.settings-section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}
.settings-section-heading > div {
  min-width: 0;
}
.settings-section-heading h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.35;
}
.settings-section-heading p {
  margin: 3px 0 0;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.45;
}
.settings-section-heading > span {
  flex: 0 0 auto;
  color: var(--text-weaker);
  font-size: 11px;
}
.settings-error {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--text-danger) 35%, var(--border-base));
  border-radius: 9px;
  color: var(--text-danger);
  font-size: 12px;
  line-height: 1.5;
}
.credential-services {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.settings-list {
  overflow: hidden;
  border: 1px solid var(--border-weak-base);
  border-radius: 12px;
  background: var(--surface-raised-base);
}
.settings-list-item + .settings-list-item {
  border-top: 1px solid var(--border-weak-base);
}
.settings-list-row {
  min-height: 62px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px 10px 14px;
}
.settings-list-copy {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}
.settings-list-copy strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}
.settings-list-copy span {
  overflow: hidden;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-list-actions,
.credential-form-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.credential-form {
  display: grid;
  gap: 12px;
  padding: 2px 14px 16px 57px;
}
.credential-form--custom {
  padding: 16px;
  border: 1px solid var(--border-weak-base);
  border-radius: 12px;
  background: var(--surface-raised-base);
}
.credential-form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(140px, 0.55fr);
  gap: 10px;
}
.credential-form label {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.credential-form label > span {
  color: var(--text-weak);
  font-size: 11px;
}
.credential-form input,
.credential-form textarea {
  width: 100%;
  min-height: 36px;
  padding: 8px 10px;
  border: 1px solid var(--border-weak-base);
  border-radius: 9px;
  outline: none;
  background: var(--surface-raised-strong);
  color: var(--text-strong);
  font-size: 13px;
}
.credential-form textarea {
  min-height: 94px;
  resize: vertical;
}
.credential-form input:focus,
.credential-form textarea:focus {
  border-color: var(--border-strong-base);
}
.credential-form > p {
  margin: -2px 0 0;
  color: var(--text-weaker);
  font-size: 11px;
}
.settings-add-row {
  min-height: 38px;
  align-self: flex-start;
  padding: 0 11px;
  border-radius: 9px;
  color: var(--text-weak);
  font-size: 12px;
  font-weight: 500;
}
.settings-add-row:hover {
  background: var(--surface-raised-base);
  color: var(--text-strong);
}
.settings-dialog [class*="rounded-[4px]"],
.settings-dialog [class*="rounded-[6px]"] {
  border-radius: 10px !important;
}

@media (max-width: 720px) {
  [data-component="dialog"]:has([data-slot="dialog-content"].settings-dialog) [data-slot="dialog-container"] {
    width: calc(100vw - 16px);
    height: calc(100vh - 20px);
  }
  .settings-layout {
    flex-direction: column;
  }
  .settings-nav {
    width: 100%;
    height: 42px;
    flex: 0 0 42px;
    padding: 0 4px;
    border-right: 0;
    border-bottom: 1px solid var(--border-weak-base);
    overflow: hidden;
  }
  .settings-nav__sections {
    flex-direction: row;
    gap: 0;
    padding: 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .settings-nav__section {
    flex: 0 0 auto;
    flex-direction: row;
    gap: 0;
  }
  .settings-nav__label,
  .settings-nav__footer {
    display: none;
  }
  .settings-nav__item {
    height: 42px;
    flex: 0 0 auto;
    gap: 6px;
    padding: 0 9px;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    font-size: 12px;
  }
  .settings-nav__item:hover {
    background: transparent;
  }
  .settings-nav__item[data-active="true"] {
    border-bottom-color: var(--text-base);
    background: transparent;
  }
  .settings-main__header {
    min-height: 44px;
  }
  .settings-page-header {
    padding: 18px 18px 14px;
  }
  .settings-page-body {
    padding: 2px 18px 36px;
  }
  .credential-form-grid {
    grid-template-columns: 1fr;
  }
}
`

export const DialogSettings: Component<{ initial?: SettingsPanelId }> = (props) => {
  const platform = usePlatform()
  const dialog = useDialog()

  // Browser-style history so back/forward chevrons are real navigation.
  const [history, setHistory] = createSignal<SettingsPanelId[]>([props.initial ?? DEFAULT_PANEL])
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
      <div class="settings-layout">
        {/* ── Left rail ── */}
        <nav class="settings-nav">
          <div class="settings-nav__sections">
            <For each={SETTINGS_SECTIONS}>
              {(section) => (
                <div class="settings-nav__section">
                  <span class="settings-nav__label">{section.label}</span>
                  <For each={SETTINGS_PANELS.filter((p) => p.section === section.id)}>
                    {(panel) => (
                      <button
                        type="button"
                        class="settings-nav__item"
                        data-active={current().id === panel.id ? "true" : "false"}
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
          <div class="settings-nav__footer">
            <span class="text-12-medium">OpenScience</span>
            <span class="text-11-regular">v{platform.version}</span>
          </div>
        </nav>

        {/* ── Right column ── */}
        <div class="settings-main">
          {/* Header */}
          <header class="settings-main__header">
            <div class="flex items-center gap-1 min-w-0">
              <IconButton icon="arrow-left" variant="ghost" disabled={!canBack()} onClick={back} aria-label="Back" />
              <IconButton
                icon="arrow-right"
                variant="ghost"
                disabled={!canForward()}
                onClick={forward}
                aria-label="Forward"
              />
              <span class="settings-main__title">{current().title}</span>
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
