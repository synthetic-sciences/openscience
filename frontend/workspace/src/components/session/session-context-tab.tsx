import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { DateTime } from "luxon"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { checksum } from "@synsci/util/encode"
import { findLast } from "@synsci/util/array"
import { TokenUsage } from "@synsci/util/token-usage"
import { Icon } from "@synsci/ui/icon"
import { Accordion } from "@synsci/ui/accordion"
import { StickyAccordionHeader } from "@synsci/ui/sticky-accordion-header"
import { Code } from "@synsci/ui/code"
import { Markdown } from "@synsci/ui/markdown"
import type { AssistantMessage, Message, Part, UserMessage } from "@synsci/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { contextComposition } from "./context-composition"

interface SessionContextTabProps {
  messages: () => Message[]
  visibleUserMessages: () => UserMessage[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  info: () => ReturnType<ReturnType<typeof useSync>["session"]["get"]>
}

export function SessionContextTab(props: SessionContextTabProps) {
  const params = useParams()
  const sync = useSync()
  const language = useLanguage()

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const ctx = createMemo(() => {
    const last = findLast(props.messages(), (x) => {
      if (x.role !== "assistant") return false
      return TokenUsage.total(x.tokens) > 0
    }) as AssistantMessage
    if (!last) return

    const provider = sync.data.provider.all.find((x) => x.id === last.providerID)
    const model = provider?.models[last.modelID]
    const limit = model?.limit.context

    const input = last.tokens.input
    const output = last.tokens.output
    const reasoning = last.tokens.reasoning
    const cacheRead = last.tokens.cache.read
    const cacheWrite = last.tokens.cache.write
    const total = TokenUsage.total(last.tokens)
    const usage = limit ? Math.round((total / limit) * 100) : null

    return {
      message: last,
      provider,
      model,
      limit,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      total,
      usage,
    }
  })

  const cost = createMemo(() => {
    const total = props.messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return usd().format(total)
  })

  const counts = createMemo(() => {
    const all = props.messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = props.visibleUserMessages().find((message) => message.id === ctx()?.message.parentID)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const number = (value: number | null | undefined) => {
    if (value === undefined) return "—"
    if (value === null) return "—"
    return value.toLocaleString(language.locale())
  }

  const percent = (value: number | null | undefined) => {
    if (value === undefined) return "—"
    if (value === null) return "—"
    return value.toLocaleString(language.locale()) + "%"
  }

  const time = (value: number | undefined) => {
    if (!value) return "—"
    return DateTime.fromMillis(value).setLocale(language.locale()).toLocaleString(DateTime.DATETIME_MED)
  }

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.provider?.name ?? c.message.providerID
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    if (c.model?.name) return c.model.name
    return c.message.modelID
  })

  const breakdown = createMemo(() => {
    const call = ctx()?.message
    if (!call) return []
    const labels = {
      instructions: language.t("context.composition.instructions"),
      user: language.t("context.breakdown.user"),
      assistant: language.t("context.breakdown.assistant"),
      tool: language.t("context.breakdown.tool"),
    }
    const colors = { instructions: "info", user: "success", assistant: "property", tool: "warning" }
    return contextComposition(props.messages(), sync.data.part, call).map((entry) => ({
      label: labels[entry.key],
      width: entry.share * 100,
      percent: `~${Math.round(entry.share * 100)}%`,
      color: `var(--syntax-${colors[entry.key]})`,
    }))
  })

  function Stat(statProps: { label: string; value: JSX.Element }) {
    return (
      <div class="flex flex-col gap-1">
        <div class="text-12-regular text-text-weak">{statProps.label}</div>
        <div class="text-12-medium text-text-strong">{statProps.value}</div>
      </div>
    )
  }

  const stats = createMemo(() => {
    const c = ctx()
    const count = counts()
    return [
      { label: language.t("context.stats.session"), value: props.info()?.title ?? params.id ?? "—" },
      { label: language.t("context.stats.messages"), value: count.all.toLocaleString(language.locale()) },
      { label: language.t("context.stats.provider"), value: providerLabel() },
      { label: language.t("context.stats.model"), value: modelLabel() },
      { label: language.t("context.stats.limit"), value: number(c?.limit) },
      { label: language.t("context.stats.totalTokens"), value: number(c?.total) },
      { label: language.t("context.stats.usage"), value: percent(c?.usage) },
      { label: language.t("context.stats.inputTokens"), value: number(c?.input) },
      { label: language.t("context.stats.outputTokens"), value: number(c?.output) },
      { label: language.t("context.stats.reasoningTokens"), value: number(c?.reasoning) },
      {
        label: language.t("context.stats.cacheTokens"),
        value: `${number(c?.cacheRead)} / ${number(c?.cacheWrite)}`,
      },
      { label: language.t("context.stats.userMessages"), value: count.user.toLocaleString(language.locale()) },
      {
        label: language.t("context.stats.assistantMessages"),
        value: count.assistant.toLocaleString(language.locale()),
      },
      { label: language.t("context.stats.totalCost"), value: cost() },
      { label: language.t("context.stats.sessionCreated"), value: time(props.info()?.time.created) },
      { label: language.t("context.stats.lastActivity"), value: time(c?.message.time.created) },
    ] satisfies { label: string; value: JSX.Element }[]
  })

  function RawMessageContent(msgProps: { message: Message }) {
    const file = createMemo(() => {
      const parts = (sync.data.part[msgProps.message.id] ?? []) as Part[]
      const contents = JSON.stringify({ message: msgProps.message, parts }, null, 2)
      return {
        name: `${msgProps.message.role}-${msgProps.message.id}.json`,
        contents,
        cacheKey: checksum(contents),
      }
    })

    return (
      <Code file={file()} overflow="wrap" class="select-text" onRendered={() => requestAnimationFrame(restoreScroll)} />
    )
  }

  function RawMessage(msgProps: { message: Message }) {
    return (
      <Accordion.Item value={msgProps.message.id}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div class="flex items-center justify-between gap-2 w-full">
              <div class="min-w-0 truncate">
                {msgProps.message.role} <span class="text-text-base">• {msgProps.message.id}</span>
              </div>
              <div class="flex items-center gap-3">
                <div class="shrink-0 text-12-regular text-text-weak">{time(msgProps.message.time.created)}</div>
                <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content class="bg-background-base">
          <div class="p-3">
            <RawMessageContent message={msgProps.message} />
          </div>
        </Accordion.Content>
      </Accordion.Item>
    )
  }

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = props.view()?.scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      props.view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => props.messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <div
      class="@container h-full overflow-y-auto no-scrollbar pb-10"
      ref={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 flex flex-col gap-10">
        <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
          <For each={stats()}>{(stat) => <Stat label={stat.label} value={stat.value} />}</For>
        </div>

        <Show when={breakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.composition.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={breakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": segment.color,
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={breakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": segment.color }} />
                    <div>{segment.label}</div>
                    <div class="text-text-weaker">{segment.percent}</div>
                  </div>
                )}
              </For>
            </div>
            <div class="text-11-regular text-text-weaker">{language.t("context.composition.note")}</div>
          </div>
        </Show>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.composition.instructions")}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion multiple>
            <For each={props.messages()}>{(message) => <RawMessage message={message} />}</For>
          </Accordion>
        </div>
      </div>
    </div>
  )
}
