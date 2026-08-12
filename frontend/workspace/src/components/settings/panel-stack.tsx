import { Dynamic } from "solid-js/web"
import { For, Suspense, createEffect, type Accessor, type Component } from "solid-js"

export interface SettingsPanelStackItem<Id extends string = string> {
  id: Id
  component: Component
}

/**
 * Retains every settings panel after its first visit.
 *
 * The shell only adds a panel after its module has preloaded, so Suspense is a
 * last-resort guard rather than a visible navigation state. Hidden panels stay
 * mounted: local form state, scroll position, resources, and subscriptions do
 * not restart when the user moves between settings sections.
 */
export function SettingsPanelStack<Id extends string>(props: {
  active: Accessor<Id>
  panels: Accessor<SettingsPanelStackItem<Id>[]>
}) {
  const slots = new Map<Id, HTMLElement>()

  createEffect(() => {
    const active = props.active()

    queueMicrotask(() => {
      if (props.active() !== active) return

      const focused = document.activeElement as HTMLElement | null
      const focusedPanel = focused?.closest<HTMLElement>("[data-settings-panel]")
      if (!focusedPanel || focusedPanel.dataset.settingsPanel === active) return

      slots.get(active)?.focus({ preventScroll: true })
    })
  })

  return (
    <For each={props.panels()}>
      {(panel) => (
        <section
          ref={(element) => slots.set(panel.id, element)}
          class="settings-panel-slot"
          data-settings-panel={panel.id}
          hidden={props.active() !== panel.id}
          aria-hidden={props.active() !== panel.id ? "true" : undefined}
          inert={props.active() !== panel.id}
          tabIndex={-1}
        >
          <Suspense
            fallback={
              <div class="settings-panel-loading" role="status" aria-label="Loading settings">
                <div class="settings-panel-loading__header">
                  <span class="settings-panel-loading__line" data-size="title" />
                  <span class="settings-panel-loading__line" data-size="copy" />
                </div>
                <div class="settings-panel-loading__body">
                  <span class="settings-panel-loading__line" data-size="label" />
                  <div class="settings-panel-loading__rows" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            }
          >
            <Dynamic component={panel.component} />
          </Suspense>
        </section>
      )}
    </For>
  )
}
