import { children, createEffect, createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { type UiI18nKey, useI18n } from "../context/i18n"
import { Card } from "./card"
import { useClock } from "./clock"
import { Collapsible } from "./collapsible"
import { Icon, IconProps } from "./icon"
import { Spinner } from "./spinner"
import { elapsedLabel, formatTaskDuration } from "./research-trace"
import {
  errorLine,
  humanizeToolName,
  runningLabel,
  toolErrorDisplay,
  toolOutcome,
  type ToolOutcome,
  type ToolSummary,
} from "./tool-display"

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
  /** Lifecycle of the underlying call. Renderers spread their ToolProps, so
   * these arrive without each renderer wiring them, and the row shows one
   * status glyph, the live elapsed time or final duration, and a one-line
   * receipt or the first error line. */
  tool?: string
  status?: string
  time?: { start: number; end?: number }
  summary?: ToolSummary[]
  error?: string
  metadata?: Record<string, unknown>
}

/** @internal Exported for the focused memoization regression test. */
export function resolveBasicToolChildren(getChildren: () => JSX.Element) {
  return children(getChildren)
}

const glyphLabel: Record<ToolOutcome, UiI18nKey> = {
  pending: "ui.tool.status.running",
  running: "ui.tool.status.running",
  done: "ui.tool.status.done",
  error: "ui.tool.status.error",
  cancelled: "ui.tool.status.cancelled",
}

function ToolFailure(props: { tool: string; error: string }) {
  const display = () => toolErrorDisplay(props.tool, props.error)
  return (
    <Card
      variant={toolOutcome("error", props.error) === "cancelled" ? "normal" : "error"}
      data-slot="basic-tool-failure"
    >
      <div data-component="tool-error" data-outcome={toolOutcome("error", props.error)}>
        <Icon name="circle-ban-sign" size="small" />
        <div data-slot="message-part-tool-error-body">
          <Switch>
            <Match when={display().title}>
              {(title) => (
                <div data-slot="message-part-tool-error-content">
                  <div data-slot="message-part-tool-error-title">{title()}</div>
                  <span data-slot="message-part-tool-error-message">{display().message}</span>
                </div>
              )}
            </Match>
            <Match when={true}>
              <span data-slot="message-part-tool-error-message">{display().message}</span>
            </Match>
          </Switch>
          <Show when={display().details}>
            {(details) => (
              <details data-slot="message-part-tool-error-details">
                <summary>Technical details</summary>
                <pre>{details()}</pre>
              </details>
            )}
          </Show>
        </div>
      </div>
    </Card>
  )
}

export function BasicTool(props: BasicToolProps) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  const content = resolveBasicToolChildren(() => props.children)
  const outcome = createMemo(() =>
    toolOutcome(props.status, props.error, props.tool === "bash" ? props.metadata?.exit : undefined),
  )
  const live = () => outcome() === "running" || outcome() === "pending"
  const now = useClock(() => live() && !!props.time?.start)
  const clock = createMemo(() => {
    const time = props.time
    if (!time?.start) return ""
    if (live()) return elapsedLabel(now() - time.start)
    const total = (time.end ?? time.start) - time.start
    return total >= 1000 ? formatTaskDuration(total) : ""
  })
  const detail = createMemo(() => {
    if (props.error) return errorLine(props.error)
    return (props.summary ?? []).map((item) => i18n.t(item.key, item.params)).join(" · ")
  })
  const detailed = () => !props.hideDetails && (!!props.error || !!content())
  const title = (trigger: TriggerTitle) => {
    const key = live() && props.tool ? runningLabel(props.tool) : undefined
    return key ? i18n.t(key) : trigger.title
  }

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
                          {title(trigger())}
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
          <Show when={props.status}>
            <span data-slot="basic-tool-tool-status" data-outcome={outcome()}>
              <Show when={detail()}>
                <span
                  data-slot="basic-tool-tool-detail"
                  data-error={outcome() === "error" ? "true" : undefined}
                  title={detail()}
                >
                  {detail()}
                </span>
              </Show>
              <span data-slot="basic-tool-tool-glyph" role="img" aria-label={i18n.t(glyphLabel[outcome()])}>
                <Switch>
                  <Match when={live()}>
                    <Spinner />
                  </Match>
                  <Match when={outcome() === "done"}>
                    <Icon name="check" size="small" />
                  </Match>
                  <Match when={outcome() === "cancelled"}>
                    <Icon name="circle-ban-sign" size="small" />
                  </Match>
                  <Match when={true}>
                    <Icon name="circle-x" size="small" />
                  </Match>
                </Switch>
              </span>
              <span data-slot="basic-tool-tool-time" aria-live="off">
                {clock()}
              </span>
            </span>
          </Show>
          <Show when={detailed() && !props.locked}>
            <Collapsible.Arrow />
          </Show>
        </div>
      </Collapsible.Trigger>
      <Show when={detailed()}>
        <Collapsible.Content>
          {content()}
          <Show when={props.error}>{(error) => <ToolFailure tool={props.tool ?? "tool"} error={error()} />}</Show>
        </Collapsible.Content>
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
  time?: { start: number; end?: number }
  summary?: ToolSummary[]
  error?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  locked?: boolean
}) {
  const subtitle = () => {
    const input = props.input ?? {}
    const first = input.command ?? input.description ?? input.query ?? input.path ?? input.pattern
    return typeof first === "string" ? first : undefined
  }
  return (
    <BasicTool
      icon="mcp"
      tool={props.tool}
      status={props.status}
      time={props.time}
      summary={props.summary}
      error={props.error}
      metadata={props.metadata}
      hideDetails={props.hideDetails}
      defaultOpen={props.defaultOpen}
      forceOpen={props.forceOpen}
      locked={props.locked}
      trigger={{ title: humanizeToolName(props.tool), subtitle: subtitle() }}
    >
      <Show when={props.output}>
        {(output) => (
          <div data-component="tool-output" data-scrollable>
            <pre>
              <code>{output()}</code>
            </pre>
          </div>
        )}
      </Show>
    </BasicTool>
  )
}
