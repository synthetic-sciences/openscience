import { For, Match, Show, Switch, createResource, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { FONT_CODE, FONT_MONO, FONT_SANS } from "@/styles/tokens"
import {
  formatBytes,
  embedding as parseEmbedding,
  normalizeInspection,
  numbers,
  object,
  objects,
  strings,
  type BinaryInspection,
  type BinaryScienceFormat,
  type Embedding,
} from "./binary"

function sentence(value: string) {
  const text = value.trim()
  if (!text) return text
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`
}

export function BinaryScienceView(props: {
  path: string
  directory: string
  sessionID?: string
  format: BinaryScienceFormat
}): JSX.Element {
  const sdk = useSDK()
  const [inspection, { refetch }] = createResource(
    () => [props.directory, props.path, props.sessionID] as const,
    async ([, path, sessionID]) => {
      const response = await sdk.request("/file/inspect", undefined, { path, sessionID })
      if (!response.ok) throw new Error(`inspection failed (${response.status})`)
      return normalizeInspection(await response.json())
    },
  )

  return (
    <div
      data-component="binary-science"
      data-format={props.format}
      style={{
        height: "100%",
        "min-height": "100%",
        display: "flex",
        "flex-direction": "column",
        background: "var(--color-bg-subtle)",
      }}
    >
      <Show
        when={!inspection.loading}
        fallback={
          <div style={empty()}>
            <Pulse />
            <strong style={title()}>Inspecting {props.format.toUpperCase()}</strong>
            <span style={muted()}>Reading local metadata without uploading the file</span>
          </div>
        }
      >
        <Show
          when={!inspection.error && inspection()}
          fallback={
            <div style={empty()}>
              <strong style={title()}>Could not inspect this file</strong>
              <span style={muted()}>
                {inspection.error instanceof Error ? inspection.error.message : String(inspection.error)}
              </span>
              <button type="button" style={button()} onClick={() => void refetch()}>
                Retry
              </button>
            </div>
          }
        >
          {(file) => (
            <div class="atlas-scroll" style={{ flex: 1, overflow: "auto", padding: "14px" }}>
              <div style={{ display: "grid", gap: "12px", "max-width": "1100px", margin: "0 auto" }}>
                <Header file={file()} />
                <Show when={!file().tool.available}>
                  <Capability file={file()} />
                </Show>
                <Switch>
                  <Match when={file().format === "h5ad" || file().format === "loom"}>
                    <Hdf5 file={file()} />
                  </Match>
                  <Match when={file().format === "bam" || file().format === "cram"}>
                    <Alignment file={file()} />
                  </Match>
                </Switch>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

function Header(props: { file: BinaryInspection }): JSX.Element {
  return (
    <>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          padding: "13px 14px",
          border: "1px solid var(--color-border)",
          "border-radius": "8px",
          background: "var(--color-bg)",
        }}
      >
        <div
          style={{
            width: "34px",
            height: "34px",
            display: "grid",
            "place-items": "center",
            "border-radius": "7px",
            background: "color-mix(in srgb, var(--color-accent) 11%, transparent)",
            color: "var(--color-accent)",
            "font-family": FONT_MONO,
            "font-size": "10px",
            "font-weight": "var(--font-weight-emphasis)",
          }}
        >
          {props.file.format.toUpperCase()}
        </div>
        <div style={{ flex: 1, "min-width": 0 }}>
          <strong
            style={{
              display: "block",
              "font-family": FONT_SANS,
              "font-size": "13px",
              color: "var(--color-text)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {props.file.name}
          </strong>
          <span style={muted()}>local · never uploaded</span>
        </div>
        <Status ok={props.file.signature} label={props.file.signature ? "signature valid" : "signature unverified"} />
        <Status
          ok={props.file.tool.available}
          label={props.file.tool.available ? `${props.file.tool.name} ready` : `${props.file.tool.name} missing`}
        />
      </div>
      <div
        style={{
          display: "grid",
          "grid-template-columns": "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "8px",
        }}
      >
        <Metric label="file size" value={formatBytes(props.file.size)} detail="streamed on download" />
        <Metric
          label="format"
          value={props.file.format.toUpperCase()}
          detail={props.file.signature ? "recognized container" : "extension match"}
        />
        <Metric
          label="index"
          value={props.file.index ? "ready" : "none"}
          detail={props.file.index ?? indexHint(props.file.format)}
        />
        <Metric
          label="inspector"
          value={props.file.tool.available ? "available" : "limited"}
          detail={props.file.tool.detail ?? props.file.tool.name}
        />
      </div>
    </>
  )
}

function Capability(props: { file: BinaryInspection }): JSX.Element {
  const hdf = props.file.format === "h5ad" || props.file.format === "loom"
  return (
    <section
      data-slot="binary-capability"
      style={{
        padding: "13px 14px",
        border: "1px solid color-mix(in srgb, #d4a72c 45%, var(--color-border))",
        "border-radius": "8px",
        background: "color-mix(in srgb, #d4a72c 7%, var(--color-bg))",
      }}
    >
      <div style={{ display: "flex", gap: "10px", "align-items": "flex-start" }}>
        <span style={{ color: "#b07a00", "font-size": "14px" }}>◇</span>
        <div style={{ display: "grid", gap: "5px" }}>
          <strong style={{ "font-family": FONT_SANS, "font-size": "11px", color: "var(--color-text)" }}>
            Add {props.file.tool.name} for full schema inspection
          </strong>
          <span style={{ ...muted(), "line-height": 1.55 }}>
            {props.file.tool.detail ||
              "The file was identified safely, but its scientific metadata needs a local reader."}
          </span>
          <code
            style={{
              width: "fit-content",
              padding: "5px 7px",
              "border-radius": "4px",
              background: "var(--color-bg-subtle)",
              "font-family": FONT_CODE,
              "font-size": "10px",
              color: "var(--color-text-muted)",
              "user-select": "all",
            }}
          >
            {hdf ? "python -m pip install h5py anndata" : "conda install -c bioconda samtools"}
          </code>
        </div>
      </div>
    </section>
  )
}

function Hdf5(props: { file: BinaryInspection }): JSX.Element {
  const summary = () => object(props.file.details.summary)
  const matrix = () => numbers(summary().matrix)
  const datasets = () => objects(props.file.details.datasets)
  const groups = () => strings(props.file.details.groups)
  const embeddings = () => strings(summary().embeddings)
  const layers = () => strings(summary().layers)
  const row = () => strings(summary().row_attributes)
  const column = () => strings(summary().column_attributes)
  const embedding = () => parseEmbedding(props.file.details.embedding)
  return (
    <>
      <Show when={props.file.tool.available}>
        <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(150px, 1fr))", gap: "8px" }}>
          <Metric
            label="matrix"
            value={
              matrix().length
                ? matrix()
                    .map((value) => value.toLocaleString())
                    .join(" × ")
                : "—"
            }
            detail={props.file.format === "h5ad" ? "observations × variables" : "rows × columns"}
          />
          <Metric
            label="observations"
            value={scalar(summary().observations)}
            detail={`${row().length} row attributes`}
          />
          <Metric
            label="variables"
            value={scalar(summary().variables)}
            detail={`${column().length} column attributes`}
          />
          <Metric label="datasets" value={String(datasets().length)} detail={`${groups().length} groups`} />
        </div>
        <Show when={embedding()}>{(value) => <EmbeddingPlot value={value()} />}</Show>
        <Show when={embeddings().length || layers().length || row().length || column().length}>
          <Panel title="Scientific schema" note="Analysis-ready structures">
            <div style={{ display: "grid", gap: "10px" }}>
              <Tags label="embeddings" values={embeddings()} />
              <Tags label="layers" values={layers()} />
              <Tags label="row attributes" values={row()} />
              <Tags label="column attributes" values={column()} />
            </div>
          </Panel>
        </Show>
        <Panel title="Dataset inventory" note={`First ${datasets().length} datasets`}>
          <div style={{ overflow: "auto" }}>
            <table style={table()}>
              <thead>
                <tr>
                  <th style={head()}>Path</th>
                  <th style={head()}>Shape</th>
                  <th style={head()}>Data type</th>
                  <th style={head()}>Storage</th>
                </tr>
              </thead>
              <tbody>
                <For each={datasets()}>
                  {(dataset) => (
                    <tr>
                      <td style={cell(true)}>{String(dataset.path ?? "")}</td>
                      <td style={cell(true)}>{numbers(dataset.shape).join(" × ") || "scalar"}</td>
                      <td style={cell()}>{String(dataset.dtype ?? "")}</td>
                      <td style={cell()}>{formatBytes(typeof dataset.bytes === "number" ? dataset.bytes : 0)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Panel>
      </Show>
      <Show when={!props.file.tool.available}>
        <Fallback
          title={`${props.file.format.toUpperCase()} container detected`}
          body="OpenScience verified the HDF5 signature and preserved the file locally. Install the optional reader above to reveal observations, variables, embeddings, layers, and every dataset."
        />
      </Show>
    </>
  )
}

function EmbeddingPlot(props: { value: Embedding }): JSX.Element {
  const extent = () => {
    const xs = props.value.points.map((point) => point.x)
    const ys = props.value.points.map((point) => point.y)
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    }
  }
  const point = (value: number, min: number, max: number, start: number, span: number) =>
    start + ((value - min) / Math.max(Number.EPSILON, max - min)) * span
  const labels = () => {
    const counts = new Map<string, number>()
    for (const item of props.value.points) {
      if (!item.label) continue
      counts.set(item.label, (counts.get(item.label) ?? 0) + 1)
    }
    return [...counts.entries()].toSorted((a, b) => b[1] - a[1])
  }
  return (
    <Panel
      title="Embedding preview"
      note={`${props.value.name} · ${props.value.points.length.toLocaleString()} of ${props.value.total.toLocaleString()} observations`}
    >
      <div
        style={{
          display: "grid",
          "grid-template-columns": labels().length ? "minmax(0, 1fr) 150px" : "1fr",
          gap: "12px",
        }}
      >
        <svg
          viewBox="0 0 720 360"
          role="img"
          aria-label={`${props.value.name} embedding scatter plot`}
          style={{
            width: "100%",
            "min-height": "260px",
            border: "1px solid var(--color-border)",
            "border-radius": "6px",
            background:
              "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-text-faint) 16%, transparent) 1px, transparent 0)",
            "background-size": "18px 18px",
          }}
        >
          <line x1="32" y1="330" x2="700" y2="330" stroke="var(--color-border-strong)" stroke-width="1" />
          <line x1="32" y1="18" x2="32" y2="330" stroke="var(--color-border-strong)" stroke-width="1" />
          <For each={props.value.points}>
            {(item) => (
              <circle
                cx={point(item.x, extent().minX, extent().maxX, 40, 650)}
                cy={point(item.y, extent().maxY, extent().minY, 24, 296)}
                r={props.value.points.length > 1_500 ? 1.65 : 2.15}
                fill={item.label ? color(item.label) : "var(--color-accent)"}
                fill-opacity="0.72"
              >
                <title>
                  {item.label ? `${item.label} · ` : ""}
                  {item.x.toFixed(3)}, {item.y.toFixed(3)}
                </title>
              </circle>
            )}
          </For>
          <text x="690" y="350" fill="var(--color-text-faint)" font-size="10" font-family={FONT_MONO}>
            {props.value.name} 1
          </text>
          <text
            x="12"
            y="28"
            fill="var(--color-text-faint)"
            font-size="10"
            font-family={FONT_MONO}
            transform="rotate(-90 12 28)"
          >
            {props.value.name} 2
          </text>
        </svg>
        <Show when={labels().length}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "7px", "min-width": 0 }}>
            <span style={{ ...muted(), "font-size": "9px" }}>{sentence(props.value.label ?? "groups")}</span>
            <For each={labels().slice(0, 14)}>
              {(item) => (
                <div
                  style={{
                    display: "grid",
                    "grid-template-columns": "7px minmax(0, 1fr) auto",
                    gap: "6px",
                    "align-items": "center",
                    "font-family": FONT_MONO,
                    "font-size": "9px",
                    color: "var(--color-text-muted)",
                  }}
                >
                  <span style={{ width: "7px", height: "7px", "border-radius": "50%", background: color(item[0]) }} />
                  <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                    {item[0]}
                  </span>
                  <span style={{ color: "var(--color-text-faint)" }}>{item[1].toLocaleString()}</span>
                </div>
              )}
            </For>
            <Show when={labels().length > 14}>
              <span style={muted()}>+{labels().length - 14} more groups</span>
            </Show>
          </div>
        </Show>
      </div>
    </Panel>
  )
}

const palette = ["#5c7cfa", "#2f9e74", "#e6a23c", "#9c6ade", "#e8590c", "#0ca678", "#d6336c", "#1098ad"]

function color(value: string): string {
  const hash = [...value].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 0)
  return palette[hash % palette.length]!
}

function Alignment(props: { file: BinaryInspection }): JSX.Element {
  const header = () => object(props.file.details.header)
  const references = () => objects(props.file.details.references)
  const chromosomes = () => objects(props.file.details.chromosomes)
  const max = () => Math.max(1, ...chromosomes().map((item) => (typeof item.mapped === "number" ? item.mapped : 0)))
  return (
    <>
      <Show when={props.file.tool.available}>
        <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(150px, 1fr))", gap: "8px" }}>
          <Metric label="references" value={String(references().length)} detail="header sequences" />
          <Metric
            label="version"
            value={String(header().VN ?? props.file.details.version ?? "—")}
            detail={props.file.format.toUpperCase()}
          />
          <Metric label="sort order" value={String(header().SO ?? "unknown")} detail="alignment header" />
          <Metric
            label="mapped reads"
            value={compact(
              chromosomes().reduce((total, item) => total + (typeof item.mapped === "number" ? item.mapped : 0), 0),
            )}
            detail={props.file.index ? "from index" : "index required"}
          />
        </div>
        <Panel
          title="Reference coverage"
          note={props.file.index ? "Mapped reads from the adjacent index" : "Add an index for counts"}
        >
          <Show
            when={chromosomes().length}
            fallback={
              <span style={muted()}>
                Header loaded. Place a BAI/CRAI beside the file to calculate per-reference counts.
              </span>
            }
          >
            <div style={{ display: "grid", gap: "7px" }}>
              <For each={chromosomes().slice(0, 40)}>
                {(item) => {
                  const mapped = typeof item.mapped === "number" ? item.mapped : 0
                  return (
                    <div
                      style={{
                        display: "grid",
                        "grid-template-columns": "90px 1fr 70px",
                        gap: "8px",
                        "align-items": "center",
                      }}
                    >
                      <span style={{ ...muted(), overflow: "hidden", "text-overflow": "ellipsis" }}>
                        {String(item.name ?? "")}
                      </span>
                      <div
                        style={{
                          height: "5px",
                          "border-radius": "99px",
                          background: "var(--color-border)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${(mapped / max()) * 100}%`,
                            height: "100%",
                            background: "var(--color-accent)",
                          }}
                        />
                      </div>
                      <span style={{ ...muted(), "text-align": "right" }}>{mapped.toLocaleString()}</span>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </Panel>
        <Panel title="Reference dictionary" note="Sequences declared in the alignment header">
          <div style={{ overflow: "auto" }}>
            <table style={table()}>
              <thead>
                <tr>
                  <th style={head()}>Reference</th>
                  <th style={head()}>Length</th>
                </tr>
              </thead>
              <tbody>
                <For each={references()}>
                  {(reference) => (
                    <tr>
                      <td style={cell(true)}>{String(reference.name ?? "")}</td>
                      <td style={cell()}>
                        {typeof reference.length === "number" ? reference.length.toLocaleString() : "—"} bp
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Panel>
      </Show>
      <Show when={!props.file.tool.available}>
        <Fallback
          title={`${props.file.format.toUpperCase()} container detected`}
          body={`OpenScience verified the container${props.file.index ? " and found its index" : ""}. Install samtools above to reveal the header, reference dictionary, sort order, and indexed read counts.`}
        />
      </Show>
    </>
  )
}

function Metric(props: { label: string; value: string; detail: string }): JSX.Element {
  return (
    <div style={card()}>
      <span style={muted()}>{sentence(props.label)}</span>
      <strong
        style={{
          display: "block",
          "margin-top": "7px",
          "font-family": FONT_SANS,
          "font-size": "18px",
          "font-weight": "var(--font-weight-emphasis)",
          color: "var(--color-text)",
          "letter-spacing": "-0.02em",
        }}
      >
        {props.value}
      </strong>
      <span
        title={props.detail}
        style={{
          ...muted(),
          display: "block",
          "margin-top": "4px",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.detail}
      </span>
    </div>
  )
}

function Panel(props: { title: string; note: string; children: JSX.Element }): JSX.Element {
  return (
    <section style={card()}>
      <div style={{ display: "flex", "align-items": "baseline", gap: "8px", "margin-bottom": "12px" }}>
        <strong style={{ "font-family": FONT_SANS, "font-size": "12px", color: "var(--color-text)" }}>
          {props.title}
        </strong>
        <span style={muted()}>{props.note}</span>
      </div>
      {props.children}
    </section>
  )
}

function Tags(props: { label: string; values: string[] }): JSX.Element {
  return (
    <Show when={props.values.length}>
      <div style={{ display: "grid", "grid-template-columns": "100px 1fr", gap: "8px" }}>
        <span style={muted()}>{sentence(props.label)}</span>
        <div style={{ display: "flex", gap: "5px", "flex-wrap": "wrap" }}>
          <For each={props.values.slice(0, 30)}>
            {(value) => (
              <code
                style={{
                  padding: "2px 6px",
                  "border-radius": "4px",
                  background: "var(--color-bg-subtle)",
                  "font-family": FONT_CODE,
                  "font-size": "9px",
                  color: "var(--color-text-muted)",
                }}
              >
                {value}
              </code>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

function Fallback(props: { title: string; body: string }): JSX.Element {
  return (
    <div
      style={{
        ...card(),
        padding: "28px",
        display: "grid",
        "place-items": "center",
        gap: "8px",
        "text-align": "center",
      }}
    >
      <div
        style={{
          width: "42px",
          height: "42px",
          display: "grid",
          "place-items": "center",
          "border-radius": "50%",
          background: "var(--color-bg-subtle)",
          color: "var(--color-text-faint)",
          "font-family": FONT_MONO,
        }}
      >
        01
      </div>
      <strong style={title()}>{props.title}</strong>
      <span style={{ ...muted(), "max-width": "580px", "line-height": 1.65 }}>{props.body}</span>
    </div>
  )
}

function Status(props: { ok: boolean; label: string }): JSX.Element {
  return (
    <span
      style={{
        padding: "3px 7px",
        "border-radius": "99px",
        border: `1px solid ${props.ok ? "color-mix(in srgb, #4ca56a 45%, var(--color-border))" : "var(--color-border)"}`,
        background: props.ok ? "color-mix(in srgb, #4ca56a 9%, transparent)" : "var(--color-bg-subtle)",
        color: props.ok ? "#418c59" : "var(--color-text-faint)",
        "font-family": FONT_MONO,
        "font-size": "9px",
        "white-space": "nowrap",
      }}
    >
      {sentence(props.label)}
    </span>
  )
}

function Pulse(): JSX.Element {
  return (
    <span
      style={{
        width: "18px",
        height: "18px",
        border: "2px solid var(--color-border)",
        "border-top-color": "var(--color-accent)",
        "border-radius": "50%",
        animation: "spin 0.8s linear infinite",
      }}
    />
  )
}

function scalar(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString() : "—"
}

function compact(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value)
}

function indexHint(format: BinaryScienceFormat): string {
  if (format === "bam") return "BAI recommended"
  if (format === "cram") return "CRAI recommended"
  return "not required"
}

function table(): JSX.CSSProperties {
  return { width: "100%", "border-collapse": "collapse", "font-family": FONT_SANS, "font-size": "10px" }
}

function head(): JSX.CSSProperties {
  return {
    padding: "6px 8px",
    border: "0",
    "border-bottom": "1px solid var(--color-border)",
    color: "var(--color-text-faint)",
    "font-family": FONT_MONO,
    "font-size": "9px",
    "font-weight": "var(--font-weight-medium)",
    "text-align": "left",
    "letter-spacing": "normal",
  }
}

function cell(mono = false): JSX.CSSProperties {
  return {
    padding: "7px 8px",
    border: "0",
    "border-bottom": "1px solid var(--color-border)",
    color: "var(--color-text-muted)",
    "font-family": mono ? FONT_CODE : FONT_SANS,
    "font-size": "10px",
    "white-space": "nowrap",
  }
}

function card(): JSX.CSSProperties {
  return {
    padding: "12px 14px",
    border: "1px solid var(--color-border)",
    "border-radius": "8px",
    background: "var(--color-bg)",
    "min-width": 0,
  }
}

function muted(): JSX.CSSProperties {
  return { "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }
}

function title(): JSX.CSSProperties {
  return { "font-family": FONT_SANS, "font-size": "13px", color: "var(--color-text)" }
}

function empty(): JSX.CSSProperties {
  return {
    display: "grid",
    "place-items": "center",
    "align-content": "center",
    gap: "9px",
    height: "100%",
    padding: "36px",
    "text-align": "center",
  }
}

function button(): JSX.CSSProperties {
  return {
    padding: "6px 10px",
    border: "1px solid var(--color-border)",
    "border-radius": "5px",
    background: "var(--color-bg)",
    color: "var(--color-text)",
    "font-family": FONT_SANS,
    "font-size": "10px",
    cursor: "pointer",
  }
}

export default BinaryScienceView
