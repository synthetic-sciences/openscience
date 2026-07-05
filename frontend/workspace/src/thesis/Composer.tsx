import { createSignal, createMemo, createEffect, on, onCleanup, untrack, type JSX, Show, For } from "solid-js"
import { Portal } from "solid-js/web"
import { useNavigate, useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useModels, type ModelKey } from "@/context/models"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import {
  IconArrowUp,
  IconChevronDown,
  IconPaperclip,
  IconSearch,
  IconSparkles,
  IconStop,
  IconX,
} from "@/thesis/shared/Icon"
import { AsciiSpinner } from "@/thesis/shared/AsciiSpinner"
import { toast } from "@/thesis/Toast"
import { SkillsBrowser } from "@/thesis/SkillsBrowser"
import { uiStore } from "@/thesis/store/ui"
import { URLS } from "@/config/urls"
import { Identifier } from "@/utils/id"
import { useProviders, popularProviders } from "@/hooks/use-providers"
import { useGlobalSync } from "@/context/global-sync"
import { resolveModelSource, type ModelSource } from "@/utils/model-cost"

const BYOK_URL = URLS.dashboard

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  google: "Google",
  "google-vertex": "Google Vertex",
  "github-copilot": "GitHub Copilot",
  openrouter: "OpenRouter",
  vercel: "Vercel",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI",
  cohere: "Cohere",
  synsci: "Atlas",
}

// Credential source shown as a single low-weight dot — the one bit that matters
// is "does this spend money?". Text badges (BYOK/metered) were removed from the
// bar and rows; the dot carries the signal at near-zero visual weight. Inferred
// from provider connection state; authoritative resolver is server-side.
const SOURCE_DOT: Record<ModelSource, { color: string; opacity: number; meters: boolean; title: string }> = {
  byok: { color: "var(--color-text-faint)", opacity: 0.5, meters: false, title: "your key — free" },
  "signed-in": { color: "var(--color-text-faint)", opacity: 0.5, meters: false, title: "signed-in account — free" },
  managed: { color: "var(--color-accent)", opacity: 0.8, meters: true, title: "metered — debits your wallet" },
}

// The effort control renders a model's OWN reasoning-effort variant keys
// (low/medium/high/xhigh/none/minimal, exactly as the backend emits them) and
// persists the choice via models.variant. No relabeling.
//
// A model exposes a REAL per-request "fast" API param only for gpt-5.5, where it
// maps to OpenAI service_tier: priority (plumbed as providerOptions.openai.serviceTier
// in src/session/llm.ts). Opus-4.8 speed:"fast" is real but not plumbable through the
// installed @ai-sdk/anthropic, so no fast toggle is shown for it.
const isGpt55 = (modelID: string) => /gpt-5\.5/.test(modelID.toLowerCase())

// Collapse a model id to its FAMILY so the picker shows one current entry per
// family and folds dated snapshots / superseded majors behind a "show older"
// toggle. Best-effort + provider-agnostic: drop a trailing dated snapshot, then
// trailing variant/tier-neutral suffixes, then the trailing version number.
//   claude-opus-4-8 · claude-opus-4-1-20250805      → "claude-opus"
//   gpt-5.5 · gpt-5.4                                → "gpt"
//   gemini-3.1-pro-preview · …-preview-customtools   → "gemini-3.1-pro"
const DATE_SUFFIX = /[-_](\d{8}|\d{4}-\d{2}-\d{2})$/
const VARIANT_SUFFIX =
  /[-_](preview|latest|stable|customtools|thinking|reasoning|non-reasoning|multi-agent|image-preview|image|hd|online)$/
function familyKey(id: string): string {
  let k = id.toLowerCase().replace(DATE_SUFFIX, "")
  let prev = ""
  while (prev !== k) {
    prev = k
    k = k.replace(VARIANT_SUFFIX, "")
  }
  // Drop every pure-version token (5.5 → 5,5 · 4 · 8 · 0309) so the surviving
  // tier words — opus / sonnet / pro / flash / nano / codex — form the family.
  // That folds gpt-5.4-nano under gpt-nano, claude-3-7-sonnet under claude-sonnet.
  const parts = k.split(/[-_.]/).filter((t) => t && !/^v?\d+$/.test(t))
  return parts.join("-") || id.toLowerCase()
}

// Models that can't serve as the agent/chat model — embeddings, TTS, image
// generation, transcription, moderation, rerankers. Kept out of the picker so it
// only offers things you can actually select. Deep-research + realtime chat
// models stay (they take text in).
const NON_CHAT_MODEL =
  /(^|[-_/])(embedding|embeddings|tts|whisper|transcribe|moderation|image|imagine|dall-?e|sora|veo|imagen|guard|rerank)([-_]|$)/
const isSelectableModel = (id: string) => !NON_CHAT_MODEL.test(id.toLowerCase())

// Compact $/1M rate from the transformed Provider.Model cost shape
// (cost.input/output, cost.experimentalOver200K.*). `over` swaps to the >200k tier.
interface ModelCostShape {
  input?: number
  output?: number
  experimentalOver200K?: { input?: number; output?: number }
}
function rateFor(cost: ModelCostShape | undefined, over: boolean) {
  const tier = over && cost?.experimentalOver200K ? cost.experimentalOver200K : cost
  const input = tier?.input ?? 0
  const output = tier?.output ?? 0
  const free = input === 0 && output === 0
  const fmt = (v: number) => (v >= 1 ? `$${v.toFixed(2).replace(/\.?0+$/, "")}` : `$${v.toPrecision(2)}`)
  return { free, input: fmt(input), output: fmt(output) }
}

// Skip the open/close animation when the OS asks for reduced motion.
const REDUCE_MOTION =
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches

// A model is a "codex" model when it's served by the Codex OAuth provider or
// its id carries the codex tag (gpt-5.x-codex). Surfaced as a badge so users
// can tell which models route through Codex.
const isCodexModel = (providerID: string, modelID: string) =>
  providerID === "openai-codex" || modelID.toLowerCase().includes("codex")

const providerLabel = (id: string) => PROVIDER_LABEL[id] ?? id

function formatTokens(value: number | undefined): string {
  if (!value) return "?"
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1))}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

// Agents the openscience CLI exposes to the user. `research` is the default harness;
// `biology`/`physics`/`ml` are the domain specialists; `plan` is read-only planning.
type AgentName = "research" | "biology" | "physics" | "ml" | "plan"

interface AgentOption {
  name: AgentName
  label: string
  hint: string
}

const AGENT_OPTIONS: AgentOption[] = [
  { name: "research", label: "research", hint: "default · literature + analysis" },
  { name: "biology", label: "biology", hint: "computational biology" },
  { name: "physics", label: "physics", hint: "simulation + theory" },
  { name: "ml", label: "ml", hint: "train + evaluate models" },
  { name: "plan", label: "plan", hint: "think first, no edits" },
]

interface Attachment {
  id: string
  filename: string
  mime: string
  size: number
  dataUrl: string
}

const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024 // 12MB

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(file)
  })
}

function safeFilename(name: string): string {
  // Keep the extension, slugify the stem so the path is shell-safe.
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extPart = dot > 0 ? name.slice(dot) : ""
  const slug = stem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return (slug || "file") + extPart
}

export function Composer(): JSX.Element {
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const models = useModels()
  const providers = useProviders()
  const globalSync = useGlobalSync()

  const [text, setText] = createSignal("")
  const [model, setModel] = createSignal<ModelKey | undefined>(undefined)
  // Agent selection is shared (welcome chips, persistence) via uiStore and
  // defaults to "research".
  const agent = () => uiStore.agent() as AgentName
  const setAgent = (name: AgentName) => uiStore.setAgent(name)
  const [modelOpen, setModelOpen] = createSignal(false)
  const [agentOpen, setAgentOpen] = createSignal(false)
  const [modelQuery, setModelQuery] = createSignal("")
  // Provider groups the user has expanded to reveal folded (older) models.
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set())
  const toggleGroup = (id: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  // Highlighted row index for keyboard nav inside the model search.
  const [modelIndex, setModelIndex] = createSignal(0)
  const [submitting, setSubmitting] = createSignal(false)

  // ── Prompt queue ─────────────────────────────────────────────────────────
  // The composer never locks while the agent is streaming. Sends that arrive
  // mid-turn are queued (with the agent/model/effort chosen at enqueue time)
  // and dispatched in order the moment the session goes idle. `inflight`
  // covers the whole server turn (session.prompt resolves when the turn
  // completes), which also bridges the SSE gap before session_status flips
  // to non-idle — without it two queued prompts could race out together.
  type QueuedPrompt = {
    id: string
    text: string
    attachments: Attachment[]
    agent: string
    model: ModelKey
    variant: string | undefined
    fast: boolean | undefined
  }
  const [queue, setQueue] = createSignal<QueuedPrompt[]>([])
  const [inflight, setInflight] = createSignal(false)
  createEffect(
    on(
      () => params.id,
      () => setQueue([]),
      { defer: true },
    ),
  )
  const [focused, setFocused] = createSignal(false)
  const [dragOver, setDragOver] = createSignal(false)
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  // Slash-command autocomplete (skills surfaced via `sync.data.skill`).
  // Popover opens whenever the input is exactly `/<query>` (single token,
  // no spaces). Arrow keys move selection; Enter inserts `/<name> `.
  const [slashIndex, setSlashIndex] = createSignal(0)
  const [skillsOpen, setSkillsOpen] = createSignal(false)
  const [caret, setCaret] = createSignal(0)
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let modelSearchRef: HTMLInputElement | undefined
  let modelBtnRef: HTMLButtonElement | undefined
  let modelRowRefs: HTMLElement[] = []

  // Pick a sensible default model the moment one becomes available:
  // last-used > visible Anthropic Sonnet > first visible model. Re-runs
  // until a real model lands so the picker isn't stuck on "no model".
  createEffect(() => {
    if (model()) return
    const recents = models.recent.list()
    if (recents.length > 0) {
      setModel({ providerID: recents[0].providerID, modelID: recents[0].modelID })
      return
    }
    const all = models.list().filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
    // Prefer the latest flagship: newest Anthropic Sonnet, then newest Opus,
    // then any "(latest)"-tagged model, then the first available.
    const byIdDesc = (a: { id: string }, b: { id: string }) => b.id.localeCompare(a.id)
    const anthropic = all.filter((m) => m.provider.id === "anthropic")
    const fallback =
      anthropic.filter((m) => m.id.startsWith("claude-sonnet")).sort(byIdDesc)[0] ??
      anthropic.filter((m) => m.id.startsWith("claude-opus")).sort(byIdDesc)[0] ??
      all.find((m) => m.latest) ??
      all[0]
    if (fallback) setModel({ providerID: fallback.provider.id, modelID: fallback.id })
  })

  // Welcome-launchpad chips + one-click actions push a starter prompt through
  // uiStore.prefill; adopt it into the composer, focus, and clear the channel. When
  // prefillSend is set (e.g. "initialize graph"), submit immediately instead of
  // waiting for the user to press enter.
  createEffect(() => {
    const pending = uiStore.prefill()
    if (!pending) return
    const send = uiStore.prefillSend()
    setText(pending)
    uiStore.setPrefill(undefined)
    uiStore.setPrefillSend(false)
    if (textareaRef) {
      textareaRef.focus()
      textareaRef.style.height = "auto"
      textareaRef.style.height = Math.min(280, textareaRef.scrollHeight) + "px"
    }
    if (send) void submit()
  })

  const selectedInfo = createMemo(() => {
    const m = model()
    if (!m) return undefined
    return models.find(m)
  })

  const selectedLabel = createMemo(() => {
    const m = model()
    const found = selectedInfo()
    return found && m ? { name: found.name, providerID: m.providerID } : undefined
  })

  const selectedSource = createMemo(() => {
    const m = model()
    if (!m) return undefined
    const connected = providers.connected().some((p) => p.id === m.providerID)
    const source = resolveModelSource({
      providerID: m.providerID,
      connected,
      authMethods: globalSync.data.provider_auth?.[m.providerID],
    })
    return SOURCE_DOT[source]
  })

  // Reasoning-effort variants for the selected model (low / medium / high /
  // max, or none / minimal / … for OpenAI). The backend maps the chosen
  // variant to provider options — see ProviderTransform.variants.
  const variantKeys = createMemo<string[]>(() => {
    const m = model()
    if (!m) return []
    const found = models.find(m) as { variants?: Record<string, { disabled?: boolean }> } | undefined
    const v = found?.variants
    if (!v) return []
    return Object.entries(v)
      .filter(([, val]) => !val?.disabled)
      .map(([k]) => k)
  })
  const effort = () => {
    const m = model()
    return m ? models.variant.get(m) : undefined
  }
  const setEffort = (value: string | undefined) => {
    const m = model()
    if (m) models.variant.set(m, value)
  }

  // Fast toggle — only gpt-5.5 has a real plumbable per-request "fast" param
  // (OpenAI service_tier: priority). Sent as `fast` on the prompt; the backend
  // guards it to gpt-5.5. Reset when the model changes (state is per-model).
  const supportsFast = createMemo(() => {
    const m = model()
    return !!m && isGpt55(m.modelID)
  })
  const [fast, setFast] = createSignal(false)
  createEffect(
    on(
      () => model()?.providerID + "/" + model()?.modelID,
      () => setFast(false),
      { defer: true },
    ),
  )

  // Context tier (Cursor "MAX mode" analogue). Only meaningful when the model
  // prices the >200k window differently. This is a price-preview + intent signal;
  // the long-context request flag is threaded through submit in a later pass.
  const [longCtx, setLongCtx] = createSignal(false)
  const selectedCost = createMemo(() => selectedInfo()?.cost as ModelCostShape | undefined)
  const hasLongTier = createMemo(() => !!selectedCost()?.experimentalOver200K)
  // Reset the tier toggle whenever the model changes — pricing is per-model.
  createEffect(
    on(
      () => model()?.providerID + "/" + model()?.modelID,
      () => setLongCtx(false),
      { defer: true },
    ),
  )

  // Per-row credential source, inferred from provider connection + auth methods
  // the web app already has (authoritative resolver is server-side).
  const rowSource = (providerID: string): ModelSource => {
    const connected = providers.connected().some((p) => p.id === providerID)
    return resolveModelSource({
      providerID,
      connected,
      authMethods: globalSync.data.provider_auth?.[providerID],
    })
  }

  // Visible models narrowed by the search query. Grouping + ordering happen in
  // modelGroups; this stays flat for the query pass.
  const filteredModels = createMemo(() => {
    const q = modelQuery().trim().toLowerCase()
    return models
      .list()
      .filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
      .filter((m) => isSelectableModel(m.id))
      .filter((m) => {
        if (!q) return true
        return (
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          providerLabel(m.provider.id).toLowerCase().includes(q)
        )
      })
  })

  // Group by provider. Mainstream + OpenRouter/Vercel lead (popularProviders);
  // every other host — Groq, Together, Mistral, DeepSeek, xAI, … — follows
  // alphabetically. No provider is force-promoted, so open-weight models sit
  // beside proprietary ones under their host.
  type ModelRow = ReturnType<typeof filteredModels>[number]
  const modelGroups = createMemo(() => {
    const byProvider = new Map<string, ModelRow[]>()
    for (const m of filteredModels()) {
      const arr = byProvider.get(m.provider.id)
      if (arr) arr.push(m)
      else byProvider.set(m.provider.id, [m])
    }
    const rank = (id: string) => {
      const i = popularProviders.indexOf(id)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    const searching = !!modelQuery().trim()
    const recentKeys = new Set(models.recent.list().map((r) => r.providerID + "/" + r.modelID))
    const sel = model()
    // Pinned models are never folded away: the newest-per-family head, plus the
    // selected model, recents, and anything the catalog tags "(latest)".
    const pinned = (m: ModelRow) =>
      m.latest ||
      recentKeys.has(m.provider.id + "/" + m.id) ||
      (!!sel && sel.providerID === m.provider.id && sel.modelID === m.id)
    const groups = [...byProvider.entries()]
      .map(([id, all]) => {
        const sorted = all.slice().sort((a, b) => {
          if (a.latest !== b.latest) return a.latest ? -1 : 1
          const date = (b.release_date ?? "").localeCompare(a.release_date ?? "")
          if (date !== 0) return date
          return a.name.localeCompare(b.name)
        })
        // While searching, show every match — never hide a result behind a fold.
        if (searching) return { id, name: providerLabel(id), items: sorted, folded: 0, open: false }
        const seen = new Set<string>()
        const primary: ModelRow[] = []
        const secondary: ModelRow[] = []
        for (const m of sorted) {
          const fam = familyKey(m.id)
          if (!seen.has(fam)) {
            seen.add(fam) // first (newest) model of this family always shows
            primary.push(m)
          } else if (pinned(m)) {
            primary.push(m)
          } else {
            secondary.push(m)
          }
        }
        const open = expandedGroups().has(id)
        return {
          id,
          name: providerLabel(id),
          items: open ? [...primary, ...secondary] : primary,
          folded: secondary.length,
          open,
        }
      })
      .sort((a, b) => {
        const r = rank(a.id) - rank(b.id)
        return r !== 0 ? r : a.name.localeCompare(b.name)
      })
    let offset = 0
    return groups.map((g) => {
      const start = offset
      offset += g.items.length
      return { ...g, offset: start }
    })
  })
  const flatRows = createMemo(() => modelGroups().flatMap((g) => g.items))

  // ── model-search keyboard nav ────────────────────────────────────────
  const selectRowAt = (i: number, close = false) => {
    const row = flatRows()[i]
    if (!row) return
    setModel({ providerID: row.provider.id, modelID: row.id })
    setModelIndex(i)
    if (close) setModelOpen(false)
  }
  const onModelSearchKey = (e: KeyboardEvent) => {
    const len = flatRows().length
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setModelIndex((i) => (len ? (i + 1) % len : 0))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setModelIndex((i) => (len ? (i - 1 + len) % len : 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      selectRowAt(modelIndex(), true)
    } else if (e.key === "Escape") {
      e.preventDefault()
      setModelOpen(false)
    }
  }

  // On open: focus the search box and start the highlight on the current model
  // so keyboard nav (and the auto-scroll below) resume where the user left off.
  createEffect(
    on(modelOpen, (open) => {
      if (!open) return
      const flat = untrack(flatRows)
      const sel = untrack(model)
      const idx = sel ? flat.findIndex((r) => r.provider.id === sel.providerID && r.id === sel.modelID) : -1
      const start = idx >= 0 ? idx : 0
      setModelIndex(start)
      queueMicrotask(() => {
        modelSearchRef?.focus()
        modelRowRefs[start]?.scrollIntoView({ block: "nearest" })
      })
    }),
  )
  // Keep the highlight in range and scrolled into view as the list narrows.
  createEffect(() => {
    const len = flatRows().length
    if (modelIndex() >= len) {
      setModelIndex(0)
      return
    }
    modelRowRefs[modelIndex()]?.scrollIntoView({ block: "nearest" })
  })

  // ── picker anchoring ─────────────────────────────────────────────────
  // Measure the trigger and place a fixed panel that left-aligns to the button,
  // clamps to the viewport, and flips below only when there's no room above.
  // Portalled to <body>, so no ancestor transform/overflow can clip it.
  const [anchor, setAnchor] = createSignal<{
    left: number
    top?: number
    bottom?: number
    width: number
    maxH: number
    up: boolean
  }>()
  const measurePicker = () => {
    const el = modelBtnRef
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 8
    const margin = 12
    const width = Math.min(384, vw - margin * 2)
    const left = Math.max(margin, Math.min(r.left, vw - width - margin))
    const above = r.top - margin
    const below = vh - r.bottom - margin
    const up = above >= 280 || above >= below
    setAnchor(
      up
        ? { left, bottom: vh - r.top + gap, width, maxH: Math.min(440, above), up: true }
        : { left, top: r.bottom + gap, width, maxH: Math.min(440, below), up: false },
    )
  }
  createEffect(
    on(modelOpen, (open) => {
      if (!open) return
      measurePicker()
      const remeasure = () => measurePicker()
      window.addEventListener("resize", remeasure)
      window.addEventListener("scroll", remeasure, true)
      onCleanup(() => {
        window.removeEventListener("resize", remeasure)
        window.removeEventListener("scroll", remeasure, true)
      })
    }),
  )

  const sessionPending = () => {
    const id = params.id
    if (!id || id === "new") return null
    return id
  }

  // The session is "working" (streaming) when openscience reports a non-idle
  // status for it. We use this to flip the send button into a stop
  // button.
  const sessionStatus = createMemo(() => {
    const id = sessionPending()
    if (!id) return undefined
    return (sync.data.session_status?.[id] as { type?: string } | undefined)?.type
  })
  const isWorking = () => {
    const s = sessionStatus()
    return s !== undefined && s !== "idle"
  }

  const stop = async () => {
    const sid = sessionPending()
    if (!sid) return
    try {
      await sdk.client.session.abort({ sessionID: sid } as any)
      toast.info("aborted", "stopped streaming for this session")
    } catch (e: any) {
      console.error("session.abort failed", e)
      toast.error("could not stop", e?.message ?? String(e))
    }
  }

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) return
    const next: Attachment[] = []
    for (const file of list) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`${file.name} too large`, "max 12MB per attachment")
        continue
      }
      try {
        const dataUrl = await readAsDataURL(file)
        next.push({
          id: crypto.randomUUID(),
          filename: file.name,
          mime: file.type || "application/octet-stream",
          size: file.size,
          dataUrl,
        })
      } catch (err: any) {
        toast.error(`could not read ${file.name}`, err?.message ?? String(err))
      }
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next])
  }

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id))

  const onPaste = (e: ClipboardEvent) => {
    const data = e.clipboardData
    if (!data) return
    const files = Array.from(data.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (files && files.length > 0) void addFiles(files)
  }

  const grow = (v: string) => {
    setText(v)
    setSlashIndex(0)
    if (textareaRef) {
      textareaRef.style.height = "auto"
      textareaRef.style.height = Math.min(280, textareaRef.scrollHeight) + "px"
    }
  }

  // A `/token` at the caret (line start or after whitespace) opens the skill
  // popover with that query — works mid-prompt, not just at the start.
  const slashQuery = createMemo(() => {
    const t = text()
    const c = Math.min(caret(), t.length)
    const before = t.slice(0, c)
    const m = before.match(/(?:^|\s)\/([A-Za-z0-9._-]*)$/)
    return m ? m[1] : null
  })
  const slashOpen = () => slashQuery() !== null && focused()

  type SkillRow = { name: string; description: string; location: string; entry?: boolean; tags?: string[] }
  const slashItems = createMemo<SkillRow[]>(() => {
    const q = (slashQuery() ?? "").toLowerCase()
    const all = ((sync.data.skill ?? []) as SkillRow[]).filter((s) => s.entry !== false)
    if (!q) {
      return all
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 12)
    }
    // Single-char queries match the name only (descriptions contain every
    // common letter); 2+ chars also search description + tags.
    const deep = q.length >= 2
    const matches = all
      .filter((s) => {
        if (s.name.toLowerCase().includes(q)) return true
        if (!deep) return false
        if ((s.description ?? "").toLowerCase().includes(q)) return true
        return (s.tags ?? []).some((t) => t.toLowerCase().includes(q))
      })
      .sort((a, b) => {
        const an = a.name.toLowerCase()
        const bn = b.name.toLowerCase()
        // Name matches rank above description/tag-only matches; within each,
        // prefix matches first.
        const aName = an.includes(q) ? 0 : 1
        const bName = bn.includes(q) ? 0 : 1
        if (aName !== bName) return aName - bName
        const ap = an.startsWith(q) ? 0 : 1
        const bp = bn.startsWith(q) ? 0 : 1
        if (ap !== bp) return ap - bp
        return an.localeCompare(bn)
      })
    return matches.slice(0, 12)
  })

  const pickSlash = (s: SkillRow | undefined) => {
    if (!s) return
    const t = text()
    const c = Math.min(caret(), t.length)
    const q = slashQuery() ?? ""
    // The token is `/` + q ending exactly at the caret; replace just that span
    // and keep everything after it intact (insert-at-cursor, no clobber).
    const tokenStart = c - (q.length + 1)
    const start = tokenStart >= 0 ? tokenStart : 0
    const insert = `/${s.name} `
    const next = t.slice(0, start) + insert + t.slice(c)
    const nextCaret = start + insert.length
    setText(next)
    setCaret(nextCaret)
    setSlashIndex(0)
    if (textareaRef) {
      textareaRef.focus()
      textareaRef.setSelectionRange(nextCaret, nextCaret)
      textareaRef.style.height = "auto"
      textareaRef.style.height = Math.min(280, textareaRef.scrollHeight) + "px"
    }
  }

  const submit = async () => {
    const trimmed = text().trim()
    const atts = attachments()
    if ((!trimmed && atts.length === 0) || submitting()) return
    const chosen = model()
    if (!chosen) {
      toast.error("no model selected", `Connect a provider key at ${BYOK_URL} to enable a model.`)
      return
    }
    const payload: QueuedPrompt = {
      id: Identifier.ascending("message"),
      text: trimmed,
      attachments: atts,
      agent: agent(),
      model: chosen,
      variant: models.variant.get(chosen),
      fast: isGpt55(chosen.modelID) ? fast() : undefined,
    }
    // Clear the input immediately in both paths so typing can continue.
    setText("")
    setAttachments([])
    if (textareaRef) textareaRef.style.height = "auto"

    // Mid-turn sends queue; the drain effect below fires them when idle.
    if (isWorking() || inflight()) {
      setQueue((q) => [...q, payload])
      return
    }
    await dispatch(payload)
  }

  const dispatch = async (p: QueuedPrompt) => {
    if (submitting()) {
      setQueue((q) => [p, ...q])
      return
    }
    setSubmitting(true)
    try {
      let sessionID = sessionPending()
      if (!sessionID) {
        const res: any = await sdk.client.session.create({
          directory: sync.project?.worktree ?? sync.data.path.directory,
        } as any)
        const data = res?.data ?? res
        sessionID = data?.id ?? data?.sessionID
        if (!sessionID) {
          toast.error("could not start session", "session.create returned no id")
          return
        }
        navigate(`/${params.dir}/session/${sessionID}`, { replace: true })
      }

      const messageID = Identifier.ascending("message")

      const filePartsBase = p.attachments.map((a) => ({
        id: Identifier.ascending("part"),
        type: "file" as const,
        mime: a.mime,
        url: a.dataUrl,
        filename: safeFilename(a.filename),
      }))

      // When the user attached anything, append a synthetic instruction
      // so the agent persists each attachment to .context/<filename>.
      // The agent's `write` tool handles binary via base64 from the
      // data URL we sent.
      const userText = p.text || (p.attachments.length > 0 ? "(see attachments)" : "")
      const guidance =
        p.attachments.length > 0
          ? `\n\n---\nAttachments: ${p.attachments
              .map((a) => safeFilename(a.filename))
              .join(
                ", ",
              )}.\nIf they aren't already there, save each attachment to \`.context/\` at the project root (create the directory if missing). For text-like files use the write tool; for binaries decode the data URL with bash. Treat \`.context/\` as the durable scratchpad for files dropped into chat.`
          : ""

      const textPartID = Identifier.ascending("part")
      const promptParts = [{ id: textPartID, type: "text" as const, text: userText + guidance }, ...filePartsBase]

      // Optimistically render the user message — text + attachment chips
      // live in the chat the moment Enter is pressed.
      sync.session.addOptimisticMessage({
        sessionID,
        messageID,
        agent: p.agent,
        model: p.model,
        parts: promptParts.map((part) => ({ ...part, sessionID, messageID }) as any),
      })

      // Fire-and-forget: session.prompt resolves only when the whole turn
      // completes, so awaiting it here is what used to freeze the composer
      // for the entire generation. `inflight` tracks the turn instead.
      setInflight(true)
      sdk.client.session
        .prompt({
          sessionID,
          messageID,
          directory: sync.project?.worktree ?? sync.data.path.directory,
          model: p.model,
          agent: p.agent,
          variant: p.variant,
          fast: p.fast,
          parts: promptParts,
        } as any)
        .catch((e: any) => {
          console.error("session.prompt failed", e)
          toast.error("send failed", e?.message ?? String(e))
        })
        .finally(() => setInflight(false))

      models.recent.push(p.model)
    } catch (e: any) {
      console.error("session.prompt failed", e)
      toast.error("send failed", e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  // Drain the queue: whenever the session is idle and nothing is in flight,
  // send the next queued prompt.
  createEffect(() => {
    if (isWorking() || inflight() || submitting()) return
    const next = queue()[0]
    if (!next) return
    setQueue((q) => q.slice(1))
    void dispatch(next)
  })

  const onKey = (e: KeyboardEvent) => {
    if (slashOpen() && slashItems().length > 0) {
      const len = slashItems().length
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % len)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + len) % len)
        return
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        pickSlash(slashItems()[slashIndex()])
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setText("")
        return
      }
      if (e.key === "Tab") {
        e.preventDefault()
        pickSlash(slashItems()[slashIndex()])
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div
      style={{
        padding: "12px 18px 16px",
        "border-top": "1px solid var(--color-border)",
        background: "var(--color-bg)",
        "flex-shrink": 0,
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const fl = e.currentTarget.files
          if (fl && fl.length > 0) void addFiles(fl)
          if (fileInputRef) fileInputRef.value = ""
        }}
      />
      <div
        class="g-composer"
        onDragOver={(e) => {
          e.preventDefault()
          if (!dragOver()) setDragOver(true)
        }}
        onDragLeave={(e) => {
          // Only clear when leaving the composer itself, not its children.
          if (e.currentTarget === e.target) setDragOver(false)
        }}
        onDrop={onDrop}
        style={{
          display: "flex",
          "flex-direction": "column",
          padding: "12px 14px",
          gap: "8px",
          "border-color": dragOver()
            ? "var(--color-accent)"
            : focused()
              ? "var(--color-border-strong)"
              : "var(--color-border)",
          "box-shadow":
            dragOver() || focused() ? "0 0 0 3px var(--color-accent-subtle), var(--shadow-xs)" : "var(--shadow-xs)",
          background: dragOver() ? "var(--color-accent-subtle)" : "var(--color-surface-solid)",
          "border-radius": "4px",
          transition: "background 120ms ease, box-shadow 120ms ease, border-color 120ms ease",
        }}
      >
        <Show when={queue().length > 0}>
          <div
            style={{
              display: "flex",
              "flex-wrap": "wrap",
              "align-items": "center",
              gap: "6px",
              "margin-bottom": "2px",
            }}
          >
            <span
              style={{
                "font-family": FONT_MONO,
                "font-size": "10px",
                color: "var(--color-text-faint)",
                "letter-spacing": "0.05em",
                "text-transform": "lowercase",
              }}
            >
              queued · {queue().length}
            </span>
            <For each={queue()}>
              {(q) => (
                <span
                  style={{
                    display: "inline-flex",
                    "align-items": "center",
                    gap: "6px",
                    border: "1px solid var(--color-border)",
                    "border-radius": "4px",
                    padding: "3px 8px",
                    "font-family": FONT_SANS,
                    "font-size": "12px",
                    color: "var(--color-text-secondary, var(--color-text))",
                    background: "var(--color-bg-elevated)",
                    "max-width": "340px",
                  }}
                >
                  <span
                    title="click to edit — moves back into the input"
                    style={{
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      if (text().trim().length > 0) {
                        toast.info("input not empty", "clear the input to pull a queued message back")
                        return
                      }
                      setQueue((qs) => qs.filter((x) => x.id !== q.id))
                      setAttachments(q.attachments)
                      grow(q.text)
                    }}
                  >
                    {q.text || "(attachments)"}
                  </span>
                  <button
                    type="button"
                    aria-label="remove from queue"
                    onClick={() => setQueue((qs) => qs.filter((x) => x.id !== q.id))}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      display: "inline-flex",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    <IconX size={11} strokeWidth={1.5} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={attachments().length > 0}>
          <div
            style={{
              display: "flex",
              "flex-wrap": "wrap",
              gap: "6px",
            }}
          >
            <For each={attachments()}>{(a) => <AttachmentChip att={a} onRemove={() => removeAttachment(a.id)} />}</For>
          </div>
        </Show>
        <div style={{ position: "relative", width: "100%" }}>
          <textarea
            ref={textareaRef}
            value={text()}
            onInput={(e) => {
              grow(e.currentTarget.value)
              setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKey}
            onFocus={() => setFocused(true)}
            // Delay blur so popover clicks register before the popover unmounts.
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            onPaste={onPaste}
            placeholder={
              agent() === "plan"
                ? "describe the plan to think through…"
                : agent().startsWith("research")
                  ? "ask a research question · / for skills"
                  : "ask the agent · drop or paste a file · / for skills"
            }
            style={{
              all: "unset",
              "font-family": FONT_SANS,
              "font-size": "13px",
              "line-height": 1.55,
              color: "var(--color-text)",
              "min-height": "20px",
              "max-height": "280px",
              "overflow-y": "auto",
              resize: "none",
              width: "100%",
              display: "block",
            }}
          />
          <Show when={skillsOpen()}>
            <SkillsBrowser
              onPick={(name) => {
                pickSlash({ name, description: "", location: "" })
                setSkillsOpen(false)
              }}
              onClose={() => setSkillsOpen(false)}
            />
          </Show>
          <Show when={slashOpen()}>
            <div
              class="thesis-fade-in thesis-scroll"
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                right: 0,
                "margin-bottom": "6px",
                "max-height": "280px",
                "overflow-y": "auto",
                background: "var(--color-surface-solid)",
                border: "1px solid var(--color-border)",
                "border-radius": "4px",
                "box-shadow": "var(--shadow-md)",
                padding: "4px",
                "z-index": 30,
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <div
                style={{
                  padding: "6px 8px 4px",
                  "font-family": FONT_MONO,
                  "font-size": "10px",
                  color: "var(--color-text-faint)",
                  "letter-spacing": "0.08em",
                  "text-transform": "uppercase",
                }}
              >
                skills
              </div>
              <Show
                when={slashItems().length > 0}
                fallback={
                  <div
                    style={{
                      padding: "8px 10px",
                      "font-family": FONT_MONO,
                      "font-size": "11px",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    no matching skills
                  </div>
                }
              >
                <For each={slashItems()}>
                  {(s, i) => (
                    <div
                      onMouseEnter={() => setSlashIndex(i())}
                      onClick={() => pickSlash(s)}
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "8px",
                        padding: "6px 8px",
                        "border-radius": "4px",
                        cursor: "pointer",
                        background: slashIndex() === i() ? "var(--color-accent-subtle)" : "transparent",
                        "font-family": FONT_MONO,
                        "font-size": "11px",
                        color: "var(--color-text)",
                      }}
                    >
                      <span style={{ "flex-shrink": 0 }}>/{s.name}</span>
                      <Show when={s.description}>
                        <span
                          style={{
                            flex: 1,
                            "min-width": 0,
                            "font-size": "11px",
                            color: "var(--color-text-faint)",
                            "white-space": "nowrap",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                          }}
                        >
                          {s.description}
                        </span>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </div>

        <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
          {/* Model picker — every connected provider's models. BYOK keys are
              added in Settings; whatever the backend reports as connected
              shows up here. */}
          <div style={{ position: "relative" }}>
            <button
              ref={modelBtnRef}
              onClick={() => setModelOpen((v) => !v)}
              type="button"
              title={
                selectedLabel()
                  ? `${providerLabel(selectedLabel()!.providerID)} · ${selectedLabel()!.name}${
                      selectedSource() ? ` — ${selectedSource()!.title}` : ""
                    }`
                  : "pick a model"
              }
              style={{
                all: "unset",
                "box-sizing": "border-box",
                cursor: "pointer",
                display: "inline-flex",
                "align-items": "center",
                height: "28px",
                padding: "0 8px",
                "border-radius": "4px",
                border: "1px solid var(--color-border)",
                background: modelOpen() ? "var(--color-bg-elevated)" : "var(--color-surface-solid)",
                "font-family": FONT_MONO,
                "font-size": "12px",
                color: "var(--color-text)",
                "max-width": "260px",
                transition: "background 120ms ease, border-color 120ms ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-border-strong)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
            >
              <Show
                when={selectedLabel()}
                fallback={<span style={{ color: "var(--color-text-faint)" }}>connect a model</span>}
              >
                <Show when={selectedSource()}>
                  {(dot) => (
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        "border-radius": "50%",
                        "margin-right": "6px",
                        "flex-shrink": 0,
                        background: dot().color,
                        opacity: dot().opacity,
                      }}
                    />
                  )}
                </Show>
                <span
                  style={{
                    "text-transform": "lowercase",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}
                >
                  {selectedLabel()!.name}
                </span>
              </Show>
              <IconChevronDown
                size={9}
                strokeWidth={1.5}
                style={{ "margin-left": "5px", "flex-shrink": 0, opacity: 0.7 }}
              />
            </button>
            <Show when={modelOpen()}>
              <Portal>
                <div onClick={() => setModelOpen(false)} style={{ position: "fixed", inset: 0, "z-index": 190 }} />
                <Show when={anchor()}>
                  {(a) => (
                    <div
                      class={REDUCE_MOTION ? undefined : a().up ? "thesis-pop-up" : "thesis-fade-in"}
                      role="dialog"
                      aria-label="Select model"
                      style={{
                        position: "fixed",
                        left: `${a().left}px`,
                        ...(a().up ? { bottom: `${a().bottom}px` } : { top: `${a().top}px` }),
                        width: `${a().width}px`,
                        "max-height": `${a().maxH}px`,
                        display: "flex",
                        "flex-direction": "column",
                        background: "var(--color-surface-solid)",
                        border: "1px solid var(--color-border-strong)",
                        "border-radius": "4px",
                        "box-shadow": "0 16px 44px rgba(0, 0, 0, 0.18), 0 3px 10px rgba(0, 0, 0, 0.10)",
                        overflow: "hidden",
                        "z-index": 200,
                        "transform-origin": a().up ? "bottom left" : "top left",
                      }}
                    >
                      {/* search */}
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "9px",
                          padding: "10px 12px",
                          "border-bottom": "1px solid var(--color-border)",
                          "flex-shrink": 0,
                        }}
                      >
                        <span style={{ display: "inline-flex", color: "var(--color-text-faint)", "flex-shrink": 0 }}>
                          <IconSearch size={13} strokeWidth={1.5} />
                        </span>
                        <input
                          ref={modelSearchRef}
                          value={modelQuery()}
                          onInput={(e) => {
                            setModelQuery(e.currentTarget.value)
                            setModelIndex(0)
                          }}
                          onKeyDown={onModelSearchKey}
                          placeholder="search models"
                          spellcheck={false}
                          autocomplete="off"
                          style={{
                            all: "unset",
                            flex: 1,
                            "min-width": 0,
                            "font-family": FONT_SANS,
                            "font-size": "13px",
                            color: "var(--color-text)",
                          }}
                        />
                        <kbd
                          style={{
                            "font-family": FONT_MONO,
                            "font-size": "10px",
                            color: "var(--color-text-faint)",
                            border: "1px solid var(--color-border)",
                            "border-radius": "4px",
                            padding: "1px 5px",
                            "flex-shrink": 0,
                          }}
                        >
                          esc
                        </kbd>
                      </div>

                      {/* list */}
                      <div
                        class="thesis-scroll"
                        role="listbox"
                        aria-label="Models"
                        style={{ overflow: "auto", padding: "4px", "min-height": 0, flex: 1 }}
                      >
                        <Show
                          when={flatRows().length > 0}
                          fallback={
                            <div
                              style={{
                                padding: "22px 14px",
                                "font-family": FONT_SANS,
                                "font-size": "13px",
                                color: "var(--color-text-faint)",
                                "line-height": 1.5,
                              }}
                            >
                              no models match “{modelQuery()}”.
                              <br />
                              add a provider key in settings, then refresh.
                            </div>
                          }
                        >
                          <For each={modelGroups()}>
                            {(group) => (
                              <div style={{ "margin-bottom": "2px" }}>
                                <div
                                  style={{
                                    position: "sticky",
                                    top: 0,
                                    "z-index": 1,
                                    display: "flex",
                                    "align-items": "baseline",
                                    "justify-content": "space-between",
                                    gap: "8px",
                                    padding: "9px 10px 4px",
                                    background: "var(--color-surface-solid)",
                                    "font-family": FONT_MONO,
                                    "font-size": "10px",
                                    "font-weight": 500,
                                    "letter-spacing": "0.02em",
                                    "text-transform": "lowercase",
                                    color: "var(--color-text-faint)",
                                  }}
                                >
                                  <span
                                    style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}
                                  >
                                    {group.name}
                                  </span>
                                  <span style={{ opacity: 0.6 }}>{group.items.length}</span>
                                </div>
                                <For each={group.items}>
                                  {(row, i) => {
                                    const flatIndex = () => group.offset + i()
                                    const active = () =>
                                      model()?.providerID === row.provider.id && model()?.modelID === row.id
                                    const highlighted = () => modelIndex() === flatIndex()
                                    const dot = SOURCE_DOT[rowSource(row.provider.id)]
                                    const price = () => rateFor(row.cost as ModelCostShape, active() && longCtx())
                                    return (
                                      <div
                                        ref={(el) => (modelRowRefs[flatIndex()] = el)}
                                        role="option"
                                        aria-selected={active()}
                                        title={`${providerLabel(row.provider.id)} · ${row.id} · ${formatTokens(row.limit?.context)} ctx`}
                                        onClick={() => selectRowAt(flatIndex())}
                                        onMouseEnter={() => setModelIndex(flatIndex())}
                                        style={{
                                          cursor: "pointer",
                                          display: "flex",
                                          "align-items": "center",
                                          gap: "10px",
                                          width: "100%",
                                          "box-sizing": "border-box",
                                          padding: "7px 10px",
                                          "border-radius": "4px",
                                          background: active()
                                            ? "var(--color-accent-subtle)"
                                            : highlighted()
                                              ? "var(--color-bg-elevated)"
                                              : "transparent",
                                          transition: REDUCE_MOTION ? undefined : "background 120ms ease",
                                        }}
                                      >
                                        <span
                                          style={{
                                            flex: 1,
                                            "min-width": 0,
                                            display: "flex",
                                            "flex-direction": "column",
                                            gap: "4px",
                                          }}
                                        >
                                          <span
                                            style={{
                                              display: "flex",
                                              "align-items": "center",
                                              gap: "7px",
                                              "min-width": 0,
                                            }}
                                          >
                                            <Show when={dot.meters}>
                                              <span
                                                title={dot.title}
                                                style={{
                                                  width: "5px",
                                                  height: "5px",
                                                  "border-radius": "50%",
                                                  "flex-shrink": 0,
                                                  background: dot.color,
                                                  opacity: dot.opacity,
                                                }}
                                              />
                                            </Show>
                                            <span
                                              style={{
                                                "font-family": FONT_SANS,
                                                "font-size": "13px",
                                                "font-weight": 400,
                                                color: "var(--color-text)",
                                                overflow: "hidden",
                                                "text-overflow": "ellipsis",
                                                "white-space": "nowrap",
                                              }}
                                            >
                                              {row.name}
                                            </span>
                                            <Show when={row.latest}>
                                              <span
                                                style={{
                                                  "flex-shrink": 0,
                                                  "font-family": FONT_MONO,
                                                  "font-size": "10px",
                                                  color: "var(--color-text-faint)",
                                                }}
                                              >
                                                latest
                                              </span>
                                            </Show>
                                            <Show when={isCodexModel(row.provider.id, row.id)}>
                                              <span
                                                style={{
                                                  "flex-shrink": 0,
                                                  "font-family": FONT_MONO,
                                                  "font-size": "10px",
                                                  color: "var(--color-text-faint)",
                                                  opacity: 0.85,
                                                }}
                                              >
                                                codex
                                              </span>
                                            </Show>
                                          </span>
                                        </span>
                                        <span
                                          style={{
                                            "flex-shrink": 0,
                                            display: "flex",
                                            "align-items": "center",
                                            gap: "10px",
                                          }}
                                        >
                                          <Show
                                            when={!price().free}
                                            fallback={
                                              <span
                                                style={{
                                                  "font-family": FONT_MONO,
                                                  "font-size": "11px",
                                                  color: "var(--color-text-faint)",
                                                }}
                                              >
                                                free
                                              </span>
                                            }
                                          >
                                            <span
                                              title="$ per 1M tokens · input / output"
                                              style={{
                                                "font-family": FONT_MONO,
                                                "font-size": "11px",
                                                "font-variant-numeric": "tabular-nums",
                                                color: "var(--color-text-faint)",
                                                "white-space": "nowrap",
                                              }}
                                            >
                                              {price().input} <span style={{ opacity: 0.4 }}>/</span> {price().output}
                                            </span>
                                          </Show>
                                          <span
                                            style={{
                                              width: "12px",
                                              display: "inline-flex",
                                              "justify-content": "center",
                                              color: "var(--color-accent)",
                                              "flex-shrink": 0,
                                            }}
                                          >
                                            <Show when={active()}>✓</Show>
                                          </span>
                                        </span>
                                      </div>
                                    )
                                  }}
                                </For>
                                <Show when={group.folded > 0}>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      toggleGroup(group.id)
                                    }}
                                    style={{
                                      all: "unset",
                                      "box-sizing": "border-box",
                                      cursor: "pointer",
                                      display: "flex",
                                      "align-items": "center",
                                      gap: "6px",
                                      width: "100%",
                                      padding: "5px 10px 7px",
                                      "font-family": FONT_MONO,
                                      "font-size": "10px",
                                      "letter-spacing": "0.02em",
                                      "text-transform": "lowercase",
                                      color: "var(--color-text-faint)",
                                    }}
                                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--color-text-muted)")}
                                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--color-text-faint)")}
                                  >
                                    {group.open ? "show fewer" : `${group.folded} older`}
                                    <span style={{ opacity: 0.7 }}>{group.open ? "▴" : "▾"}</span>
                                  </button>
                                </Show>
                              </div>
                            )}
                          </For>
                        </Show>
                      </div>

                      {/* controls for the selected model — one home for effort /
                          speed / context, so every list row stays uniform */}
                      <Show when={!!model() && (variantKeys().length > 0 || supportsFast() || hasLongTier())}>
                        <div
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            display: "flex",
                            "flex-wrap": "wrap",
                            "align-items": "center",
                            gap: "16px",
                            padding: "9px 12px",
                            "border-top": "1px solid var(--color-border)",
                            "flex-shrink": 0,
                          }}
                        >
                          <Show when={variantKeys().length > 0}>
                            <span style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
                              <span style={CONTROL_LABEL}>effort</span>
                              <Segmented
                                options={variantKeys().map((k) => ({ id: k, label: k }))}
                                value={effort() ?? ""}
                                onPick={(id) => setEffort(id)}
                              />
                            </span>
                          </Show>
                          <Show when={supportsFast()}>
                            <span style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
                              <span style={CONTROL_LABEL}>speed</span>
                              <Segmented
                                options={[
                                  { id: "normal", label: "normal" },
                                  { id: "fast", label: "fast" },
                                ]}
                                value={fast() ? "fast" : "normal"}
                                onPick={(id) => setFast(id === "fast")}
                              />
                            </span>
                          </Show>
                          <Show when={hasLongTier()}>
                            <span style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
                              <span style={CONTROL_LABEL}>context</span>
                              <Segmented
                                options={[
                                  { id: "std", label: "≤200k" },
                                  { id: "long", label: ">200k" },
                                ]}
                                value={longCtx() ? "long" : "std"}
                                onPick={(id) => setLongCtx(id === "long")}
                              />
                            </span>
                          </Show>
                        </div>
                      </Show>

                      {/* footer */}
                      <a
                        href={BYOK_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "space-between",
                          padding: "9px 12px",
                          "border-top": "1px solid var(--color-border)",
                          "font-family": FONT_MONO,
                          "font-size": "11px",
                          color: "var(--color-text-muted)",
                          "text-decoration": "none",
                          "flex-shrink": 0,
                        }}
                      >
                        <span>manage models</span>
                        <span style={{ color: "var(--color-text-faint)" }}>↗</span>
                      </a>
                    </div>
                  )}
                </Show>
              </Portal>
            </Show>
          </div>

          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setAgentOpen((v) => !v)}
              title="choose agent mode"
              style={{
                all: "unset",
                "box-sizing": "border-box",
                cursor: "pointer",
                display: "inline-flex",
                "align-items": "center",
                gap: "5px",
                height: "28px",
                padding: "0 8px",
                "border-radius": "4px",
                border: "1px solid var(--color-border)",
                background: agentOpen() ? "var(--color-bg-elevated)" : "var(--color-surface-solid)",
                "font-family": FONT_MONO,
                "font-size": "12px",
                color: "var(--color-text)",
                transition: "background 120ms ease, border-color 120ms ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-border-strong)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
            >
              <span>{agent()}</span>
              <IconChevronDown size={9} strokeWidth={1.5} style={{ opacity: 0.7 }} />
            </button>
            <Show when={agentOpen()}>
              <div onClick={() => setAgentOpen(false)} style={{ position: "fixed", inset: 0, "z-index": 20 }} />
              <div
                class="thesis-pop-up thesis-scroll"
                style={{
                  position: "absolute",
                  bottom: "100%",
                  left: 0,
                  "margin-bottom": "4px",
                  "min-width": "260px",
                  "max-height": "320px",
                  "overflow-y": "auto",
                  background: "var(--color-surface-solid)",
                  border: "1px solid var(--color-border)",
                  "border-radius": "4px",
                  "box-shadow": "var(--shadow-md)",
                  padding: "4px",
                  "z-index": 30,
                }}
              >
                <For each={AGENT_OPTIONS}>
                  {(opt) => (
                    <button
                      type="button"
                      onClick={() => {
                        setAgent(opt.name)
                        setAgentOpen(false)
                      }}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        display: "flex",
                        "flex-direction": "column",
                        gap: "1px",
                        width: "100%",
                        "box-sizing": "border-box",
                        padding: "6px 10px",
                        "border-radius": "4px",
                        background: agent() === opt.name ? "var(--color-accent-subtle)" : "transparent",
                      }}
                      onMouseEnter={(e) => {
                        if (agent() !== opt.name) e.currentTarget.style.background = "var(--color-bg-elevated)"
                      }}
                      onMouseLeave={(e) => {
                        if (agent() !== opt.name) e.currentTarget.style.background = "transparent"
                      }}
                    >
                      <span
                        style={{
                          "font-family": FONT_MONO,
                          "font-size": "12px",
                          color: "var(--color-text)",
                          "font-weight": 400,
                        }}
                      >
                        {opt.label}
                      </span>
                      <span
                        style={{
                          "font-family": FONT_SANS,
                          "font-size": "12px",
                          color: "var(--color-text-faint)",
                        }}
                      >
                        {opt.hint}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <button
            type="button"
            title="attach file (or drop / paste)"
            onClick={() => fileInputRef?.click()}
            style={{
              all: "unset",
              "box-sizing": "border-box",
              cursor: "pointer",
              height: "28px",
              padding: "0 7px",
              color: attachments().length > 0 ? "var(--color-text)" : "var(--color-text-faint)",
              display: "inline-flex",
              "align-items": "center",
              gap: "4px",
              "border-radius": "4px",
              "font-family": FONT_MONO,
              "font-size": "12px",
            }}
          >
            <IconPaperclip size={13} strokeWidth={1.5} />
            <Show when={attachments().length > 0}>
              <span>{attachments().length}</span>
            </Show>
          </button>

          <button
            type="button"
            title="browse skills (or type / in the prompt)"
            onClick={() => setSkillsOpen((v) => !v)}
            style={{
              all: "unset",
              "box-sizing": "border-box",
              cursor: "pointer",
              height: "28px",
              padding: "0 7px",
              color: skillsOpen() ? "var(--color-text)" : "var(--color-text-faint)",
              display: "inline-flex",
              "align-items": "center",
              "border-radius": "4px",
              background: skillsOpen() ? "var(--color-accent-subtle)" : "transparent",
            }}
          >
            <IconSparkles size={13} strokeWidth={1.5} />
          </button>

          <span style={{ flex: 1 }} />

          <Show when={isWorking() || inflight()}>
            <span
              style={{
                "font-family": FONT_MONO,
                "font-size": "11px",
                color: "var(--color-text-faint)",
                display: "inline-flex",
                "align-items": "center",
                gap: "5px",
              }}
            >
              <AsciiSpinner size={10} />
              streaming
            </span>
          </Show>

          <Show when={text().trim().length > 0 && !submitting()}>
            <span
              style={{
                "font-family": FONT_MONO,
                "font-size": "11px",
                color: "var(--color-text-faint)",
              }}
            >
              {isWorking() || inflight() ? "↵ to queue · ⇧↵ newline" : "↵ to send · ⇧↵ newline"}
            </span>
          </Show>

          <Show when={text().trim().length > 0 || attachments().length > 0}>
            <button
              onClick={() => void submit()}
              disabled={submitting()}
              type="button"
              title={isWorking() || inflight() ? "queue — sends when the agent finishes" : "send"}
              style={{
                all: "unset",
                "box-sizing": "border-box",
                cursor: submitting() ? "not-allowed" : "pointer",
                height: "28px",
                padding: "0 12px",
                display: "inline-flex",
                "align-items": "center",
                gap: "5px",
                "border-radius": "4px",
                background: isWorking() || inflight() ? "transparent" : "var(--color-accent)",
                color: isWorking() || inflight() ? "var(--color-text)" : "var(--color-on-accent)",
                border: isWorking() || inflight() ? "1px solid var(--color-border)" : "1px solid transparent",
                "font-family": FONT_MONO,
                "font-size": "12px",
                transition: "all 120ms ease",
              }}
            >
              <IconArrowUp size={12} strokeWidth={2} />
              {isWorking() || inflight() ? "queue" : "send"}
            </button>
          </Show>

          <Show when={isWorking() || inflight()}>
            <button
              onClick={() => void stop()}
              type="button"
              title="stop streaming"
              style={{
                all: "unset",
                "box-sizing": "border-box",
                cursor: "pointer",
                height: "28px",
                padding: "0 12px",
                display: "inline-flex",
                "align-items": "center",
                gap: "5px",
                "border-radius": "4px",
                background: "var(--color-error-muted, rgba(220,38,38,0.12))",
                color: "var(--color-error, #dc2626)",
                border: "1px solid var(--color-error, #dc2626)",
                "font-family": FONT_MONO,
                "font-size": "12px",
                transition: "all 120ms ease",
              }}
            >
              <IconStop size={12} strokeWidth={2} />
              stop
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}

// Faint caption preceding a segmented control ("effort" / "speed" / "context").
const CONTROL_LABEL: JSX.CSSProperties = {
  "font-family": FONT_MONO,
  "font-size": "10px",
  color: "var(--color-text-faint)",
  "text-transform": "lowercase",
}

// Cursor-style segmented control: a quiet row of peers where the selected one is
// marked by a faint tint + hairline border at a consistent weight — never bold.
// Used on the active model row for the effort keys, the fast/normal speed toggle,
// and the context tier.
function Segmented(props: {
  options: { id: string; label: string }[]
  value: string
  onPick: (id: string) => void
}): JSX.Element {
  return (
    <span style={{ display: "inline-flex", gap: "2px" }} onClick={(e) => e.stopPropagation()}>
      <For each={props.options}>
        {(o) => {
          const on = () => props.value === o.id
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                props.onPick(o.id)
              }}
              style={{
                all: "unset",
                cursor: "pointer",
                "font-family": FONT_MONO,
                "font-size": "11px",
                "font-weight": 400,
                "text-transform": "lowercase",
                color: on() ? "var(--color-text)" : "var(--color-text-muted)",
                background: on() ? "var(--color-accent-subtle)" : "transparent",
                border: on() ? "1px solid var(--color-border)" : "1px solid transparent",
                "border-radius": "4px",
                padding: "1px 7px",
                "line-height": 1.5,
                transition: "background 120ms ease",
              }}
              onMouseEnter={(e) => {
                if (!on()) e.currentTarget.style.background = "var(--color-bg-elevated)"
              }}
              onMouseLeave={(e) => {
                if (!on()) e.currentTarget.style.background = "transparent"
              }}
            >
              {o.label}
            </button>
          )
        }}
      </For>
    </span>
  )
}

function AttachmentChip(props: { att: Attachment; onRemove: () => void }): JSX.Element {
  const isImage = () => props.att.mime.startsWith("image/")
  const sizeLabel = () => {
    const s = props.att.size
    if (s < 1024) return `${s}B`
    if (s < 1024 * 1024) return `${(s / 1024).toFixed(0)}KB`
    return `${(s / (1024 * 1024)).toFixed(1)}MB`
  }
  return (
    <div
      title={`${props.att.filename} · ${sizeLabel()} · saved to .context/`}
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "6px",
        padding: "3px 6px 3px 4px",
        "border-radius": "4px",
        border: "1px solid var(--color-border)",
        background: "var(--color-bg-elevated)",
        "font-family": FONT_MONO,
        "font-size": "11px",
        color: "var(--color-text)",
        "max-width": "260px",
      }}
    >
      <Show when={isImage()} fallback={<IconPaperclip size={11} strokeWidth={1.5} />}>
        <img
          src={props.att.dataUrl}
          alt={props.att.filename}
          style={{
            width: "18px",
            height: "18px",
            "object-fit": "cover",
            "border-radius": "4px",
          }}
        />
      </Show>
      <span
        style={{
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
          flex: 1,
          "min-width": 0,
        }}
      >
        {props.att.filename}
      </span>
      <span style={{ color: "var(--color-text-faint)", "font-size": "10px" }}>{sizeLabel()}</span>
      <button
        type="button"
        title="remove"
        onClick={(e) => {
          e.stopPropagation()
          props.onRemove()
        }}
        style={{
          all: "unset",
          cursor: "pointer",
          padding: "0 4px",
          color: "var(--color-text-faint)",
          "font-size": "11px",
          "line-height": 1,
        }}
        onMouseEnter={(el) => (el.currentTarget.style.color = "var(--color-error)")}
        onMouseLeave={(el) => (el.currentTarget.style.color = "var(--color-text-faint)")}
      >
        ×
      </button>
    </div>
  )
}
