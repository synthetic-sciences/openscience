import { For, Show, createEffect, createMemo, createResource, createSignal, on, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { uiStore } from "@/atlas/store/ui"
import {
  IconActivity,
  IconAlertCircle,
  IconCheckCircle,
  IconDownload,
  IconFile,
  IconNetwork,
  IconRefresh,
  IconSearch,
} from "@/atlas/shared/Icon"

type Kind = "artifact" | "run" | "source" | "claim"
type Relation = "produced" | "consumed" | "derived-from" | "supports" | "refutes"
type Filter = "all" | Kind | "review"

interface Node {
  id: string
  kind: Kind
  label: string
  recordedAt: string
  meta?: Record<string, unknown>
  artifactType?: string
  path?: string
  contentHash?: string
  size?: number
  tool?: string
  status?: "ok" | "error"
}

interface Edge {
  from: string
  to: string
  relation: Relation
}

interface Graph {
  nodes: Node[]
  edges: Edge[]
  summary: {
    total: number
    edges: number
    kinds: Record<Kind, number>
    reviews: {
      supports: number
      refutes: number
      blocking: number
      major: number
      minor: number
      info: number
    }
    orphan_edges: number
  }
}

const colors: Record<Kind, string> = {
  source: "#5c7cfa",
  run: "#e6a23c",
  artifact: "#2f9e74",
  claim: "#9c6ade",
}

export function EvidenceGraph(props: { active: boolean }): JSX.Element {
  const sdk = useSDK()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch
  const endpoint = (path = "") => {
    const url = new URL(`${sdk.url.replace(/\/+$/, "")}/provenance${path}`)
    url.searchParams.set("directory", sdk.directory)
    return url.toString()
  }
  const [latest, setLatest] = createSignal<Graph>()
  const load = async () => {
    const response = await fetchFn(endpoint())
    if (!response.ok) throw new Error(await response.text())
    const value = (await response.json()) as Graph
    setLatest(value)
    return value
  }
  const [graph, graphApi] = createResource(() => sdk.directory, load)
  const data = createMemo(() => latest() ?? (graph.error ? undefined : graph()))
  const refresh = () => Promise.resolve(graphApi.refetch()).catch(() => undefined)
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<Filter>("all")
  const [selected, setSelected] = createSignal<string>()
  const nodes = createMemo(() => {
    const value = query().trim().toLowerCase()
    return (data()?.nodes ?? [])
      .filter((node) => filter() === "all" || node.kind === filter() || (filter() === "review" && node.meta?.review))
      .filter(
        (node) =>
          !value ||
          node.label.toLowerCase().includes(value) ||
          node.id.toLowerCase().includes(value) ||
          node.kind.includes(value),
      )
      .toSorted((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
  })
  const current = createMemo(() => data()?.nodes.find((node) => node.id === selected()))
  const related = createMemo(() =>
    (data()?.edges ?? []).filter((edge) => edge.from === selected() || edge.to === selected()),
  )
  const positions = createMemo(() => layout(nodes().slice(0, 48)))

  createEffect(() => {
    const list = nodes()
    if (!list.length) {
      setSelected(undefined)
      return
    }
    if (!selected() || !list.some((node) => node.id === selected())) setSelected(list[0].id)
  })

  createEffect(
    on(
      () => props.active,
      (active, previous) => {
        if (!active || previous !== false || graph.loading) return
        void refresh()
      },
    ),
  )

  const exportAudit = async () => {
    const response = await fetchFn(endpoint("/export"))
    if (!response.ok) return
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement("a")
    link.href = url
    link.download = "openscience-provenance-audit.json"
    link.click()
    URL.revokeObjectURL(url)
  }

  const audit = () => {
    uiStore.setAgent("research")
    uiStore.setPrefill(
      "Audit the important claims, numbers, figures, and reports in this workspace. Use the reviewer agent and the provenance graph. Trace each claim to concrete evidence, record supported and refuted findings with provenance_review, and give me a blocking/major/minor summary.",
    )
    uiStore.setPrefillSend(true)
  }

  return (
    <div style={shell}>
      <header style={header}>
        <div style={{ display: "flex", "align-items": "center", gap: "8px", "min-width": 0 }}>
          <span style={mark}>
            <IconNetwork size={13} strokeWidth={1.5} />
          </span>
          <div style={{ display: "flex", "flex-direction": "column", "min-width": 0 }}>
            <span style={title}>evidence & lineage</span>
            <span style={subtitle}>
              {data()?.summary.total ?? 0} nodes · {data()?.summary.edges ?? 0} links
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          <Action title="export audit" onClick={() => void exportAudit()}>
            <IconDownload size={12} />
          </Action>
          <Action title="refresh evidence" onClick={() => void refresh()}>
            <IconRefresh size={12} />
          </Action>
        </div>
      </header>

      <Show when={graph.error}>
        <div role="alert" style={errorBox}>
          <span>
            {data()
              ? "Evidence could not refresh. The last available lineage is still shown."
              : "Evidence is unavailable."}
          </span>
          <button type="button" style={primaryButton} onClick={() => void refresh()}>
            retry
          </button>
        </div>
      </Show>

      <Show
        when={(data()?.nodes.length ?? 0) > 0}
        fallback={
          <div style={empty}>
            <span style={emptyMark}>
              <IconNetwork size={19} />
            </span>
            <strong>No recorded lineage yet</strong>
            <span>
              Local project content stays in Files. Notebook runs and research agents record sources, runs, outputs,
              claims, and reviews here.
            </span>
            <button type="button" style={primaryButton} onClick={audit}>
              audit this workspace
            </button>
          </div>
        }
      >
        <section style={scoreRow} aria-label="Evidence summary">
          <Score label="sources" value={data()?.summary.kinds.source ?? 0} color={colors.source} />
          <Score label="runs" value={data()?.summary.kinds.run ?? 0} color={colors.run} />
          <Score label="outputs" value={data()?.summary.kinds.artifact ?? 0} color={colors.artifact} />
          <Score label="claims" value={data()?.summary.kinds.claim ?? 0} color={colors.claim} />
        </section>

        <Show when={(data()?.summary.reviews.blocking ?? 0) + (data()?.summary.reviews.major ?? 0) > 0}>
          <div style={warning}>
            <IconAlertCircle size={12} />
            <span>
              {data()?.summary.reviews.blocking ?? 0} blocking · {data()?.summary.reviews.major ?? 0} major findings
            </span>
          </div>
        </Show>

        <div style={controls}>
          <label style={search}>
            <IconSearch size={11} />
            <input
              aria-label="Search evidence"
              style={{
                all: "unset",
                flex: 1,
                "font-family": FONT_MONO,
                "font-size": "9px",
                color: "var(--color-text)",
              }}
              value={query()}
              placeholder="Search evidence"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div style={filters}>
            <For each={["all", "source", "run", "artifact", "claim", "review"] as Filter[]}>
              {(value) => (
                <button
                  type="button"
                  data-active={filter() === value ? "true" : "false"}
                  style={filterButton(filter() === value)}
                  onClick={() => setFilter(value)}
                >
                  {value === "artifact" ? "output" : value}
                </button>
              )}
            </For>
          </div>
        </div>

        <div style={map}>
          <svg
            viewBox="0 0 360 188"
            role="img"
            aria-label="Evidence lineage graph"
            style={{ width: "100%", height: "188px" }}
          >
            <For each={(data()?.edges ?? []).filter((edge) => positions().has(edge.from) && positions().has(edge.to))}>
              {(edge) => {
                const from = () => positions().get(edge.from)!
                const to = () => positions().get(edge.to)!
                return (
                  <line
                    x1={from().x}
                    y1={from().y}
                    x2={to().x}
                    y2={to().y}
                    stroke={edge.relation === "refutes" ? "var(--color-danger)" : "var(--color-border-strong)"}
                    stroke-width={edge.relation === "refutes" ? "1.6" : "1"}
                    stroke-dasharray={edge.relation === "derived-from" ? "3 3" : undefined}
                  />
                )
              }}
            </For>
            <For each={nodes().slice(0, 48)}>
              {(node) => {
                const point = () => positions().get(node.id)!
                return (
                  <g
                    role="button"
                    tabindex="0"
                    aria-label={`${node.kind === "artifact" ? "output" : node.kind}: ${node.label}`}
                    onClick={() => setSelected(node.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setSelected(node.id)
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <circle
                      cx={point().x}
                      cy={point().y}
                      r={selected() === node.id ? 7 : 5}
                      fill={colors[node.kind]}
                      stroke={selected() === node.id ? "var(--color-text)" : "var(--color-bg)"}
                      stroke-width="2"
                    />
                    <title>{node.label}</title>
                  </g>
                )
              }}
            </For>
          </svg>
          <div style={legend}>
            <span>source</span>
            <span>run</span>
            <span>output</span>
            <span>claim / review</span>
          </div>
        </div>

        <div style={body}>
          <div style={nodeList}>
            <For each={nodes()}>
              {(node) => (
                <button type="button" style={nodeRow(selected() === node.id)} onClick={() => setSelected(node.id)}>
                  <span style={{ ...nodeDot, background: colors[node.kind] }} />
                  <span style={{ display: "flex", "flex-direction": "column", gap: "2px", flex: 1, "min-width": 0 }}>
                    <strong>{node.label}</strong>
                    <small>
                      {node.kind === "artifact" ? "output" : node.kind} · {status(node, data()?.edges ?? [])}
                    </small>
                  </span>
                </button>
              )}
            </For>
          </div>

          <Show when={current()}>
            {(node) => (
              <section style={detail}>
                <div style={{ display: "flex", "align-items": "flex-start", gap: "8px" }}>
                  <span style={{ ...detailMark, color: colors[node().kind] }}>
                    <KindIcon node={node()} />
                  </span>
                  <span style={{ display: "flex", "flex-direction": "column", gap: "3px", flex: 1, "min-width": 0 }}>
                    <strong>{node().label}</strong>
                    <small>
                      {node().kind === "artifact" ? "output" : node().kind} · {node().id}
                    </small>
                  </span>
                  <State node={node()} edges={data()?.edges ?? []} />
                </div>
                <Show when={node().path}>
                  <div style={property}>
                    <span>path</span>
                    <strong>{node().path}</strong>
                  </div>
                </Show>
                <Show when={node().tool}>
                  <div style={property}>
                    <span>tool</span>
                    <strong>{node().tool}</strong>
                  </div>
                </Show>
                <Show when={node().meta?.claim}>
                  <div style={claimCard}>
                    <span>claim</span>
                    <p>{String(node().meta?.claim)}</p>
                  </div>
                </Show>
                <Show when={node().meta?.issue}>
                  <div style={finding(node().meta?.severity)}>
                    <span>{String(node().meta?.severity ?? "review")} finding</span>
                    <strong>{String(node().meta?.issue)}</strong>
                    <small>{String(node().meta?.evidence ?? "")}</small>
                  </div>
                </Show>
                <div style={relationList}>
                  <For each={related()}>
                    {(edge) => {
                      const other = () =>
                        data()?.nodes.find((item) => item.id === (edge.from === node().id ? edge.to : edge.from))
                      return (
                        <button
                          type="button"
                          style={relationButton}
                          onClick={() => other() && setSelected(other()!.id)}
                        >
                          <span>{edge.relation}</span>
                          <strong>{other()?.label ?? "missing node"}</strong>
                        </button>
                      )
                    }}
                  </For>
                </div>
                <button type="button" style={auditButton} onClick={audit}>
                  <IconCheckCircle size={11} />
                  run reviewer audit
                </button>
              </section>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

function Score(props: { label: string; value: number; color: string }): JSX.Element {
  return (
    <div style={score}>
      <strong style={{ color: props.color }}>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  )
}

function KindIcon(props: { node: Node }): JSX.Element {
  if (props.node.kind === "run") return <IconActivity size={12} />
  if (props.node.kind === "artifact") return <IconFile size={12} />
  if (props.node.kind === "claim") return <IconCheckCircle size={12} />
  return <IconNetwork size={12} />
}

function State(props: { node: Node; edges: Edge[] }): JSX.Element {
  const value = () => status(props.node, props.edges)
  const color = () => {
    if (value() === "supported") return "var(--color-success)"
    if (value() === "flagged") return "var(--color-danger)"
    return "var(--color-text-faint)"
  }
  return <span style={{ ...state, color: color() }}>{value()}</span>
}

function status(node: Node, edges: Edge[]): string {
  if (node.meta?.review === true) return String(node.meta.verdict ?? "reviewed")
  if (edges.some((edge) => edge.to === node.id && edge.relation === "refutes")) return "flagged"
  if (edges.some((edge) => edge.to === node.id && edge.relation === "supports")) return "supported"
  if (node.kind === "run") return node.status === "error" ? "failed" : "recorded"
  return "unchecked"
}

function layout(nodes: Node[]): Map<string, { x: number; y: number }> {
  const columns: Record<Kind, number> = { source: 45, run: 135, artifact: 225, claim: 315 }
  const groups = new Map<Kind, Node[]>([
    ["source", []],
    ["run", []],
    ["artifact", []],
    ["claim", []],
  ])
  for (const node of nodes) groups.get(node.kind)?.push(node)
  const points = new Map<string, { x: number; y: number }>()
  for (const [kind, values] of groups) {
    const gap = 150 / Math.max(1, values.length)
    values.forEach((node, index) => points.set(node.id, { x: columns[kind], y: 19 + gap * (index + 0.5) }))
  }
  return points
}

function Action(props: { title: string; onClick: () => void; children: JSX.Element }): JSX.Element {
  return (
    <button type="button" title={props.title} aria-label={props.title} onClick={props.onClick} style={action}>
      {props.children}
    </button>
  )
}

const shell: JSX.CSSProperties = {
  flex: 1,
  "min-height": 0,
  display: "flex",
  "flex-direction": "column",
  overflow: "hidden",
  background: "var(--color-bg-subtle)",
  "font-family": FONT_SANS,
}

const header: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "10px",
  padding: "10px",
  border: "1px solid transparent",
  "border-bottom-color": "var(--color-border)",
  background: "var(--color-bg)",
  "flex-shrink": 0,
}

const mark: JSX.CSSProperties = {
  width: "27px",
  height: "27px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  "border-radius": "6px",
  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  color: "var(--color-accent)",
}

const title: JSX.CSSProperties = {
  color: "var(--color-text)",
  "font-size": "12px",
  "font-weight": 680,
  "letter-spacing": "-0.01em",
}

const subtitle: JSX.CSSProperties = {
  color: "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "9px",
}

const action: JSX.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  width: "27px",
  height: "27px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  "border-radius": "4px",
  border: "1px solid var(--color-border)",
  background: "var(--color-bg-elevated)",
  color: "var(--color-text-muted)",
  "box-sizing": "border-box",
}

const scoreRow: JSX.CSSProperties = {
  display: "grid",
  "grid-template-columns": "repeat(4, minmax(0, 1fr))",
  gap: "1px",
  border: "1px solid var(--color-border)",
  "border-width": "0 0 1px",
  background: "var(--color-border)",
}

const score: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "2px",
  padding: "9px 8px",
  background: "var(--color-bg)",
  "text-align": "center",
  "font-family": FONT_MONO,
  "font-size": "8px",
  color: "var(--color-text-faint)",
}

const warning: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "6px",
  padding: "7px 10px",
  background: "color-mix(in srgb, var(--color-danger) 8%, transparent)",
  color: "var(--color-danger)",
  "font-family": FONT_MONO,
  "font-size": "9px",
  border: "1px solid transparent",
  "border-bottom-color": "color-mix(in srgb, var(--color-danger) 24%, transparent)",
}

const controls: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "6px",
  padding: "8px",
  border: "1px solid transparent",
  "border-bottom-color": "var(--color-border)",
  background: "var(--color-bg)",
}

const search: JSX.CSSProperties = {
  height: "29px",
  display: "flex",
  "align-items": "center",
  gap: "6px",
  padding: "0 8px",
  border: "1px solid var(--color-border)",
  "border-radius": "4px",
  color: "var(--color-text-faint)",
  background: "var(--color-bg-subtle)",
}

const filters: JSX.CSSProperties = {
  display: "flex",
  gap: "3px",
  overflow: "auto",
}

const filterButton = (active: boolean): JSX.CSSProperties => ({
  all: "unset",
  cursor: "pointer",
  padding: "4px 6px",
  border: "1px solid",
  "border-color": active ? "var(--color-accent)" : "var(--color-border)",
  "border-radius": "999px",
  background: active ? "var(--color-accent-subtle)" : "transparent",
  color: active ? "var(--color-accent)" : "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "8px",
})

const map: JSX.CSSProperties = {
  position: "relative",
  height: "210px",
  "flex-shrink": 0,
  background:
    "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-text-faint) 18%, transparent) 1px, transparent 0)",
  "background-size": "14px 14px",
  border: "1px solid transparent",
  "border-bottom-color": "var(--color-border)",
}

const legend: JSX.CSSProperties = {
  position: "absolute",
  left: "8px",
  right: "8px",
  bottom: "6px",
  display: "flex",
  "justify-content": "space-between",
  color: "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "7px",
  "text-transform": "uppercase",
  "letter-spacing": "0.04em",
}

const body: JSX.CSSProperties = {
  flex: 1,
  "min-height": 0,
  overflow: "auto",
  display: "flex",
  "flex-direction": "column",
}

const nodeList: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "2px",
  padding: "6px",
  "max-height": "176px",
  overflow: "auto",
  border: "1px solid transparent",
  "border-bottom-color": "var(--color-border)",
}

const nodeRow = (active: boolean): JSX.CSSProperties => ({
  cursor: "pointer",
  width: "100%",
  display: "flex",
  "align-items": "center",
  gap: "7px",
  padding: "7px",
  border: "1px solid",
  "border-color": active ? "var(--color-border-strong)" : "transparent",
  "border-radius": "4px",
  background: active ? "var(--color-surface-solid)" : "transparent",
  "text-align": "left",
  color: "var(--color-text)",
  "font-family": FONT_SANS,
  "font-size": "10px",
})

const nodeDot: JSX.CSSProperties = {
  width: "7px",
  height: "7px",
  "border-radius": "50%",
  "flex-shrink": 0,
}

const detail: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
  padding: "10px",
  background: "var(--color-bg)",
}

const detailMark: JSX.CSSProperties = {
  width: "25px",
  height: "25px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  "border-radius": "5px",
  border: "1px solid var(--color-border)",
  "flex-shrink": 0,
}

const state: JSX.CSSProperties = {
  padding: "3px 5px",
  border: "1px solid currentColor",
  "border-radius": "999px",
  "font-family": FONT_MONO,
  "font-size": "7px",
  "text-transform": "uppercase",
}

const property: JSX.CSSProperties = {
  display: "grid",
  "grid-template-columns": "52px minmax(0, 1fr)",
  gap: "8px",
  color: "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "8px",
  "overflow-wrap": "anywhere",
}

const claimCard: JSX.CSSProperties = {
  padding: "8px",
  border: "1px solid color-mix(in srgb, #9c6ade 32%, var(--color-border))",
  "border-radius": "5px",
  background: "color-mix(in srgb, #9c6ade 6%, var(--color-bg))",
  color: "var(--color-text-muted)",
  "font-size": "10px",
  "line-height": 1.45,
}

const finding = (severity: unknown): JSX.CSSProperties => ({
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
  padding: "8px",
  border: "1px solid",
  "border-color":
    severity === "blocking" || severity === "major"
      ? "color-mix(in srgb, var(--color-danger) 38%, var(--color-border))"
      : "var(--color-border)",
  "border-radius": "5px",
  background:
    severity === "blocking" || severity === "major"
      ? "color-mix(in srgb, var(--color-danger) 7%, var(--color-bg))"
      : "var(--color-bg-subtle)",
  color: "var(--color-text-muted)",
  "font-family": FONT_MONO,
  "font-size": "8px",
  "line-height": 1.4,
})

const relationList: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "3px",
}

const relationButton: JSX.CSSProperties = {
  cursor: "pointer",
  display: "grid",
  "grid-template-columns": "72px minmax(0, 1fr)",
  gap: "6px",
  padding: "5px 6px",
  border: "1px solid var(--color-border)",
  "border-radius": "4px",
  background: "var(--color-bg-subtle)",
  color: "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "8px",
  "text-align": "left",
}

const auditButton: JSX.CSSProperties = {
  cursor: "pointer",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  gap: "5px",
  padding: "6px 8px",
  border: "1px solid var(--color-accent)",
  "border-radius": "4px",
  background: "var(--color-accent-subtle)",
  color: "var(--color-accent)",
  "font-family": FONT_MONO,
  "font-size": "9px",
}

const errorBox: JSX.CSSProperties = {
  margin: "8px",
  padding: "8px",
  border: "1px solid color-mix(in srgb, var(--color-danger) 35%, transparent)",
  "border-radius": "4px",
  color: "var(--color-danger)",
  "font-family": FONT_MONO,
  "font-size": "9px",
}

const empty: JSX.CSSProperties = {
  flex: 1,
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  "justify-content": "center",
  gap: "9px",
  padding: "30px 22px",
  color: "var(--color-text-muted)",
  "font-size": "11px",
  "line-height": 1.5,
  "text-align": "center",
}

const emptyMark: JSX.CSSProperties = {
  width: "40px",
  height: "40px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  "border-radius": "10px",
  background: "var(--color-surface-solid)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text-faint)",
}

const primaryButton: JSX.CSSProperties = {
  cursor: "pointer",
  border: "1px solid var(--color-accent)",
  "border-radius": "4px",
  background: "var(--color-accent)",
  color: "var(--color-bg)",
  padding: "6px 10px",
  "font-family": FONT_MONO,
  "font-size": "9px",
  "font-weight": 650,
}
