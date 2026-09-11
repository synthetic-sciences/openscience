import { Popover as Kobalte } from "@kobalte/core/popover"
import { Icon } from "@synsci/ui/icon"
import { createSignal, For, Show, type Component } from "solid-js"
import { DELEGATION_AUTONOMY, type DelegationAutonomy } from "./prompt-capabilities"
import { ModelPopoverSurface, focusModelRadio } from "./model-settings-popover"

/** How independently OpenScience decides: whether it takes the recommended
 * option itself or asks. This governs the lead's own questions, not only
 * delegated work, so it sits beside the model and effort chips where it can be
 * seen and changed in one click. */
export const IndependenceChip: Component<{
  value: DelegationAutonomy
  onSelect: (value: DelegationAutonomy) => void
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  let trigger: HTMLButtonElement | undefined
  const current = () => DELEGATION_AUTONOMY.find((option) => option.value === props.value) ?? DELEGATION_AUTONOMY[1]!
  const close = () => {
    setOpen(false)
    queueMicrotask(() => trigger?.focus({ preventScroll: true }))
  }
  return (
    <div data-model-control-group="label" data-independence-control>
      <Kobalte open={open()} onOpenChange={setOpen} placement="top-end" gutter={12}>
        <Kobalte.Trigger
          ref={trigger}
          type="button"
          data-model-effort-chip
          data-independence-chip
          aria-label={`Independence: ${current().label}. Independence options`}
        >
          <strong>{current().label}</strong>
          <Icon name="chevron-down" size="small" aria-hidden="true" />
        </Kobalte.Trigger>
        <ModelPopoverSurface
          kind="effort"
          view="effort"
          title="Independence"
          close={close}
          initialFocus='[data-independence-option][aria-checked="true"]'
        >
          <div data-model-effort-panel data-independence-menu>
            <section class="model-settings-option-section" aria-label="Independence">
              <div
                role="radiogroup"
                aria-label="How independently should OpenScience decide?"
                class="flex flex-col"
                onKeyDown={focusModelRadio}
              >
                <For each={DELEGATION_AUTONOMY}>
                  {(option) => (
                    <button
                      type="button"
                      role="radio"
                      data-independence-option
                      data-model-option-id={option.value}
                      aria-checked={props.value === option.value}
                      tabindex={props.value === option.value ? 0 : -1}
                      class="model-settings-row flex w-full min-w-0 items-center justify-between text-left transition-colors"
                      onClick={() => {
                        props.onSelect(option.value)
                        close()
                      }}
                    >
                      <span class="model-settings-setting">
                        <span data-model-menu-label>{option.label}</span>
                        <small>{option.description}</small>
                      </span>
                      <Show when={props.value === option.value}>
                        <Icon name="check" size="small" class="model-settings-check" aria-hidden="true" />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </section>
          </div>
        </ModelPopoverSurface>
      </Kobalte>
    </div>
  )
}
