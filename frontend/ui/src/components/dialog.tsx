import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ComponentProps, JSXElement, Match, ParentProps, Show, Switch } from "solid-js"
import { useI18n } from "../context/i18n"
import { useDialogLite } from "../context/dialog"
import { IconButton } from "./icon-button"

export interface DialogProps extends ParentProps {
  title?: JSXElement
  description?: JSXElement
  action?: JSXElement
  size?: "normal" | "large" | "x-large"
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  fit?: boolean
  transition?: boolean
}

export function Dialog(props: DialogProps) {
  const i18n = useI18n()
  // In lite mode the parent dialog wrapper doesn't mount a Kobalte root —
  // we render plain divs in place of Kobalte.* primitives so nothing tries
  // to read context that isn't there.
  const lite = useDialogLite()

  const Header = (
    <Show when={props.title || props.action}>
      <div data-slot="dialog-header">
        <Show when={props.title}>
          <Show when={!lite} fallback={<div data-slot="dialog-title">{props.title}</div>}>
            <Kobalte.Title data-slot="dialog-title">{props.title}</Kobalte.Title>
          </Show>
        </Show>
        <Switch>
          <Match when={props.action}>{props.action}</Match>
          <Match when={!lite}>
            <Kobalte.CloseButton
              data-slot="dialog-close-button"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </Match>
        </Switch>
      </div>
    </Show>
  )

  const Description = (
    <Show when={props.description}>
      <Show
        when={!lite}
        fallback={
          <div data-slot="dialog-description" style={{ "margin-left": "-4px" }}>
            {props.description}
          </div>
        }
      >
        <Kobalte.Description data-slot="dialog-description" style={{ "margin-left": "-4px" }}>
          {props.description}
        </Kobalte.Description>
      </Show>
    </Show>
  )

  return (
    <div
      data-component="dialog"
      data-fit={props.fit ? true : undefined}
      data-size={props.size || "normal"}
      data-transition={props.transition ? true : undefined}
    >
      <div data-slot="dialog-container">
        <Show
          when={!lite}
          fallback={
            <div
              data-slot="dialog-content"
              data-expanded
              data-no-header={!props.title && !props.action ? "" : undefined}
              classList={{
                ...(props.classList ?? {}),
                [props.class ?? ""]: !!props.class,
              }}
            >
              {Header}
              {Description}
              <div data-slot="dialog-body">{props.children}</div>
            </div>
          }
        >
          <Kobalte.Content
            data-slot="dialog-content"
            data-no-header={!props.title && !props.action ? "" : undefined}
            classList={{
              ...(props.classList ?? {}),
              [props.class ?? ""]: !!props.class,
            }}
            onOpenAutoFocus={(e) => {
              const target = e.currentTarget as HTMLElement | null
              const autofocusEl = target?.querySelector("[autofocus]") as HTMLElement | null
              if (autofocusEl) {
                e.preventDefault()
                autofocusEl.focus()
              }
            }}
          >
            {Header}
            {Description}
            <div data-slot="dialog-body">{props.children}</div>
          </Kobalte.Content>
        </Show>
      </div>
    </div>
  )
}
