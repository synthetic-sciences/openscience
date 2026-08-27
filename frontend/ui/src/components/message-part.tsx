import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  onCleanup,
  type JSX,
} from "solid-js"
import stripAnsi from "strip-ansi"
import { Dynamic } from "solid-js/web"
import {
  AgentPart,
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessage,
  Todo,
  QuestionRequest,
  QuestionAnswer,
  QuestionInfo,
} from "@synsci/sdk/v2"
import { createStore } from "solid-js/store"
import { useData } from "../context"
import { useDiffComponent } from "../context/diff"
import { useCodeComponent } from "../context/code"
import { useDialog } from "../context/dialog"
import { useI18n } from "../context/i18n"
import { BasicTool } from "./basic-tool"
import { GenericTool } from "./basic-tool"
import { Button } from "./button"
import { Card } from "./card"
import { createTypewriter } from "./typewriter"
import { Icon } from "./icon"
import { Checkbox } from "./checkbox"
import { DiffChanges } from "./diff-changes"
import { Spinner } from "./spinner"
import { Markdown } from "./markdown"
import { ImagePreview } from "./image-preview"
import { findLast } from "@synsci/util/array"
import { getDirectory as _getDirectory, getFilename } from "@synsci/util/path"
import { checksum } from "@synsci/util/encode"
import { Tooltip } from "./tooltip"
import { IconButton } from "./icon-button"
import { createAutoScroll } from "../hooks"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import {
  reasoningDisplayText,
  savedArtifact,
  scienceTaskLabel,
  sentenceCaseLabel,
  skillActivity,
  toolErrorDisplay,
} from "./tool-display"
import { ToolRegistry, type ToolProps } from "./tool-registry"
import { formatTaskDuration, stripTaskMetadata, summarizeTaskActivity } from "./research-trace"

export { ARTIFACT_TOOL, ToolRegistry, type ToolComponent, type ToolProps } from "./tool-registry"

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath] ?? []
  return diagnostics.filter((d) => d.severity === 1).slice(0, 3)
}

function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

type PermissionReply = "once" | "session" | "project" | "always" | "reject"

function modalMachine(plan: Record<string, any>) {
  const resources = plan.resources ?? {}
  return [
    plan.gpu === "none" ? "CPU" : `${plan.gpu} GPU`,
    resources.cpus ? `${resources.cpus} CPU` : undefined,
    resources.memory_gb ? `${resources.memory_gb} GB memory` : undefined,
    plan.image,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ")
}

function computeDetails(plan: Record<string, any>) {
  if (plan.provider === "modal") {
    return [
      ["Machine", modalMachine(plan)],
      ["Timeout", `${plan.timeout_minutes} min`],
      ["Network", plan.network === "none" ? "Blocked" : "Unrestricted"],
    ]
  }
  return [
    ["Host", `${plan.label} · ${plan.host}`],
    ["Scheduler", plan.scheduler === "none" ? "Direct SSH" : String(plan.scheduler).toUpperCase()],
    ["Host key", plan.fingerprint],
  ]
}

/** The approval card under a tool awaiting permission. States exactly what is
 *  being granted (access level and target) when the request carries scoped
 *  metadata; "Allow for…" swaps the row to the three standing scopes so every
 *  option stays a plain button. */
function PermissionActions(props: { respond: (response: PermissionReply) => void; metadata?: Record<string, any> }) {
  const i18n = useI18n()
  const [scopes, setScopes] = createSignal(false)
  const compute = () => props.metadata?.compute
  const mutation = () => props.metadata?.environment_mutation
  const boundary = () => compute() ?? mutation()
  const mutationOperation = () => {
    const value = mutation()?.operation
    if (value === "package_install") return "Install packages"
    if (value === "package_remove") return "Remove packages"
    return "Update environment"
  }
  const summary = () => {
    const filesystem = props.metadata?.filesystem
    if (filesystem?.path) {
      const key = filesystem.access === "write" ? "ui.permission.grantWrite" : "ui.permission.grantRead"
      return i18n.t(key, { path: filesystem.path })
    }
    const network = props.metadata?.network
    if (network?.host) return i18n.t("ui.permission.allowHost", { host: network.host })
    return undefined
  }
  return (
    <Show
      when={Boolean(
        ((compute()?.provider === "modal" || compute()?.provider === "ssh") && compute()) ||
          (mutation()?.plan_digest && mutation()),
      )}
      fallback={
        <div data-component="permission-prompt">
          <span data-slot="permission-origin">OpenScience approval</span>
          <Show when={summary()}>
            <div data-slot="permission-summary">{summary()}</div>
          </Show>
          <div data-slot="permission-actions">
            <Show
              when={scopes()}
              fallback={
                <>
                  <Button variant="ghost" size="small" onClick={() => props.respond("reject")}>
                    {i18n.t("ui.permission.deny")}
                  </Button>
                  <Button variant="secondary" size="small" onClick={() => setScopes(true)}>
                    {i18n.t("ui.permission.allow")}
                  </Button>
                  <Button variant="primary" size="small" onClick={() => props.respond("once")}>
                    {i18n.t("ui.permission.allowOnce")}
                  </Button>
                </>
              }
            >
              <Button variant="ghost" size="small" onClick={() => setScopes(false)}>
                {i18n.t("ui.common.cancel")}
              </Button>
              <Button variant="secondary" size="small" onClick={() => props.respond("session")}>
                {i18n.t("ui.permission.allowSession")}
              </Button>
              <Button variant="secondary" size="small" onClick={() => props.respond("project")}>
                {i18n.t("ui.permission.allowProject")}
              </Button>
              <Button variant="secondary" size="small" onClick={() => props.respond("always")}>
                {i18n.t("ui.permission.allowAlways")}
              </Button>
            </Show>
          </div>
        </div>
      }
    >
      <div data-component="permission-prompt" data-kind={mutation() ? "environment-mutation" : "remote-compute"}>
        <span data-slot="permission-origin">OpenScience approval</span>
        <div data-slot="permission-summary" data-kind={mutation() ? "environment-mutation" : "remote-compute"}>
          <strong data-slot="permission-compute-title">
            {mutation()
              ? `Change ${String(mutation().language).toUpperCase()} environment`
              : boundary().provider === "modal"
                ? "Run outside the local sandbox"
                : "Run on a saved SSH host"}
          </strong>
          <span data-slot="permission-compute-purpose">{mutation() ? mutationOperation() : boundary().purpose}</span>
          <div
            data-slot="permission-compute-details"
            aria-label={mutation() ? "Environment change details" : "Remote job details"}
          >
            <For
              each={
                mutation()
                  ? [
                      ["Language", String(mutation().language).toUpperCase()],
                      ["Environment", mutation().environment],
                      ["Manager", mutation().manager],
                    ]
                  : computeDetails(boundary())
              }
            >
              {(row) => (
                <>
                  <span>{row[0]}</span>
                  <strong>{row[1]}</strong>
                </>
              )}
            </For>
          </div>
          <span data-slot="permission-compute-warning">
            {mutation()
              ? mutation().warning
              : boundary().provider === "modal"
                ? "Runs in your Modal account, outside OpenScience's local sandbox. It may incur Modal charges until the job exits, is cancelled, or reaches its timeout."
                : boundary().warning}
          </span>
          <span data-slot="permission-compute-scope">
            {mutation()
              ? "Every scope applies only to this exact requested change. A successful change restarts this environment and clears its in-memory state; files and execution history remain."
              : "Every scope is bound to this exact plan, including its command, machine, image, network, and input file hashes."}
          </span>
        </div>
        <div
          data-slot="permission-actions"
          aria-label={mutation() ? "Environment change approval scope" : "Remote compute approval scope"}
        >
          <Button variant="ghost" size="small" onClick={() => props.respond("reject")}>
            {i18n.t("ui.permission.deny")}
          </Button>
          <Button variant="primary" size="small" onClick={() => props.respond("once")}>
            {i18n.t("ui.permission.scopeOnce")}
          </Button>
          <Button variant="secondary" size="small" onClick={() => props.respond("session")}>
            {i18n.t("ui.permission.allowSession")}
          </Button>
          <Button variant="secondary" size="small" onClick={() => props.respond("project")}>
            {i18n.t("ui.permission.allowProject")}
          </Button>
          <Button variant="secondary" size="small" onClick={() => props.respond("always")}>
            {i18n.t("ui.permission.scopeGlobal")}
          </Button>
        </div>
      </div>
    </Show>
  )
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

// A file-mutation tool (write/edit/apply_patch) has no diff/content for a brief
// window right after it starts, which would otherwise render a title-only card
// that reads as "done but blank". Show a compact spinner + label during that
// genuinely-blank window only; each renderer's <Show> also opens as soon as its
// body content is available (e.g. the diff/content used during permission
// approval, which happens before the tool finishes), not just on completion.
function isToolDone(status?: string) {
  return status === "completed" || status === "error"
}

function ToolProgress(props: { label: string; subtitle?: string }): JSX.Element {
  return (
    <div data-component="tool-progress">
      <Spinner />
      <span data-slot="tool-progress-label">{props.label}</span>
      <Show when={props.subtitle}>
        <span data-slot="tool-progress-subtitle">{props.subtitle}</span>
      </Show>
    </div>
  )
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function relativizeProjectPaths(text: string, directory?: string) {
  if (!text) return ""
  if (!directory) return text
  return text.split(directory).join("")
}

function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPaths(_getDirectory(path), data.directory)
}

export function getSessionToolParts(store: ReturnType<typeof useData>["store"], sessionId: string): ToolPart[] {
  const messages = store.message[sessionId]?.filter((m) => m.role === "assistant")
  if (!messages) return []

  const parts: ToolPart[] = []
  for (const m of messages) {
    const msgParts = store.part[m.id]
    if (msgParts) {
      for (const p of msgParts) {
        if (p && p.type === "tool") parts.push(p as ToolPart)
      }
    }
  }
  return parts
}

import type { IconProps } from "./icon"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

export function getToolInfo(tool: string, input: any = {}): ToolInfo {
  const i18n = useI18n()
  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "list":
      return {
        icon: "bullet-list",
        title: i18n.t("ui.tool.list"),
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.glob"),
        subtitle: input.pattern,
      }
    case "grep":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: input.pattern,
      }
    case "webfetch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.webfetch"),
        subtitle: input.url,
      }
    case "task":
      return {
        icon: "task",
        title: i18n.t("ui.tool.agent", { type: sentenceCaseLabel(String(input.subagent_type || "task")) }),
        subtitle: input.description,
      }
    case "bash":
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell"),
        subtitle: input.description,
      }
    case "edit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "write":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "generate_image":
      return {
        icon: "photo",
        title: "Generate image",
        subtitle: input.output_path,
      }
    case "apply_patch":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle: input.files?.length
          ? `${input.files.length} ${i18n.t(input.files.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case "planwrite":
      return {
        icon: "checklist",
        title: "Plan updated",
      }
    case "todoread":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos.read"),
      }
    case "question":
      return {
        icon: "bubble-5",
        title: i18n.t("ui.tool.questions"),
      }
    case "websearch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.websearch"),
        subtitle: input.query,
      }
    case "codesearch":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.codesearch"),
        subtitle: input.query ?? input.pattern,
      }
    case "multiedit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.multiedit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "learn":
      return {
        icon: "mcp",
        title: i18n.t("ui.tool.learn"),
      }
    case "notebook":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.notebook"),
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    default:
      return {
        icon: "mcp",
        title: tool,
      }
  }
}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={props.message.role === "user" && props.message}>
        {(userMessage) => <UserMessageDisplay message={userMessage() as UserMessage} parts={props.parts} />}
      </Match>
      <Match when={props.message.role === "assistant" && props.message}>
        {(assistantMessage) => (
          <AssistantMessageDisplay message={assistantMessage() as AssistantMessage} parts={props.parts} />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: { message: AssistantMessage; parts: PartType[] }) {
  const emptyParts: PartType[] = []
  const filteredParts = createMemo(
    () =>
      props.parts.filter((x) => {
        return x.type !== "tool" || (x as ToolPart).tool !== "todoread"
      }),
    emptyParts,
    { equals: same },
  )
  return <For each={filteredParts()}>{(part) => <Part part={part} message={props.message} />}</For>
}

export function UserMessageDisplay(props: { message: UserMessage; parts: PartType[] }) {
  const dialog = useDialog()
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [canExpand, setCanExpand] = createSignal(false)
  let textRef: HTMLDivElement | undefined

  const updateCanExpand = () => {
    const el = textRef
    if (!el) return
    if (expanded()) return
    setCanExpand(el.scrollHeight > el.clientHeight + 2)
  }

  createResizeObserver(
    () => textRef,
    () => {
      updateCanExpand()
    },
  )

  const textPart = createMemo(
    () => props.parts?.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined,
  )

  const text = createMemo(() => textPart()?.text || "")

  createEffect(() => {
    text()
    updateCanExpand()
  })

  const files = createMemo(() => (props.parts?.filter((p) => p.type === "file") as FilePart[]) ?? [])

  const attachments = createMemo(() =>
    files()?.filter((f) => {
      const mime = f.mime
      // Images and PDFs are always attachments. A raw uploaded blob (data: URL with
      // no source.text — e.g. an uploaded .md/.txt) also renders as a filename chip;
      // @file references carry source.text and stay inline instead.
      return (
        mime.startsWith("image/") ||
        mime === "application/pdf" ||
        (f.url?.startsWith("data:") === true && f.source?.text === undefined)
      )
    }),
  )

  const inlineFiles = createMemo(() =>
    files().filter((f) => {
      const mime = f.mime
      return !mime.startsWith("image/") && mime !== "application/pdf" && f.source?.text?.start !== undefined
    }),
  )

  const agents = createMemo(() => (props.parts?.filter((p) => p.type === "agent") as AgentPart[]) ?? [])

  const openImagePreview = (url: string, alt?: string) => {
    dialog.show(() => <ImagePreview src={url} alt={alt} />)
  }

  const attachmentFormat = (file: FilePart) => {
    const name = file.filename?.trim() ?? ""
    const dot = name.lastIndexOf(".")
    const extension =
      dot > -1
        ? name
            .slice(dot + 1)
            .trim()
            .toUpperCase()
        : ""
    if (extension && extension.length <= 8) return extension
    if (file.mime === "application/pdf") return "PDF"
    return file.mime.split("/").pop()?.replace(/^x-/, "").toUpperCase() || "FILE"
  }

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const toggleExpanded = () => {
    if (!canExpand()) return
    setExpanded((value) => !value)
  }

  return (
    <div data-component="user-message" data-expanded={expanded()} data-can-expand={canExpand()}>
      <Show when={attachments().length > 0}>
        <div data-slot="user-message-attachments">
          <For each={attachments()}>
            {(file) => (
              <a
                data-slot="user-message-attachment"
                data-type={file.mime.startsWith("image/") ? "image" : "file"}
                href={file.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`${file.mime.startsWith("image/") ? "Preview" : "Open"} ${file.filename ?? i18n.t("ui.message.attachment.alt")}`}
                onClick={(event) => {
                  if (file.mime.startsWith("image/") && file.url) {
                    event.preventDefault()
                    openImagePreview(file.url, file.filename)
                  }
                }}
              >
                <Show
                  when={file.mime.startsWith("image/") && file.url}
                  fallback={
                    <div data-slot="user-message-attachment-icon">
                      <Icon name="file" />
                    </div>
                  }
                >
                  <img data-slot="user-message-attachment-image" src={file.url} alt="" />
                </Show>
                <span data-slot="user-message-attachment-copy">
                  <strong title={file.filename}>{file.filename ?? i18n.t("ui.message.attachment.alt")}</strong>
                  <span>
                    {attachmentFormat(file)} · {file.mime.startsWith("image/") ? "Preview" : "Open"}
                  </span>
                </span>
              </a>
            )}
          </For>
        </div>
      </Show>
      <Show when={text()}>
        <div data-slot="user-message-row">
          <div data-slot="user-message-copy-wrapper" data-copied={copied()}>
            <Tooltip
              value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              placement="top"
              gutter={8}
            >
              <IconButton
                type="button"
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
          <div data-slot="user-message-content">
            <div data-slot="user-message-text" ref={(el) => (textRef = el)} onClick={toggleExpanded}>
              <HighlightedText text={text()} references={inlineFiles()} agents={agents()} />
            </div>
            <Tooltip
              value={expanded() ? i18n.t("ui.message.collapse") : i18n.t("ui.message.expand")}
              placement="top"
              gutter={8}
            >
              <button
                data-slot="user-message-expand"
                type="button"
                aria-label={expanded() ? i18n.t("ui.message.collapse") : i18n.t("ui.message.expand")}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleExpanded()
                }}
              >
                <Icon name="chevron-down" size="small" />
              </button>
            </Tooltip>
          </div>
        </div>
      </Show>
    </div>
  )
}

type HighlightSegment = { text: string; type?: "file" | "agent" }

function HighlightedText(props: { text: string; references: FilePart[]; agents: AgentPart[] }) {
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file" | "agent" }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text!.start, end: r.source!.text!.end, type: "file" as const })),
      ...props.agents
        .filter((a) => a.source?.start !== undefined && a.source?.end !== undefined)
        .map((a) => ({ start: a.source!.start, end: a.source!.end, type: "agent" as const })),
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type })
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return <For each={segments()}>{(segment) => <span data-highlight={segment.type}>{segment.text}</span>}</For>
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
      />
    </Show>
  )
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = props.part as ToolPart

  const permission = createMemo(() => {
    const next = data.store.permission?.[props.message.sessionID]?.[0]
    if (!next || !next.tool) return undefined
    if (next.tool!.callID !== part.callID) return undefined
    return next
  })

  const questionRequest = createMemo(() => {
    const next = data.store.question?.[props.message.sessionID]?.[0]
    if (!next || !next.tool) return undefined
    if (next.tool!.callID !== part.callID) return undefined
    return next
  })

  const [showPermission, setShowPermission] = createSignal(false)
  const [showQuestion, setShowQuestion] = createSignal(false)

  createEffect(() => {
    const perm = permission()
    if (perm) {
      const timeout = setTimeout(() => setShowPermission(true), 50)
      onCleanup(() => clearTimeout(timeout))
    } else {
      setShowPermission(false)
    }
  })

  createEffect(() => {
    const question = questionRequest()
    if (question) {
      const timeout = setTimeout(() => setShowQuestion(true), 50)
      onCleanup(() => clearTimeout(timeout))
    } else {
      setShowQuestion(false)
    }
  })

  const [forceOpen, setForceOpen] = createSignal(false)
  createEffect(() => {
    if (permission() || questionRequest()) setForceOpen(true)
  })

  const respond = (response: PermissionReply) => {
    const perm = permission()
    if (!perm || !data.respondToPermission) return
    data.respondToPermission({
      sessionID: perm.sessionID,
      permissionID: perm.id,
      response,
    })
  }

  const emptyInput: Record<string, any> = {}
  const emptyMetadata: Record<string, any> = {}

  const input = () => part.state?.input ?? emptyInput
  // @ts-expect-error
  const partMetadata = () => part.state?.metadata ?? emptyMetadata
  const metadata = () => {
    const perm = permission()
    if (perm?.metadata) return { ...perm.metadata, ...partMetadata() }
    return partMetadata()
  }
  // @ts-expect-error - title only exists on the running/completed state variants
  const title = () => part.state?.title as string | undefined

  const render = createMemo(() => ToolRegistry.render(part.tool, metadata()) ?? GenericTool)

  return (
    <div data-component="tool-part-wrapper" data-permission={showPermission()} data-question={showQuestion()}>
      <Switch>
        <Match when={part.state.status === "error" && part.state.error}>
          {(error) => {
            const display = () => toolErrorDisplay(part.tool, error())
            return (
              <Card variant="error">
                <div data-component="tool-error">
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
          }}
        </Match>
        <Match when={true}>
          <Dynamic
            component={render()}
            input={input()}
            tool={part.tool}
            metadata={metadata()}
            // @ts-expect-error
            output={part.state.output}
            status={part.state.status}
            partID={part.id}
            title={title()}
            hideDetails={props.hideDetails}
            forceOpen={forceOpen()}
            locked={showPermission() || showQuestion()}
            defaultOpen={props.defaultOpen}
          />
        </Match>
      </Switch>
      <Show when={showPermission() && permission()}>
        <PermissionActions respond={respond} metadata={permission()?.metadata} />
      </Show>
      <Show when={showQuestion() && questionRequest()}>{(request) => <QuestionPrompt request={request()} />}</Show>
    </div>
  )
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = props.part as TextPart
  const displayText = () => relativizeProjectPaths((part.text ?? "").trim(), data.directory)
  const throttledText = createTypewriter(displayText)
  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    const content = displayText()
    if (!content) return
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Show when={throttledText()}>
      <div data-component="text-part">
        <div data-slot="text-part-body">
          <Markdown text={throttledText()} cacheKey={part.id} />
          <div data-slot="text-part-copy-wrapper">
            <Tooltip
              value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              placement="top"
              gutter={8}
            >
              <IconButton
                icon={copied() ? "check" : "copy"}
                variant="secondary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              />
            </Tooltip>
          </div>
        </div>
      </div>
    </Show>
  )
}

// Keep the provider-visible reasoning bytes untouched in the stored message so
// signed continuation still works. Normalize only its presentation: OpenRouter
// can concatenate provider summary headings directly onto adjacent prose.
// Encrypted reasoning remains in providerMetadata and is never rendered.

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const part = props.part as ReasoningPart
  const text = () => reasoningDisplayText(part.text)

  return (
    <Show when={text()}>
      <div data-component="reasoning-part" data-origin="provider-reasoning">
        <Markdown text={text()} cacheKey={part.id} />
      </div>
    </Show>
  )
}

function KernelTool(props: ToolProps & { language: "python" | "r"; label: "Python" | "R" }) {
  const code = () => (typeof props.input.code === "string" ? props.input.code : "")
  const kernel = () => (typeof props.input.kernel === "string" ? props.input.kernel : props.language)
  const task = () => scienceTaskLabel({ title: props.input.title, code: code(), language: props.language })
  const source = () => (typeof props.input.source === "string" ? props.input.source : undefined)
  const count = () => (typeof props.metadata.executionCount === "number" ? props.metadata.executionCount : undefined)
  const failed = () => props.metadata.ok === false || props.status === "error"
  const subtitle = () =>
    [props.label, `env ${kernel()}`, count() === undefined ? undefined : `run ${count()}`, source()]
      .filter(Boolean)
      .join(" · ")
  const images = () => {
    const artifact = props.metadata.artifact
    if (!artifact || typeof artifact !== "object") return []
    const data = "data" in artifact && artifact.data && typeof artifact.data === "object" ? artifact.data : undefined
    const value = data && "images" in data ? data.images : undefined
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === "string" && item.startsWith("data:image/"))
  }

  if (props.input.action === "stop") {
    return (
      <BasicTool
        {...props}
        icon="circle-check"
        trigger={{ title: "Kernel stopped", subtitle: `${props.label} · ${kernel()}` }}
      />
    )
  }

  return (
    <BasicTool
      {...props}
      icon="code"
      trigger={{
        title: failed() ? `Failed · ${task()}` : props.status === "completed" ? task() : `Running · ${task()}`,
        subtitle: subtitle(),
      }}
    >
      <div data-component="kernel-tool">
        <header>
          <strong>{props.label}</strong>
          <span>{subtitle()}</span>
        </header>
        <Show when={images().length > 0}>
          <div data-slot="kernel-tool-images">
            <For each={images()}>
              {(image) => <img src={image} alt={`${props.label} execution result`} loading="lazy" />}
            </For>
          </div>
        </Show>
        <Show when={props.output}>
          <div data-slot="kernel-tool-result">
            <pre>{stripAnsi(props.output ?? "")}</pre>
          </div>
        </Show>
        <details data-slot="kernel-tool-source">
          <summary>Code</summary>
          <pre>
            <code>{code()}</code>
          </pre>
        </details>
      </div>
    </BasicTool>
  )
}

ToolRegistry.register({
  name: "python",
  render: (props) => <KernelTool {...props} language="python" label="Python" />,
})

ToolRegistry.register({
  name: "r",
  render: (props) => <KernelTool {...props} language="r" label="R" />,
})

ToolRegistry.register({
  name: "notebook",
  render: (props) => <KernelTool {...props} language="python" label="Python" />,
})

ToolRegistry.register({
  name: "rkernel",
  render: (props) => <KernelTool {...props} language="r" label="R" />,
})

function SavedArtifactTool(props: ToolProps) {
  const data = useData()
  const saved = () => savedArtifact(props.metadata.savedArtifact)
  const open = () => {
    const artifact = saved()
    if (!artifact) return
    if (data.openArtifact) {
      data.openArtifact(artifact.id)
      return
    }
    data.openFile?.(artifact.path)
  }

  return (
    <BasicTool
      {...props}
      icon="archive"
      trigger={{
        title: saved() ? "Saved to Results" : props.title || "Result",
        subtitle: saved() ? getFilename(saved()!.path) : undefined,
      }}
    >
      <Show
        when={saved()}
        fallback={
          <Show when={props.output}>
            <div data-component="tool-output" data-scrollable>
              <pre>{stripAnsi(props.output ?? "")}</pre>
            </div>
          </Show>
        }
      >
        {(artifact) => (
          <div data-component="saved-artifact-tool">
            <header>
              <strong>{getFilename(artifact().path)}</strong>
              <span>{artifact().kind}</span>
            </header>
            <Show when={artifact().preview?.kind === "image" ? artifact().preview?.data : undefined}>
              {(image) => (
                <img data-slot="saved-artifact-preview" src={image()} alt={artifact().title} loading="lazy" />
              )}
            </Show>
            <Show when={artifact().preview?.kind === "text" ? artifact().preview?.data : undefined}>
              {(preview) => (
                <div data-slot="saved-artifact-preview-text">
                  <Markdown
                    text={artifact().mimeType === "text/markdown" ? preview() : `\`\`\`\n${preview()}\n\`\`\``}
                  />
                </div>
              )}
            </Show>
            <footer>
              <button type="button" onClick={open}>
                Open Result
              </button>
            </footer>
          </div>
        )}
      </Show>
    </BasicTool>
  )
}

ToolRegistry.register({
  name: "artifact",
  render: (props) => <SavedArtifactTool {...props} />,
})

function RemoteComputeTool(props: ToolProps) {
  const job = () => {
    const envelope = props.metadata.compute_job
    const value =
      props.metadata.job ?? (envelope && typeof envelope === "object" && "job" in envelope ? envelope.job : undefined)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  }
  const gpu = () => {
    const value = job()?.modal
    if (value && typeof value === "object" && "gpu" in value && typeof value.gpu === "string") return value.gpu
    return typeof props.input.gpu === "string" ? props.input.gpu : undefined
  }
  const status = () => (typeof job()?.status === "string" ? job()!.status : props.status)
  return (
    <BasicTool
      {...props}
      icon="console"
      trigger={{
        title: props.title || (props.tool === "modal" ? "Modal compute" : "Remote compute"),
        subtitle: [gpu(), status()].filter(Boolean).join(" · "),
      }}
    >
      <Show when={typeof props.input.command === "string" ? props.input.command : undefined}>
        {(command) => (
          <div data-component="tool-output" data-scrollable>
            <pre>{command()}</pre>
          </div>
        )}
      </Show>
      <Show when={props.output}>
        <div data-component="tool-output" data-scrollable>
          <pre>{stripAnsi(props.output ?? "")}</pre>
        </div>
      </Show>
    </BasicTool>
  )
}

ToolRegistry.register({ name: "modal", render: (props) => <RemoteComputeTool {...props} /> })
ToolRegistry.register({ name: "compute_job", render: (props) => <RemoteComputeTool {...props} /> })

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.offset) args.push("offset=" + props.input.offset)
    if (props.input.limit) args.push("limit=" + props.input.limit)
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: props.input.filePath ? getFilename(props.input.filePath) : "",
            args,
          }}
          onSubtitleClick={props.input.filePath ? () => data.openFile?.(props.input.filePath!) : undefined}
        />
        <For each={loaded()}>
          {(filepath) => (
            <div data-component="tool-loaded-file">
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("ui.tool.loaded")} {relativizeProjectPaths(filepath, data.directory)}
              </span>
            </div>
          )}
        </For>
      </>
    )
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    const activity = () =>
      skillActivity({ metadata: props.metadata, input: props.input, title: props.title, status: props.status })
    return (
      <BasicTool {...props} icon="mcp" trigger={{ title: activity().title, subtitle: activity().subtitle }}>
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "modal",
  render(props) {
    const plan = () => props.metadata.compute
    return (
      <BasicTool
        {...props}
        icon="mcp"
        trigger={{
          title: props.title || (props.status === "pending" ? "Review Modal job" : "Modal job"),
          subtitle: props.input.name,
          args: [props.input.gpu || "none"],
        }}
      >
        <Show when={plan()}>
          {(value) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={`\`\`\`json\n${JSON.stringify(value(), null, 2)}\n\`\`\``} />
            </div>
          )}
        </Show>
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "list",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="bullet-list"
        trigger={{ title: i18n.t("ui.tool.list"), subtitle: getDirectory(props.input.path || "/") }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: getDirectory(props.input.path || "/"),
          args: props.input.pattern ? ["pattern=" + props.input.pattern] : [],
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.pattern) args.push("pattern=" + props.input.pattern)
    if (props.input.include) args.push("include=" + props.input.include)
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: getDirectory(props.input.path || "/"),
          args,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    const data = useData()
    const downloaded = () => {
      const value = props.metadata.download
      return value && typeof value === "object" ? (value as { path?: unknown; autoOpen?: unknown }) : undefined
    }
    // Do not reopen persisted downloads on reload, but keep listening if the
    // completed metadata arrives one event after the terminal status.
    let opened = props.status === "completed"
    createEffect(() => {
      const status = props.status
      const download = downloaded()
      if (!opened && status === "completed" && download?.autoOpen === true && typeof download.path === "string") {
        opened = true
        data.openFile?.(download.path)
      }
    })
    return (
      <BasicTool
        {...props}
        icon="window-cursor"
        trigger={{
          title: downloaded() ? "Downloaded file" : i18n.t("ui.tool.webfetch"),
          subtitle: typeof downloaded()?.path === "string" ? (downloaded()!.path as string) : props.input.url || "",
          args: props.input.format ? ["format=" + props.input.format] : [],
          action: (
            <div data-component="tool-action">
              <Icon name="square-arrow-top-right" size="small" />
            </div>
          ),
        }}
        onSubtitleClick={
          typeof downloaded()?.path === "string" ? () => data.openFile?.(downloaded()!.path as string) : undefined
        }
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "generate_image",
  render(props) {
    const route = () => (props.metadata.route === "wallet" ? "OpenScience wallet" : "Connected OpenRouter key")
    return (
      <BasicTool
        {...props}
        icon="photo"
        defaultOpen={true}
        trigger={{
          title: props.status === "error" ? "Image generation failed" : "Generated image",
          subtitle: props.title || props.input.output_path || "generated-image.png",
          args: [props.metadata.model || props.input.model, route()].filter((value): value is string => !!value),
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output">
              <Markdown text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const summary = () =>
      (props.metadata.summary ?? []) as { id: string; tool: string; state: { status: string; title?: string } }[]

    const childSessionId = () => props.metadata.sessionId as string | undefined
    const activity = createMemo(() => summarizeTaskActivity(summary()))
    const findings = createMemo(() => stripTaskMetadata(props.output))
    const duration = () => formatTaskDuration(props.metadata.durationMs as number | undefined)
    const model = () => {
      const value = props.metadata.model as { providerID?: string; modelID?: string } | undefined
      return [value?.providerID, value?.modelID].filter(Boolean).join(" / ") || undefined
    }
    const outcome = () => {
      if (props.status === "running" || props.status === "pending") return props.status
      const value = props.metadata.outcome
      if (value === "completed" || value === "partial" || value === "error" || value === "timed_out") return value
      return props.status === "error" ? "error" : "completed"
    }
    const outcomeLabel = () => {
      if (outcome() === "running") return "Working"
      if (outcome() === "pending") return "Queued"
      if (outcome() === "partial") return "Partial result"
      if (outcome() === "timed_out") return "Time limit reached"
      if (outcome() === "error") return "Needs attention"
      return "Completed"
    }
    const current = () => summary().findLast((item) => item.state.status === "running") ?? summary().at(-1)
    const subtitle = () =>
      (outcome() === "running" || outcome() === "pending" ? current()?.state.title : undefined) ??
      props.input.description

    const childPermission = createMemo(() => {
      const sessionId = childSessionId()
      if (!sessionId) return undefined
      const permissions = data.store.permission?.[sessionId] ?? []
      return permissions[0]
    })

    const childQuestion = createMemo(() => {
      const sessionId = childSessionId()
      if (!sessionId) return undefined
      const questions = data.store.question?.[sessionId] ?? []
      return questions[0]
    })

    const childRequest = createMemo(() => childPermission() ?? childQuestion())

    const childToolPart = createMemo(() => {
      const request = childRequest()
      if (!request || !request.tool) return undefined
      const sessionId = childSessionId()
      if (!sessionId) return undefined
      // Find the tool part that owns the pending permission or question.
      const messages = data.store.message[sessionId] ?? []
      const message = findLast(messages, (m) => m.id === request.tool!.messageID)
      if (!message) return undefined
      const parts = data.store.part[message.id] ?? []
      for (const part of parts) {
        if (part.type === "tool" && (part as ToolPart).callID === request.tool!.callID) {
          return { part: part as ToolPart, message }
        }
      }

      return undefined
    })

    const respond = (response: PermissionReply) => {
      const perm = childPermission()
      if (!perm || !data.respondToPermission) return
      data.respondToPermission({
        sessionID: perm.sessionID,
        permissionID: perm.id,
        response,
      })
    }

    const handleSubtitleClick = () => {
      const sessionId = childSessionId()
      if (sessionId && data.navigateToSession) {
        data.navigateToSession(sessionId)
      }
    }

    const renderChildToolPart = () => {
      const toolData = childToolPart()
      if (!toolData) return null
      const { part } = toolData
      // @ts-expect-error
      const metadata = part.state?.metadata ?? {}
      const render = ToolRegistry.render(part.tool, metadata) ?? GenericTool
      const input = part.state?.input ?? {}
      return (
        <Dynamic
          component={render}
          input={input}
          tool={part.tool}
          metadata={metadata}
          // @ts-expect-error
          output={part.state.output}
          status={part.state.status}
          defaultOpen={true}
        />
      )
    }

    return (
      <div data-component="tool-part-wrapper" data-permission={!!childPermission()} data-question={!!childQuestion()}>
        <Switch>
          <Match when={childPermission()}>
            <>
              <Show
                when={childToolPart()}
                fallback={
                  <BasicTool
                    icon="task"
                    defaultOpen={true}
                    trigger={{
                      title: i18n.t("ui.tool.agent", {
                        type: sentenceCaseLabel(String(props.input.subagent_type || props.tool)),
                      }),
                      subtitle: props.input.description,
                    }}
                    onSubtitleClick={handleSubtitleClick}
                  />
                }
              >
                {renderChildToolPart()}
              </Show>
              <PermissionActions respond={respond} metadata={childPermission()?.metadata} />
            </>
          </Match>
          <Match when={childQuestion()}>
            {(request) => (
              <>
                <Show
                  when={childToolPart()}
                  fallback={
                    <BasicTool
                      icon="task"
                      defaultOpen={true}
                      trigger={{
                        title: i18n.t("ui.tool.agent", {
                          type: sentenceCaseLabel(String(props.input.subagent_type || props.tool)),
                        }),
                        subtitle: props.input.description,
                      }}
                      onSubtitleClick={handleSubtitleClick}
                    />
                  }
                >
                  {renderChildToolPart()}
                </Show>
                <QuestionPrompt request={request()} />
              </>
            )}
          </Match>
          <Match when={true}>
            <details
              data-component="delegation-card"
              data-outcome={outcome()}
              open={outcome() === "running" || outcome() === "pending"}
            >
              <summary data-slot="delegation-summary" aria-label={`${outcomeLabel()} delegated research`}>
                <div data-slot="delegation-mark">
                  <Icon name="research" size="normal" />
                </div>
                <div data-slot="delegation-heading">
                  <strong>
                    {i18n.t("ui.tool.agent", {
                      type: sentenceCaseLabel(String(props.input.subagent_type || props.tool)),
                    })}
                  </strong>
                  <Show when={subtitle()}>
                    <p>{subtitle()}</p>
                  </Show>
                </div>
                <div data-slot="delegation-summary-meta">
                  <span data-slot="delegation-status">{outcomeLabel()}</span>
                  <Show when={duration()}>{(value) => <span>{value()}</span>}</Show>
                  <Show when={props.metadata.toolCalls !== undefined}>
                    <span>{Number(props.metadata.toolCalls)} ops</span>
                  </Show>
                  <Icon name="chevron-down" size="small" />
                </div>
              </summary>

              <div data-slot="delegation-body">
                <div data-slot="delegation-toolbar">
                  <div data-slot="delegation-metrics" aria-label="Delegated research details">
                    <Show when={model()}>{(value) => <span>{value()}</span>}</Show>
                    <Show when={props.metadata.effort}>
                      <span>{sentenceCaseLabel(String(props.metadata.effort))} effort</span>
                    </Show>
                    <Show when={Number(props.metadata.failedToolCalls) > 0}>
                      <span data-failed>{Number(props.metadata.failedToolCalls)} failed</span>
                    </Show>
                  </div>
                  <Show when={childSessionId()}>
                    <button type="button" data-slot="delegation-open" onClick={handleSubtitleClick}>
                      Open agent
                      <Icon name="arrow-right" size="small" />
                    </button>
                  </Show>
                </div>

                <Show when={(outcome() === "running" || outcome() === "pending") && current()}>
                  {(item) => (
                    <div data-slot="delegation-current">
                      <Spinner />
                      <span>Current activity</span>
                      <strong>{item().state.title || getToolInfo(item().tool).title}</strong>
                    </div>
                  )}
                </Show>

                <Show when={findings()}>
                  {(value) => (
                    <div data-slot="delegation-findings">
                      <span data-slot="delegation-section-label">Findings</span>
                      <Markdown text={value()} />
                    </div>
                  )}
                </Show>

                <Show when={activity().length > 0}>
                  <div data-slot="delegation-activity">
                    <span data-slot="delegation-section-label">Activity</span>
                    <For each={activity()}>
                      {(group) => (
                        <div data-slot="delegation-activity-row" data-family={group.family}>
                          <Icon
                            name={
                              group.family === "context"
                                ? "glasses"
                                : group.family === "sources"
                                  ? "window-cursor"
                                  : group.family === "commands"
                                    ? "console"
                                    : group.family === "changes"
                                      ? "code-lines"
                                      : group.family === "images"
                                        ? "photo"
                                        : group.family === "skills"
                                          ? "sparkles"
                                          : "activity"
                            }
                            size="small"
                          />
                          <div>
                            <strong>{group.label}</strong>
                            <span>{group.detail}</span>
                          </div>
                          <Show when={group.failed > 0}>
                            <span data-slot="delegation-activity-failed">{group.failed} failed</span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={summary().length > 0}>
                  <details data-slot="delegation-raw">
                    <summary>
                      Raw operations <span>· {summary().length}</span>
                    </summary>
                    <div data-component="task-tools">
                      <For each={summary()}>
                        {(item) => {
                          const info = getToolInfo(item.tool)
                          return (
                            <div data-slot="task-tool-item">
                              <Icon name={info.icon} size="small" />
                              <span data-slot="task-tool-title">{info.title}</span>
                              <Show when={item.state.title}>
                                <span data-slot="task-tool-subtitle">{item.state.title}</span>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </details>
                </Show>
              </div>
            </details>
          </Match>
        </Switch>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="console"
        trigger={{
          title: i18n.t("ui.tool.shell"),
          subtitle: props.input.description,
        }}
      >
        <Show when={props.input.command || props.metadata.command || props.output || props.metadata.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown
              text={`\`\`\`\`command\n$ ${props.input.command ?? props.metadata.command ?? ""}${props.output || props.metadata.output ? "\n\n" + stripAnsi(props.output || props.metadata.output) : ""}\n\`\`\`\``}
            />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const data = useData()
    const diffComponent = useDiffComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const filename = () => getFilename(props.input.filePath ?? "")
    const canOpen = () => !!(data.openFile && props.input.filePath)
    const bodyReady = () => !!(props.metadata.filediff?.path || props.input.filePath)
    return (
      <Show
        when={isToolDone(props.status) || bodyReady()}
        fallback={<ToolProgress label={i18n.t("ui.messagePart.title.edit")} subtitle={filename()} />}
      >
        <BasicTool
          {...props}
          icon="code-lines"
          trigger={
            <div data-component="edit-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">{i18n.t("ui.messagePart.title.edit")}</span>
                  <span
                    data-slot="message-part-title-filename"
                    classList={{ clickable: canOpen() }}
                    onClick={(e) => {
                      if (!canOpen()) return
                      e.stopPropagation()
                      data.openFile!(props.input.filePath!)
                    }}
                  >
                    {filename()}
                  </span>
                </div>
                <Show when={props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                <Show when={props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff} />
                </Show>
              </div>
            </div>
          }
        >
          <Show when={props.metadata.filediff?.path || props.input.filePath}>
            <div data-component="edit-content">
              <Dynamic
                component={diffComponent}
                before={{
                  name: props.metadata?.filediff?.file || props.input.filePath,
                  contents: props.metadata?.filediff?.before || props.input.oldString,
                }}
                after={{
                  name: props.metadata?.filediff?.file || props.input.filePath,
                  contents: props.metadata?.filediff?.after || props.input.newString,
                }}
              />
            </div>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </Show>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const i18n = useI18n()
    const data = useData()
    const codeComponent = useCodeComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const filename = () => getFilename(props.input.filePath ?? "")
    const canOpen = () => !!(data.openFile && props.input.filePath)
    const bodyReady = () => !!props.input.content

    return (
      <Show
        when={isToolDone(props.status) || bodyReady()}
        fallback={<ToolProgress label={i18n.t("ui.messagePart.title.write")} subtitle={filename()} />}
      >
        <BasicTool
          {...props}
          icon="code-lines"
          trigger={
            <div data-component="write-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">{i18n.t("ui.messagePart.title.write")}</span>
                  <span
                    data-slot="message-part-title-filename"
                    classList={{ clickable: canOpen() }}
                    onClick={(e) => {
                      if (!canOpen()) return
                      e.stopPropagation()
                      data.openFile!(props.input.filePath!)
                    }}
                  >
                    {filename()}
                  </span>
                </div>
                <Show when={props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
            </div>
          }
        >
          <Show when={props.input.content}>
            <div data-component="write-content">
              <Dynamic
                component={codeComponent}
                file={{
                  name: props.input.filePath,
                  contents: props.input.content,
                  cacheKey: checksum(props.input.content),
                }}
                overflow="scroll"
              />
            </div>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </Show>
    )
  },
})

interface ApplyPatchFile {
  filePath: string
  relativePath: string
  type: "add" | "update" | "delete" | "move"
  diff: string
  before: string
  after: string
  additions: number
  deletions: number
  movePath?: string
}

ToolRegistry.register({
  name: "apply_patch",
  render(props) {
    const i18n = useI18n()
    const diffComponent = useDiffComponent()
    const files = createMemo(() => (props.metadata.files ?? []) as ApplyPatchFile[])

    const subtitle = createMemo(() => {
      const count = files().length
      if (count === 0) return ""
      return `${count} ${i18n.t(count > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
    })

    return (
      <Show
        when={isToolDone(props.status) || files().length > 0}
        fallback={<ToolProgress label={i18n.t("ui.tool.patch")} subtitle={subtitle()} />}
      >
        <BasicTool
          {...props}
          icon="code-lines"
          trigger={{
            title: i18n.t("ui.tool.patch"),
            subtitle: subtitle(),
          }}
        >
          <Show when={files().length > 0}>
            <div data-component="apply-patch-files">
              <For each={files()}>
                {(file) => (
                  <div data-component="apply-patch-file">
                    <div data-slot="apply-patch-file-header">
                      <Switch>
                        <Match when={file.type === "delete"}>
                          <span data-slot="apply-patch-file-action" data-type="delete">
                            {i18n.t("ui.patch.action.deleted")}
                          </span>
                        </Match>
                        <Match when={file.type === "add"}>
                          <span data-slot="apply-patch-file-action" data-type="add">
                            {i18n.t("ui.patch.action.created")}
                          </span>
                        </Match>
                        <Match when={file.type === "move"}>
                          <span data-slot="apply-patch-file-action" data-type="move">
                            {i18n.t("ui.patch.action.moved")}
                          </span>
                        </Match>
                        <Match when={file.type === "update"}>
                          <span data-slot="apply-patch-file-action" data-type="update">
                            {i18n.t("ui.patch.action.patched")}
                          </span>
                        </Match>
                      </Switch>
                      <span data-slot="apply-patch-file-path">{file.relativePath}</span>
                      <Show when={file.type !== "delete"}>
                        <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                      </Show>
                      <Show when={file.type === "delete"}>
                        <span data-slot="apply-patch-deletion-count">-{file.deletions}</span>
                      </Show>
                    </div>
                    <Show when={file.type !== "delete"}>
                      <div data-component="apply-patch-file-diff">
                        <Dynamic
                          component={diffComponent}
                          before={{ name: file.filePath, contents: file.before }}
                          after={{ name: file.filePath, contents: file.after }}
                        />
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </BasicTool>
      </Show>
    )
  },
})

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const i18n = useI18n()
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta

      const input = props.input.todos
      if (Array.isArray(input)) return input

      return []
    })

    const subtitle = createMemo(() => {
      const list = todos()
      if (list.length === 0) return ""
      return `${list.filter((t: Todo) => t.status === "completed").length}/${list.length}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="checklist"
        trigger={{
          title: i18n.t("ui.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div data-component="todos">
            <For each={todos()}>
              {(todo: Todo) => (
                <Checkbox readOnly checked={todo.status === "completed"}>
                  <div data-slot="message-part-todo-content" data-completed={todo.status === "completed"}>
                    {todo.content}
                  </div>
                </Checkbox>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "planwrite",
  render(props) {
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta
      return props.input?.todos ?? []
    })
    const subtitle = createMemo(() => {
      const list = todos()
      if (!list.length) return ""
      return `${list.filter((t: Todo) => t.status === "completed").length}/${list.length}`
    })
    return (
      <BasicTool
        {...props}
        icon="checklist"
        trigger={{
          title: "Plan updated",
          subtitle: subtitle(),
        }}
      />
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()
    const questions = createMemo(() => (props.input.questions ?? []) as QuestionInfo[])
    const answers = createMemo(() => (props.metadata.answers ?? []) as QuestionAnswer[])
    const completed = createMemo(() => answers().length > 0)

    const subtitle = createMemo(() => {
      const count = questions().length
      if (count === 0) return ""
      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })
      return `${count} ${i18n.t(count > 1 ? "ui.common.question.other" : "ui.common.question.one")}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{
          title: i18n.t("ui.tool.questions"),
          subtitle: subtitle(),
        }}
      >
        <Show when={completed()}>
          <div data-component="question-answers">
            <For each={questions()}>
              {(q, i) => {
                const answer = () => answers()[i()] ?? []
                return (
                  <div data-slot="question-answer-item">
                    <div data-slot="question-text">{q.question}</div>
                    <div data-slot="answer-text">{answer().join(", ") || i18n.t("ui.question.answer.none")}</div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

// --- Colab Plugin Tool Renderers ---

ToolRegistry.register({
  name: "colab_connect",
  render(props) {
    const connected = () => props.metadata?.connection?.state === "connected"
    const mode = () => props.metadata?.connection?.mode ?? props.input?.mode ?? "standard"
    const gpu = () => {
      if (props.output) {
        const match = props.output.match(/GPU:\s*(.+)/m)
        if (match) return match[1].trim()
      }
      return props.metadata?.connection?.gpu ?? ""
    }

    return (
      <BasicTool
        {...props}
        icon={connected() ? "link" : "circle-ban-sign"}
        trigger={{
          title: connected() ? "Colab Connected" : "Colab Connect",
          subtitle: connected()
            ? `${mode()} · ${gpu() || "GPU ready"}`
            : mode() === "enterprise"
              ? "Vertex AI"
              : "Bridge notebook",
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={`\`\`\`\n${props.output}\n\`\`\``} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "colab_execute",
  render(props) {
    const cellNum = () => props.metadata?.executionCount ?? "?"
    const status = () => props.metadata?.status ?? ""
    const code = () => props.input?.code ?? ""

    return (
      <BasicTool
        {...props}
        icon="console"
        trigger={{
          title: `Cell [${cellNum()}]`,
          subtitle: status() === "error" ? "Error" : code().split("\n")[0]?.slice(0, 80),
        }}
      >
        <div data-component="tool-output" data-scrollable>
          <Markdown
            text={`\`\`\`python\n${code()}\n\`\`\`${props.output ? "\n\n```\n" + stripAnsi(props.output) + "\n```" : ""}`}
          />
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "colab_status",
  render(props) {
    const state = () => props.metadata?.connection?.state ?? "unknown"
    return (
      <BasicTool
        {...props}
        icon="dot-grid"
        trigger={{
          title: "Colab Status",
          subtitle: state(),
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={`\`\`\`\n${stripAnsi(props.output ?? "")}\n\`\`\``} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "colab_finetune",
  render(props) {
    const workflow = () => (props.input?.workflow ?? "").toUpperCase()
    const model = () => props.input?.model ?? ""
    const failed = () => props.output?.includes("FAILED") ?? false
    const complete = () => props.output?.includes("COMPLETE") ?? false

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon={failed() ? "circle-ban-sign" : complete() ? "circle-check" : "settings-gear"}
        trigger={{
          title: `Fine-tune ${workflow()}`,
          subtitle: model(),
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={`\`\`\`\n${stripAnsi(props.output ?? "")}\n\`\`\``} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "colab_notebook",
  render(props) {
    const workflow = () => props.input?.workflow ?? "notebook"
    const path = () => props.metadata?.path ?? props.output?.match(/generated:\s*(.+)/m)?.[1] ?? ""

    return (
      <BasicTool
        {...props}
        icon="code"
        trigger={{
          title: `Notebook: ${workflow()}`,
          subtitle: path() ? path().split("/").pop() : "",
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output ?? ""} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

// --- End Colab Plugin Tool Renderers ---

export function QuestionPrompt(props: { request: QuestionRequest }) {
  const data = useData()
  const i18n = useI18n()
  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)

  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    editing: false,
  })

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  function submit() {
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    data.replyToQuestion?.({
      requestID: props.request.id,
      answers,
    })
  }

  function reject() {
    data.rejectQuestion?.({
      requestID: props.request.id,
    })
  }

  function pick(answer: string, custom: boolean = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      data.replyToQuestion?.({
        requestID: props.request.id,
        answers: [[answer]],
      })
      return
    }
    setStore("tab", store.tab + 1)
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    if (index !== -1) next.splice(index, 1)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
  }

  function selectTab(index: number) {
    setStore("tab", index)
    setStore("editing", false)
  }

  function selectOption(optIndex: number) {
    if (optIndex === options().length) {
      setStore("editing", true)
      return
    }
    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  function handleCustomSubmit(e: Event) {
    e.preventDefault()
    const value = input().trim()
    if (!value) {
      setStore("editing", false)
      return
    }
    if (multi()) {
      const existing = store.answers[store.tab] ?? []
      const next = [...existing]
      if (!next.includes(value)) next.push(value)
      const answers = [...store.answers]
      answers[store.tab] = next
      setStore("answers", answers)
      setStore("editing", false)
      return
    }
    pick(value, true)
    setStore("editing", false)
  }

  return (
    <div data-component="question-prompt">
      <Show when={!single()}>
        <div data-slot="question-tabs">
          <For each={questions()}>
            {(q, index) => {
              const active = () => index() === store.tab
              const answered = () => (store.answers[index()]?.length ?? 0) > 0
              return (
                <button
                  data-slot="question-tab"
                  data-active={active()}
                  data-answered={answered()}
                  onClick={() => selectTab(index())}
                >
                  {q.header}
                </button>
              )
            }}
          </For>
          <button data-slot="question-tab" data-active={confirm()} onClick={() => selectTab(questions().length)}>
            {i18n.t("ui.common.confirm")}
          </button>
        </div>
      </Show>

      <Show when={!confirm()}>
        <div data-slot="question-content">
          <div data-slot="question-text">
            {question()?.question}
            {multi() ? " " + i18n.t("ui.question.multiHint") : ""}
          </div>
          <div data-slot="question-options">
            <For each={options()}>
              {(opt, i) => {
                const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                return (
                  <button data-slot="question-option" data-picked={picked()} onClick={() => selectOption(i())}>
                    <span data-slot="option-label">{opt.label}</span>
                    <Show when={opt.description}>
                      <span data-slot="option-description">{opt.description}</span>
                    </Show>
                    <Show when={picked()}>
                      <Icon name="check-small" size="normal" />
                    </Show>
                  </button>
                )
              }}
            </For>
            <button
              data-slot="question-option"
              data-picked={customPicked()}
              onClick={() => selectOption(options().length)}
            >
              <span data-slot="option-label">{i18n.t("ui.messagePart.option.typeOwnAnswer")}</span>
              <Show when={!store.editing && input()}>
                <span data-slot="option-description">{input()}</span>
              </Show>
              <Show when={customPicked()}>
                <Icon name="check-small" size="normal" />
              </Show>
            </button>
            <Show when={store.editing}>
              <form data-slot="custom-input-form" onSubmit={handleCustomSubmit}>
                <input
                  ref={(el) => setTimeout(() => el.focus(), 0)}
                  type="text"
                  data-slot="custom-input"
                  placeholder={i18n.t("ui.question.custom.placeholder")}
                  value={input()}
                  onInput={(e) => {
                    const inputs = [...store.custom]
                    inputs[store.tab] = e.currentTarget.value
                    setStore("custom", inputs)
                  }}
                />
                <Button type="submit" variant="primary" size="small">
                  {multi() ? i18n.t("ui.common.add") : i18n.t("ui.common.submit")}
                </Button>
                <Button type="button" variant="ghost" size="small" onClick={() => setStore("editing", false)}>
                  {i18n.t("ui.common.cancel")}
                </Button>
              </form>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={confirm()}>
        <div data-slot="question-review">
          <div data-slot="review-title">{i18n.t("ui.messagePart.review.title")}</div>
          <For each={questions()}>
            {(q, index) => {
              const value = () => store.answers[index()]?.join(", ") ?? ""
              const answered = () => Boolean(value())
              return (
                <div data-slot="review-item">
                  <span data-slot="review-label">{q.question}</span>
                  <span data-slot="review-value" data-answered={answered()}>
                    {answered() ? value() : i18n.t("ui.question.review.notAnswered")}
                  </span>
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      <div data-slot="question-actions">
        <Button variant="ghost" size="small" onClick={reject}>
          {i18n.t("ui.common.dismiss")}
        </Button>
        <Show when={!single()}>
          <Show when={confirm()}>
            <Button variant="primary" size="small" onClick={submit}>
              {i18n.t("ui.common.submit")}
            </Button>
          </Show>
          <Show when={!confirm() && multi()}>
            <Button
              variant="secondary"
              size="small"
              onClick={() => selectTab(store.tab + 1)}
              disabled={(store.answers[store.tab]?.length ?? 0) === 0}
            >
              {i18n.t("ui.common.next")}
            </Button>
          </Show>
        </Show>
      </div>
    </div>
  )
}
