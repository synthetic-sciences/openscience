import {
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  type PermissionRequest,
  type QuestionRequest,
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
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  ParentProps,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { DiffChanges } from "./diff-changes"
import { Message, Part, QuestionPrompt } from "./message-part"
import {
  artifactTypeLabel,
  artifactActions,
  generatedArtifacts,
  sessionErrorDisplay,
  reasoningDisplayText,
  privateReasoningOnly,
  stripRedactedReasoning,
  writtenFiles,
} from "./tool-display"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { Card } from "./card"
import { Dynamic } from "solid-js/web"
import { Button } from "./button"
import { Spinner } from "./spinner"
import { createStore } from "solid-js/store"
import { createAutoScroll } from "../hooks"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { responseText } from "./session-turn-response"
import { progressStatus } from "./session-turn-progress"
import { collapsibleTracePart, elapsedLabel, visibleResearchTrace, type ResearchTraceEntry } from "./research-trace"
import { buildTraceRows, editedLabel, exploredLabel, thoughtLabel, type TraceRow } from "./trace-rows"
import { Collapsible } from "./collapsible"
import { MarkdownFileScope, useMarkdownFileResolvers } from "./markdown"

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

export function computeStatusFromPart(part: PartType | undefined, t: Translator): string | undefined {
  if (!part) return undefined

  if (part.type === "tool") {
    // Pending means the model is still supplying arguments, not execution.
    if (part.state.status !== "running") return undefined
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
      case "websearch":
      case "research_search":
        return t("ui.sessionTurn.status.searchingWeb")
      case "edit":
      case "write":
        return t("ui.sessionTurn.status.makingEdits")
      case "bash":
      case "compute_job":
      case "modal":
        return t("ui.sessionTurn.status.runningCommands")
      default:
        return undefined
    }
  }
  if (part.type === "reasoning") {
    if (part.time?.end || !stripRedactedReasoning(part.text ?? "")) return undefined
    return t("ui.sessionTurn.status.thinking")
  }
  if (part.type === "text") {
    if (part.time?.end || !part.text?.trim()) return undefined
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

function isGeneratedTool(part: PartType | undefined): part is ToolPart {
  return part?.type === "tool" && part.tool === "artifact" && part.state.status === "completed"
}

/** One collapsible line of the trace: a verb, a muted summary, a chevron.
 * Nested content is the ordinary part renderer, so details stay identical.
 * A burst of one shows its part directly; the header appears once a second
 * call joins, without remounting the first. */
function TraceGroupRow(props: {
  kind: "explored" | "edited" | "thought"
  label: string
  live?: boolean
  working?: boolean
  header?: boolean
  children: JSX.Element
}) {
  const [manual, setManual] = createSignal<boolean>()
  // Bursts stay open while the turn works so progress reads live, then fold
  // to their one-line summary; a thought streams open and folds when it ends.
  // The reader's own choice always wins.
  const open = () => manual() ?? (props.kind === "thought" ? !!props.live : !!props.working)
  return (
    <Collapsible
      open={open()}
      onOpenChange={(value) => setManual(value)}
      // Nested parts stay mounted while folded: a pending request or a draft
      // answer inside a burst must survive the fold, and find-in-page still works.
      forceMount
      data-component="trace-group"
      data-kind={props.kind}
      data-live={props.live ? "true" : undefined}
      data-header={props.header === false ? "false" : "true"}
    >
      <Show when={props.header !== false}>
        <Collapsible.Trigger>
          <div data-component="trace-row" data-open={open() ? "true" : undefined}>
            <Show when={props.live}>
              <Spinner />
            </Show>
            <span data-slot="trace-row-label">{props.label}</span>
            <Icon name="chevron-down" size="small" data-slot="trace-row-chevron" />
          </div>
        </Collapsible.Trigger>
      </Show>
      <Collapsible.Content>
        <div data-slot="trace-group-body">{props.children}</div>
      </Collapsible.Content>
    </Collapsible>
  )
}

function AssistantTrace(props: {
  messages: AssistantMessage[]
  expanded: boolean
  working: boolean
  pendingRequestCallID?: string
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const pendingChildRequest = (sessionID: string) =>
    !!(data.store.permission?.[sessionID]?.[0] || data.store.question?.[sessionID]?.[0])
  const entries = createMemo(() =>
    visibleResearchTrace(
      props.messages.flatMap((message) =>
        (data.store.part[message.id] ?? emptyParts).map((part) => ({
          message,
          part,
          hidden: (part.type === "tool" && part.tool === "todoread") || isGeneratedTool(part),
        })),
      ),
    ),
  )
  // Collapsed, the turn shows what the reader asked for: the answer, plus
  // anything that still needs them (a failure, a pending request). Expanded,
  // the whole trace appears as rows, chronological, with narration in place.
  const rows = createMemo(() => {
    const all = buildTraceRows(entries())
    if (props.expanded) return all
    return all.filter((row) => {
      if (row.kind === "text") return !row.narration
      if (row.kind === "tool" || row.kind === "agent")
        return !collapsibleTracePart(row.entry.part, props.pendingRequestCallID, pendingChildRequest)
      return false
    })
  })
  // A burst keeps the key of its first call, so a call that joins it later
  // never remounts what the reader already opened.
  const keyOf = (row: TraceRow) =>
    row.kind === "explored" || row.kind === "edited" ? `burst:${row.entries[0]!.part.id}` : row.entry.part.id
  const rowByKey = createMemo(() => new Map(rows().map((row) => [keyOf(row), row])))
  const keys = createMemo(() => rows().map(keyOf), [], { equals: same })
  const live = (entry: ResearchTraceEntry) =>
    entry.part.type === "reasoning" && !entry.part.time?.end && !entry.message.time.completed

  // The kind of a row never changes under a stable key, so pick the renderer
  // once and let only labels stay reactive. Re-picking on every store change
  // would remount the part and drop a pending question's draft.
  return (
    <For each={keys()}>
      {(key) => {
        const row = () => rowByKey().get(key)
        const kind = untrack(row)?.kind
        return (
          <Show when={row()}>
            {(current) => {
              if (kind === "thought") {
                const value = () => current() as Extract<TraceRow, { kind: "thought" }>
                return (
                  <TraceGroupRow
                    kind="thought"
                    live={live(value().entry)}
                    working={props.working}
                    label={thoughtLabel(value().seconds, live(value().entry))}
                  >
                    <Part part={value().entry.part} message={value().entry.message} hideCopy />
                  </TraceGroupRow>
                )
              }
              if (kind === "explored" || kind === "edited") {
                const value = () => current() as Extract<TraceRow, { kind: "explored" | "edited" }>
                const ids = createMemo(() => value().entries.map((entry) => entry.part.id), [], { equals: same })
                const byID = createMemo(() => new Map(value().entries.map((entry) => [entry.part.id, entry])))
                return (
                  <TraceGroupRow
                    kind={kind}
                    working={props.working}
                    header={value().entries.length > 1}
                    label={
                      kind === "explored"
                        ? exploredLabel(value() as Extract<TraceRow, { kind: "explored" }>)
                        : editedLabel(value() as Extract<TraceRow, { kind: "edited" }>)
                    }
                  >
                    <For each={ids()}>
                      {(id) => (
                        <Show when={byID().get(id)}>
                          {(entry) => <Part part={entry().part} message={entry().message} hideCopy />}
                        </Show>
                      )}
                    </For>
                  </TraceGroupRow>
                )
              }
              const value = () => current() as Extract<TraceRow, { kind: "text" | "tool" | "agent" }>
              return (
                <div
                  data-slot="trace-entry"
                  data-narration={(() => {
                    const row = value()
                    return row.kind === "text" && row.narration ? "true" : undefined
                  })()}
                >
                  <Part part={value().entry.part} message={value().entry.message} hideCopy />
                </div>
              )
            }}
          </Show>
        )
      }}
    </For>
  )
}

/** A fault or a pause the reader must act on. A plain stop is not one: it
 * reads on the header line ("Stopped after 2m 3s") and, when a provider or a
 * credential change ended the turn, as one quiet line under the trace. */
function SessionErrorNotice(props: { error: unknown }) {
  const display = () => sessionErrorDisplay(props.error)
  return (
    <Card
      variant={display().state === "paused" ? "warning" : "error"}
      class="session-state-card"
      classList={{ "error-card": display().state === "error" }}
      data-state={display().state}
      data-reason={display().reason}
      role={display().state === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      <div data-slot="session-state-head">
        <Show
          when={display().state !== "error"}
          fallback={<span data-slot="session-state-message">{display().message}</span>}
        >
          <Icon name="alert-circle" size="small" />
          <div data-slot="session-state-copy">
            <strong>{display().title}</strong>
            <span data-slot="session-state-message">{display().message}</span>
          </div>
        </Show>
      </div>
    </Card>
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

  const hasSteps = createMemo(() => {
    for (const m of assistantMessages()) {
      const msgParts = data.store.part[m.id]
      if (!msgParts) continue
      for (const p of msgParts) {
        if (p?.type === "tool") return true
        if (p?.type === "reasoning" && (reasoningDisplayText(p.text ?? "") || privateReasoningOnly(p.text ?? "")))
          return true
      }
    }
    return false
  })

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
    const latest = assistantMessages().at(-1)
    const msgs = latest && !latest.time.completed ? [latest] : []
    let lastStatus: string | undefined
    let currentTask: ToolPart | undefined

    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = data.store.part[msgs[mi].id] ?? emptyParts
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi]
        if (!part) continue
        if (!lastStatus) lastStatus = computeStatusFromPart(part, i18n.t)

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
        if (!msg || msg.role !== "assistant" || msg.time.completed) continue

        const msgParts = data.store.part[msg.id] ?? emptyParts
        for (let pi = msgParts.length - 1; pi >= 0; pi--) {
          const part = msgParts[pi]
          if (!part) continue
          const current = computeStatusFromPart(part, i18n.t)
          if (current) return current
        }
      }
    }

    return lastStatus
  })

  const status = createMemo(() => data.store.session_status[props.sessionID] ?? idle)
  const working = createMemo(() => {
    if (status().type === "idle" || !isLastUserMessage()) return false
    const latest = lastAssistantMessage()
    // Message completion and session status arrive independently. An old busy
    // or retry event cannot restart a request that already ended with an error.
    return !(latest?.time.completed && latest.error)
  })
  const retry = createMemo(() => {
    if (!working()) return
    const s = status()
    if (s.type !== "retry") return
    return s
  })
  // Live provider request phase for this turn's in-flight assistant message.
  // Older backends never publish it, so it is optional end to end.
  const progress = createMemo(() => {
    const item = data.store.session_progress?.[props.sessionID]
    if (!item) return
    if (assistantMessages().at(-1)?.id !== item.messageID) return
    return item
  })

  // Files this turn wrote: completed write/edit/multiedit/apply_patch receipts
  // plus the filesystem diffs the backend recorded after each step, which is
  // how a shell command's outputs are known without guessing from its text.
  // Recorded paths go through the same host-path rules the chat's file links
  // use, so only project or session-scratch targets are offered. Feeds the
  // end-of-response "Save as artifact…" affordance on the last completed turn
  // (promoting a scratch file into a durable Result through the data context's
  // saveArtifact callback) and the receipt of a turn that ended early.
  const resolvers = useMarkdownFileResolvers()
  const resolveReceipt = (path: string) => {
    const resolve = resolvers.resolveFileReceipt ?? resolvers.resolveFile
    return resolve ? resolve(path) : path
  }
  const turnParts = createMemo(() =>
    assistantMessages().flatMap((message) => data.store.part[message.id] ?? emptyParts),
  )
  const emptyWritten: string[] = []
  const candidates = createMemo(
    () => writtenFiles(turnParts(), { canonicalOnly: true, resolve: resolveReceipt }),
    emptyWritten,
    {
      equals: same,
    },
  )
  const outputsIdle = createMemo(() => data.store.session_status[props.sessionID]?.type === "idle")
  const [existing, { refetch: refreshReceipts }] = createResource(
    () => {
      if (!data.resolveFileReceipts || !candidates().length) return false
      return { paths: candidates(), idle: outputsIdle(), sessionID: props.sessionID }
    },
    ({ paths, sessionID }) =>
      data.resolveFileReceipts!(sessionID, paths).then(
        (paths) => ({ paths, error: false }),
        () => ({ paths: emptyWritten, error: true }),
      ),
    // Background receipt checks must not suspend the surrounding transcript.
    { initialValue: { paths: emptyWritten, error: false } },
  )
  const written = createMemo(() =>
    data.resolveFileReceipts ? candidates().filter((path) => existing.latest.paths.includes(path)) : candidates(),
  )
  const linkedFiles = written
  // A stop the user asked for needs no explanation beyond the header line; a
  // stop the provider or a credential change caused keeps its reason.
  const stopped = createMemo(() => {
    const value = error()
    return !!value && sessionErrorDisplay(value).state === "stopped"
  })
  const stopNote = createMemo(() => {
    const value = error()
    if (!value) return undefined
    const display = sessionErrorDisplay(value)
    if (display.state !== "stopped" || display.reason === "user") return undefined
    return display.message
  })

  const response = createMemo(() =>
    responseText(assistantMessages().flatMap((message) => data.store.part[message.id] ?? emptyParts)),
  )
  const messageDiffs = createMemo(() => message()?.summary?.diffs ?? emptyDiffs)
  const hasDiffs = createMemo(() => messageDiffs().length > 0)

  const [copy, setCopy] = createStore({ copied: false, error: false })
  const copyTimer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  onCleanup(() => clearTimeout(copyTimer.current))

  const handleCopy = async () => {
    const content = response()
    if (!content) return
    clearTimeout(copyTimer.current)
    setCopy({ copied: false, error: false })
    if (!navigator.clipboard) {
      setCopy("error", true)
      return
    }
    await navigator.clipboard.writeText(content).then(
      () => {
        setCopy("copied", true)
        copyTimer.current = setTimeout(() => setCopy("copied", false), 2000)
      },
      () => setCopy("error", true),
    )
  }

  const [rootRef, setRootRef] = createSignal<HTMLDivElement | undefined>()
  const [stickyRef, setStickyRef] = createSignal<HTMLDivElement | undefined>()

  const updateStickyHeight = (height: number) => {
    const root = rootRef()
    if (!root) return
    // A transcript that lets the user message scroll away (position: static)
    // offsets nothing below it.
    const sticky = stickyRef()
    const pinned = !!sticky && getComputedStyle(sticky).position === "sticky"
    root.style.setProperty("--session-turn-sticky-height", `${pinned ? Math.ceil(height) : 0}px`)
  }

  function duration() {
    const msg = message()
    if (!msg) return ""
    const completed = lastAssistantMessage()?.time.completed
    // The same "6m 10s" form the activity rows use, instead of a list-formatted
    // "6m, 10s" that read as two separate values.
    return elapsedLabel((completed ?? Date.now()) - msg.time.created)
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
    stepsExpanded: undefined as boolean | undefined,
    retrySeconds: 0,
    now: Date.now(),
    diffsOpen: [] as string[],
    diffPreviewsExpanded: [] as string[],
    diffLimit: diffInit,
    artifacts: {} as Record<string, { state: "saving" | "saved" | "error"; error?: string }>,
    duration: duration(),
  })

  const expanded = () => props.stepsExpanded ?? store.stepsExpanded ?? false
  const traceID = () => `session-turn-trace-${props.messageID}`
  const toggleSteps = () => {
    props.onUserInteracted?.()
    if (props.onStepsExpandedToggle) return props.onStepsExpandedToggle()
    setStore("stepsExpanded", !expanded())
  }

  // Open a live turn once. Finishing a response must not collapse the text
  // underneath someone reading it, and an explicit collapse must stay put.
  createEffect(() => {
    if (working() && store.stepsExpanded === undefined) setStore("stepsExpanded", true)
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
      setStore("now", Date.now())
    }

    update()

    // Only keep ticking while the active (in-progress) turn is running.
    if (!working()) return

    const timer = setInterval(update, 1000)
    onCleanup(() => clearInterval(timer))
  })

  // Waiting belongs to the current request. Completed tools from earlier
  // steps must never replace it with a stale execution label.
  const phase = createMemo(() => {
    const current = progress()
    const status = progressStatus(current, store.now)
    const latest = assistantMessages().at(-1)
    const running =
      latest &&
      (data.store.part[latest.id] ?? emptyParts).some((part) => part.type === "tool" && part.state.status === "running")
    if (current?.phase === "streaming" && running) return
    if (current?.phase === "streaming" && !status?.hint && rawStatus()) return
    return status
  })
  const statusText = createMemo(() => {
    const live = phase()
    if (live) return i18n.t(live.key, live.params)
    const current = rawStatus()
    if (current) return current
    return i18n.t("ui.sessionTurn.status.consideringNextSteps")
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
                    </div>
                    {/* One disclosure owns this turn's trace, never the whole
                        conversation. It has its own sticky row because the
                        transcript lets the user message scroll away, and a long
                        trace must stay collapsible from wherever the reader is.
                        Request and retry status sit beside the label, never in
                        place of it. */}
                    {/* One line owns the trace, the way Cursor does it: while
                        working it is the live status; afterwards it reads
                        "Worked for 2m 3s" and folds the whole trace. */}
                    <Show when={working() || hasSteps()}>
                      <div data-slot="session-turn-trace-control" data-working={working() ? "true" : undefined}>
                        <Show when={hasSteps()}>
                          <Button
                            type="button"
                            data-slot="session-turn-collapsible-trigger-content"
                            variant="ghost"
                            size="small"
                            aria-expanded={expanded()}
                            aria-controls={traceID()}
                            aria-label={i18n.t(expanded() ? "ui.sessionTurn.steps.hide" : "ui.sessionTurn.steps.show")}
                            title={i18n.t("ui.sessionTurn.totalTime")}
                            onClick={toggleSteps}
                          >
                            <Show when={working()}>
                              <Spinner />
                            </Show>
                            <Icon name="chevron-down" size="small" data-slot="session-turn-trigger-icon" />
                            <span data-slot="session-turn-trigger-label">
                              <Switch>
                                <Match when={working() && retry()}>
                                  <span data-slot="session-turn-retry-message">{retry()?.message}</span>
                                  <span data-slot="session-turn-retry-seconds">
                                    · {i18n.t("ui.sessionTurn.retry.retrying")}
                                    {store.retrySeconds > 0
                                      ? " " + i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: store.retrySeconds })
                                      : ""}
                                  </span>
                                  <span data-slot="session-turn-retry-attempt">(#{retry()?.attempt})</span>
                                </Match>
                                <Match when={working()}>
                                  <span data-slot="session-turn-status-text">{statusText()}</span>
                                </Match>
                                <Match when={stopped()}>
                                  {i18n.t("ui.sessionTurn.stoppedAfter", { duration: store.duration })}
                                </Match>
                                <Match when={true}>
                                  {i18n.t("ui.sessionTurn.workedFor", { duration: store.duration })}
                                </Match>
                              </Switch>
                            </span>
                            <Show when={working()}>
                              <span data-slot="session-turn-duration" aria-live="off">
                                {store.duration}
                              </span>
                            </Show>
                          </Button>
                        </Show>
                        <Show when={working() && !hasSteps()}>
                          <div data-slot="session-turn-live-status" aria-live="off" title={statusText()}>
                            <Spinner />
                            <span data-slot="session-turn-status-text">{statusText()}</span>
                            <span data-slot="session-turn-duration" aria-live="off">
                              {store.duration}
                            </span>
                          </div>
                        </Show>
                      </div>
                    </Show>
                    <Show when={assistantMessages().length > 0}>
                      <div
                        id={traceID()}
                        data-slot="session-turn-response-section"
                        data-expanded={expanded() ? "true" : undefined}
                      >
                        <MarkdownFileScope paths={linkedFiles()}>
                          <AssistantTrace
                            messages={assistantMessages()}
                            expanded={expanded()}
                            working={working()}
                            pendingRequestCallID={requestTool()?.callID}
                          />
                        </MarkdownFileScope>
                        <Show when={response()}>
                          <div
                            data-slot="session-turn-response-copy-wrapper"
                            data-copied={copy.copied ? "true" : undefined}
                            role="group"
                            aria-label="Response actions"
                          >
                            <Button
                              icon={copy.copied ? "check" : "copy"}
                              size="small"
                              variant="ghost"
                              onMouseDown={(event: MouseEvent) => event.preventDefault()}
                              onClick={(event: MouseEvent) => {
                                event.stopPropagation()
                                void handleCopy()
                              }}
                              aria-label="Copy response"
                            >
                              {copy.copied ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
                            </Button>
                            <span role="status" aria-live="polite">
                              {copy.error ? "Could not copy. Select the response text and copy it manually." : ""}
                            </span>
                          </div>
                        </Show>
                        <Show when={error()}>
                          {(value) => (
                            <Switch>
                              <Match when={stopped() && stopNote()}>
                                <p data-slot="session-turn-stop-note" role="status">
                                  {stopNote()}
                                </p>
                              </Match>
                              <Match when={!stopped()}>
                                <SessionErrorNotice error={value()} />
                              </Match>
                            </Switch>
                          )}
                        </Show>
                      </div>
                    </Show>
                    <Show when={requestParts().length === 0 && requestMessage() && nextQuestion()}>
                      <div data-slot="session-turn-permission-parts">
                        <Show when={requestParts().length === 0 && requestMessage() && nextQuestion()}>
                          {(question) => (
                            <div data-component="tool-part-wrapper" data-question="true">
                              <QuestionPrompt request={question()} />
                            </div>
                          )}
                        </Show>
                      </div>
                    </Show>
                    <Show when={hasDiffs()}>
                      <div data-slot="session-turn-summary-section">
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
                    {/* Session outputs stay editable in scratch until explicitly kept as immutable Results. */}
                    <Show when={!working() && existing.latest.error}>
                      <div data-slot="session-turn-output-error">
                        <span>Session outputs could not be checked.</span>
                        <Button
                          variant="ghost"
                          size="small"
                          disabled={existing.loading}
                          onClick={() => void refreshReceipts()}
                        >
                          Retry file check
                        </Button>
                      </div>
                    </Show>
                    <Show when={isLastUserMessage() && !working() && !!data.saveArtifact && written().length > 0}>
                      {/* One quiet line by default; the file list opens on demand. */}
                      <details data-slot="session-turn-session-outputs">
                        <summary>
                          <Icon name="chevron-down" size="small" />
                          <strong>
                            {artifactActions(written()).length}{" "}
                            {artifactActions(written()).length === 1 ? "file" : "files"} written this turn
                          </strong>
                          <small>Save the ones that matter to Results</small>
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
                                return "Save to Results"
                              }
                              return (
                                <div data-slot="session-turn-output-row">
                                  <button
                                    type="button"
                                    data-slot="session-turn-output-file"
                                    title={action.path}
                                    onClick={() => data.openFile?.(action.path)}
                                  >
                                    <FileIcon node={{ path: action.path, type: "file" }} />
                                    <span>{action.path.split("/").pop() ?? action.path}</span>
                                  </button>
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
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </details>
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
