import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
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
import { contextWindow } from "@/pages/session-context"
import { sessionCost, sessionCostFormatter, sessionProviderLabel } from "./session-usage"
import {
  CONTEXT_BUCKET_COLORS,
  contextComposition,
  contextSegments,
  recordedContextComposition,
  type ContextCompositionEstimate,
} from "./context-composition"
import "./session-context-tab.css"

interface SessionContextTabProps {
  composition?: ContextCompositionEstimate
  /** The size the header pill shows: the live pre-call estimate while a turn
   * is in flight, else the newest reported usage. */
  total?: number
  estimate?: boolean
  messages: () => Message[]
  visibleUserMessages: () => UserMessage[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  info: () => ReturnType<ReturnType<typeof useSync>["session"]["get"]>
}

export function SessionContextTab(props: SessionContextTabProps) {
  const params = useParams()
  const sync = useSync()
  const language = useLanguage()

  const usd = createMemo(() => sessionCostFormatter(language.locale()))

  const ctx = createMemo(() => {
    const last = findLast(props.messages(), (x) => {
      if (x.role !== "assistant") return false
      return TokenUsage.total(x.tokens) > 0
    }) as AssistantMessage
    if (!last) return

    const provider = sync.data.provider.all.find((x) => x.id === last.providerID)
    const model = provider?.models[last.modelID]
    const window = contextWindow(props.messages(), model)
    const reported = TokenUsage.total(last.tokens)
    const total = props.total ?? reported
    const usage = window.window ? Math.round((total / window.window) * 100) : null

    return {
      message: last,
      provider,
      model,
      window: window.window,
      full: window.full,
      capped: window.capped,
      input: last.tokens.input,
      output: last.tokens.output,
      reasoning: last.tokens.reasoning,
      cacheRead: last.tokens.cache.read,
      cacheWrite: last.tokens.cache.write,
      reported,
      total,
      usage,
    }
  })

  const cost = createMemo(() => {
    return usd().format(sessionCost(props.messages(), sync.data.part).total)
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

  // Two decimals keep 1.05M distinct from a rounded 1.1M; short counts are unaffected.
  const compact = (value: number | undefined) =>
    value === undefined
      ? "—"
      : new Intl.NumberFormat(language.locale(), { notation: "compact", maximumFractionDigits: 2 }).format(value)

  const time = (value: number | undefined) => {
    if (!value) return "—"
    return DateTime.fromMillis(value).setLocale(language.locale()).toLocaleString(DateTime.DATETIME_MED)
  }

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    const prompt = props
      .messages()
      .find((message): message is UserMessage => message.role === "user" && message.id === c.message.parentID)
    return sessionProviderLabel(c.message, prompt, c.provider)
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    if (c.model?.name) return c.model.name
    return c.message.modelID
  })

  // What fills the window: the server's recorded buckets when a turn reported
  // them, else the transcript's own estimate of the text it holds.
  const segments = createMemo(() => {
    const recorded = props.composition
    if (recorded) return contextSegments(recordedContextComposition(recorded))
    const call = ctx()?.message
    if (!call) return []
    const labels = {
      instructions: language.t("context.composition.instructions"),
      user: language.t("context.breakdown.user"),
      assistant: language.t("context.breakdown.assistant"),
      tool: language.t("context.breakdown.tool"),
    }
    return contextSegments(
      contextComposition(props.messages(), sync.data.part, call).map((entry) => ({
        key: entry.key,
        label: labels[entry.key],
        tokens: entry.tokens,
      })),
    )
  })

  const level = createMemo(() => {
    const usage = ctx()?.usage ?? 0
    if (usage >= 100) return "full"
    if (usage >= 85) return "high"
    return undefined
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
      class="context-panel"
      ref={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <header class="context-panel__headline">
        <div class="context-panel__tokens">
          <strong>{compact(ctx()?.total)}</strong>
          <span>
            {ctx()?.window
              ? language.t("context.headline.of", { window: compact(ctx()?.window) })
              : language.t("context.headline.tokens")}
          </span>
          <Show when={ctx()?.usage !== null && ctx()?.usage !== undefined}>
            <span class="context-panel__percent" data-level={level()}>
              {ctx()?.usage}%
            </span>
          </Show>
        </div>
        <div
          class="context-panel__bar"
          role="img"
          aria-label={`${number(ctx()?.total)} ${language.t("context.headline.tokens")}, ${ctx()?.usage ?? 0}%`}
        >
          <For each={segments().filter((segment) => segment.share > 0)}>
            {(segment) => (
              <span
                style={{
                  width: `${Math.max(0, Math.min(100, (ctx()?.usage ?? 0) * segment.share))}%`,
                  background: CONTEXT_BUCKET_COLORS[segment.key],
                }}
              />
            )}
          </For>
        </div>
        <div class="context-panel__subline">
          <span>{modelLabel()}</span>
          <span>{providerLabel()}</span>
          <Show when={ctx()?.capped && ctx()?.full}>
            <span>{language.t("context.headline.cap", { full: compact(ctx()?.full) })}</span>
          </Show>
          <span>{props.estimate ? language.t("context.usage.estimate") : language.t("context.headline.reported")}</span>
        </div>
      </header>

      <Show when={segments().length > 0}>
        <section class="context-panel__section" aria-label={language.t("context.section.composition")}>
          <h3 class="context-panel__title">{language.t("context.section.composition")}</h3>
          <ul class="context-panel__legend">
            <For each={segments()}>
              {(segment) => (
                <li data-empty={segment.tokens ? undefined : "true"}>
                  <i style={{ background: CONTEXT_BUCKET_COLORS[segment.key] }} />
                  <span class="label">{segment.label}</span>
                  <span class="value">
                    {segment.tokens === undefined
                      ? language.t("context.composition.notReported")
                      : `~${number(segment.tokens)}`}
                  </span>
                  <span class="share">{segment.share > 0 ? `${Math.round(segment.share * 100)}%` : ""}</span>
                </li>
              )}
            </For>
          </ul>
          <p class="context-panel__note">
            {props.composition
              ? language.t("context.composition.recordedNote")
              : language.t("context.composition.note")}
          </p>
        </section>
      </Show>

      <div class="context-panel__cards">
        <section class="context-panel__card" aria-label={language.t("context.section.lastRequest")}>
          <h3 class="context-panel__title">{language.t("context.section.lastRequest")}</h3>
          <dl>
            <dt>{language.t("context.stats.inputTokens")}</dt>
            <dd>{number(ctx()?.input)}</dd>
            <dt>{language.t("context.stats.cacheRead")}</dt>
            <dd>{number(ctx()?.cacheRead)}</dd>
            <dt>{language.t("context.stats.cacheWrite")}</dt>
            <dd>{number(ctx()?.cacheWrite)}</dd>
            <dt>{language.t("context.stats.outputTokens")}</dt>
            <dd>{number(ctx()?.output)}</dd>
            <dt>{language.t("context.stats.reasoningTokens")}</dt>
            <dd>{number(ctx()?.reasoning)}</dd>
            <dt>{language.t("context.stats.limit")}</dt>
            <dd>
              {number(ctx()?.window)}
              <Show when={ctx()?.capped && ctx()?.full}>
                <small>/ {number(ctx()?.full)}</small>
              </Show>
            </dd>
          </dl>
        </section>
        <section class="context-panel__card" aria-label={language.t("context.section.session")}>
          <h3 class="context-panel__title">{language.t("context.section.session")}</h3>
          <dl>
            <dt>{language.t("context.stats.messages")}</dt>
            <dd>
              {number(counts().all)}
              <small>
                {language.t("context.stats.messagesDetail", {
                  user: number(counts().user),
                  assistant: number(counts().assistant),
                })}
              </small>
            </dd>
            <dt>{language.t("context.stats.totalCost")}</dt>
            <dd>{cost()}</dd>
            <dt>{language.t("context.stats.sessionCreated")}</dt>
            <dd>{time(props.info()?.time.created)}</dd>
            <dt>{language.t("context.stats.lastActivity")}</dt>
            <dd>{time(ctx()?.message.time.created)}</dd>
          </dl>
        </section>
      </div>

      <Show when={systemPrompt()}>
        {(prompt) => (
          <details class="context-panel__details">
            <summary>{language.t("context.composition.instructions")}</summary>
            <div>
              <div class="context-panel__instructions">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          </details>
        )}
      </Show>

      <details class="context-panel__details">
        <summary>
          {language.t("context.rawMessages.title")}
          <small>{number(counts().all)}</small>
        </summary>
        <div>
          <Accordion multiple>
            <For each={props.messages()}>{(message) => <RawMessage message={message} />}</For>
          </Accordion>
        </div>
      </details>
    </div>
  )
}
