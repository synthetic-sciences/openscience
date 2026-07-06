/**
 * Atlas graph — three views mirroring Atlas web:
 *  - orbit:    force-directed SVG (small outcome-colored rings, bright roots)
 *  - cards:    layered top-down cards (kind/outcome badges, title, summary)
 *  - timeline: layered left-to-right rings with labels
 *
 * Labels use collision avoidance so they never pile up. Pan/drag/zoom and
 * the detail drawer are shared across views. Data comes from /api/thesis/*
 * (the Atlas bridge), scoped to the signed-in user's account.
 */
import {
  createSignal,
  createMemo,
  createResource,
  createEffect,
  onMount,
  onCleanup,
  untrack,
  type JSX,
  For,
  Show,
  Suspense,
} from "solid-js"
import { useDialog } from "@synsci/ui/context/dialog"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { uiStore } from "@/thesis/store/ui"
import { FONT_MONO, FONT_SANS, FONT_SERIF, sectionTitle } from "@/styles/tokens"
import {
  IconRefresh,
  IconPlus,
  IconNetwork,
  IconArrowRight,
  IconLayoutGrid,
  IconAtom,
  IconActivity,
} from "@/thesis/shared/Icon"
import { thesisAPI, type ThesisNode } from "@/thesis/api/thesis"
import { toast } from "@/thesis/Toast"
import { promptDialog } from "@/thesis/dialogs"
import { AsciiSpinner } from "@/thesis/shared/AsciiSpinner"

const POSITIONS_KEY = "thesis-canvas-positions-v1"
const VIEW_MODE_KEY = "dashboard.viewMode"
const GRAPH_STYLE_KEY = "dashboard.graphStyle"
const ROOT_R = 12
const BASE_R = 9
const MAX_R = 14
const LINK_DIST = 120
const CARD_W = 210
const CARD_H = 92

type Mode = "orbit" | "cards" | "timeline"
type ViewMode = "graph" | "timeline"
type GraphStyle = "cards" | "orbit"

type ModeIcon = (p: { size?: number; strokeWidth?: number }) => JSX.Element
const MODES: { k: Mode; label: string; Icon: ModeIcon }[] = [
  { k: "cards", label: "cards", Icon: IconLayoutGrid },
  { k: "orbit", label: "orbit", Icon: IconAtom },
  { k: "timeline", label: "timeline", Icon: IconActivity },
]

interface Pt {
  x: number
  y: number
}

interface Sim {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  isRoot: boolean
  pinned: boolean
}

interface Link {
  source: string
  target: string
  staged: boolean
}

function outcomeColor(outcome: string | null | undefined): string {
  if (outcome === "completed") return "var(--color-success)"
  if (outcome === "failed") return "var(--color-error)"
  if (outcome === "canceled" || outcome === "cancelled") return "var(--color-warning)"
  return "var(--color-text-faint)"
}

function lifecycleColor(node: ThesisNode): string {
  if (node.outcome === "completed") return "var(--color-success)"
  if (node.outcome === "failed") return "var(--color-error)"
  if (node.lifecycle === "committed") return "var(--color-accent)"
  if (node.lifecycle === "staged") return "var(--color-warning)"
  return "var(--color-text-muted)"
}

function readSavedPositions(): Map<string, Pt> {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY)
    if (!raw) return new Map()
    return new Map(Object.entries(JSON.parse(raw) as Record<string, Pt>))
  } catch {
    return new Map()
  }
}

function writeSavedPositions(map: Map<string, Pt>) {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {}
}

function readViewMode(): ViewMode {
  try {
    const m = localStorage.getItem(VIEW_MODE_KEY)
    if (m === "timeline") return "timeline"
  } catch {}
  return "graph"
}

function readGraphStyle(): GraphStyle {
  try {
    const m = localStorage.getItem(GRAPH_STYLE_KEY)
    if (m === "orbit") return "orbit"
  } catch {}
  return "cards"
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

/** Longest-path layered layout (TB for cards, LR for timeline). */
function layered(list: ThesisNode[], dir: "TB" | "LR", gapAlong: number, gapLayer: number): Map<string, Pt> {
  const present = new Set(list.map((n) => n.node_id))
  const byId = new Map(list.map((n) => [n.node_id, n]))
  const layer = new Map<string, number>()
  const visit = (id: string, stack: Set<string>): number => {
    const cached = layer.get(id)
    if (cached !== undefined) return cached
    if (stack.has(id)) return 0
    stack.add(id)
    const parents = (byId.get(id)?.parent_ids ?? []).filter((p) => present.has(p))
    const L = parents.length === 0 ? 0 : Math.max(...parents.map((p) => visit(p, stack) + 1))
    stack.delete(id)
    layer.set(id, L)
    return L
  }
  for (const n of list) visit(n.node_id, new Set())
  const byLayer = new Map<number, string[]>()
  for (const n of list) {
    const L = layer.get(n.node_id) ?? 0
    const arr = byLayer.get(L) ?? []
    arr.push(n.node_id)
    byLayer.set(L, arr)
  }
  const pos = new Map<string, Pt>()
  for (const [L, ids] of byLayer) {
    const total = (ids.length - 1) * gapAlong
    ids.forEach((id, i) => {
      const along = i * gapAlong - total / 2
      pos.set(id, dir === "TB" ? { x: along, y: L * gapLayer } : { x: L * gapLayer, y: along })
    })
  }
  return pos
}

export function ThesisCanvas(): JSX.Element {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  // The project the SPA has open (NOT the serve launch dir). Same resolution as
  // RightPane — threaded to the bridge so the canvas defaults to THIS project's
  // graph instead of the launch directory's.
  const directory = () => sync.project?.worktree || sync.data.path.directory || sdk.directory
  const GRAPH_KEY = "thesis-graph-id-v1"
  // Root list — just the graph roots (fast, root_only=true). Powers the dropdown
  // and default-selection logic without loading every node in the account.
  const [graphList, { refetch: refetchGraphs }] = createResource(() =>
    thesisAPI
      .listGraphs()
      .then((r) => r.nodes ?? [])
      .catch(() => [] as ThesisNode[]),
  )
  const graphs = createMemo<ThesisNode[]>(() =>
    [...(graphList.latest ?? [])].sort((a, b) => (a.title || "").localeCompare(b.title || "")),
  )
  // Resolve THIS folder's project root so the canvas defaults to its own graph
  // instead of another project's. `null` = unlinked (offer Initialize); read via
  // `.latest` so it never suspends. `undefined` = still resolving.
  const [folderProject, { refetch: refetchFolderProject }] = createResource(directory, (dir) =>
    thesisAPI
      .resolveProject(dir)
      .then((r) => r.project_id)
      .catch(() => null),
  )
  const [graphId, setGraphIdRaw] = createSignal<string | undefined>(
    (() => {
      try {
        return localStorage.getItem(GRAPH_KEY) || undefined
      } catch {
        return undefined
      }
    })(),
  )
  const setGraphId = (id: string) => {
    try {
      localStorage.setItem(GRAPH_KEY, id)
    } catch {}
    setGraphIdRaw(id)
  }
  // Default to THIS folder's own graph once both the graph list and the folder's
  // project have resolved — never auto-jump to another project's graph (that was
  // the bug: a fresh folder showed some other project). If the folder has no root
  // yet, leave nothing selected so the empty state offers "Initialize". Runs once
  // (`settled`), so manual dropdown switches and post-stage refetches stick.
  let settled = false
  createEffect(() => {
    const list = graphs()
    const fp = folderProject.latest
    if (settled) return
    if (!list.length) return // wait for graph list to load
    if (fp === undefined) return // wait for the folder project to resolve
    settled = true
    if (fp && list.some((g) => g.node_id === fp)) {
      setGraphIdRaw(fp)
      return
    }
    setGraphIdRaw(undefined) // unlinked folder → Initialize affordance, not another project
  })
  const selectedGraph = createMemo(() => graphs().find((g) => g.node_id === graphId()))
  const [graphMenu, setGraphMenu] = createSignal(false)

  // Selected project's subtree — the ONLY node set we load (server-scoped).
  // Keyed on graphId() so switching graphs triggers a fresh fetch automatically.
  const [graphTree, { refetch: refetchTree }] = createResource(
    () => graphId(),
    (id) =>
      thesisAPI
        .getGraphTree(id)
        .then((r) => r.nodes ?? [])
        .catch(() => [] as ThesisNode[]),
  )
  const nodes = createMemo<ThesisNode[]>(() => graphTree.latest ?? [])
  const byId = createMemo(() => new Map(nodes().map((n) => [n.node_id, n])))
  const loading = createMemo(() => graphList.loading || (graphId() !== undefined && graphTree.loading))
  const refetchAll = () => {
    void refetchGraphs()
    void refetchTree()
  }

  // Only the selected graph has a known node count; non-selected graphs show no badge.
  const graphSizes = createMemo(() => {
    const id = graphId()
    return id ? new Map([[id, nodes().length]]) : new Map<string, number>()
  })

  // Structural signature: changes only when the node set actually differs
  // (id + lifecycle + outcome + revision + parent count + child count + title).
  // A no-op background refetch won't reheat the force-sim or refit the view.
  const nodeSig = createMemo(() =>
    nodes()
      .map(
        (n) =>
          `${n.node_id}:${n.lifecycle}:${n.outcome}:${n.revision ?? ""}:${(n.parent_ids ?? []).length}:${(n.child_ids ?? []).length}:${n.title}`,
      )
      .sort()
      .join("|"),
  )

  // Live-refresh: poll the selected project's tree cheaply while the canvas is
  // visible. The structural-signature memo above ensures a no-op refetch (same
  // data) doesn't trigger a force-sim rebuild or view refit.
  onMount(() => {
    // One guarded handler for the interval + focus + visibility — only refetch
    // when the document is actually visible (a window can focus while hidden).
    const tick = () => {
      if (document.visibilityState !== "visible") return
      if (graphId() === undefined) {
        // Unlinked (Initialize hero showing): an agent-driven `openscience project init`
        // (e.g. from the initialize-atlas-graph skill) may have just created this
        // folder's graph. Re-arm the one-shot auto-select and re-resolve so the new
        // graph is picked up and selected automatically.
        settled = false
        void refetchFolderProject()
        void refetchGraphs()
      } else {
        void refetchTree()
      }
    }
    const interval = setInterval(tick, 8000)
    window.addEventListener("focus", tick)
    document.addEventListener("visibilitychange", tick)
    onCleanup(() => {
      clearInterval(interval)
      window.removeEventListener("focus", tick)
      document.removeEventListener("visibilitychange", tick)
    })
  })

  const [viewMode, setViewModeRaw] = createSignal<ViewMode>(readViewMode())
  const [graphStyle, setGraphStyleRaw] = createSignal<GraphStyle>(readGraphStyle())
  const mode = createMemo<Mode>(() => (viewMode() === "timeline" ? "timeline" : graphStyle()))
  const setViewMode = (m: ViewMode) => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, m)
    } catch {}
    setViewModeRaw(m)
  }
  const setGraphStyle = (m: GraphStyle) => {
    try {
      localStorage.setItem(GRAPH_STYLE_KEY, m)
    } catch {}
    setGraphStyleRaw(m)
  }
  // One flat control over the three real layouts (cards / orbit / timeline),
  // instead of the old nested graph→style + separate timeline toggles.
  const setMode = (m: Mode) => {
    if (m === "timeline") {
      setViewMode("timeline")
      return
    }
    setViewMode("graph")
    setGraphStyle(m)
  }
  const [selectedID, setSelectedID] = createSignal<string | null>(null)
  const [creating, setCreating] = createSignal(false)
  const [saved, setSaved] = createSignal(readSavedPositions())
  const selected = createMemo<ThesisNode | null>(() => {
    const id = selectedID()
    return id ? (nodes().find((n) => n.node_id === id) ?? null) : null
  })

  const [sims, setSims] = createSignal<Sim[]>([])
  const [links, setLinks] = createSignal<Link[]>([])
  const [frame, setFrame] = createSignal(0)
  let simById = new Map<string, Sim>()
  let alpha = 0
  let raf = 0
  let size = { w: 900, h: 640 }

  const [tx, setTx] = createSignal(0)
  const [ty, setTy] = createSignal(0)
  const [scale, setScale] = createSignal(1)
  const [hover, setHover] = createSignal<{ id: string; x: number; y: number } | null>(null)

  let containerRef: HTMLDivElement | undefined
  let svgRef: SVGSVGElement | undefined

  const neighbors = createMemo(() => {
    const m = new Map<string, Set<string>>()
    const add = (a: string, b: string) => {
      if (!m.has(a)) m.set(a, new Set())
      m.get(a)!.add(b)
    }
    for (const l of links()) {
      add(l.source, l.target)
      add(l.target, l.source)
    }
    return m
  })

  function build() {
    const list = nodes()
    const present = new Set(list.map((n) => n.node_id))
    const savedMap = saved()
    const m = mode()
    const seedR = Math.min(size.w, size.h) * 0.34
    const next: Sim[] = list.map((n, i) => {
      const isRoot = n.parent_ids.filter((id) => present.has(id)).length === 0
      const childCount = n.child_ids.filter((id) => present.has(id)).length
      const r = isRoot ? ROOT_R : Math.min(MAX_R, BASE_R + Math.sqrt(childCount) * 1.3)
      const sp = m === "orbit" ? savedMap.get(n.node_id) : undefined
      const angle = (i / Math.max(1, list.length)) * Math.PI * 2
      return {
        id: n.node_id,
        x: sp?.x ?? size.w / 2 + Math.cos(angle) * seedR,
        y: sp?.y ?? size.h / 2 + Math.sin(angle) * seedR,
        vx: 0,
        vy: 0,
        r,
        isRoot,
        pinned: m === "orbit" ? !!sp : true,
      }
    })
    simById = new Map(next.map((s) => [s.id, s]))
    const nextLinks: Link[] = []
    for (const n of list) {
      for (const p of n.parent_ids) {
        if (present.has(p)) nextLinks.push({ source: p, target: n.node_id, staged: n.lifecycle === "staged" })
      }
    }
    setLinks(nextLinks)

    if (m === "orbit") {
      setSims(next)
      alpha = 1
      runSim()
      return
    }

    // Structured (cards / timeline): static layered layout.
    const dir = m === "timeline" ? "LR" : "TB"
    const gapAlong = m === "cards" ? CARD_W + 44 : 34
    const gapLayer = m === "cards" ? CARD_H + 64 : m === "timeline" ? 160 : 90
    const pos = layered(list, dir, gapAlong, gapLayer)
    for (const s of next) {
      const p = pos.get(s.id)
      if (p) {
        s.x = p.x
        s.y = p.y
      }
    }
    cancelAnimationFrame(raf)
    raf = 0
    setSims(next)
    setFrame((f) => f + 1)
    requestAnimationFrame(() => fit())
  }

  function tick() {
    const list = sims()
    const n = list.length
    if (n === 0) return
    const rep = Math.max(2600, n * 85)
    const cx = size.w / 2
    const cy = size.h / 2
    for (let i = 0; i < n; i++) {
      const a = list[i]
      for (let j = i + 1; j < n; j++) {
        const b = list[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 0.01) {
          dx = Math.random() - 0.5
          dy = Math.random() - 0.5
          d2 = dx * dx + dy * dy
        }
        const d = Math.sqrt(d2)
        const f = ((rep / d2) * alpha) / d
        a.vx += dx * f
        a.vy += dy * f
        b.vx -= dx * f
        b.vy -= dy * f
        const min = a.r + b.r + 24
        if (d < min) {
          const push = ((min - d) / d) * 0.5
          a.vx += dx * push
          a.vy += dy * push
          b.vx -= dx * push
          b.vy -= dy * push
        }
      }
    }
    for (const l of links()) {
      const s = simById.get(l.source)
      const t = simById.get(l.target)
      if (!s || !t) continue
      const dx = t.x - s.x
      const dy = t.y - s.y
      const d = Math.hypot(dx, dy) || 1
      const diff = (((d - LINK_DIST) / d) * 0.5 * alpha) / 2
      const mx = dx * diff
      const my = dy * diff
      s.vx += mx
      s.vy += my
      t.vx -= mx
      t.vy -= my
    }
    for (const s of list) {
      if (s.pinned) {
        s.vx = 0
        s.vy = 0
        continue
      }
      s.vx += (cx - s.x) * 0.02 * alpha
      s.vy += (cy - s.y) * 0.02 * alpha
      s.vx *= 0.62
      s.vy *= 0.62
      s.x += s.vx
      s.y += s.vy
    }
  }

  function runSim() {
    cancelAnimationFrame(raf)
    const step = () => {
      tick()
      alpha *= 0.977
      setFrame((f) => f + 1)
      if (alpha > 0.006) raf = requestAnimationFrame(step)
      else {
        raf = 0
        fit()
      }
    }
    raf = requestAnimationFrame(step)
  }

  function reheat() {
    if (mode() !== "orbit") return
    alpha = Math.max(alpha, 0.35)
    if (!raf) runSim()
  }

  function fit() {
    const list = sims()
    if (list.length === 0 || size.w === 0) return
    const card = mode() === "cards"
    const hw = card ? CARD_W / 2 : 24
    const hh = card ? CARD_H / 2 : 24
    // Rings carry labels that extend to the right — reserve room so they
    // don't clip at the canvas edge.
    const labelPad = card ? 0 : 140
    const minX = Math.min(...list.map((s) => s.x - hw)) - 40
    const maxX = Math.max(...list.map((s) => s.x + hw)) + 40 + labelPad
    const minY = Math.min(...list.map((s) => s.y - hh)) - 40
    const maxY = Math.max(...list.map((s) => s.y + hh)) + 40
    const w = Math.max(1, maxX - minX)
    const h = Math.max(1, maxY - minY)
    const s = Math.min(1.4, Math.max(0.2, Math.min(size.w / w, size.h / h)))
    setScale(s)
    setTx(size.w / 2 - ((minX + maxX) / 2) * s)
    setTy(size.h / 2 - ((minY + maxY) / 2) * s)
  }

  onMount(() => {
    if (!containerRef) return
    const r = containerRef.getBoundingClientRect()
    size = { w: r.width || 900, h: r.height || 640 }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) size = { w: e.contentRect.width, h: e.contentRect.height }
    })
    ro.observe(containerRef)
    onCleanup(() => ro.disconnect())
  })
  onCleanup(() => cancelAnimationFrame(raf))

  // Rebuild when the node set structurally changes or the view mode changes.
  // Gated on the structural signature so background refetches that return the
  // same data don't reheat the force-sim or refit the view.
  // NOTE: build() reads nodes()/saved()/size UNTRACKED — only nodeSig()+mode()
  // drive this effect. Code that should trigger a rebuild on pin/drag changes
  // calls build()/reheat() directly (resetLayout, drag-release), not via saved().
  createEffect(() => {
    nodeSig()
    mode()
    untrack(() => build())
  })

  const refresh = () => void refetchAll()

  const createNode = async () => {
    if (creating()) return
    const title = await promptDialog(dialog, {
      title: "Stage a new node",
      placeholder: "node title",
      confirmLabel: "stage",
    })
    if (!title) return
    setCreating(true)
    try {
      await thesisAPI.createNode(title)
      toast.info("node staged", title)
      refresh()
    } catch (err: any) {
      toast.error("could not create node", err?.message ?? String(err))
    } finally {
      setCreating(false)
    }
  }

  // Explicitly create the folder's project root, then refetch + select it.
  const [initializing, setInitializing] = createSignal(false)
  const initGraph = async () => {
    if (initializing()) return
    setInitializing(true)
    try {
      const { project_id } = await thesisAPI.initProject(directory())
      if (!project_id) throw new Error("backend returned no project id")
      settled = true
      await refetchAll()
      setGraphId(project_id)
      toast.info("project graph initialized")
    } catch (err: any) {
      toast.error("could not initialize project graph", err?.message ?? String(err))
    } finally {
      setInitializing(false)
    }
  }

  const resetLayout = () => {
    setSaved(new Map())
    writeSavedPositions(new Map())
    build()
    toast.info("layout reset")
  }

  // ---- pointer interaction ----
  let panStart: { x: number; y: number; tx: number; ty: number } | null = null
  let drag: { id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null

  const toGraph = (clientX: number, clientY: number): Pt => {
    const rect = svgRef!.getBoundingClientRect()
    return { x: (clientX - rect.left - tx()) / scale(), y: (clientY - rect.top - ty()) / scale() }
  }

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as SVGElement
    const nodeEl = target.closest("[data-node-id]") as SVGElement | null
    if (nodeEl) {
      const id = nodeEl.getAttribute("data-node-id")!
      const s = simById.get(id)
      if (s) {
        const g = toGraph(e.clientX, e.clientY)
        drag = { id, sx: g.x, sy: g.y, ox: s.x, oy: s.y, moved: false }
      }
    } else {
      panStart = { x: e.clientX, y: e.clientY, tx: tx(), ty: ty() }
    }
    svgRef!.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e: PointerEvent) => {
    if (panStart) {
      setTx(panStart.tx + (e.clientX - panStart.x))
      setTy(panStart.ty + (e.clientY - panStart.y))
      return
    }
    if (drag) {
      const g = toGraph(e.clientX, e.clientY)
      const s = simById.get(drag.id)
      if (!s) return
      s.x = drag.ox + (g.x - drag.sx)
      s.y = drag.oy + (g.y - drag.sy)
      s.pinned = true
      if (Math.abs(g.x - drag.sx) + Math.abs(g.y - drag.sy) > 3) drag.moved = true
      reheat()
      setFrame((f) => f + 1)
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    svgRef!.releasePointerCapture(e.pointerId)
    if (drag) {
      if (!drag.moved) {
        setSelectedID((cur) => (cur === drag!.id ? null : drag!.id))
      } else if (mode() === "orbit") {
        const s = simById.get(drag.id)
        if (s) {
          setSaved((prev) => {
            const next = new Map(prev)
            next.set(drag!.id, { x: s.x, y: s.y })
            writeSavedPositions(next)
            return next
          })
        }
      }
    }
    panStart = null
    drag = null
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = svgRef!.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const s0 = scale()
    const s1 = Math.min(3, Math.max(0.12, s0 * factor))
    setTx(px - ((px - tx()) / s0) * s1)
    setTy(py - ((py - ty()) / s0) * s1)
    setScale(s1)
  }

  const hovered = createMemo(() => {
    const h = hover()
    return h ? (byId().get(h.id) ?? null) : null
  })

  // Collision-avoided labels (orbit roots / timeline all) so they never pile up.
  const labelIds = createMemo<Set<string>>(() => {
    const m = mode()
    if (m === "cards") return new Set()
    frame()
    const list = sims()
    const idmap = byId()
    const placed: { x1: number; y1: number; x2: number; y2: number }[] = []
    const show = new Set<string>()
    const candidates = (m === "timeline" ? list : list.filter((s) => s.isRoot))
      .slice()
      .sort((a, b) => a.x - b.x || b.r - a.r)
    for (const s of candidates) {
      const node = idmap.get(s.id)
      if (!node) continue
      const text = truncate(node.title || node.slug_name || "untitled", m === "timeline" ? 16 : 22)
      const w = text.length * 6.6 + 8
      const h = 15
      const x1 = s.x + s.r + 5
      const y1 = s.y - h / 2
      const x2 = x1 + w
      const y2 = y1 + h
      if (placed.some((p) => x1 < p.x2 && x2 > p.x1 && y1 < p.y2 && y2 > p.y1)) continue
      placed.push({ x1, y1, x2, y2 })
      show.add(s.id)
    }
    return show
  })

  const cardEdge = (s: Sim, t: Sim): string => {
    const x1 = s.x
    const y1 = s.y + CARD_H / 2
    const x2 = t.x
    const y2 = t.y - CARD_H / 2
    const my = (y1 + y2) / 2
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`
  }

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        position: "relative",
        background: "var(--color-bg)",
        display: "flex",
        "flex-direction": "column",
        "min-height": 0,
      }}
    >
      {/* Header — compact, integrated control bar */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          padding: "7px 8px 7px 12px",
          "border-bottom": "1px solid var(--color-border)",
          background: "var(--color-bg)",
          "flex-shrink": 0,
          "min-width": 0,
        }}
      >
        {/* Graph identity */}
        <div style={{ display: "flex", "align-items": "center", gap: "7px", "min-width": 0, flex: 1 }}>
          <span style={{ color: "var(--color-text-muted)", display: "inline-flex", "flex-shrink": 0 }}>
            <IconNetwork size={13} strokeWidth={1.6} />
          </span>
          <span
            title={selectedGraph()?.title || selectedGraph()?.node_id || "Atlas graph (account-scoped)"}
            style={{
              "font-family": FONT_SANS,
              "font-size": "13px",
              "font-weight": 400,
              color: "var(--color-text)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
              "min-width": 0,
            }}
          >
            {selectedGraph()?.title || (loading() ? "loading…" : "no graph")}
          </span>
          <Show when={nodes().length > 0}>
            <span
              style={{
                "flex-shrink": 0,
                "font-family": FONT_MONO,
                "font-size": "10px",
                "font-weight": 700,
                color: "var(--color-text-muted)",
                background: "var(--color-bg-subtle)",
                border: "1px solid var(--color-border)",
                "border-radius": "999px",
                padding: "1px 6px",
                "letter-spacing": "0.02em",
              }}
            >
              {nodes().length}
            </span>
          </Show>
          <Show when={loading() && nodes().length > 0}>
            <AsciiSpinner size={10} color="var(--color-text-faint)" />
          </Show>
        </div>

        {/* Mode segmented control */}
        <div
          style={{
            display: "inline-flex",
            "align-items": "center",
            gap: "2px",
            padding: "2px",
            "border-radius": "4px",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-subtle)",
            "flex-shrink": 0,
          }}
        >
          <For each={MODES}>
            {(opt) => (
              <ModeSeg active={mode() === opt.k} Icon={opt.Icon} label={opt.label} onClick={() => setMode(opt.k)} />
            )}
          </For>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", "align-items": "center", gap: "1px", "flex-shrink": 0 }}>
          <Show when={mode() === "orbit"}>
            <CanvasAction title="reset pinned layout" disabled={saved().size === 0} onClick={resetLayout}>
              <span style={{ "font-size": "10px", "letter-spacing": "0.04em" }}>reset</span>
            </CanvasAction>
          </Show>
          <CanvasAction title="fit to view" onClick={fit}>
            <FitGlyph />
          </CanvasAction>
          <CanvasAction title="stage a new node" disabled={creating()} onClick={() => void createNode()}>
            <IconPlus size={12} strokeWidth={1.7} />
          </CanvasAction>
          <CanvasAction title="refresh" onClick={refresh}>
            <IconRefresh size={11} strokeWidth={1.6} />
          </CanvasAction>
        </div>
      </div>

      {/* Canvas */}
      <Show
        when={nodes().length > 0}
        fallback={
          <div
            style={{
              flex: 1,
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              "background-image": "radial-gradient(circle at 1px 1px, var(--color-border) 1px, transparent 0)",
              "background-size": "22px 22px",
            }}
          >
            <Show
              when={loading()}
              fallback={
                <Show
                  when={selectedGraph()}
                  fallback={
                    <InitHero
                      // Primary: hit the deterministic find-or-create endpoint
                      // directly (POST /api/thesis/project/init via thesisAPI) so
                      // the button reliably creates the graph without depending on
                      // the agent or the `atlas` binary. initGraph() refetches and
                      // selects the new root, and toasts a typed error on failure.
                      onInit={() => void initGraph()}
                      // Secondary: route through the agent — drop the
                      // initialize-atlas-graph skill invocation in the composer
                      // WITHOUT sending, so the user can review/run it (useful when
                      // the direct call reports a plan/auth issue to resolve in chat).
                      onChat={() => uiStore.setPrefill("/initialize-atlas-graph")}
                      busy={initializing()}
                    />
                  }
                >
                  <EmptyHero onCreate={() => void createNode()} />
                </Show>
              }
            >
              <span
                style={{
                  "font-family": FONT_MONO,
                  "font-size": "10px",
                  color: "var(--color-text-faint)",
                  "letter-spacing": "0.04em",
                }}
              >
                loading atlas nodes…
              </span>
            </Show>
          </div>
        }
      >
        <div style={{ flex: 1, position: "relative", "min-height": 0, overflow: "hidden" }}>
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            style={{ display: "block", cursor: panStart ? "grabbing" : "grab", "touch-action": "none" }}
            onpointerdown={onPointerDown}
            onpointermove={onPointerMove}
            onpointerup={onPointerUp}
            onwheel={onWheel}
          >
            <g transform={(frame(), `translate(${tx()},${ty()}) scale(${scale()})`)}>
              <For each={links()}>
                {(l) => {
                  const s = () => simById.get(l.source)
                  const t = () => simById.get(l.target)
                  const lit = () => {
                    const h = hover()
                    return h ? h.id === l.source || h.id === l.target : true
                  }
                  return (
                    <Show when={s() && t()}>
                      <Show
                        when={mode() === "cards"}
                        fallback={
                          <line
                            x1={(frame(), s()!.x)}
                            y1={s()!.y}
                            x2={t()!.x}
                            y2={t()!.y}
                            stroke={lit() && hover() ? "var(--color-text-faint)" : "var(--color-border-strong)"}
                            stroke-opacity={lit() ? (l.staged ? 0.4 : 0.6) : 0.12}
                            stroke-width={1}
                          />
                        }
                      >
                        <path
                          d={(frame(), cardEdge(s()!, t()!))}
                          fill="none"
                          stroke="var(--color-border-strong)"
                          stroke-opacity={lit() ? 0.5 : 0.15}
                          stroke-width={1}
                        />
                      </Show>
                    </Show>
                  )
                }}
              </For>

              <For each={sims()}>
                {(s) => {
                  const node = () => byId().get(s.id)
                  const dim = () => {
                    const h = hover()
                    if (!h) return false
                    return h.id !== s.id && !neighbors().get(h.id)?.has(s.id)
                  }
                  const hov = () => hover()?.id === s.id
                  const rr = () => (hov() ? s.r + 2 : s.r)
                  const sel = () => selectedID() === s.id
                  const oc = () => outcomeColor(node()?.outcome)
                  const staged = () => node()?.lifecycle === "staged"
                  const showLabel = () => labelIds().has(s.id) || hov()
                  return (
                    <Show when={node()}>
                      <g
                        data-node-id={s.id}
                        transform={(frame(), `translate(${s.x},${s.y})`)}
                        style={{ cursor: "pointer", opacity: dim() ? 0.26 : 1 }}
                        onmouseenter={(e) => setHover({ id: s.id, x: e.clientX, y: e.clientY })}
                        onmousemove={(e) => setHover({ id: s.id, x: e.clientX, y: e.clientY })}
                        onmouseleave={() => setHover((h) => (h?.id === s.id ? null : h))}
                      >
                        <Show
                          when={mode() === "cards"}
                          fallback={
                            <>
                              <Show when={sel()}>
                                <circle r={rr() + 4} fill="none" stroke="var(--color-accent)" stroke-width={1.5} />
                              </Show>
                              <Show
                                when={!s.isRoot}
                                fallback={
                                  <circle
                                    r={rr()}
                                    fill="var(--color-text)"
                                    stroke="var(--color-bg)"
                                    stroke-width={1.5}
                                  />
                                }
                              >
                                <circle
                                  r={rr()}
                                  fill={oc()}
                                  fill-opacity={staged() ? 0.07 : 0.16}
                                  stroke={oc()}
                                  stroke-opacity={staged() ? 0.4 : hov() ? 0.95 : 0.65}
                                  stroke-width={Math.max(2, rr() * 0.32)}
                                  stroke-dasharray={staged() ? "2 2" : undefined}
                                />
                              </Show>
                              <Show when={showLabel()}>
                                <text
                                  x={rr() + 8}
                                  dy="0.34em"
                                  font-size="12"
                                  fill="var(--color-text)"
                                  style={{
                                    "font-family": FONT_SERIF,
                                    "pointer-events": "none",
                                    "paint-order": "stroke",
                                    stroke: "var(--color-bg)",
                                    "stroke-width": "3.5px",
                                    "stroke-linejoin": "round",
                                  }}
                                >
                                  {truncate(node()!.title || node()!.slug_name || "untitled", 22)}
                                </text>
                              </Show>
                            </>
                          }
                        >
                          <CardNode node={node()!} selected={sel()} hovered={hov()} />
                        </Show>
                      </g>
                    </Show>
                  )
                }}
              </For>
            </g>
          </svg>

          <Show when={hovered() && hover() && mode() !== "cards"}>
            <OrbitTooltip node={hovered()!} x={hover()!.x} y={hover()!.y} byId={byId()} />
          </Show>

          {/* Graph selector — bottom-left, Atlas-web style. Switches which
              graph (root + its tree) the canvas renders. */}
          <div style={{ position: "absolute", left: "16px", bottom: "16px", "z-index": 6 }}>
            <Show when={graphMenu()}>
              <div
                class="thesis-pop-up thesis-scroll"
                onMouseLeave={() => setGraphMenu(false)}
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  left: 0,
                  width: "300px",
                  "max-height": "60vh",
                  "overflow-y": "auto",
                  background: "var(--color-surface-solid)",
                  border: "1px solid var(--color-border-strong)",
                  "border-radius": "4px",
                  "box-shadow": "0 18px 50px rgba(0,0,0,0.18)",
                  padding: "4px",
                }}
              >
                <div
                  style={{ ...sectionTitle, padding: "7px 8px 5px", "border-bottom": "1px solid var(--color-border)" }}
                >
                  graphs · {(graphs() ?? []).length}
                </div>
                <For each={graphs() ?? []}>
                  {(g) => (
                    <button
                      type="button"
                      onClick={() => {
                        setGraphId(g.node_id)
                        setGraphMenu(false)
                      }}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        display: "flex",
                        "align-items": "center",
                        gap: "8px",
                        width: "100%",
                        "box-sizing": "border-box",
                        padding: "7px 8px",
                        "border-radius": "4px",
                        background: g.node_id === graphId() ? "var(--color-bg-elevated)" : "transparent",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-elevated)")}
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background =
                          g.node_id === graphId() ? "var(--color-bg-elevated)" : "transparent")
                      }
                    >
                      <span
                        style={{
                          flex: 1,
                          "min-width": 0,
                          "font-family": FONT_SANS,
                          "font-size": "12px",
                          "font-weight": g.node_id === graphId() ? 700 : 400,
                          color: "var(--color-text)",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {g.title || "untitled graph"}
                      </span>
                      <span
                        style={{
                          "font-family": FONT_MONO,
                          "font-size": "10px",
                          color: "var(--color-text-faint)",
                          "flex-shrink": 0,
                          padding: "1px 6px",
                          background: g.node_id === graphId() ? "var(--color-accent-subtle)" : "transparent",
                          "border-radius": "4px",
                        }}
                      >
                        {graphSizes().get(g.node_id) ?? ""}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <button
              type="button"
              onClick={() => setGraphMenu((v) => !v)}
              title="switch graph"
              style={{
                all: "unset",
                cursor: "pointer",
                display: "inline-flex",
                "align-items": "center",
                gap: "7px",
                "max-width": "300px",
                padding: "6px 10px",
                "border-radius": "4px",
                border: "1px solid var(--color-border-strong)",
                background: "var(--color-surface-solid)",
                "box-shadow": "0 12px 28px rgba(0,0,0,0.12)",
              }}
            >
              <IconNetwork size={12} strokeWidth={1.5} />
              <span
                style={{
                  "font-family": FONT_SANS,
                  "font-size": "12px",
                  "font-weight": 400,
                  color: "var(--color-text)",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                }}
              >
                {selectedGraph()?.title || "select graph"}
              </span>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                style={{ color: "var(--color-text-faint)", "flex-shrink": 0 }}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </div>

          <div
            style={{
              position: "absolute",
              right: "14px",
              bottom: "12px",
              "font-family": FONT_MONO,
              "font-size": "10px",
              "line-height": 1.7,
              "text-align": "right",
              color: "var(--color-text-faint)",
              opacity: 0.7,
              "pointer-events": "none",
            }}
          >
            <div>scroll to zoom · drag to move</div>
            <div>click a node to open</div>
          </div>
        </div>
      </Show>

      <Show when={selected()}>{(node) => <NodeDetail node={node()} onClose={() => setSelectedID(null)} />}</Show>
    </div>
  )
}

function CardNode(props: { node: ThesisNode; selected: boolean; hovered: boolean }): JSX.Element {
  return (
    <>
      <rect
        x={-CARD_W / 2}
        y={-CARD_H / 2}
        width={CARD_W}
        height={CARD_H}
        rx="5"
        fill="var(--color-surface-solid)"
        stroke={props.selected ? "var(--color-accent)" : "var(--color-border-strong)"}
        stroke-width={props.selected ? 1.5 : 1}
        style={{ filter: props.hovered ? "brightness(1.04)" : undefined }}
      />
      <circle cx={-CARD_W / 2 + 12} cy={-CARD_H / 2 + 14} r="3.5" fill={lifecycleColor(props.node)} />
      <text
        x={-CARD_W / 2 + 22}
        y={-CARD_H / 2 + 14}
        dy="0.32em"
        font-size="10"
        fill="var(--color-text-faint)"
        style={{ "font-family": FONT_MONO, "letter-spacing": "0.08em", "pointer-events": "none" }}
      >
        {(props.node.kind || "untyped").toUpperCase()}
        {props.node.outcome ? ` · ${props.node.outcome}` : props.node.lifecycle === "staged" ? " · staged" : ""}
      </text>
      <text
        x={-CARD_W / 2 + 12}
        y={-CARD_H / 2 + 36}
        font-size="13"
        fill="var(--color-text)"
        style={{ "font-family": FONT_SERIF, "font-weight": 400, "pointer-events": "none" }}
      >
        {truncate(props.node.title || props.node.slug_name || "untitled", 28)}
      </text>
      <Show when={props.node.summary}>
        <text
          x={-CARD_W / 2 + 12}
          y={-CARD_H / 2 + 54}
          font-size="10"
          fill="var(--color-text-muted)"
          style={{ "font-family": FONT_SANS, "pointer-events": "none" }}
        >
          {truncate(props.node.summary, 34)}
        </text>
        <text
          x={-CARD_W / 2 + 12}
          y={-CARD_H / 2 + 69}
          font-size="10"
          fill="var(--color-text-muted)"
          style={{ "font-family": FONT_SANS, "pointer-events": "none" }}
        >
          {props.node.summary.length > 34 ? truncate(props.node.summary.slice(34), 34) : ""}
        </text>
      </Show>
    </>
  )
}

function OrbitTooltip(props: { node: ThesisNode; x: number; y: number; byId: Map<string, ThesisNode> }): JSX.Element {
  const segs = () => props.node.child_ids.map((id) => props.byId.get(id)?.outcome ?? null)
  const done = () => segs().filter((s) => s === "completed").length
  return (
    <div
      style={{
        position: "fixed",
        left: `${props.x + 16}px`,
        top: `${props.y + 16}px`,
        "z-index": 50,
        "pointer-events": "none",
        "max-width": "300px",
        background: "var(--color-surface-solid)",
        border: "1px solid var(--color-border-strong)",
        "border-radius": "4px",
        "box-shadow": "var(--shadow-md)",
        padding: "8px 11px",
      }}
    >
      <div
        style={{
          "font-family": FONT_SERIF,
          "font-size": "13px",
          "font-weight": 400,
          color: "var(--color-text)",
          "line-height": 1.3,
        }}
      >
        {props.node.title || props.node.slug_name || "untitled"}
      </div>
      <div
        style={{
          "margin-top": "4px",
          "font-family": FONT_MONO,
          "font-size": "10px",
          color: "var(--color-text-faint)",
        }}
      >
        {props.node.kind}
        {" · "}
        {props.node.outcome ?? (props.node.lifecycle === "staged" ? "staged" : "untyped")}
        {segs().length ? ` · ${done()}/${segs().length} children done` : ""}
      </div>
      <Show when={props.node.summary}>
        <div
          style={{
            "margin-top": "6px",
            "font-family": FONT_SANS,
            "font-size": "12px",
            color: "var(--color-text-muted)",
            "line-height": 1.5,
            display: "-webkit-box",
            "-webkit-line-clamp": "3",
            "-webkit-box-orient": "vertical",
            overflow: "hidden",
          }}
        >
          {props.node.summary}
        </div>
      </Show>
    </div>
  )
}

function NodeDetail(props: { node: ThesisNode; onClose: () => void }): JSX.Element {
  const [artifacts] = createResource(
    () => props.node.node_id,
    async (id) => {
      try {
        const res = await thesisAPI.listArtifacts(id)
        const list = Array.isArray(res) ? res : ((res as any)?.artifacts ?? [])
        return list as Array<{ name?: string; kind?: string; uri?: string }>
      } catch {
        return []
      }
    },
  )
  return (
    <div
      class="thesis-fade-in"
      style={{
        position: "absolute",
        right: "10px",
        bottom: "10px",
        left: "10px",
        "max-height": "55%",
        background: "var(--color-surface-solid)",
        border: "1px solid var(--color-border-strong)",
        "border-radius": "4px",
        padding: "12px 14px",
        display: "flex",
        "flex-direction": "column",
        gap: "8px",
        "box-shadow": "var(--shadow-md)",
        overflow: "auto",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <span
          style={{
            width: "8px",
            height: "8px",
            "border-radius": "50%",
            background: lifecycleColor(props.node),
            "flex-shrink": 0,
          }}
        />
        <span
          style={{
            "font-family": FONT_SERIF,
            "font-size": "14px",
            "font-weight": 400,
            color: "var(--color-text)",
            flex: 1,
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          {props.node.title || props.node.slug_name || "untitled"}
        </span>
        <Show when={props.node.repo_url}>
          {(url) => (
            <a
              href={url().startsWith("http") ? url() : `https://${url()}`}
              target="_blank"
              rel="noopener"
              title="open repo"
              style={{ color: "var(--color-text-faint)", display: "inline-flex" }}
            >
              <IconArrowRight size={11} strokeWidth={1.5} />
            </a>
          )}
        </Show>
        <button onClick={props.onClose} style={iconBtn(false)} title="close">
          ×
        </button>
      </div>
      <div
        style={{
          "font-family": FONT_MONO,
          "font-size": "10px",
          color: "var(--color-text-faint)",
          "letter-spacing": "0.04em",
          display: "flex",
          gap: "10px",
          "flex-wrap": "wrap",
        }}
      >
        <span>{props.node.kind}</span>
        <span>·</span>
        <span>{props.node.lifecycle}</span>
        <Show when={props.node.outcome}>
          <span>·</span>
          <span style={{ color: lifecycleColor(props.node) }}>{props.node.outcome}</span>
        </Show>
        <Show when={props.node.head_commit_sha}>
          <span>·</span>
          <span>{props.node.head_commit_sha?.slice(0, 7)}</span>
        </Show>
        <Show when={props.node.branch_name}>
          <span>·</span>
          <span>{props.node.branch_name}</span>
        </Show>
      </div>
      <Show when={props.node.hypothesis}>
        <DetailField label="hypothesis" value={props.node.hypothesis} />
      </Show>
      <Show when={props.node.summary}>
        <DetailField label="summary" value={props.node.summary} />
      </Show>
      <Show when={props.node.content}>
        <DetailField label="content" value={props.node.content} mono />
      </Show>
      <Suspense fallback={<AsciiSpinner size={10} label="loading artifacts…" color="var(--color-text-faint)" />}>
        <Show when={(artifacts() ?? []).length > 0}>
          <div
            style={{
              "font-family": FONT_MONO,
              "font-size": "10px",
              color: "var(--color-text-faint)",
              "letter-spacing": "0.04em",
              "border-top": "1px solid var(--color-border)",
              "padding-top": "6px",
              "margin-top": "2px",
            }}
          >
            artifacts · {(artifacts() ?? []).length}
          </div>
          <For each={artifacts() ?? []}>
            {(a) => (
              <div
                style={{
                  "font-family": FONT_MONO,
                  "font-size": "11px",
                  color: "var(--color-text-muted)",
                  display: "flex",
                  gap: "8px",
                }}
              >
                <span style={{ color: "var(--color-text-faint)" }}>{a.kind ?? "—"}</span>
                <span style={{ color: "var(--color-text)" }}>{a.name ?? a.uri ?? "?"}</span>
              </div>
            )}
          </For>
        </Show>
      </Suspense>
    </div>
  )
}

function DetailField(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
      <span style={sectionTitle}>{props.label}</span>
      <span
        style={{
          "font-family": props.mono ? FONT_MONO : FONT_SANS,
          "font-size": props.mono ? "11px" : "12px",
          color: "var(--color-text)",
          "line-height": 1.45,
          "white-space": "pre-wrap",
        }}
      >
        {props.value}
      </span>
    </div>
  )
}

function EmptyHero(props: { onCreate: () => void }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        gap: "12px",
        "text-align": "center",
        padding: "20px",
      }}
    >
      <div
        style={{
          "font-family": FONT_MONO,
          "font-size": "11px",
          color: "var(--color-text-muted)",
          "letter-spacing": "0.06em",
        }}
      >
        atlas graph is empty
      </div>
      <div
        style={{
          "font-family": FONT_SANS,
          "font-size": "12px",
          color: "var(--color-text-faint)",
          "max-width": "280px",
          "line-height": 1.55,
        }}
      >
        Stage a node to begin. Or ask the agent to <span style={{ color: "var(--color-text)" }}>"propose a claim"</span>{" "}
        and it'll seed one for you.
      </div>
      <button
        onClick={props.onCreate}
        style={{
          all: "unset",
          cursor: "pointer",
          padding: "6px 14px",
          "border-radius": "4px",
          background: "var(--color-accent)",
          color: "var(--color-on-accent)",
          "font-family": FONT_MONO,
          "font-size": "11px",
          "font-weight": 400,
          display: "inline-flex",
          "align-items": "center",
          gap: "6px",
        }}
      >
        <IconPlus size={11} strokeWidth={1.8} />
        stage your first node
      </button>
    </div>
  )
}

// Shown when the current folder has no Atlas project graph yet. Distinct from
// EmptyHero (which is for a linked-but-empty graph): this initializes the root.
function InitHero(props: { onInit: () => void; onChat: () => void; busy: boolean }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        gap: "12px",
        "text-align": "center",
        padding: "20px",
      }}
    >
      <div
        style={{
          "font-family": FONT_MONO,
          "font-size": "11px",
          color: "var(--color-text-muted)",
          "letter-spacing": "0.06em",
        }}
      >
        no graph for this project
      </div>
      <div
        style={{
          "font-family": FONT_SANS,
          "font-size": "12px",
          color: "var(--color-text-faint)",
          "max-width": "300px",
          "line-height": 1.55,
        }}
      >
        This folder isn't linked to an Atlas research graph yet. Initialize one to start tracking hypotheses,
        experiments, and decisions here.
      </div>
      <button
        onClick={() => !props.busy && props.onInit()}
        disabled={props.busy}
        style={{
          all: "unset",
          cursor: props.busy ? "default" : "pointer",
          opacity: props.busy ? 0.6 : 1,
          padding: "6px 14px",
          "border-radius": "4px",
          background: "var(--color-accent)",
          color: "var(--color-on-accent)",
          "font-family": FONT_MONO,
          "font-size": "11px",
          "font-weight": 400,
          display: "inline-flex",
          "align-items": "center",
          gap: "6px",
        }}
      >
        {props.busy ? "initializing…" : "initialize this project's graph"}
      </button>
      <button
        onClick={() => !props.busy && props.onChat()}
        disabled={props.busy}
        style={{
          all: "unset",
          cursor: props.busy ? "default" : "pointer",
          opacity: props.busy ? 0.5 : 0.8,
          "font-family": FONT_MONO,
          "font-size": "10px",
          color: "var(--color-text-faint)",
        }}
        title="Drop a prompt in the chat and let the agent run `openscience project init`"
      >
        or set it up from chat →
      </button>
    </div>
  )
}

// A single icon segment in the layout switcher. Active segment lifts onto an
// elevated chip with a soft shadow; everything animates so switching feels live.
function ModeSeg(props: { active: boolean; Icon: ModeIcon; label: string; onClick: () => void }): JSX.Element {
  const [hover, setHover] = createSignal(false)
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        width: "26px",
        height: "22px",
        "border-radius": "4px",
        color: props.active ? "var(--color-text)" : hover() ? "var(--color-text-muted)" : "var(--color-text-faint)",
        background: props.active ? "var(--color-surface-solid, var(--color-bg-elevated))" : "transparent",
        "box-shadow": props.active ? "0 1px 2px rgba(0, 0, 0, 0.22)" : "none",
        transform: props.active ? "translateY(-0.5px)" : "none",
        transition:
          "background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard)",
      }}
    >
      <props.Icon size={13} strokeWidth={props.active ? 1.9 : 1.6} />
    </button>
  )
}

// Quiet icon/text action button with a hover wash. Used for fit/reset/new/refresh.
function CanvasAction(props: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: JSX.Element
}): JSX.Element {
  const [hover, setHover] = createSignal(false)
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: "unset",
        cursor: props.disabled ? "not-allowed" : "pointer",
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        height: "26px",
        "min-width": "26px",
        padding: "0 5px",
        "border-radius": "4px",
        color: props.disabled ? "var(--color-text-faint)" : hover() ? "var(--color-text)" : "var(--color-text-muted)",
        background: hover() && !props.disabled ? "var(--color-bg-subtle)" : "transparent",
        opacity: props.disabled ? 0.45 : 1,
        "font-family": FONT_MONO,
        transition:
          "background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)",
      }}
    >
      {props.children}
    </button>
  )
}

// "Fit to view" — four corner brackets framing the content.
function FitGlyph(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 5V3.5A.5.5 0 0 1 3.5 3H5 M9 3h1.5a.5.5 0 0 1 .5.5V5 M11 9v1.5a.5.5 0 0 1-.5.5H9 M5 11H3.5a.5.5 0 0 1-.5-.5V9" />
    </svg>
  )
}

function iconBtn(disabled: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: disabled ? "not-allowed" : "pointer",
    color: "var(--color-text-faint)",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    padding: "0 4px",
    height: "20px",
    "min-width": "20px",
    "border-radius": "4px",
    opacity: disabled ? 0.5 : 1,
    "font-family": FONT_MONO,
  } as JSX.CSSProperties
}
