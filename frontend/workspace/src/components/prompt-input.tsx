import { useFilteredList } from "@synsci/ui/hooks"
import {
  createEffect,
  on,
  Component,
  Show,
  For,
  onMount,
  onCleanup,
  Switch,
  Match,
  createMemo,
  createResource,
  createSignal,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createFocusSignal } from "@solid-primitives/active-element"
import { useLocal } from "@/context/local"
import { useFile, type FileSelection } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  ConversationAttachmentPart,
  FileAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { FileIcon } from "@synsci/ui/file-icon"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { Tooltip } from "@synsci/ui/tooltip"
import { IconButton } from "@synsci/ui/icon-button"
import { getDirectory, getFilename, getFilenameTruncated } from "@synsci/util/path"
import { useDialog } from "@synsci/ui/context/dialog"
import { ImagePreview } from "@synsci/ui/image-preview"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { createOpenScienceClient, type Message, type Part } from "@synsci/sdk/v2/client"
import { Binary } from "@synsci/util/binary"
import { showToast } from "@synsci/ui/toast"
import { uiStore } from "@/atlas/store/ui"
import { confirmDialog } from "@/atlas/dialogs"
import { projectHref, projectPathname } from "@/utils/project-route"
import { ModelSettingsPopover } from "./model-settings-popover"
import { enabledSkills, skillAction, visibleSkills } from "@/atlas/skill-permissions"
import { DialogSettings } from "./dialog-settings"
import "./prompt-input.css"
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  attachmentFormat,
  attachmentMime,
  attachmentSize,
} from "./prompt-attachment"
import {
  CAPABILITY_PREFERENCES_EVENT,
  delegatedSpecialist,
  delegationSettings,
  DELEGATION_AUTONOMY,
  DELEGATION_LEVELS,
  type CapabilityPreferences,
  type DelegationAutonomy,
  type DelegationLevel,
  type DelegationSettings,
  publishCapabilityPreferences,
} from "./prompt-capabilities"
import { canRestoreFailedSubmission } from "./prompt-submission"
import { requestFailure, requestStatus } from "@/utils/request-error"
import {
  slashGroup,
  slashIcon,
  slashMode,
  slashActionSkill,
  slashEdit,
  slashSource,
  slashTokenAt,
  SLASH_NATIVE,
  sortSlash,
  type SlashCommand,
  type SlashMode,
} from "./prompt-slash"
import {
  DEFAULT_RESEARCH_ACCESS_MODE,
  RESEARCH_ACCESS_OPTIONS,
  researchAccessLabel as accessLabel,
  researchAccessMode,
  type ResearchAccessMode,
} from "./research-access"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  onSubmit?: () => void
}

interface ResearchAccessSnapshot {
  root: string
  mode: ResearchAccessMode
  requestedMode: ResearchAccessMode
  managed: boolean
  sandboxStatus: { available: boolean; reason?: string }
}

type ResearchSliderOption = { value: string; label: string }

const ResearchSlider: Component<{
  label: string
  value: string
  options: ResearchSliderOption[]
  disabled?: boolean
  onSelect: (value: string) => void
}> = (props) => {
  const move = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    const target = event.target
    const scope = event.currentTarget
    if (!(target instanceof HTMLButtonElement)) return
    if (!(scope instanceof HTMLElement)) return
    const options = Array.from(scope.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    const current = options.indexOf(target)
    if (current < 0) return
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : event.key === "ArrowRight"
            ? (current + 1) % options.length
            : (current - 1 + options.length) % options.length
    event.preventDefault()
    options[next]?.focus()
    options[next]?.click()
  }

  return (
    <div class="workspace-composer__research-slider">
      <span class="workspace-composer__research-slider-label">{props.label}</span>
      <div role="radiogroup" aria-label={props.label} onKeyDown={move}>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.value === option.value}
              tabindex={props.value === option.value ? 0 : -1}
              disabled={props.disabled}
              onClick={() => props.onSelect(option.value)}
            >
              {option.label}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const commentCount = createMemo(() => prompt.context.items().filter((item) => !!item.comment?.trim()).length)
  const layout = useLayout()
  const comments = useComments()
  const params = useParams()
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()
  let editorRef!: HTMLDivElement
  let fileInputRef!: HTMLInputElement
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement
  let researchToolsRef: HTMLDetailsElement | undefined
  const settings = async <T,>(path: string, init?: RequestInit) => {
    const response = await sdk.request(path, init)
    const text = await response.text()
    if (!response.ok) throw new Error(text || `${response.status} ${response.statusText}`)
    return JSON.parse(text) as T
  }
  const [capabilities, capabilityActions] = createResource(() =>
    settings<CapabilityPreferences>("/settings/preferences"),
  )
  onMount(() => {
    const update = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      capabilityActions.mutate(event.detail as CapabilityPreferences)
    }
    globalThis.addEventListener(CAPABILITY_PREFERENCES_EVENT, update)
    onCleanup(() => globalThis.removeEventListener(CAPABILITY_PREFERENCES_EVENT, update))
  })
  const saveCapabilities = (patch: Partial<CapabilityPreferences>) => {
    const previous = capabilities()
    if (!previous) return
    const next = { ...previous, ...patch }
    capabilityActions.mutate(next)
    void settings<CapabilityPreferences>("/settings/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then((value) => {
        capabilityActions.mutate(value)
        publishCapabilityPreferences(value)
      })
      .catch((error) => {
        capabilityActions.mutate(previous)
        showToast({
          title: "Couldn't update research preferences",
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }
  const delegation = createMemo(() => delegationSettings(capabilities()))
  const saveDelegation = (patch: { level?: DelegationLevel; autonomy?: DelegationAutonomy }) => {
    const current = delegation()
    const next = {
      level: patch.level ?? current.level,
      workerModel: current.workerModel,
      autonomy: patch.autonomy ?? current.autonomy,
    }
    saveCapabilities({
      delegation_enabled: next.level !== "off",
      delegation_level: next.level,
      delegation_worker_model: next.workerModel ?? null,
      delegation_autonomy: next.autonomy,
    })
  }
  const projectAccess = async (projectID: string, init?: RequestInit) => {
    const response = await sdk.request(`/project/${encodeURIComponent(projectID)}/access`, init)
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(detail || `${response.status} ${response.statusText}`)
    }
    return (await response.json()) as ResearchAccessSnapshot
  }
  const loadResearchAccess = async (projectID: string): Promise<ResearchAccessSnapshot> => {
    return projectAccess(projectID)
  }
  const [researchAccess, researchAccessControls] = createResource(() => sdk.projectID || false, loadResearchAccess)
  const [researchAccessSaving, setResearchAccessSaving] = createSignal(false)
  const selectedResearchAccess = createMemo(() => {
    const current = researchAccess()
    return current ? researchAccessMode(current) : DEFAULT_RESEARCH_ACCESS_MODE
  })
  const researchAccessLabel = createMemo(() => accessLabel(selectedResearchAccess()))

  const applyResearchAccess = async (mode: ResearchAccessMode, target: HTMLButtonElement) => {
    target.focus()
    const projectID = sdk.projectID
    const initial = researchAccess()
    if (!projectID || !initial || researchAccessSaving()) return
    if (researchAccessMode(initial) === mode) return
    if (mode === "full") {
      const confirmed = await confirmDialog(dialog, {
        title: "Enable Full access?",
        message:
          "Full access disables the execution sandbox. OpenScience may run commands with unrestricted file and network access without asking for action approval.",
        confirmLabel: "Enable Full access",
        danger: true,
      })
      if (!confirmed) return
    }

    setResearchAccessSaving(true)
    try {
      const confirmed = await projectAccess(projectID, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, ...(mode === "ask" ? {} : { root: initial.root }) }),
      })
      researchAccessControls.mutate(confirmed)
      const effective = researchAccessMode(confirmed)
      if (effective !== mode) {
        showToast({
          title: "Access is limited by managed settings",
          description: `The effective mode remains ${accessLabel(effective)}.`,
        })
        return
      }
      showToast({ variant: "success", title: `${accessLabel(effective)} enabled` })
    } catch (error) {
      showToast({
        title: "Couldn't update action approval",
        description: error instanceof Error ? error.message : String(error),
      })
      void researchAccessControls.refetch()
    } finally {
      setResearchAccessSaving(false)
    }
  }

  const refreshResearchAccess = () => {
    if (!sdk.projectID || researchAccessSaving()) return
    void researchAccessControls.refetch()
  }
  const trustSubscription = sdk.event.on("project.trust.changed", (event) => {
    if (event.properties.status.projectID !== sdk.projectID) return
    refreshResearchAccess()
  })
  const instanceSubscription = sdk.event.on("server.instance.disposed", refreshResearchAccess)
  onCleanup(trustSubscription)
  onCleanup(instanceSubscription)

  const mirror = { input: false }

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const rect = range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - padding) {
      container.scrollTop = bottom - container.clientHeight + padding
    }
  }

  const queueScroll = () => {
    requestAnimationFrame(scrollCursorIntoView)
  }

  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey))

  const attach = () => {
    queueMicrotask(() => fileInputRef.click())
  }

  const resetResearchTools = () => {
    for (const choice of researchToolsRef?.querySelectorAll<HTMLDetailsElement>(
      ".workspace-composer__research-choice[open]",
    ) ?? []) {
      choice.open = false
    }
  }

  const closeResearchTools = () => {
    resetResearchTools()
    if (researchToolsRef) researchToolsRef.open = false
  }

  const toggleResearchChoice = (event: Event) => {
    const choice = event.currentTarget
    if (!(choice instanceof HTMLDetailsElement) || !choice.open) return
    for (const item of researchToolsRef?.querySelectorAll<HTMLDetailsElement>(
      ".workspace-composer__research-choice[open]",
    ) ?? []) {
      if (item !== choice) item.open = false
    }
  }

  const navigateResearchChoices = (event: KeyboardEvent) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    const target = event.target
    const scope = event.currentTarget
    if (!(target instanceof HTMLButtonElement) || target.getAttribute("role") !== "radio") return
    if (!(scope instanceof HTMLElement)) return
    const choices = Array.from(scope.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    const index = choices.indexOf(target)
    if (index < 0 || choices.length === 0) return
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? choices.length - 1
          : event.key === "ArrowDown" || event.key === "ArrowRight"
            ? (index + 1) % choices.length
            : (index <= 0 ? choices.length : index) - 1
    const choice = choices[next]
    if (!choice) return
    event.preventDefault()
    choice.focus()
    choice.click()
  }

  const dismissResearchTools = (event: PointerEvent) => {
    if (!researchToolsRef?.open) return
    if (event.target instanceof Node && researchToolsRef.contains(event.target)) return
    closeResearchTools()
  }

  const commentInReview = (path: string) => {
    const sessionID = params.id
    if (!sessionID) return false

    const diffs = sync.data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      layout.fileTree.open()
      layout.fileTree.setTab("changes")
      requestAnimationFrame(() => comments.setFocus(focus))
      return
    }

    layout.fileTree.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    tabs().open(tab)
    files.load(item.path)
    requestAnimationFrame(() => comments.setFocus(focus))
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = tabs().active()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const status = createMemo(
    () =>
      sync.data.session_status[params.id ?? ""] ?? {
        type: "idle",
      },
  )
  const working = createMemo(() => status()?.type !== "idle")
  const imageAttachments = createMemo(
    () => prompt.current().filter((part) => part.type === "image") as ImageAttachmentPart[],
  )

  const [store, setStore] = createStore<{
    popover: "at" | "conversation" | "slash" | null
    historyIndex: number
    savedPrompt: Prompt | null
    dragging: boolean
    mode: "normal" | "shell"
    intent: SlashMode | null
    slashInline: boolean
    applyingHistory: boolean
    bootstrapID?: string
    bootstrapDirectory?: string
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null,
    dragging: false,
    mode: "normal",
    intent: null,
    slashInline: false,
    applyingHistory: false,
    bootstrapID: undefined,
    bootstrapDirectory: undefined,
  })

  const [submitting, setSubmitting] = createSignal(false)

  const placeholder = createMemo(() => {
    if (submitting()) return "Sending…"
    if (store.mode === "shell") return language.t("prompt.placeholder.shell")
    if (store.intent === "plan") return "Describe your task to generate a plan…"
    if (store.intent === "goal") return "Describe your goal and the measurable outcome…"
    if (commentCount() > 1) return language.t("prompt.placeholder.summarizeComments")
    if (commentCount() === 1) return language.t("prompt.placeholder.summarizeComment")
    return language.t("prompt.placeholder.normal")
  })

  const MAX_HISTORY = 100
  const [history, setHistory] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )

  const clonePromptParts = (prompt: Prompt): Prompt =>
    prompt.map((part) => {
      if (part.type === "text") return { ...part }
      if (part.type === "image") return { ...part }
      if (part.type === "agent") return { ...part }
      if (part.type === "conversation") return { ...part }
      return {
        ...part,
        selection: part.selection ? { ...part.selection } : undefined,
      }
    })

  const promptLength = (prompt: Prompt) =>
    prompt.reduce((len, part) => len + ("content" in part ? part.content.length : 0), 0)

  const applyHistoryPrompt = (p: Prompt, position: "start" | "end") => {
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const isFocused = createFocusSignal(() => editorRef)

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const addAttachment = async (file: File) => {
    const mime = attachmentMime(file)
    if (!mime) {
      showToast({
        variant: "error",
        title: "File not attached",
        description: `${file.name} is not a supported image, PDF, text, code, or scientific data file.`,
      })
      return
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast({
        variant: "error",
        title: "File not attached",
        description: `${file.name} is ${attachmentSize(file.size)}; attachments are limited to ${attachmentSize(MAX_ATTACHMENT_BYTES)}.`,
      })
      return
    }

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error("file read failed"))
      reader.readAsDataURL(file)
    }).then(
      (value) => value,
      (error: unknown) => {
        showToast({
          variant: "error",
          title: "File not attached",
          description: error instanceof Error ? error.message : String(error),
        })
        return undefined
      },
    )
    if (!dataUrl) return

    const attachment: ImageAttachmentPart = {
      type: "image",
      id: crypto.randomUUID(),
      filename: file.name,
      mime,
      dataUrl,
      size: file.size,
    }
    const cursorPosition = prompt.cursor() ?? getCursorPosition(editorRef)
    prompt.set([...prompt.current(), attachment], cursorPosition)
  }

  const removeImageAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    if (!isFocused()) return
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const items = Array.from(clipboardData.items)
    const fileItems = items.filter((item) => item.kind === "file")
    const files = fileItems.flatMap((item) => {
      const file = item.getAsFile()
      return file && attachmentMime(file) ? [file] : []
    })

    if (files.length > 0) {
      for (const file of files) await addAttachment(file)
      return
    }

    if (fileItems.length > 0) {
      showToast({
        title: language.t("prompt.toast.pasteUnsupported.title"),
        description: language.t("prompt.toast.pasteUnsupported.description"),
      })
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""
    if (!plainText) return
    addPart({ type: "text", content: plainText, start: 0, end: 0 })
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (dialog.active) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    if (hasFiles) {
      setStore("dragging", true)
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (dialog.active) return

    // relatedTarget is null when leaving the document window
    if (!event.relatedTarget) {
      setStore("dragging", false)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (dialog.active) return

    event.preventDefault()
    setStore("dragging", false)

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    for (const file of Array.from(dropped)) {
      await addAttachment(file)
    }
  }

  onMount(() => {
    document.addEventListener("dragover", handleGlobalDragOver)
    document.addEventListener("dragleave", handleGlobalDragLeave)
    document.addEventListener("drop", handleGlobalDrop)
    document.addEventListener("pointerdown", dismissResearchTools)
    if (!params.id || params.id === "new") queueMicrotask(() => editorRef.focus())
  })
  onCleanup(() => {
    document.removeEventListener("dragover", handleGlobalDragOver)
    document.removeEventListener("dragleave", handleGlobalDragLeave)
    document.removeEventListener("drop", handleGlobalDrop)
    document.removeEventListener("pointerdown", dismissResearchTools)
  })

  createEffect(() => {
    if (!isFocused()) setStore("popover", null)
  })

  // Safety: reset composing state on focus change to prevent stuck state
  // This handles edge cases where compositionend event may not fire
  createEffect(() => {
    if (!isFocused()) setComposing(false)
  })

  type AtOption =
    | { type: "agent"; name: string; display: string }
    | { type: "file"; path: string; display: string; recent?: boolean }

  // Research is the only user-facing agent. Existing transcripts can still
  // render legacy agent parts, but the composer advertises capabilities and
  // files rather than exposing an internal-worker picker.
  const agentList = createMemo<AtOption[]>(() => [])

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    return x.type === "agent" ? `agent:${x.name}` : `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "recent") return 1
        return 2
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  type ConversationOption = {
    sourceSessionID: string
    label: string
    throughMessageID?: string
    updated: number
  }

  const conversationOptions = createMemo<ConversationOption[]>(() =>
    sync.data.session
      .filter((session) => !session.parentID && session.id !== params.id && !session.time?.archived)
      .map((session) => ({
        sourceSessionID: session.id,
        label: session.title?.trim() || "Untitled conversation",
        throughMessageID: sync.data.message[session.id]?.at(-1)?.id,
        updated: session.time?.updated ?? session.time?.created ?? 0,
      }))
      .toSorted((a, b) => b.updated - a.updated || a.label.localeCompare(b.label)),
  )

  const handleConversationSelect = (option: ConversationOption | undefined) => {
    if (!option) return
    addPart({
      type: "conversation",
      sourceSessionID: option.sourceSessionID,
      throughMessageID: option.throughMessageID,
      label: option.label,
      content: `#${option.label}`,
      start: 0,
      end: 0,
    })
  }

  const {
    flat: conversationFlat,
    active: conversationActive,
    setActive: setConversationActive,
    onInput: conversationOnInput,
    onKeyDown: conversationOnKeyDown,
  } = useFilteredList<ConversationOption>({
    items: async () => conversationOptions(),
    key: (option) => option?.sourceSessionID,
    filterKeys: ["label"],
    sortBy: (a, b) => b.updated - a.updated || a.label.localeCompare(b.label),
    onSelect: handleConversationSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const usage: Record<string, string> = {
      compact: "/compact [focus]",
      context: "/context",
      plan: "/plan",
      goal: "/goal",
      status: "/status",
    }
    const catalog = new Map(sync.data.command.map((item) => [item.name, item]))
    const enabled = enabledSkills(sync.data.skill ?? [], [], sync.data.config.permission)
    const local = command.options
      .filter((item) => item.slash && !item.disabled)
      .map((item) => ({
        id: item.id,
        actionID: item.id,
        trigger: item.slash!,
        title: item.title,
        description: item.description,
        usage: `/${item.slash}`,
        keybind: item.keybind,
        source: "builtin" as const,
        category: "session" as const,
        type: "action" as const,
      }))
    const localTriggers = new Set(local.map((item) => item.trigger))
    const builtin = SLASH_NATIVE.filter(
      (name) => !localTriggers.has(name) && skillAction(sync.data.config.permission, name) !== "deny",
    ).map((name) => {
      const item = catalog.get(name)
      return {
        id: `command.${name}`,
        trigger: name,
        title: name,
        description: item?.description,
        usage: usage[name],
        source: "builtin" as const,
        category: ((["compact", "context", "status"] as string[]).includes(name) ? "session" : "research") as
          | "session"
          | "research",
        type: slashMode({ trigger: name }) ? ("mode" as const) : ("action" as const),
      }
    })

    const reserved = new Set<string>([...SLASH_NATIVE, ...local.map((item) => item.trigger)])

    // Surface installed skills as slash entries. Selecting one prefills a
    // "Use the <name> skill: " prompt that the agent matches against its
    // built-in skill tool — lazy invocation, no new pipeline. A real command
    // owns its trigger when names collide, so it is never repeated as a skill.
    // Hide skills tagged `entry: false` (internal helpers).
    const skills = enabled
      .filter((skill) => !reserved.has(skill.name))
      .map((s) => ({
        id: `skill.${s.name}`,
        trigger: s.name,
        title: s.name,
        description: s.description?.slice(0, 120) ?? "",
        usage: `/${s.name} [request]`,
        source: "skill" as const,
        category: "skill" as const,
        type: slashActionSkill(s.name) ? ("action" as const) : ("skill" as const),
      }))

    return [...builtin, ...local, ...skills].toSorted(sortSlash)
  })

  const slashItems = (query: string) => {
    const items = slashCommands()
    if (!query.trim()) return items

    const shown = new Set(items.map((item) => item.trigger))
    const governed = new Set(visibleSkills(sync.data.skill ?? [], []).map((skill) => skill.name))
    const commands: SlashCommand[] = sync.data.command
      .filter(
        (item) =>
          item.source === "builtin" &&
          !shown.has(item.name) &&
          ((!governed.has(item.name) && !SLASH_NATIVE.some((name) => name === item.name)) ||
            skillAction(sync.data.config.permission, item.name) !== "deny"),
      )
      .map((item) => ({
        id: `command.${item.name}`,
        trigger: item.name,
        title: item.name,
        description: item.description,
        usage: item.usage,
        source: "builtin",
        category: item.category ?? "session",
        type: slashMode({ trigger: item.name }) ? "mode" : "action",
      }))

    const all = store.slashInline
      ? items.filter((item) => item.type === "skill" || item.type === "mode")
      : [...items, ...commands]
    const needle = query.trim().replace(/^\/+/, "").toLowerCase()
    const trigger = (item: SlashCommand) => item.trigger.toLowerCase()
    const exact = all.filter((item) => trigger(item) === needle)
    if (exact.length) return exact

    const prefix = all.filter((item) => trigger(item).startsWith(needle))
    if (prefix.length) return prefix

    const contained = all.filter((item) => trigger(item).includes(needle))
    if (contained.length) return contained

    const terms = needle.split(/\s+/)
    return all.filter((item) => {
      const text = [item.trigger, item.title, item.description, item.usage].filter(Boolean).join(" ").toLowerCase()
      return terms.every((term) => text.includes(term))
    })
  }

  const setIntent = (intent: SlashMode | null) => {
    setStore("intent", intent)
    setStore("mode", "normal")
    setStore("popover", null)
    requestAnimationFrame(() => editorRef.focus({ preventScroll: true }))
  }

  const enterIntent = (intent: SlashMode) => {
    editorRef.textContent = ""
    prompt.set([{ type: "text", content: "", start: 0, end: 0 }], 0)
    setIntent(intent)
  }

  const replaceSlash = (value: string) => {
    const selection = window.getSelection()
    const cursor = getCursorPosition(editorRef)
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    const edit = slashEdit(text, cursor, value)
    if (!selection || selection.rangeCount === 0 || !edit) return false

    const range = selection.getRangeAt(0)
    setRangeEdge(range, "start", edit.start)
    setRangeEdge(range, "end", edit.end)
    range.deleteContents()

    if (edit.value) {
      const node = document.createTextNode(edit.value)
      range.insertNode(node)
      range.setStart(node, edit.value.length)
    }

    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    handleInput()
    requestAnimationFrame(() => editorRef.focus({ preventScroll: true }))
    return true
  }

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    setStore("popover", null)

    const intent = slashMode(cmd)
    if (intent) {
      if (!replaceSlash("")) return
      setIntent(intent)
      return
    }

    if (cmd.type === "skill") {
      replaceSlash(`/${cmd.trigger} `)
      return
    }

    if (cmd.actionID) {
      if (!replaceSlash("")) return
      command.trigger(cmd.actionID, "slash")
      return
    }

    editorRef.textContent = ""
    prompt.set([{ type: "text", content: "", start: 0, end: 0 }], 0)
    void handleSubmit(new Event("submit"), cmd.trigger)
  }

  const {
    grouped: slashGrouped,
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
    refetch: slashRefetch,
  } = useFilteredList<SlashCommand>({
    items: slashItems,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title", "description", "usage"],
    groupBy: slashGroup,
    sortBy: sortSlash,
    sortGroupsBy: (a, b) => (a.category === "Commands" ? -1 : b.category === "Commands" ? 1 : 0),
    onSelect: handleSlashSelect,
  })

  const createPill = (part: FileAttachmentPart | AgentPart | ConversationAttachmentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    if (part.type === "conversation") {
      pill.textContent = `#${part.label}`
      pill.setAttribute("data-session-id", part.sourceSessionID)
      pill.setAttribute("data-label", part.label)
      if (part.throughMessageID) pill.setAttribute("data-through-message-id", part.throughMessageID)
    }
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        const nextIsBr = next?.nodeType === Node.ELEMENT_NODE && (next as HTMLElement).tagName === "BR"
        if (!prevIsBr && !nextIsBr) return false
        if (nextIsBr && !prevIsBr && prev) return false
        return true
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      if (el.dataset.type === "conversation") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    editorRef.innerHTML = ""
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent" || part.type === "conversation") {
        editorRef.appendChild(createPill(part))
      }
    }
  }

  createEffect(
    on([() => sync.data.command, () => sync.data.skill, () => sync.data.config.permission], () => slashRefetch(), {
      defer: true,
    }),
  )

  const scrollSlashActive = () => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return
    const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
    element?.scrollIntoView({ block: "nearest", behavior: "auto" })
  }

  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "conversation") {
      const items = conversationFlat()
      if (items.length === 0) return
      const active = conversationActive()
      const item = items.find((entry) => entry.sourceSessionID === active) ?? items[0]
      handleConversationSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  createEffect(
    on(
      () => prompt.current(),
      (currentParts) => {
        const inputParts = currentParts.filter((part) => part.type !== "image") as Prompt

        if (mirror.input) {
          mirror.input = false
          if (isNormalizedEditor()) return

          const selection = window.getSelection()
          let cursorPosition: number | null = null
          if (selection && selection.rangeCount > 0 && editorRef.contains(selection.anchorNode)) {
            cursorPosition = getCursorPosition(editorRef)
          }

          renderEditor(inputParts)

          if (cursorPosition !== null) {
            setCursorPosition(editorRef, cursorPosition)
          }
          return
        }

        const domParts = parseFromDOM()
        if (isNormalizedEditor() && isPromptEqual(inputParts, domParts)) return

        const selection = window.getSelection()
        let cursorPosition: number | null = null
        if (selection && selection.rangeCount > 0 && editorRef.contains(selection.anchorNode)) {
          cursorPosition = getCursorPosition(editorRef)
        }

        renderEditor(inputParts)

        if (cursorPosition !== null) {
          setCursorPosition(editorRef, cursorPosition)
        }
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      const content = buffer.replace(/\r\n?/g, "\n").replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushConversation = (conversation: HTMLElement) => {
      const content = conversation.textContent ?? ""
      parts.push({
        type: "conversation",
        sourceSessionID: conversation.dataset.sessionId!,
        throughMessageID: conversation.dataset.throughMessageId,
        label: conversation.dataset.label || content.replace(/^#/, "") || "Conversation",
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.dataset.type === "conversation") {
        flushText()
        pushConversation(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText = rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const trimmed = rawText.replace(/\u200B/g, "").trim()
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset = trimmed.length === 0 && !hasNonText && images.length === 0

    if (shouldReset) {
      setStore("popover", null)
      if (store.historyIndex >= 0 && !store.applyingHistory) {
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
      }
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"
    const slashMatch = shellMode ? undefined : slashTokenAt(rawText, cursorPosition)
    const keepSlashFocus = !!slashMatch && document.activeElement === editorRef

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const conversationMatch = rawText.substring(0, cursorPosition).match(/#([^\s#]*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (conversationMatch) {
        conversationOnInput(conversationMatch[1])
        setStore("popover", "conversation")
      } else if (slashMatch) {
        setStore("slashInline", slashMatch.inline)
        slashOnInput(slashMatch.query)
        setStore("popover", "slash")
        requestAnimationFrame(() => {
          if (slashPopoverRef) slashPopoverRef.scrollTop = 0
        })
      } else {
        setStore("popover", null)
        setStore("slashInline", false)
      }
    } else {
      setStore("popover", null)
    }

    if (store.historyIndex >= 0 && !store.applyingHistory) {
      setStore("historyIndex", -1)
      setStore("savedPrompt", null)
    }

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
    if (keepSlashFocus) {
      requestAnimationFrame(() => {
        if (document.activeElement !== editorRef) {
          editorRef.focus({ preventScroll: true })
          setCursorPosition(editorRef, cursorPosition)
        }
        if (slashTokenAt(editorRef.textContent ?? "", getCursorPosition(editorRef))) setStore("popover", "slash")
      })
    }
  }

  const setRangeEdge = (range: Range, edge: "start" | "end", offset: number) => {
    let remaining = offset
    const nodes = Array.from(editorRef.childNodes)

    for (const node of nodes) {
      const length = getNodeLength(node)
      const isText = node.nodeType === Node.TEXT_NODE
      const isPill =
        node.nodeType === Node.ELEMENT_NODE &&
        ["file", "agent", "conversation"].includes((node as HTMLElement).dataset.type ?? "")
      const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

      if (isText && remaining <= length) {
        if (edge === "start") range.setStart(node, remaining)
        if (edge === "end") range.setEnd(node, remaining)
        return
      }

      if ((isPill || isBreak) && remaining <= length) {
        if (edge === "start" && remaining === 0) range.setStartBefore(node)
        if (edge === "start" && remaining > 0) range.setStartAfter(node)
        if (edge === "end" && remaining === 0) range.setEndBefore(node)
        if (edge === "end" && remaining > 0) range.setEndAfter(node)
        return
      }

      remaining -= length
    }
  }

  const addPart = (part: ContentPart) => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const cursorPosition = getCursorPosition(editorRef)
    const currentPrompt = prompt.current()
    const rawText = currentPrompt.map((p) => ("content" in p ? p.content : "")).join("")
    const textBeforeCursor = rawText.substring(0, cursorPosition)
    const atMatch = textBeforeCursor.match(/@(\S*)$/)
    const conversationMatch = textBeforeCursor.match(/#([^\s#]*)$/)

    if (part.type === "file" || part.type === "agent" || part.type === "conversation") {
      const pill = createPill(part)
      const gap = document.createTextNode(" ")
      const range = selection.getRangeAt(0)

      const match = part.type === "conversation" ? conversationMatch : atMatch
      if (match) {
        const start = match.index ?? cursorPosition - match[0].length
        setRangeEdge(range, "start", start)
        setRangeEdge(range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    } else if (part.type === "text") {
      const range = selection.getRangeAt(0)
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(last)
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    setStore("popover", null)
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()
    const queued = pending.get(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(sessionID)
      return Promise.resolve()
    }
    return sdk.client.session
      .abort({
        sessionID,
      })
      .catch(() => {})
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const text = prompt
      .map((p) => ("content" in p ? p.content : ""))
      .join("")
      .trim()
    const hasImages = prompt.some((part) => part.type === "image")
    if (!text && !hasImages) return

    const entry = clonePromptParts(prompt)
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const lastEntry = currentHistory.entries[0]
    if (lastEntry && isPromptEqual(lastEntry, entry)) return

    setCurrentHistory("entries", (entries) => [entry, ...entries].slice(0, MAX_HISTORY))
  }

  const navigateHistory = (direction: "up" | "down") => {
    const entries = store.mode === "shell" ? shellHistory.entries : history.entries
    const current = store.historyIndex

    if (direction === "up") {
      if (entries.length === 0) return false
      if (current === -1) {
        setStore("savedPrompt", clonePromptParts(prompt.current()))
        setStore("historyIndex", 0)
        applyHistoryPrompt(entries[0], "start")
        return true
      }
      if (current < entries.length - 1) {
        const next = current + 1
        setStore("historyIndex", next)
        applyHistoryPrompt(entries[next], "start")
        return true
      }
      return false
    }

    if (current > 0) {
      const next = current - 1
      setStore("historyIndex", next)
      applyHistoryPrompt(entries[next], "end")
      return true
    }
    if (current === 0) {
      setStore("historyIndex", -1)
      const saved = store.savedPrompt
      if (saved) {
        applyHistoryPrompt(saved, "end")
        setStore("savedPrompt", null)
        return true
      }
      applyHistoryPrompt(DEFAULT_PROMPT, "end")
      return true
    }

    return false
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("intent", null)
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }
    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Escape") {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "conversation") {
          conversationOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
          requestAnimationFrame(scrollSlashActive)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        setStore("popover", null)
        event.preventDefault()
        return
      }
      if (working()) {
        abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textLength = promptLength(prompt.current())
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const isEmpty = textContent.trim() === "" || textLength <= 1
      const hasNewlines = textContent.includes("\n")
      const inHistory = store.historyIndex >= 0
      const atStart = cursorPosition <= (isEmpty ? 1 : 0)
      const atEnd = cursorPosition >= (isEmpty ? textLength - 1 : textLength)
      const allowUp = isEmpty || atStart || (!hasNewlines && !inHistory) || (inHistory && atEnd)
      const allowDown = isEmpty || atEnd || (!hasNewlines && !inHistory) || (inHistory && atStart)

      if (event.key === "ArrowUp") {
        if (!allowUp) return
        if (navigateHistory("up")) {
          event.preventDefault()
        }
        return
      }

      if (!allowDown) return
      if (navigateHistory("down")) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      handleSubmit(event)
    }
    if (event.key === "Escape") {
      if (store.popover) {
        setStore("popover", null)
      } else if (working()) {
        abort()
      }
    }
  }

  const handleSubmit = async (event: Event, action?: string) => {
    event.preventDefault()

    // A first prompt may need to create its session (and sometimes a
    // worktree) before it has a real session ID. Keep that bootstrap single-
    // flight while the composer is showing its immediate acknowledgement.
    if (submitting()) return

    // While a response is active this control is Stop, regardless of whether
    // the user has started drafting the next message. Preserve that draft and
    // terminate the active response instead of accidentally submitting it.
    if (working()) {
      abort()
      return
    }

    const currentPrompt = prompt.current()
    const text = action ? `/${action}` : currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = action ? [] : imageAttachments().slice()
    const mode = action ? "normal" : store.mode
    const intent = action ? null : store.intent

    const typedIntent = !intent && images.length === 0 ? text.trim().match(/^\/(plan|goal)$/)?.[1] : undefined
    if (typedIntent === "plan" || typedIntent === "goal") {
      enterIntent(typedIntent)
      return
    }

    if (text.trim().length === 0 && images.length === 0) return

    const errorMessage = (err: unknown) => requestFailure(err, "Request").description

    const clearInput = () => {
      prompt.reset()
      setStore("mode", "normal")
      setStore("popover", null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, promptLength(currentPrompt))
      setStore("mode", mode)
      setStore("popover", null)
      requestAnimationFrame(() => {
        editorRef.focus()
        setCursorPosition(editorRef, promptLength(currentPrompt))
        queueScroll()
      })
    }

    const restoreInputAfterFailure = () => {
      if (!canRestoreFailedSubmission(prompt.current(), store.mode)) return false
      restoreInput()
      return true
    }

    const researchEffort = "normal" as const
    const delegationConfig = delegation()
    const delegationEnabled = delegationConfig.level !== "off"
    const [head, ...tail] = text.split(" ")
    const name = text.startsWith("/") ? head.slice(1) : undefined
    const command = name ? sync.data.command.find((item) => item.name === name) : undefined
    const native = command?.source === "builtin" && command.menu
    const active = info()
    if (native && active && mode === "normal" && images.length === 0) {
      setSubmitting(true)
      clearInput()
      if (!action) window.setTimeout(() => addToHistory(currentPrompt, mode), 0)
      setStore("historyIndex", -1)
      setStore("savedPrompt", null)
      props.onSubmit?.()
      const request = {
        sessionID: active.id,
        command: command.name,
        arguments: tail.join(" "),
        effort: researchEffort,
        delegation: delegationEnabled,
        delegationSettings: delegationConfig,
      } satisfies Parameters<typeof sdk.client.session.command>[0] & {
        effort: "normal"
        delegation: boolean
        delegationSettings: DelegationSettings
      }
      sdk.client.session.command(request).catch((err) => {
        showToast({
          title: language.t("prompt.toast.commandSendFailed.title"),
          description: errorMessage(err),
        })
        restoreInputAfterFailure()
      })
      setSubmitting(false)
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const variant = local.model.variant.prompt()
    const tier = local.model.tier.prompt()

    const restoreBootstrap = () => {
      setSubmitting(false)
      restoreInput()
    }

    // Acknowledge Enter before the first network boundary. Persisting up to
    // 100 history entries can synchronously serialize several megabytes, so
    // keep that work off the input event's critical path.
    setSubmitting(true)
    clearInput()
    if (!action) window.setTimeout(() => addToHistory(currentPrompt, mode), 0)
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)

    const projectDirectory = sdk.directory
    const isNewSession = !params.id || params.id === "new"
    const worktreeSelection = props.newSessionWorktree ?? "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          restoreBootstrap()
          return
        }
        WorktreeState.pending(createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = createOpenScienceClient({
          baseUrl: sdk.url,
          fetch: platform.fetch,
          directory: sessionDirectory,
          projectID: sdk.projectID,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory, { projectID: sdk.projectID })
      }

      props.onNewSessionWorktreeReset?.()
    }

    let session = info()
    if (!session && isNewSession) {
      const candidate =
        store.bootstrapID && store.bootstrapDirectory === sessionDirectory
          ? store.bootstrapID
          : Identifier.descending("session")
      setStore({ bootstrapID: candidate, bootstrapDirectory: sessionDirectory })
      session = await client.session
        .create({ id: candidate })
        .then((x) => x.data ?? undefined)
        .catch(async (err) => {
          const recovery = await client.session
            .get({ sessionID: candidate })
            .then((x) => ({ recovered: x.data ?? undefined, error: undefined as unknown }))
            .catch((error) => ({ recovered: undefined, error }))
          const recovered = recovery.recovered
          if (recovered) return recovered
          const failure = requestFailure(err, "Create session", {
            ambiguousCreate: !recovery.error || requestStatus(recovery.error) !== 404,
            candidate,
          })
          showToast({
            title: failure.title,
            description: failure.description,
          })
          return undefined
        })
      if (session) {
        setStore({ bootstrapID: undefined, bootstrapDirectory: undefined })
        const project = sync.project
        const href = project
          ? projectHref(project, sessionDirectory, session.id)
          : projectPathname(sdk.scope, session.id)
        navigate(href)
      }
    }
    if (!session) {
      restoreBootstrap()
      return
    }
    props.onSubmit?.()

    if (mode === "shell") {
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          const failure = requestFailure(err, "Send shell command")
          showToast({
            title: failure.title,
            description: failure.description,
          })
          restoreInputAfterFailure()
        })
      setSubmitting(false)
      return
    }

    if (intent) {
      const request = {
        sessionID: session.id,
        command: intent,
        arguments: text,
        agent,
        model: `${model.providerID}/${model.modelID}`,
        effort: researchEffort,
        delegation: delegationEnabled,
        delegationSettings: delegationConfig,
        variant,
        tier,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      } satisfies Parameters<typeof client.session.command>[0] & {
        effort: "normal"
        delegation: boolean
        delegationSettings: DelegationSettings
      }
      client.session.command(request).catch((err) => {
        const failure = requestFailure(err, `Start ${intent} mode`)
        showToast({
          title: failure.title,
          description: failure.description,
        })
        restoreInputAfterFailure()
      })
      setSubmitting(false)
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        const request = {
          sessionID: session.id,
          command: commandName,
          arguments: args.join(" "),
          agent,
          model: `${model.providerID}/${model.modelID}`,
          effort: researchEffort,
          delegation: delegationEnabled,
          delegationSettings: delegationConfig,
          variant,
          tier,
          parts: images.map((attachment) => ({
            id: Identifier.ascending("part"),
            type: "file" as const,
            mime: attachment.mime,
            url: attachment.dataUrl,
            filename: attachment.filename,
          })),
        } satisfies Parameters<typeof client.session.command>[0] & {
          effort: "normal"
          delegation: boolean
          delegationSettings: DelegationSettings
        }
        client.session.command(request).catch((err) => {
          const failure = requestFailure(err, "Send command")
          showToast({
            title: failure.title,
            description: failure.description,
          })
          restoreInputAfterFailure()
        })
        setSubmitting(false)
        return
      }
    }

    const toAbsolutePath = (path: string) =>
      path.startsWith("/") ? path : (sessionDirectory + "/" + path).replace("//", "/")

    const fileAttachments = currentPrompt.filter((part) => part.type === "file") as FileAttachmentPart[]
    const agentAttachments = currentPrompt.filter((part) => part.type === "agent") as AgentPart[]
    const conversationAttachments = currentPrompt.filter(
      (part) => part.type === "conversation",
    ) as ConversationAttachmentPart[]

    const fileAttachmentParts = fileAttachments.map((attachment) => {
      const absolute = toAbsolutePath(attachment.path)
      const query = attachment.selection
        ? `?start=${attachment.selection.startLine}&end=${attachment.selection.endLine}`
        : ""
      return {
        id: Identifier.ascending("part"),
        type: "file" as const,
        mime: "text/plain",
        url: `file://${absolute}${query}`,
        filename: getFilename(attachment.path),
        source: {
          type: "file" as const,
          text: {
            value: attachment.content,
            start: attachment.start,
            end: attachment.end,
          },
          path: absolute,
        },
      }
    })

    const agentAttachmentParts = agentAttachments.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "agent" as const,
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    }))
    const conversationAttachmentParts = conversationAttachments.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "conversation" as const,
      sourceSessionID: attachment.sourceSessionID,
      throughMessageID: attachment.throughMessageID,
      label: attachment.label,
    }))
    const specialist = delegatedSpecialist(
      capabilities()?.delegation_enabled ?? true,
      capabilities()?.delegation_specialist ?? null,
      agentAttachments.map((attachment) => attachment.name),
    )
    const delegationParts = specialist
      ? [
          {
            id: Identifier.ascending("part"),
            type: "agent" as const,
            name: specialist,
            source: { value: `@${specialist}`, start: 0, end: 0 },
          },
        ]
      : []

    const usedUrls = new Set(fileAttachmentParts.map((part) => part.url))

    const context = prompt.context.items().slice()

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())

    const contextParts: Array<
      | {
          id: string
          type: "text"
          text: string
          synthetic?: boolean
        }
      | {
          id: string
          type: "file"
          mime: string
          url: string
          filename?: string
        }
    > = []

    const commentNote = (path: string, selection: FileSelection | undefined, comment: string) => {
      const start = selection ? Math.min(selection.startLine, selection.endLine) : undefined
      const end = selection ? Math.max(selection.startLine, selection.endLine) : undefined
      const range =
        start === undefined || end === undefined
          ? "this file"
          : start === end
            ? `line ${start}`
            : `lines ${start} through ${end}`

      return `The user made the following comment regarding ${range} of ${path}: ${comment}`
    }

    const addContextFile = (input: { path: string; selection?: FileSelection; comment?: string }) => {
      const absolute = toAbsolutePath(input.path)
      const query = input.selection ? `?start=${input.selection.startLine}&end=${input.selection.endLine}` : ""
      const url = `file://${absolute}${query}`

      const comment = input.comment?.trim()
      if (!comment && usedUrls.has(url)) return
      usedUrls.add(url)

      if (comment) {
        contextParts.push({
          id: Identifier.ascending("part"),
          type: "text",
          text: commentNote(input.path, input.selection, comment),
          synthetic: true,
        })
      }

      contextParts.push({
        id: Identifier.ascending("part"),
        type: "file",
        mime: "text/plain",
        url,
        filename: getFilename(input.path),
      })
    }

    for (const item of context) {
      if (item.type !== "file") continue
      addContextFile({ path: item.path, selection: item.selection, comment: item.comment })
    }

    const imageAttachmentParts = images.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: attachment.mime,
      url: attachment.dataUrl,
      filename: attachment.filename,
    }))

    const messageID = Identifier.ascending("message")
    const textPart = {
      id: Identifier.ascending("part"),
      type: "text" as const,
      text,
    }
    const requestParts = [
      textPart,
      ...fileAttachmentParts,
      ...conversationAttachmentParts,
      ...contextParts,
      ...delegationParts,
      ...agentAttachmentParts,
      ...imageAttachmentParts,
    ]
    const sendParts = requestParts as unknown as Parameters<typeof client.session.prompt>[0]["parts"]

    const optimisticParts = requestParts.map((part) => ({
      ...part,
      sessionID: session.id,
      messageID,
    })) as unknown as Part[]

    const optimisticMessage: Message = {
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent,
      model,
    }

    const addOptimisticMessage = () => {
      if (sessionDirectory === projectDirectory) {
        sync.set(
          produce((draft) => {
            const messages = draft.message[session.id]
            if (!messages) {
              draft.message[session.id] = [optimisticMessage]
            } else {
              const result = Binary.search(messages, messageID, (m) => m.id)
              messages.splice(result.index, 0, optimisticMessage)
            }
            draft.part[messageID] = optimisticParts
              .filter((p) => !!p?.id)
              .slice()
              .sort((a, b) => a.id.localeCompare(b.id))
          }),
        )
        return
      }

      globalSync.child(sessionDirectory)[1](
        produce((draft) => {
          const messages = draft.message[session.id]
          if (!messages) {
            draft.message[session.id] = [optimisticMessage]
          } else {
            const result = Binary.search(messages, messageID, (m) => m.id)
            messages.splice(result.index, 0, optimisticMessage)
          }
          draft.part[messageID] = optimisticParts
            .filter((p) => !!p?.id)
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
        }),
      )
    }

    const removeOptimisticMessage = () => {
      if (sessionDirectory === projectDirectory) {
        sync.set(
          produce((draft) => {
            const messages = draft.message[session.id]
            if (messages) {
              const result = Binary.search(messages, messageID, (m) => m.id)
              if (result.found) messages.splice(result.index, 1)
            }
            delete draft.part[messageID]
          }),
        )
        return
      }

      globalSync.child(sessionDirectory)[1](
        produce((draft) => {
          const messages = draft.message[session.id]
          if (messages) {
            const result = Binary.search(messages, messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          delete draft.part[messageID]
        }),
      )
    }

    for (const item of commentItems) {
      prompt.context.remove(item.key)
    }

    addOptimisticMessage()
    setSubmitting(false)

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()

      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        for (const item of commentItems) {
          prompt.context.add({
            type: "file",
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }
        restoreInputAfterFailure()
      }

      pending.set(session.id, { abort: controller, cleanup })

      const abort = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({ status: "failed", message: language.t("workspace.error.stillPreparing") })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sessionDirectory), abort, timeout]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(session.id)
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    const send = async () => {
      const ok = await waitForWorktree()
      if (!ok) return
      const request: Parameters<typeof client.session.prompt>[0] & {
        effort: "normal"
        delegationSettings: DelegationSettings
      } = {
        sessionID: session.id,
        agent,
        model,
        messageID,
        parts: sendParts,
        effort: researchEffort,
        delegation: delegationEnabled,
        delegationSettings: delegationConfig,
        variant,
        tier,
      }
      await client.session.prompt(request)
    }

    void send().catch((err) => {
      pending.delete(session.id)
      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "idle" })
      }
      const failure = requestFailure(err, "Send prompt")
      showToast({ title: failure.title, description: failure.description })
      removeOptimisticMessage()
      for (const item of commentItems) {
        prompt.context.add({
          type: "file",
          path: item.path,
          selection: item.selection,
          comment: item.comment,
          commentID: item.commentID,
          commentOrigin: item.commentOrigin,
          preview: item.preview,
        })
      }
      restoreInputAfterFailure()
    })
  }

  createEffect(() => {
    const text = uiStore.prefill()
    if (!text || !editorRef) return
    const send = uiStore.prefillSend()
    editorRef.textContent = text
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    uiStore.setPrefill(undefined)
    uiStore.setPrefillSend(false)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, text.length)
      queueScroll()
      if (send) void handleSubmit(new Event("submit"))
    })
  })

  return (
    <div class="relative size-full flex flex-col gap-3">
      <Show when={store.popover}>
        <div
          ref={(el) => {
            if (store.popover === "slash") slashPopoverRef = el
          }}
          class="workspace-composer__suggestions absolute inset-x-0 -top-3 -translate-y-full origin-bottom-left
                 min-h-10 overflow-auto no-scrollbar flex flex-col"
          onMouseDown={(e) => e.preventDefault()}
        >
          <Switch>
            <Match when={store.popover === "at"}>
              <Show
                when={atFlat().length > 0}
                fallback={<div class="text-text-weak px-2 py-1">{language.t("prompt.popover.emptyResults")}</div>}
              >
                <For each={atFlat().slice(0, 10)}>
                  {(item) => (
                    <button
                      classList={{
                        "workspace-composer__suggestion w-full flex items-center gap-x-2": true,
                        "bg-surface-raised-base-hover": atActive() === atKey(item),
                      }}
                      onClick={() => handleAtSelect(item)}
                      onMouseEnter={() => setAtActive(atKey(item))}
                    >
                      <Show
                        when={item.type === "agent"}
                        fallback={
                          <>
                            <FileIcon
                              node={{ path: (item as { type: "file"; path: string }).path, type: "file" }}
                              class="shrink-0 size-4"
                            />
                            <div class="flex items-center text-14-regular min-w-0">
                              <span class="text-text-weak whitespace-nowrap truncate min-w-0">
                                {(() => {
                                  const path = (item as { type: "file"; path: string }).path
                                  return path.endsWith("/") ? path : getDirectory(path)
                                })()}
                              </span>
                              <Show when={!(item as { type: "file"; path: string }).path.endsWith("/")}>
                                <span class="text-text-strong whitespace-nowrap">
                                  {getFilename((item as { type: "file"; path: string }).path)}
                                </span>
                              </Show>
                            </div>
                          </>
                        }
                      >
                        <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
                        <span class="text-14-regular text-text-strong whitespace-nowrap">
                          @{(item as { type: "agent"; name: string }).name}
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>
            </Match>
            <Match when={store.popover === "conversation"}>
              <Show
                when={conversationFlat().length > 0}
                fallback={
                  <div class="workspace-composer__suggestion-empty">No other conversations in this project</div>
                }
              >
                <div class="workspace-composer__suggestion-heading">Conversations</div>
                <For each={conversationFlat().slice(0, 12)}>
                  {(item) => (
                    <button
                      type="button"
                      classList={{
                        "workspace-composer__suggestion workspace-composer__conversation-row": true,
                        "bg-surface-raised-base-hover": conversationActive() === item.sourceSessionID,
                      }}
                      onClick={() => handleConversationSelect(item)}
                      onMouseEnter={() => setConversationActive(item.sourceSessionID)}
                    >
                      <span class="workspace-composer__conversation-mark" aria-hidden="true">
                        #
                      </span>
                      <span>
                        <strong>{item.label}</strong>
                        <small>Reference a snapshot of this conversation</small>
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </Match>
            <Match when={store.popover === "slash"}>
              <Show
                when={slashFlat().length > 0}
                fallback={<div class="text-text-weak px-2 py-1">{language.t("prompt.popover.emptyCommands")}</div>}
              >
                <For each={slashGrouped()}>
                  {(group) => (
                    <section class="workspace-composer__slash-group" aria-label={group.category}>
                      <Show when={group.category === "Skills"}>
                        <header class="workspace-composer__slash-heading">Skills</header>
                      </Show>
                      <For each={group.items}>
                        {(cmd) => (
                          <button
                            data-slash-id={cmd.id}
                            classList={{
                              "workspace-composer__suggestion workspace-composer__slash-row w-full": true,
                              "bg-surface-raised-base-hover": slashActive() === cmd.id,
                            }}
                            onClick={() => handleSlashSelect(cmd)}
                            onMouseEnter={() => setSlashActive(cmd.id)}
                          >
                            <span class="workspace-composer__slash-icon">
                              <Icon name={slashIcon(cmd)} size="small" />
                            </span>
                            <span class="workspace-composer__slash-name">/{cmd.trigger}</span>
                            <span class="workspace-composer__slash-detail truncate">
                              {cmd.description || cmd.title}
                            </span>
                            <Show when={command.keybind(cmd.id) || slashSource(cmd)}>
                              <span class="workspace-composer__slash-meta">
                                {command.keybind(cmd.id) || slashSource(cmd)}
                              </span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </section>
                  )}
                </For>
              </Show>
            </Match>
          </Switch>
        </div>
      </Show>
      <Show when={store.mode === "normal" && !local.model.current()}>
        <div class="workspace-composer__setup" role="status">
          <span>
            <strong>Choose a model to start</strong>
            <small>Connect a provider in Settings to choose a model.</small>
          </span>
          <button type="button" onClick={() => dialog.show(() => <DialogSettings />)}>
            Set up model
          </button>
        </div>
      </Show>
      <form
        onSubmit={handleSubmit}
        classList={{
          "group/prompt-input": true,
          "workspace-composer": true,
          "relative overflow-visible": true,
          "border-icon-info-active border-dashed": store.dragging,
          [props.class ?? ""]: !!props.class,
        }}
      >
        <Show when={store.dragging}>
          <div class="workspace-composer__dropzone absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div class="workspace-composer__dropzone-copy">
              <Icon name="paperclip" class="size-6" />
              <strong>{language.t("prompt.dropzone.label")}</strong>
              <span>{language.t("prompt.dropzone.hint")}</span>
            </div>
          </div>
        </Show>
        <Show when={prompt.context.items().length > 0}>
          <div class="workspace-composer__context flex flex-nowrap items-start gap-2 overflow-x-auto no-scrollbar">
            <For each={prompt.context.items()}>
              {(item) => {
                const active = () => {
                  const a = comments.active()
                  return !!item.commentID && item.commentID === a?.id && item.path === a?.file
                }
                return (
                  <Tooltip
                    value={
                      <span class="flex max-w-[300px]">
                        <span class="text-text-invert-base truncate-start [unicode-bidi:plaintext] min-w-0">
                          {getDirectory(item.path)}
                        </span>
                        <span class="shrink-0">{getFilename(item.path)}</span>
                      </span>
                    }
                    placement="top"
                    openDelay={2000}
                  >
                    <div
                      classList={{
                        "workspace-composer__context-item group shrink-0 flex flex-col max-w-[220px]": true,
                        "cursor-pointer hover:bg-surface-interactive-weak": !!item.commentID && !active(),
                        "cursor-pointer bg-surface-interactive-hover hover:bg-surface-interactive-hover": active(),
                      }}
                      onClick={() => {
                        openComment(item)
                      }}
                    >
                      <div class="workspace-composer__context-heading flex items-center gap-1.5">
                        <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-3.5" />
                        <div class="flex items-center min-w-0">
                          <span class="text-text-strong whitespace-nowrap">{getFilenameTruncated(item.path, 14)}</span>
                          <Show when={item.selection}>
                            {(sel) => (
                              <span class="text-text-weak whitespace-nowrap shrink-0">
                                {sel().startLine === sel().endLine
                                  ? `:${sel().startLine}`
                                  : `:${sel().startLine}-${sel().endLine}`}
                              </span>
                            )}
                          </Show>
                        </div>
                        <IconButton
                          type="button"
                          icon="close-small"
                          variant="ghost"
                          class="workspace-composer__context-remove ml-auto"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (item.commentID) comments.remove(item.path, item.commentID)
                            prompt.context.remove(item.key)
                          }}
                          aria-label={language.t("prompt.context.removeFile")}
                        />
                      </div>
                      <Show when={item.comment}>
                        {(comment) => <div class="workspace-composer__context-comment truncate">{comment()}</div>}
                      </Show>
                    </div>
                  </Tooltip>
                )
              }}
            </For>
          </div>
        </Show>
        <Show when={imageAttachments().length > 0}>
          <div class="workspace-composer__attachments" aria-label="Attached files">
            <For each={imageAttachments()}>
              {(attachment) => (
                <div
                  class="workspace-composer__attachment"
                  data-image={attachment.mime.startsWith("image/")}
                  data-attachment-status="attached"
                >
                  <a
                    href={attachment.dataUrl}
                    target="_blank"
                    rel="noreferrer"
                    class="workspace-composer__attachment-open"
                    aria-label={`${attachment.mime.startsWith("image/") ? "Preview" : "Open"} ${attachment.filename}`}
                    onClick={(event) => {
                      if (!attachment.mime.startsWith("image/")) return
                      event.preventDefault()
                      dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
                    }}
                  >
                    <Show
                      when={attachment.mime.startsWith("image/")}
                      fallback={
                        <div class="workspace-composer__attachment-icon" aria-hidden="true">
                          <FileIcon node={{ path: attachment.filename, type: "file" }} class="size-4" />
                        </div>
                      }
                    >
                      <img src={attachment.dataUrl} alt="" class="workspace-composer__attachment-preview" />
                    </Show>
                    <span class="workspace-composer__attachment-copy">
                      <strong title={attachment.filename}>{attachment.filename}</strong>
                      <span>
                        Attached · {attachmentFormat({ name: attachment.filename, type: attachment.mime })}
                        <Show when={attachment.size !== undefined}> · {attachmentSize(attachment.size!)}</Show>
                      </span>
                    </span>
                  </a>
                  <button
                    type="button"
                    onClick={() => removeImageAttachment(attachment.id)}
                    class="workspace-composer__attachment-remove"
                    aria-label={language.t("prompt.attachment.remove")}
                  >
                    <Icon name="close" class="size-3 text-text-weak" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="workspace-composer__editor" data-composer-mode={store.mode} ref={(el) => (scrollRef = el)}>
          <div
            data-component="prompt-input"
            ref={(el) => {
              editorRef = el
              props.ref?.(el)
            }}
            role="textbox"
            aria-multiline="true"
            aria-label={placeholder()}
            aria-busy={submitting()}
            dir="auto"
            contenteditable={submitting() ? "false" : "true"}
            onInput={handleInput}
            onPaste={handlePaste}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={handleKeyDown}
            classList={{
              "select-text": true,
              "focus:outline-none whitespace-pre-wrap": true,
              "[&_[data-type=file]]:text-syntax-property": true,
              "[&_[data-type=agent]]:text-syntax-type": true,
              "[&_[data-type=conversation]]:text-syntax-keyword": true,
            }}
          />
          <Show when={!prompt.dirty()}>
            <div class="workspace-composer__placeholder" aria-hidden="true" dir="auto">
              {placeholder()}
            </div>
          </Show>
        </div>
        <div class="workspace-composer__footer">
          <div
            data-slot="prompt-controls"
            class="workspace-composer__controls flex items-center justify-start gap-2"
            role="group"
            aria-label="Composer tools"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              multiple
              class="hidden"
              onChange={(e) => {
                const selected = Array.from(e.currentTarget.files ?? [])
                for (const file of selected) void addAttachment(file)
                e.currentTarget.value = ""
              }}
            />
            <Switch>
              <Match when={store.mode === "shell"}>
                <div class="flex items-center gap-2 px-2 h-6">
                  <Icon name="console" size="small" class="text-icon-base" />
                  <span class="text-12-regular text-text-strong">{language.t("prompt.mode.shell")}</span>
                  <span class="text-12-regular text-text-weak">{language.t("prompt.mode.shell.exit")}</span>
                </div>
              </Match>
              <Match when={store.mode === "normal"}>
                <Tooltip placement="top" value={language.t("prompt.action.attachFile")}>
                  <Button
                    type="button"
                    variant="ghost"
                    class="workspace-composer__attach shrink-0"
                    onClick={attach}
                    aria-label={language.t("prompt.action.attachFile")}
                  >
                    <Icon name="paperclip" class="size-4" />
                  </Button>
                </Tooltip>
                <details
                  ref={(element) => (researchToolsRef = element)}
                  class="workspace-composer__research-tools"
                  onToggle={(event) => {
                    if (event.currentTarget.open) return
                    resetResearchTools()
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return
                    event.preventDefault()
                    closeResearchTools()
                    researchToolsRef?.querySelector("summary")?.focus()
                  }}
                >
                  <summary aria-label="Research tools">
                    <span class="workspace-composer__research-tools-label">Research</span>
                    <Icon name="chevron-down" size="small" />
                  </summary>
                  <div class="workspace-composer__research-tools-menu" role="group" aria-label="Research tools">
                    <section class="workspace-composer__research-controls" aria-label="Research roles">
                      <ResearchSlider
                        label="Delegation"
                        value={delegation().level}
                        options={DELEGATION_LEVELS}
                        disabled={!capabilities()}
                        onSelect={(value) => saveDelegation({ level: value as DelegationLevel })}
                      />
                      <Show when={delegation().level !== "off"}>
                        <ResearchSlider
                          label="Independence"
                          value={delegation().autonomy}
                          options={DELEGATION_AUTONOMY}
                          onSelect={(value) => saveDelegation({ autonomy: value as DelegationAutonomy })}
                        />
                      </Show>
                      <div class="workspace-composer__research-divider" />
                      <Show
                        when={!researchAccess.error}
                        fallback={
                          <button
                            type="button"
                            class="workspace-composer__research-access-retry"
                            onClick={() => void researchAccessControls.refetch()}
                          >
                            Access settings unavailable · Retry
                          </button>
                        }
                      >
                        <details class="workspace-composer__research-choice" onToggle={toggleResearchChoice}>
                          <summary aria-label={`Action approval, ${researchAccessLabel()}`}>
                            <span>Action approval</span>
                            <strong aria-live="polite">
                              {researchAccessSaving() ? "Saving…" : researchAccessLabel()}
                            </strong>
                            <Icon name="chevron-right" size="small" />
                          </summary>
                          <div
                            class="workspace-composer__research-choice-menu"
                            role="radiogroup"
                            aria-label="How should OpenScience actions be approved?"
                            aria-busy={researchAccessSaving() ? "true" : undefined}
                            onKeyDown={navigateResearchChoices}
                          >
                            <For each={RESEARCH_ACCESS_OPTIONS}>
                              {(option) => (
                                <button
                                  type="button"
                                  role="radio"
                                  data-research-access={option.value}
                                  data-tone={option.value === "full" ? "warning" : undefined}
                                  aria-checked={selectedResearchAccess() === option.value}
                                  tabindex={selectedResearchAccess() === option.value ? 0 : -1}
                                  disabled={
                                    researchAccess.loading ||
                                    researchAccessSaving() ||
                                    (option.value !== "full" && researchAccess()?.sandboxStatus.available === false)
                                  }
                                  onClick={(event) => {
                                    void applyResearchAccess(option.value, event.currentTarget)
                                    event.currentTarget.closest("details")?.removeAttribute("open")
                                  }}
                                >
                                  <span>
                                    <strong>{option.label}</strong>
                                    <small>
                                      {option.value !== "full" && researchAccess()?.sandboxStatus.available === false
                                        ? `Unavailable: ${researchAccess()?.sandboxStatus.reason ?? "sandbox backend not installed"}`
                                        : option.description}
                                    </small>
                                  </span>
                                  <Show when={selectedResearchAccess() === option.value}>
                                    <Icon name="check" size="small" />
                                  </Show>
                                </button>
                              )}
                            </For>
                          </div>
                        </details>
                      </Show>
                    </section>
                  </div>
                </details>
                <Show when={store.intent}>
                  {(intent) => (
                    <Tooltip placement="top" value={`Exit ${intent()} mode`}>
                      <button
                        type="button"
                        class="workspace-composer__intent"
                        data-composer-intent={intent()}
                        aria-label={`Exit ${intent()} mode`}
                        onClick={() => setIntent(null)}
                      >
                        <span class="workspace-composer__intent-close" aria-hidden="true">
                          <Icon name="close" size="small" />
                        </span>
                        <span>{intent() === "plan" ? "Plan" : "Goal"}</span>
                      </button>
                    </Tooltip>
                  )}
                </Show>
              </Match>
            </Switch>
          </div>
          <div
            class="workspace-composer__actions flex items-center gap-3"
            role="group"
            aria-label="Model, effort, and send"
          >
            <ModelSettingsPopover />
            <Tooltip
              placement="top"
              inactive={!prompt.dirty() && !working()}
              value={
                <Switch>
                  <Match when={working()}>
                    <div class="flex items-center gap-2">
                      <span>{language.t("prompt.action.stop")}</span>
                      <span class="text-icon-base text-10-medium">{language.t("common.key.esc")}</span>
                    </div>
                  </Match>
                  <Match when={true}>
                    <div class="flex items-center gap-2">
                      <span>{language.t("prompt.action.send")}</span>
                      <Icon name="enter" size="small" class="text-icon-base" />
                    </div>
                  </Match>
                </Switch>
              }
            >
              <IconButton
                type="submit"
                disabled={!prompt.dirty() && !working()}
                icon={working() ? "stop" : "arrow-up"}
                variant="primary"
                class="workspace-composer__send rounded-full"
                data-composer-action={working() ? "stop" : prompt.dirty() ? "send" : "idle"}
                aria-label={working() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
              />
            </Tooltip>
          </div>
        </div>
      </form>
    </div>
  )
}

function createTextFragment(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const segments = content.split("\n")
  segments.forEach((segment, index) => {
    if (segment) {
      fragment.appendChild(document.createTextNode(segment))
    } else if (segments.length > 1) {
      fragment.appendChild(document.createTextNode("\u200B"))
    }
    if (index < segments.length - 1) {
      fragment.appendChild(document.createElement("br"))
    }
  })
  return fragment
}

function getNodeLength(node: Node): number {
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  return (node.textContent ?? "").replace(/\u200B/g, "").length
}

function getTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u200B/g, "").length
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  let length = 0
  for (const child of Array.from(node.childNodes)) {
    length += getTextLength(child)
  }
  return length
}

function getCursorPosition(parent: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return 0
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(parent)
  preCaretRange.setEnd(range.startContainer, range.startOffset)
  return getTextLength(preCaretRange.cloneContents())
}

function setCursorPosition(parent: HTMLElement, position: number) {
  let remaining = position
  let node = parent.firstChild
  while (node) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill =
      node.nodeType === Node.ELEMENT_NODE &&
      ((node as HTMLElement).dataset.type === "file" || (node as HTMLElement).dataset.type === "agent")
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

    if (isText && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      range.setStart(node, remaining)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      if (remaining === 0) {
        range.setStartBefore(node)
      }
      if (remaining > 0 && isPill) {
        range.setStartAfter(node)
      }
      if (remaining > 0 && isBreak) {
        const next = node.nextSibling
        if (next && next.nodeType === Node.TEXT_NODE) {
          range.setStart(next, 0)
        }
        if (!next || next.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(node)
        }
      }
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    remaining -= length
    node = node.nextSibling
  }

  const fallbackRange = document.createRange()
  const fallbackSelection = window.getSelection()
  const last = parent.lastChild
  if (last && last.nodeType === Node.TEXT_NODE) {
    const len = last.textContent ? last.textContent.length : 0
    fallbackRange.setStart(last, len)
  }
  if (!last || last.nodeType !== Node.TEXT_NODE) {
    fallbackRange.selectNodeContents(parent)
  }
  fallbackRange.collapse(false)
  fallbackSelection?.removeAllRanges()
  fallbackSelection?.addRange(fallbackRange)
}
