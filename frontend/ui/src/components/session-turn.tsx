import {
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  type PermissionRequest,
  type QuestionRequest,
  TextPart,
  ToolPart,
} from "@synsci/sdk/v2/client"
import { type FileDiff } from "@synsci/sdk/v2"
import { useData } from "../context"
import { useDiffComponent } from "../context/diff"
import { type UiI18nKey, type UiI18nParams, useI18n } from "../context/i18n"
import { findLast } from "@synsci/util/array"
import { getDirectory, getFilename } from "@synsci/util/path"

import { Binary } from "@synsci/util/binary"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  ParentProps,
  Show,
  Switch,
} from "solid-js"
import { DiffChanges } from "./diff-changes"
import { Message, Part, QuestionPrompt } from "./message-part"
import {
  artifactTypeLabel,
  artifactActions,
  generatedArtifacts,
  reasoningTopic,
  sessionErrorText,
  stripRedactedReasoning,
  writtenFiles,
} from "./tool-display"
import { Markdown } from "./markdown"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { Card } from "./card"
import { Dynamic } from "solid-js/web"
import { Button } from "./button"
import { Spinner } from "./spinner"
import { Tooltip } from "./tooltip"
import { createStore } from "solid-js/store"
import { DateTime, DurationUnit, Interval } from "luxon"
import { createAutoScroll } from "../hooks"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { lastResponseTextPart } from "./session-turn-response"
import { groupResearchTrace, type ResearchTraceGroup } from "./research-trace"

type Translator = (key: UiI18nKey, params?: UiI18nParams) => string

const DIFF_PREVIEW_LINE_THRESHOLD = 18

function contentLineCount(value: string | undefined) {
  if (!value) return 0
  const lines = value.split(/\r?\n/)
  return lines.at(-1) === "" ? lines.length - 1 : lines.length
}

/** Long transcript diffs stay bounded until the reader explicitly expands them. */
export function isLongDiffPreview(diff: Pick<FileDiff, "before" | "after">) {
  return Math.max(contentLineCount(diff.before), contentLineCount(diff.after)) > DIFF_PREVIEW_LINE_THRESHOLD
}

function computeStatusFromPart(part: PartType | undefined, t: Translator): string | undefined {
  if (!part) return undefined

  if (part.type === "tool") {
    switch (part.tool) {
      case "task":
        return t("ui.sessionTurn.status.delegating")
      case "todowrite":
      case "todoread":
        return t("ui.sessionTurn.status.planning")
      case "read":
        return t("ui.sessionTurn.status.gatheringContext")
      case "list":
      case "grep":
      case "glob":
        return t("ui.sessionTurn.status.searchingCodebase")
      case "webfetch":
        return t("ui.sessionTurn.status.searchingWeb")
      case "edit":
      case "write":
        return t("ui.sessionTurn.status.makingEdits")
      case "bash":
        return t("ui.sessionTurn.status.runningCommands")
      default:
        return undefined
    }
  }
  if (part.type === "reasoning") {
    const topic = reasoningTopic(part.text ?? "")
    if (topic) return t("ui.sessionTurn.status.thinkingWithTopic", { topic })
    return t("ui.sessionTurn.status.thinking")
  }
  if (part.type === "text") {
    return t("ui.sessionTurn.status.gatheringThoughts")
  }
  return undefined
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function isAttachment(part: PartType | undefined) {
  if (part?.type !== "file") return false
  const file = part as FilePart
  const mime = file.mime ?? ""
  // Images/PDFs, plus raw uploaded blobs (data: URL, no source.text — e.g. .md/.txt).
  // @file references carry source.text and render inline, not as chips.
  return (
    mime.startsWith("image/") ||
    mime === "application/pdf" ||
    (file.url?.startsWith("data:") === true && file.source?.text === undefined)
  )
}

const promotedTools = new Set(["python", "r", "notebook", "rkernel", "modal", "compute_job"])

function isPromotedTool(part: PartType | undefined): part is ToolPart {
  if (part?.type !== "tool" || !promotedTools.has(part.tool)) return false
  if (part.state.status === "error") return false
  if (part.state.status !== "running" && part.state.status !== "completed") return false
  const metadata = "metadata" in part.state ? (part.state.metadata as Record<string, unknown> | undefined) : undefined
  return metadata?.ok !== false
}

function isGeneratedTool(part: PartType | undefined): part is ToolPart {
  return part?.type === "tool" && part.tool === "artifact" && part.state.status === "completed"
}

function isHiddenTool(part: PartType | undefined): part is ToolPart {
  return isPromotedTool(part) || isGeneratedTool(part)
}

function AssistantTrace(props: {
  messages: AssistantMessage[]
  responsePartId: string | undefined
  hideResponsePart: boolean
  hideReasoning: boolean
  hidePromotedTools?: boolean
  pendingRequestCallID?: string
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const trace = createMemo(() =>
    groupResearchTrace(
      props.messages.flatMap((message) => {
        const parts = data.store.part[message.id] ?? emptyParts
        return parts.flatMap((part) => {
          if (props.hideReasoning && part?.type === "reasoning") return []
          if (props.hideResponsePart && props.responsePartId === part?.id) return []
          if (part?.type === "tool" && part.callID === props.pendingRequestCallID) return []
          if (props.hidePromotedTools && isHiddenTool(part)) return [{ message, part, hidden: true }]
          if (part?.type === "tool" && part.tool === "todoread") return [{ message, part, hidden: true }]
          return [{ message, part }]
        })
      }),
    ),
  )

  return (
    <Index each={trace()}>
      {(item) => (
        <Show
          when={item().kind === "group" ? (item() as ResearchTraceGroup) : undefined}
          fallback={
            <Part
              part={(item() as { kind: "part"; entry: ResearchTraceEntry }).entry.part}
              message={(item() as { kind: "part"; entry: ResearchTraceEntry }).entry.message}
            />
          }
        >
          {(group) => <ResearchTraceGroupDisplay group={group()} />}
        </Show>
      )}
    </Index>
  )
}

type ResearchTraceEntry = { part: PartType; message: AssistantMessage }

function ResearchTraceGroupDisplay(props: { group: ResearchTraceGroup }) {
  const icon = () => {
    if (props.group.family === "context") return "glasses" as const
    if (props.group.family === "sources") return "window-cursor" as const
    if (props.group.family === "commands") return "console" as const
    if (props.group.family === "changes") return "code-lines" as const
    if (props.group.family === "images") return "photo" as const
    if (props.group.family === "skills") return "sparkles" as const
    return "activity" as const
  }

  return (
    <details data-component="research-trace-group" data-family={props.group.family}>
      <summary>
        <Icon name={icon()} size="small" />
        <span data-slot="research-trace-group-label">{props.group.label}</span>
        <span data-slot="research-trace-group-detail">{props.group.detail}</span>
        <Icon name="chevron-down" size="small" />
      </summary>
      <div data-slot="research-trace-group-operations">
        <Index each={props.group.entries}>{(entry) => <Part part={entry().part} message={entry().message} />}</Index>
      </div>
    </details>
  )
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    sessionTitle?: string
    messageID: string
    lastUserMessageID?: string
    stepsExpanded?: boolean
    onStepsExpandedToggle?: () => void
    onUserInteracted?: () => void
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const i18n = useI18n()
  const data = useData()
  const diffComponent = useDiffComponent()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyFiles: FilePart[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyPermissions: PermissionRequest[] = []
  const emptyQuestions: QuestionRequest[] = []
  const emptyRequestParts: { part: ToolPart; message: AssistantMessage }[] = []
  const emptyDiffs: FileDiff[] = []
  const idle = { type: "idle" as const }

  const allMessages = createMemo(() => data.store.message[props.sessionID] ?? emptyMessages)

  const messageIndex = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, props.messageID, (m) => m.id)
    if (!result.found) return -1

    const msg = messages[result.index]
    if (!msg || msg.role !== "user") return -1

    return result.index
  })

  const message = createMemo(() => {
    const index = messageIndex()
    if (index < 0) return undefined

    const messages = allMessages() ?? emptyMessages
    const msg = messages[index]
    if (!msg || msg.role !== "user") return undefined

    return msg
  })

  const lastUserMessageID = createMemo(() => {
    if (props.lastUserMessageID) return props.lastUserMessageID

    const messages = allMessages() ?? emptyMessages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === "user") return msg.id
    }
    return undefined
  })

  const isLastUserMessage = createMemo(() => props.messageID === lastUserMessageID())

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return data.store.part[msg.id] ?? emptyParts
  })

  const attachmentParts = createMemo(() => {
    const msgParts = parts()
    if (msgParts.length === 0) return emptyFiles
    return msgParts.filter((part) => isAttachment(part)) as FilePart[]
  })

  const stickyParts = createMemo(() => {
    const msgParts = parts()
    if (msgParts.length === 0) return emptyParts
    if (attachmentParts().length === 0) return msgParts
    return msgParts.filter((part) => !isAttachment(part))
  })

  const assistantMessages = createMemo(
    () => {
      const msg = message()
      if (!msg) return emptyAssistant

      const messages = allMessages() ?? emptyMessages
      const index = messageIndex()
      if (index < 0) return emptyAssistant

      const result: AssistantMessage[] = []
      for (let i = index + 1; i < messages.length; i++) {
        const item = messages[i]
        if (!item) continue
        if (item.role === "user") break
        if (item.role === "assistant" && item.parentID === msg.id) result.push(item as AssistantMessage)
      }
      return result
    },
    emptyAssistant,
    { equals: same },
  )

  const lastAssistantMessage = createMemo(() => assistantMessages().at(-1))

  const error = createMemo(() => assistantMessages().find((m) => m.error)?.error)

  const lastTextPart = createMemo(() => {
    const msgs = assistantMessages()
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = data.store.part[msgs[mi].id] ?? emptyParts
      const part = lastResponseTextPart(msgParts)
      if (part) return part
    }
    return undefined
  })

  const hasSteps = createMemo(() => {
    for (const m of assistantMessages()) {
      const msgParts = data.store.part[m.id]
      if (!msgParts) continue
      for (const p of msgParts) {
        if (p?.type === "tool") return true
        // Encrypted placeholders are continuation state, not readable UI.
        if (p?.type === "reasoning" && stripRedactedReasoning(p.text ?? "").length > 0) return true
      }
    }
    return false
  })

  const promoted = createMemo(() =>
    assistantMessages().flatMap((message) => {
      const parts = (data.store.part[message.id] ?? emptyParts).filter(isPromotedTool)
      return parts.length ? [{ message, parts }] : []
    }),
  )

  const generated = createMemo(() =>
    generatedArtifacts(assistantMessages().flatMap((message) => data.store.part[message.id] ?? emptyParts)),
  )

  const permissions = createMemo(() => data.store.permission?.[props.sessionID] ?? emptyPermissions)
  const nextPermission = createMemo(() => permissions()[0])
  const questions = createMemo(() => data.store.question?.[props.sessionID] ?? emptyQuestions)
  const nextQuestion = createMemo(() => questions()[0])
  const requestTool = createMemo(() => nextPermission()?.tool ?? nextQuestion()?.tool)
  const requestMessage = createMemo(() => {
    const tool = requestTool()
    if (!tool) return
    return findLast(assistantMessages(), (message) => message.id === tool.messageID)
  })
  const pendingRequestCallID = createMemo(() => (requestMessage() ? requestTool()?.callID : undefined))
  const requestParts = createMemo(() => {
    const tool = requestTool()
    if (!tool) return emptyRequestParts

    const message = requestMessage()
    if (!message) return emptyRequestParts

    const parts = data.store.part[message.id] ?? emptyParts
    for (const part of parts) {
      if (part?.type !== "tool") continue
      const toolPart = part as ToolPart
      if (toolPart.callID === tool.callID) return [{ part: toolPart, message }]
    }

    return emptyRequestParts
  })

  const shellModePart = createMemo(() => {
    const p = parts()
    if (p.length === 0) return
    if (!p.every((part) => part?.type === "text" && part?.synthetic)) return

    const msgs = assistantMessages()
    if (msgs.length !== 1) return

    const msgParts = data.store.part[msgs[0].id] ?? emptyParts
    if (msgParts.length !== 1) return

    const assistantPart = msgParts[0]
    if (assistantPart?.type === "tool" && assistantPart.tool === "bash") return assistantPart
  })

  const isShellMode = createMemo(() => !!shellModePart())

  const rawStatus = createMemo(() => {
    const msgs = assistantMessages()
    let last: PartType | undefined
    let currentTask: ToolPart | undefined

    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = data.store.part[msgs[mi].id] ?? emptyParts
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi]
        if (!part) continue
        if (!last) last = part

        if (
          part.type === "tool" &&
          part.tool === "task" &&
          part.state &&
          "metadata" in part.state &&
          part.state.metadata?.sessionId &&
          part.state.status === "running"
        ) {
          currentTask = part as ToolPart
          break
        }
      }
      if (currentTask) break
    }

    const taskSessionId =
      currentTask?.state && "metadata" in currentTask.state
        ? (currentTask.state.metadata?.sessionId as string | undefined)
        : undefined

    if (taskSessionId) {
      const taskMessages = data.store.message[taskSessionId] ?? emptyMessages
      for (let mi = taskMessages.length - 1; mi >= 0; mi--) {
        const msg = taskMessages[mi]
        if (!msg || msg.role !== "assistant") continue

        const msgParts = data.store.part[msg.id] ?? emptyParts
        for (let pi = msgParts.length - 1; pi >= 0; pi--) {
          const part = msgParts[pi]
          if (part) return computeStatusFromPart(part, i18n.t)
        }
      }
    }

    return computeStatusFromPart(last, i18n.t)
  })

  const status = createMemo(() => data.store.session_status[props.sessionID] ?? idle)
  const working = createMemo(() => status().type !== "idle" && isLastUserMessage())
  const retry = createMemo(() => {
    const s = status()
    if (s.type !== "retry") return
    return s
  })

  // Files this turn wrote (completed write/edit/multiedit/apply_patch parts).
  // Feeds the end-of-response "Save as artifact…" affordance on the last
  // completed turn, which promotes a scratch file into a durable Result
  // through the data context's saveArtifact callback.
  const emptyWritten: string[] = []
  const written = createMemo(
    () => {
      const collected: PartType[] = []
      for (const m of assistantMessages()) {
        for (const part of data.store.part[m.id] ?? emptyParts) collected.push(part)
      }
      return writtenFiles(collected)
    },
    emptyWritten,
    { equals: same },
  )

  const response = createMemo(() => lastTextPart()?.text)
  const responsePartId = createMemo(() => lastTextPart()?.id)
  const messageDiffs = createMemo(() => message()?.summary?.diffs ?? emptyDiffs)
  const hasDiffs = createMemo(() => messageDiffs().length > 0)
  const hideResponsePart = createMemo(() => !!responsePartId())

  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    const content = response() ?? ""
    if (!content) return
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const [rootRef, setRootRef] = createSignal<HTMLDivElement | undefined>()
  const [stickyRef, setStickyRef] = createSignal<HTMLDivElement | undefined>()

  const updateStickyHeight = (height: number) => {
    const root = rootRef()
    if (!root) return
    const next = Math.ceil(height)
    root.style.setProperty("--session-turn-sticky-height", `${next}px`)
  }

  function duration() {
    const msg = message()
    if (!msg) return ""
    const completed = lastAssistantMessage()?.time.completed
    const from = DateTime.fromMillis(msg.time.created)
    const to = completed ? DateTime.fromMillis(completed) : DateTime.now()
    const interval = Interval.fromDateTimes(from, to)
    const unit: DurationUnit[] = interval.length("seconds") > 60 ? ["minutes", "seconds"] : ["seconds"]

    const locale = i18n.locale()
    const human = interval.toDuration(unit).normalize().reconfigure({ locale }).toHuman({
      notation: "compact",
      unitDisplay: "narrow",
      compactDisplay: "short",
      showZeros: false,
    })
    return locale.startsWith("zh") ? human.replaceAll("、", "") : human
  }

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
    overflowAnchor: "auto",
  })

  createResizeObserver(
    () => stickyRef(),
    ({ height }) => {
      updateStickyHeight(height)
    },
  )

  createEffect(() => {
    const root = rootRef()
    if (!root) return
    const sticky = stickyRef()
    if (!sticky) {
      root.style.setProperty("--session-turn-sticky-height", "0px")
      return
    }
    updateStickyHeight(sticky.getBoundingClientRect().height)
  })

  const diffInit = 20
  const diffBatch = 20

  const [store, setStore] = createStore({
    retrySeconds: 0,
    diffsOpen: [] as string[],
    diffPreviewsExpanded: [] as string[],
    diffLimit: diffInit,
    artifacts: {} as Record<string, { state: "saving" | "saved" | "error"; error?: string }>,
    status: rawStatus(),
    duration: duration(),
  })

  createEffect(
    on(
      () => message()?.id,
      () => {
        setStore("diffsOpen", [])
        setStore("diffPreviewsExpanded", [])
        setStore("diffLimit", diffInit)
        setStore("artifacts", {})
      },
      { defer: true },
    ),
  )

  const saveArtifact = (path: string) => {
    const save = data.saveArtifact
    if (!save || store.artifacts[path]?.state === "saving") return
    setStore("artifacts", path, { state: "saving" })
    void save(path).then(
      () => setStore("artifacts", path, { state: "saved" }),
      (error: unknown) =>
        setStore("artifacts", path, {
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
    )
  }

  createEffect(() => {
    const r = retry()
    if (!r) {
      setStore("retrySeconds", 0)
      return
    }
    const updateSeconds = () => {
      const next = r.next
      if (next) setStore("retrySeconds", Math.max(0, Math.round((next - Date.now()) / 1000)))
    }
    updateSeconds()
    const timer = setInterval(updateSeconds, 1000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const update = () => {
      setStore("duration", duration())
    }

    update()

    // Only keep ticking while the active (in-progress) turn is running.
    if (!working()) return

    const timer = setInterval(update, 1000)
    onCleanup(() => clearInterval(timer))
  })

  let lastStatusChange = Date.now()
  let statusTimeout: number | undefined
  createEffect(() => {
    const newStatus = rawStatus()
    if (newStatus === store.status || !newStatus) return

    const timeSinceLastChange = Date.now() - lastStatusChange
    if (timeSinceLastChange >= 2500) {
      setStore("status", newStatus)
      lastStatusChange = Date.now()
      if (statusTimeout) {
        clearTimeout(statusTimeout)
        statusTimeout = undefined
      }
    } else {
      if (statusTimeout) clearTimeout(statusTimeout)
      statusTimeout = setTimeout(() => {
        setStore("status", rawStatus())
        lastStatusChange = Date.now()
        statusTimeout = undefined
      }, 2500 - timeSinceLastChange) as unknown as number
    }
  })

  onCleanup(() => {
    if (!statusTimeout) return
    clearTimeout(statusTimeout)
  })

  return (
    <div data-component="session-turn" class={props.classes?.root} ref={setRootRef}>
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()}>
            {(msg) => (
              <div
                ref={autoScroll.contentRef}
                data-message={msg().id}
                data-slot="session-turn-message-container"
                class={props.classes?.container}
              >
                <Switch>
                  <Match when={isShellMode()}>
                    <Part part={shellModePart()!} message={msg()} defaultOpen />
                  </Match>
                  <Match when={true}>
                    <Show when={attachmentParts().length > 0}>
                      <div data-slot="session-turn-attachments" aria-live="off">
                        <Message message={msg()} parts={attachmentParts()} />
                      </div>
                    </Show>
                    <div data-slot="session-turn-sticky" ref={setStickyRef}>
                      {/* User Message */}
                      <div data-slot="session-turn-message-content" aria-live="off">
                        <Message message={msg()} parts={stickyParts()} />
                      </div>

                      {/* Trigger (sticky) */}
                      <Show when={working() || hasSteps()}>
                        <div data-slot="session-turn-response-trigger">
                          <Button
                            data-expandable={assistantMessages().length > 0}
                            data-slot="session-turn-collapsible-trigger-content"
                            variant="ghost"
                            size="small"
                            onClick={props.onStepsExpandedToggle ?? (() => {})}
                            aria-expanded={props.stepsExpanded}
                          >
                            <Switch>
                              <Match when={working()}>
                                <Spinner />
                              </Match>
                              <Match when={true}>
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 10 10"
                                  fill="none"
                                  xmlns="http://www.w3.org/2000/svg"
                                  data-slot="session-turn-trigger-icon"
                                  style={{
                                    transform: props.stepsExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                                    transition: "transform 0.15s ease",
                                  }}
                                >
                                  <path
                                    d="M8.125 1.875H1.875L5 8.125L8.125 1.875Z"
                                    fill="currentColor"
                                    stroke="currentColor"
                                    stroke-linejoin="round"
                                  />
                                </svg>
                              </Match>
                            </Switch>
                            <Switch>
                              <Match when={retry()}>
                                <span data-slot="session-turn-retry-message">
                                  {(() => {
                                    const r = retry()
                                    if (!r) return ""
                                    return r.message.length > 60 ? r.message.slice(0, 60) + "..." : r.message
                                  })()}
                                </span>
                                <span data-slot="session-turn-retry-seconds">
                                  · {i18n.t("ui.sessionTurn.retry.retrying")}
                                  {store.retrySeconds > 0
                                    ? " " + i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: store.retrySeconds })
                                    : ""}
                                </span>
                                <span data-slot="session-turn-retry-attempt">(#{retry()?.attempt})</span>
                              </Match>
                              <Match when={working()}>
                                <span data-slot="session-turn-status-text">
                                  {store.status ?? i18n.t("ui.sessionTurn.status.consideringNextSteps")}
                                </span>
                              </Match>
                              <Match when={props.stepsExpanded}>
                                <span data-slot="session-turn-status-text">{i18n.t("ui.sessionTurn.steps.hide")}</span>
                              </Match>
                              <Match when={!props.stepsExpanded}>
                                <span data-slot="session-turn-status-text">{i18n.t("ui.sessionTurn.steps.show")}</span>
                              </Match>
                            </Switch>
                            <span aria-hidden="true">·</span>
                            <span aria-live="off">{store.duration}</span>
                          </Button>
                        </div>
                      </Show>
                    </div>
                    {/* Response */}
                    <Show when={props.stepsExpanded && assistantMessages().length > 0}>
                      <div data-slot="session-turn-collapsible-content-inner">
                        <AssistantTrace
                          messages={assistantMessages()}
                          responsePartId={responsePartId()}
                          hideResponsePart={hideResponsePart()}
                          hideReasoning={false}
                          hidePromotedTools
                          pendingRequestCallID={pendingRequestCallID()}
                        />
                        <Show when={error()}>
                          <Card variant="error" class="error-card">
                            {sessionErrorText(error())}
                          </Card>
                        </Show>
                      </div>
                    </Show>
                    <Show when={promoted().length > 0}>
                      <details data-slot="session-turn-metadata">
                        <summary>
                          Analysis outputs
                          <span>· {promoted().reduce((count, entry) => count + entry.parts.length, 0)}</span>
                        </summary>
                        <section data-slot="session-turn-promoted-results" aria-label="Analysis code and results">
                          <For each={promoted()}>
                            {(entry) => <Message message={entry.message} parts={entry.parts} />}
                          </For>
                        </section>
                      </details>
                    </Show>
                    <Show when={requestParts().length > 0 || (requestMessage() && nextQuestion())}>
                      <div data-slot="session-turn-permission-parts">
                        <For each={requestParts()}>{({ part, message }) => <Part part={part} message={message} />}</For>
                        <Show when={requestParts().length === 0 && requestMessage() && nextQuestion()}>
                          {(question) => (
                            <div data-component="tool-part-wrapper" data-question="true">
                              <QuestionPrompt request={question()} />
                            </div>
                          )}
                        </Show>
                      </div>
                    </Show>
                    <Show when={response() || hasDiffs()}>
                      <div data-slot="session-turn-summary-section">
                        <div data-slot="session-turn-summary-header">
                          <h2 data-slot="session-turn-summary-title">{i18n.t("ui.sessionTurn.summary.response")}</h2>
                          <div data-slot="session-turn-response" aria-live="polite" aria-atomic="true">
                            <Markdown
                              data-slot="session-turn-markdown"
                              data-diffs={hasDiffs()}
                              text={response() ?? ""}
                              cacheKey={responsePartId()}
                            />
                            <Show when={response()}>
                              <div
                                data-slot="session-turn-response-copy-wrapper"
                                data-copied={copied() ? "true" : undefined}
                              >
                                <Tooltip
                                  value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
                                  placement="top"
                                  gutter={8}
                                >
                                  <IconButton
                                    icon={copied() ? "check" : "copy"}
                                    variant="ghost"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      handleCopy()
                                    }}
                                    aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
                                  />
                                </Tooltip>
                              </div>
                            </Show>
                          </div>
                        </div>
                        <Accordion
                          data-slot="session-turn-accordion"
                          multiple
                          value={store.diffsOpen}
                          onChange={(value) => {
                            if (!Array.isArray(value)) return
                            setStore("diffsOpen", value)
                          }}
                        >
                          <For each={messageDiffs().slice(0, store.diffLimit)}>
                            {(diff, index) => {
                              const previewID = () => `${props.messageID}-diff-preview-${index()}`
                              const expanded = () => store.diffPreviewsExpanded.includes(diff.file!)
                              const long = () => isLongDiffPreview(diff)
                              const setExpanded = (value: boolean) => {
                                setStore("diffPreviewsExpanded", (current) => {
                                  if (value) return current.includes(diff.file!) ? current : [...current, diff.file!]
                                  return current.filter((file) => file !== diff.file)
                                })
                              }

                              return (
                                <Accordion.Item value={diff.file}>
                                  <StickyAccordionHeader>
                                    <Accordion.Trigger>
                                      <div data-slot="session-turn-accordion-trigger-content">
                                        <div data-slot="session-turn-file-info">
                                          <FileIcon
                                            node={{ path: diff.file, type: "file" }}
                                            data-slot="session-turn-file-icon"
                                          />
                                          <div data-slot="session-turn-file-path">
                                            <Show when={diff.file.includes("/")}>
                                              <span data-slot="session-turn-directory">
                                                {`\u202A${getDirectory(diff.file)}\u202C`}
                                              </span>
                                            </Show>
                                            <span data-slot="session-turn-filename">{getFilename(diff.file)}</span>
                                          </div>
                                        </div>
                                        <div data-slot="session-turn-accordion-actions">
                                          <DiffChanges changes={diff} />
                                          <Icon name="chevron-grabber-vertical" size="small" />
                                        </div>
                                      </div>
                                    </Accordion.Trigger>
                                  </StickyAccordionHeader>
                                  <Accordion.Content>
                                    <div data-slot="session-turn-diff-content">
                                      <div
                                        id={previewID()}
                                        data-slot="session-turn-diff-preview"
                                        data-expanded={expanded() ? "true" : undefined}
                                      >
                                        <Show when={store.diffsOpen.includes(diff.file!)}>
                                          <Dynamic
                                            component={diffComponent}
                                            before={{
                                              name: diff.file!,
                                              contents: diff.before!,
                                            }}
                                            after={{
                                              name: diff.file!,
                                              contents: diff.after!,
                                            }}
                                          />
                                        </Show>
                                      </div>
                                      <Show when={long() || data.openFile}>
                                        <div
                                          data-slot="session-turn-diff-actions"
                                          role="group"
                                          aria-label={`Preview actions for ${diff.file}`}
                                        >
                                          <Show when={data.openFile}>
                                            <Button
                                              variant="ghost"
                                              size="small"
                                              icon="file"
                                              onClick={() => data.openFile?.(diff.file!)}
                                            >
                                              Open file
                                            </Button>
                                          </Show>
                                          <Show when={long()}>
                                            <Button
                                              variant="ghost"
                                              size="small"
                                              icon={expanded() ? "collapse" : "expand"}
                                              aria-expanded={expanded()}
                                              aria-controls={previewID()}
                                              onClick={() => setExpanded(!expanded())}
                                            >
                                              {expanded() ? "Compact preview" : "Expand preview"}
                                            </Button>
                                          </Show>
                                        </div>
                                      </Show>
                                    </div>
                                  </Accordion.Content>
                                </Accordion.Item>
                              )
                            }}
                          </For>
                        </Accordion>
                        <Show when={messageDiffs().length > store.diffLimit}>
                          <Button
                            data-slot="session-turn-accordion-more"
                            variant="ghost"
                            size="small"
                            onClick={() => {
                              const total = messageDiffs().length
                              setStore("diffLimit", (limit) => {
                                const next = limit + diffBatch
                                if (next > total) return total
                                return next
                              })
                            }}
                          >
                            {i18n.t("ui.sessionTurn.diff.showMore", {
                              count: messageDiffs().length - store.diffLimit,
                            })}
                          </Button>
                        </Show>
                      </div>
                    </Show>
                    <Show when={!working() && generated().length > 0}>
                      <section
                        data-slot="session-turn-generated"
                        aria-label={`${generated().length} generated artifacts`}
                      >
                        <header>
                          <strong>Generated</strong>
                          <span>· {generated().length}</span>
                        </header>
                        <div data-slot="session-turn-generated-list">
                          <For each={generated()}>
                            {(artifact) => (
                              <button
                                type="button"
                                data-slot="session-turn-generated-artifact"
                                title={`Open ${artifact.title} in Files`}
                                onClick={() => {
                                  if (data.openArtifact) {
                                    data.openArtifact(artifact.id)
                                    return
                                  }
                                  data.openFile?.(artifact.path)
                                }}
                              >
                                <span data-slot="session-turn-generated-preview">
                                  <Show
                                    when={artifact.preview?.kind === "image" ? artifact.preview.data : undefined}
                                    fallback={<FileIcon node={{ path: artifact.path, type: "file" }} />}
                                  >
                                    {(image) => <img src={image()} alt="" loading="lazy" />}
                                  </Show>
                                </span>
                                <span data-slot="session-turn-generated-copy">
                                  <strong>{artifact.title}</strong>
                                  <small>{artifactTypeLabel(artifact)}</small>
                                </span>
                              </button>
                            )}
                          </For>
                        </div>
                      </section>
                    </Show>
                    {/* Explicit save: offer the written files as durable Results */}
                    <Show when={isLastUserMessage() && !working() && !!data.saveArtifact && written().length > 0}>
                      <details data-slot="session-turn-metadata">
                        <summary>
                          Other changed files<span>· {artifactActions(written()).length}</span>
                        </summary>
                        <div data-slot="session-turn-artifact-save">
                          <For each={artifactActions(written())}>
                            {(action) => {
                              const state = () => store.artifacts[action.path]
                              const label = () => {
                                if (state()?.state === "saving")
                                  return `Saving ${action.path.split("/").pop() ?? action.path}…`
                                if (state()?.state === "saved") return "Saved to Results"
                                if (state()?.state === "error") return "Save failed · retry"
                                return action.label
                              }
                              return (
                                <Button
                                  data-slot="session-turn-artifact-action"
                                  data-state={state()?.state}
                                  variant="ghost"
                                  size="small"
                                  title={state()?.error ?? action.path}
                                  disabled={state()?.state === "saving"}
                                  onClick={() => saveArtifact(action.path)}
                                >
                                  {label()}
                                </Button>
                              )
                            }}
                          </For>
                        </div>
                      </details>
                    </Show>
                    <Show when={error() && !props.stepsExpanded}>
                      <Card variant="error" class="error-card">
                        {sessionErrorText(error())}
                      </Card>
                    </Show>
                  </Match>
                </Switch>
              </div>
            )}
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
