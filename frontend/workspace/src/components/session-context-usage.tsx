import { Match, Show, Switch, createMemo } from "solid-js"
import { Tooltip } from "@synsci/ui/tooltip"
import { ProgressCircle } from "@synsci/ui/progress-circle"
import { Button } from "@synsci/ui/button"
import { useParams } from "@solidjs/router"
import { AssistantMessage, type UserMessage } from "@synsci/sdk/v2/client"
import { findLast } from "@synsci/util/array"
import { Dialog } from "@synsci/ui/dialog"
import { useDialog } from "@synsci/ui/context/dialog"

import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { SessionContextTab } from "@/components/session/session-context-tab"
import { compactContextTokens, formatContextTokens, usageSample, type ContextSample } from "@/pages/session-context"

interface SessionContextUsageProps {
  variant?: "button" | "indicator" | "header"
  // Resolved sample from the page that subscribes to `session.context`; without one the
  // component falls back to the newest provider-reported usage.
  sample?: ContextSample
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const params = useParams()
  const layout = useLayout()
  const language = useLanguage()
  const dialog = useDialog()

  const variant = createMemo(() => props.variant ?? "button")
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const view = layout.view(sessionKey)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const visibleUserMessages = createMemo(() =>
    messages().filter((message): message is UserMessage => message.role === "user"),
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return usd().format(total)
  })

  const context = createMemo(() => {
    const locale = language.locale()
    const sample = props.sample ?? usageSample(messages())
    if (!sample) return
    // A compaction summary runs on the compaction agent's model; size the window by the
    // model the conversation itself uses.
    const last = findLast(messages(), (x) => x.role === "assistant" && !x.summary) as AssistantMessage | undefined
    const model = last ? sync.data.provider.all.find((x) => x.id === last.providerID)?.models[last.modelID] : undefined
    return {
      tokens: formatContextTokens(sample.total, locale),
      compact: compactContextTokens(sample.total, locale),
      percentage: model?.limit.context ? Math.round((sample.total / model.limit.context) * 100) : null,
      estimate: sample.source === "estimate",
    }
  })

  const openContext = () => {
    if (!params.id) return
    dialog.show(() => (
      <Dialog title={language.t("session.tab.context")} size="large" transition>
        <div style={{ width: "min(760px, 82vw)", height: "min(680px, 75vh)", overflow: "hidden" }}>
          <SessionContextTab
            messages={messages}
            visibleUserMessages={visibleUserMessages}
            view={() => view}
            info={() => (params.id ? sync.session.get(params.id) : undefined)}
          />
        </div>
      </Dialog>
    ))
  }

  const circle = () => (
    <div class="p-1">
      <ProgressCircle size={16} strokeWidth={2} percentage={context()?.percentage ?? 0} />
    </div>
  )

  const tooltipValue = () => (
    <div>
      <Show when={context()}>
        {(ctx) => (
          <>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{ctx().tokens}</span>
              <span class="text-text-invert-base">{language.t("context.usage.tokens")}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{ctx().percentage ?? 0}%</span>
              <span class="text-text-invert-base">{language.t("context.usage.usage")}</span>
            </div>
            <Show when={ctx().estimate}>
              <div class="text-text-invert-base">{language.t("context.usage.estimate")}</div>
            </Show>
          </>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <span class="text-text-invert-strong">{cost()}</span>
        <span class="text-text-invert-base">{language.t("context.usage.cost")}</span>
      </div>
    </div>
  )

  return (
    <Show when={params.id}>
      <Tooltip value={tooltipValue()} placement="top">
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={variant() === "header"}>
            <Show when={context()}>
              {(ctx) => (
                <button
                  type="button"
                  class="workspace-header__context"
                  data-estimate={ctx().estimate ? "true" : undefined}
                  onClick={openContext}
                  aria-label={`${ctx().tokens} ${language.t("context.usage.tokens")}. ${language.t("context.usage.view")}`}
                >
                  <ProgressCircle size={14} strokeWidth={2} percentage={ctx().percentage ?? 0} />
                  <span class="workspace-header__context-tokens">{ctx().compact}</span>
                  <Show when={ctx().percentage !== null}>
                    <span class="workspace-header__context-percent">{ctx().percentage}%</span>
                  </Show>
                </button>
              )}
            </Show>
          </Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-6"
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </Tooltip>
    </Show>
  )
}
