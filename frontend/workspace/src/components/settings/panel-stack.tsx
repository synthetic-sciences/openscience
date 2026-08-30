import { Dynamic } from "solid-js/web"
import { For, Suspense, createEffect, onCleanup, type Accessor, type Component } from "solid-js"

export interface SettingsPanelStackItem<Id extends string = string> {
  id: Id
  component: Component
}

/**
 * Retains the shell's small recent-panel cache.
 *
 * The shell adds a panel synchronously while its module preloads, so Suspense
 * is a last-resort guard rather than a blocked navigation state. Recently used
 * panels keep local form and scroll state; older hidden panels are unmounted so
 * their subscriptions and oversized trees cannot accumulate indefinitely.
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
          ref={(element) => {
            slots.set(panel.id, element)
            onCleanup(() => slots.delete(panel.id))
          }}
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
