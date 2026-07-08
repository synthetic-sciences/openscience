import { createEffect, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { Collapsible } from "./collapsible"
import { Icon, IconProps } from "./icon"
import { Markdown } from "./markdown"
import { humanizeToolName } from "./tool-display"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

const isTriggerTitle = (val: any): val is TriggerTitle => {
  return (
    typeof val === "object" && val !== null && "title" in val && (typeof Node === "undefined" || !(val instanceof Node))
  )
}

export interface BasicToolProps {
  icon: IconProps["name"]
  trigger: TriggerTitle | JSX.Element
  children?: JSX.Element
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  locked?: boolean
  onSubtitleClick?: () => void
}

export function BasicTool(props: BasicToolProps) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)

  createEffect(() => {
    if (props.forceOpen) setOpen(true)
  })

  const handleOpenChange = (value: boolean) => {
    if (props.locked && !value) return
    setOpen(value)
  }

  return (
    <Collapsible open={open()} onOpenChange={handleOpenChange}>
      <Collapsible.Trigger>
        <div data-component="tool-trigger">
          <div data-slot="basic-tool-tool-trigger-content">
            <Icon name={props.icon} size="small" />
            <div data-slot="basic-tool-tool-info">
              <Switch>
                <Match when={isTriggerTitle(props.trigger) && props.trigger}>
                  {(trigger) => (
                    <div data-slot="basic-tool-tool-info-structured">
                      <div data-slot="basic-tool-tool-info-main">
                        <span
                          data-slot="basic-tool-tool-title"
                          classList={{
                            [trigger().titleClass ?? ""]: !!trigger().titleClass,
                          }}
                        >
                          {trigger().title}
                        </span>
                        <Show when={trigger().subtitle}>
                          <span
                            data-slot="basic-tool-tool-subtitle"
                            classList={{
                              [trigger().subtitleClass ?? ""]: !!trigger().subtitleClass,
                              clickable: !!props.onSubtitleClick,
                            }}
                            onClick={(e) => {
                              if (props.onSubtitleClick) {
                                e.stopPropagation()
                                props.onSubtitleClick()
                              }
                            }}
                          >
                            {trigger().subtitle}
                          </span>
                        </Show>
                        <Show when={trigger().args?.length}>
                          <For each={trigger().args}>
                            {(arg) => (
                              <span
                                data-slot="basic-tool-tool-arg"
                                classList={{
                                  [trigger().argsClass ?? ""]: !!trigger().argsClass,
                                }}
                              >
                                {arg}
                              </span>
                            )}
                          </For>
                        </Show>
                      </div>
                      <Show when={trigger().action}>{trigger().action}</Show>
                    </div>
                  )}
                </Match>
                <Match when={true}>{props.trigger as JSX.Element}</Match>
              </Switch>
            </div>
          </div>
          <Show when={props.children && !props.hideDetails && !props.locked}>
            <Collapsible.Arrow />
          </Show>
        </div>
      </Collapsible.Trigger>
      <Show when={props.children && !props.hideDetails}>
        <Collapsible.Content>{props.children}</Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

export function GenericTool(props: {
  tool: string
  input?: Record<string, any>
  metadata?: Record<string, any>
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  locked?: boolean
}) {
  const glyph = () => (props.status === "error" ? "✗" : props.status === "completed" ? "✓" : "…")
  const subtitle = () => {
    const input = props.input ?? {}
    const first = input.command ?? input.description ?? input.query ?? input.path ?? input.pattern
    return typeof first === "string" ? first : undefined
  }
  return (
    <BasicTool
      icon="mcp"
      hideDetails={props.hideDetails}
      defaultOpen={props.defaultOpen}
      forceOpen={props.forceOpen}
      locked={props.locked}
      trigger={{ title: humanizeToolName(props.tool), subtitle: subtitle(), args: [glyph()] }}
    >
      <Show when={props.output}>
        {(output) => (
          <div data-component="tool-output" data-scrollable>
            <Markdown text={"```\n" + output() + "\n```"} />
          </div>
        )}
      </Show>
    </BasicTool>
  )
}
