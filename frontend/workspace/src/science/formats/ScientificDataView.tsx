import { For, Match, Show, Switch, createMemo, createSignal, type JSX } from "solid-js"
import { FONT_CODE, FONT_SANS } from "@/styles/tokens"
import {
  parseBiologicalFile,
  type BiologicalFile,
  type BiologicalFormat,
  type Count,
  type FastqFile,
  type IntervalFile,
  type MzmlFile,
  type SamFile,
  type VcfFile,
} from "./biological"

const CONTROL_FONT_SIZE = "12px"
const HELPER_FONT_SIZE = "11.5px"
const TABLE_FONT_SIZE = "12px"
const SECTION_FONT_SIZE = "13px"

function sentence(value: string) {
  const text = value.trim()
  if (!text) return text
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`
}

export function ScientificDataView(props: { text: string; format: BiologicalFormat; name: string }): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [view, setView] = createSignal<"overview" | "records">("overview")
  const parsed = createMemo(() => {
    try {
      return { data: parseBiologicalFile(props.format, props.text), error: "" }
    } catch (cause) {
      return { data: undefined, error: cause instanceof Error ? cause.message : "Could not inspect scientific file" }
    }
  })
  const data = () => parsed().data
  const fastq = () => (data()?.format === "fastq" ? (data() as FastqFile) : undefined)
  const vcf = () => (data()?.format === "vcf" ? (data() as VcfFile) : undefined)
  const interval = () =>
    data()?.format === "bed" || data()?.format === "gff" || data()?.format === "gtf"
      ? (data() as IntervalFile)
      : undefined
  const sam = () => (data()?.format === "sam" ? (data() as SamFile) : undefined)
  const mzml = () => (data()?.format === "mzml" ? (data() as MzmlFile) : undefined)
  const recordCount = () => {
    const value = data()
    if (!value) return 0
    if (value.format === "fastq") return value.reads
    if (value.format === "vcf") return value.variants
    if (value.format === "sam") return value.alignments
    if (value.format === "mzml") return value.spectra
    return value.features
  }

  return (
    <div
      data-component="scientific-data"
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
        when={data()}
        fallback={
          <div style={empty()}>
            <strong
              style={{
                "font-family": FONT_SANS,
                "font-size": "14px",
                "font-weight": "var(--font-weight-medium)",
              }}
            >
              Could not inspect this file
            </strong>
            <span
              style={{ "font-family": FONT_SANS, "font-size": CONTROL_FONT_SIZE, color: "var(--color-text-faint)" }}
            >
              {parsed().error}
            </span>
          </div>
        }
      >
        {(value) => (
          <>
            <div
              style={{
                display: "flex",
                "align-items": "center",
                gap: "8px",
                padding: "10px 12px",
                border: "0",
                "border-bottom": "1px solid var(--color-border)",
                background: "var(--color-bg)",
                "flex-wrap": "wrap",
              }}
            >
              <span style={formatBadge()}>{props.format.toUpperCase()}</span>
              <strong
                style={{
                  "font-family": FONT_SANS,
                  "font-size": SECTION_FONT_SIZE,
                  "font-weight": "var(--font-weight-medium)",
                  color: "var(--color-text)",
                }}
              >
                {recordCount().toLocaleString()} {noun(value())}
              </strong>
              <Show when={value().truncated}>
                <span style={warning()}>First 10,000 records inspected</span>
              </Show>
              <div style={{ flex: 1 }} />
              <button type="button" style={button(view() === "overview")} onClick={() => setView("overview")}>
                Overview
              </button>
              <Show when={value().format !== "mzml"}>
                <button type="button" style={button(view() === "records")} onClick={() => setView("records")}>
                  Records
                </button>
              </Show>
            </div>

            <div class="atlas-scroll" style={{ flex: 1, "min-height": 0, overflow: "auto" }}>
              <Show when={view() === "overview"}>
                <Switch>
                  <Match when={fastq()}>{(file) => <FastqOverview file={file()} />}</Match>
                  <Match when={vcf()}>{(file) => <VcfOverview file={file()} />}</Match>
                  <Match when={interval()}>{(file) => <IntervalOverview file={file()} />}</Match>
                  <Match when={sam()}>{(file) => <SamOverview file={file()} />}</Match>
                  <Match when={mzml()}>{(file) => <MzmlOverview file={file()} />}</Match>
                </Switch>
              </Show>
              <Show when={view() === "records"}>
                <div
                  style={{
                    position: "sticky",
                    top: 0,
                    "z-index": 4,
                    padding: "10px 12px",
                    background: "var(--color-bg)",
                    "border-bottom": "1px solid var(--color-border)",
                  }}
                >
                  <input
                    data-action="scientific-filter"
                    aria-label="Filter scientific records"
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Filter records…"
                    style={input()}
                  />
                </div>
                <Switch>
                  <Match when={fastq()}>{(file) => <FastqRecords file={file()} query={query()} />}</Match>
                  <Match when={vcf()}>{(file) => <VcfRecords file={file()} query={query()} />}</Match>
                  <Match when={interval()}>{(file) => <IntervalRecords file={file()} query={query()} />}</Match>
                  <Match when={sam()}>{(file) => <SamRecords file={file()} query={query()} />}</Match>
                </Switch>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function FastqOverview(props: { file: FastqFile }): JSX.Element {
  return (
    <Overview>
      <Metrics>
        <Metric label="reads" value={compact(props.file.reads)} detail={`${compact(props.file.bases)} bases`} />
        <Metric
          label="mean length"
          value={`${props.file.meanLength} bp`}
          detail={`${props.file.minLength}–${props.file.maxLength} bp`}
        />
        <Metric label="GC" value={`${props.file.gc}%`} detail={`${props.file.n}% ambiguous N`} />
        <Metric label="mean quality" value={`Q${props.file.meanQuality}`} detail={`${props.file.q30}% bases ≥ Q30`} />
      </Metrics>
      <Panel title="Per-cycle base quality" note={`Phred score · first ${props.file.cycles.length} cycles`}>
        <Line values={props.file.cycles} floor={0} ceiling={45} />
      </Panel>
      <div style={grid()}>
        <Panel title="Read quality" note="Quick health check">
          <QualityGauge value={props.file.meanQuality} />
        </Panel>
        <Panel title="Parser health" note="FASTQ structural validation">
          <div style={{ display: "flex", "align-items": "baseline", gap: "8px", padding: "12px 2px" }}>
            <strong style={large()}>{props.file.invalid}</strong>
            <span style={muted()}>Malformed records</span>
          </div>
        </Panel>
      </div>
    </Overview>
  )
}

function VcfOverview(props: { file: VcfFile }): JSX.Element {
  return (
    <Overview>
      <Metrics>
        <Metric label="variants" value={compact(props.file.variants)} detail={`${props.file.passed} pass`} />
        <Metric
          label="samples"
          value={String(props.file.samples.length)}
          detail={props.file.samples.slice(0, 3).join(", ") || "sites only"}
        />
        <Metric
          label="mean QUAL"
          value={String(props.file.meanQuality || "—")}
          detail={props.file.fileformat || "VCF"}
        />
        <Metric
          label="reference"
          value={short(props.file.reference || "unspecified", 18)}
          detail={`${props.file.chromosomes.length} contigs`}
        />
      </Metrics>
      <div style={grid()}>
        <Panel title="Variant classes" note="By REF/ALT allele shape">
          <Bars items={Object.entries(props.file.types).map(([name, count]) => ({ name, count }))} />
        </Panel>
        <Panel title="Chromosomes" note="Most populated contigs">
          <Bars items={props.file.chromosomes.slice(0, 8)} />
        </Panel>
      </div>
      <Panel title="Filter outcomes" note="PASS and caller-specific flags">
        <Bars items={props.file.filters.slice(0, 10)} />
      </Panel>
    </Overview>
  )
}

function IntervalOverview(props: { file: IntervalFile }): JSX.Element {
  return (
    <Overview>
      <Metrics>
        <Metric label="features" value={compact(props.file.features)} detail={props.file.format.toUpperCase()} />
        <Metric label="total span" value={`${compact(props.file.totalSpan)} bp`} detail="sum of intervals" />
        <Metric
          label="mean span"
          value={`${props.file.meanSpan} bp`}
          detail={`max ${compact(props.file.maxSpan)} bp`}
        />
        <Metric
          label="contigs"
          value={String(props.file.chromosomes.length)}
          detail={`${props.file.types.length} feature types`}
        />
      </Metrics>
      <div style={grid()}>
        <Panel title="Chromosomes" note="Feature density">
          <Bars items={props.file.chromosomes.slice(0, 10)} />
        </Panel>
        <Panel title="Feature types" note={props.file.format === "bed" ? "BED regions" : "Annotation categories"}>
          <Bars items={props.file.types.slice(0, 10)} />
        </Panel>
      </div>
    </Overview>
  )
}

function SamOverview(props: { file: SamFile }): JSX.Element {
  const rate = props.file.alignments ? (props.file.mapped / props.file.alignments) * 100 : 0
  return (
    <Overview>
      <Metrics>
        <Metric
          label="alignments"
          value={compact(props.file.alignments)}
          detail={`${props.file.references.length} references`}
        />
        <Metric label="mapped" value={`${round(rate)}%`} detail={`${props.file.unmapped} unmapped`} />
        <Metric label="mean MAPQ" value={String(props.file.meanMapq)} detail="mapped reads" />
        <Metric
          label="sort order"
          value={props.file.order || "unknown"}
          detail={props.file.version ? `SAM ${props.file.version}` : "SAM"}
        />
      </Metrics>
      <div style={grid()}>
        <Panel title="Reference distribution" note="Mapped alignments">
          <Bars items={props.file.chromosomes.slice(0, 10)} />
        </Panel>
        <Panel title="Alignment flags" note="Records may occupy multiple groups">
          <Bars
            items={[
              {
                name: "primary mapped",
                count: Math.max(0, props.file.mapped - props.file.secondary - props.file.supplementary),
              },
              { name: "secondary", count: props.file.secondary },
              { name: "supplementary", count: props.file.supplementary },
              { name: "duplicate", count: props.file.duplicates },
              { name: "unmapped", count: props.file.unmapped },
            ]}
          />
        </Panel>
      </div>
    </Overview>
  )
}

function MzmlOverview(props: { file: MzmlFile }): JSX.Element {
  return (
    <Overview>
      <Metrics>
        <Metric label="spectra" value={compact(props.file.spectra)} detail={props.file.run || "unnamed run"} />
        <Metric label="chromatograms" value={compact(props.file.chromatograms)} detail="stored traces" />
        <Metric
          label="MS levels"
          value={String(props.file.levels.length)}
          detail={props.file.levels.map((item) => item.name).join(", ")}
        />
        <Metric
          label="time range"
          value={props.file.range ? `${round(props.file.range.start)}–${round(props.file.range.end)}` : "—"}
          detail="scan time in source units"
        />
      </Metrics>
      <div style={grid()}>
        <Panel title="Spectrum inventory" note="Tandem-MS level distribution">
          <Bars items={props.file.levels} />
        </Panel>
        <Panel title="Acquisition timeline" note={`${props.file.times.length} scans with start time`}>
          <Rug values={props.file.times} />
        </Panel>
      </div>
      <Panel title="Run readiness" note="What OpenScience found">
        <div style={{ display: "grid", gap: "8px", padding: "4px 0" }}>
          <Check ok={props.file.spectra > 0} text="spectrum list detected" />
          <Check ok={props.file.levels.some((item) => item.name === "MS2")} text="MS/MS spectra detected" />
          <Check ok={props.file.times.length > 0} text="scan timing metadata detected" />
        </div>
      </Panel>
    </Overview>
  )
}

function FastqRecords(props: { file: FastqFile; query: string }): JSX.Element {
  const rows = () => match(props.file.records, props.query, (record) => `${record.id} ${record.sequence}`)
  return (
    <Table columns={["read", "length", "GC", "mean Q", "sequence"]}>
      <For each={rows()}>
        {(record) => (
          <tr>
            <Cell mono>{record.id}</Cell>
            <Cell>{record.length}</Cell>
            <Cell>{record.gc}%</Cell>
            <Cell>Q{record.quality}</Cell>
            <Cell mono>{short(record.sequence, 80)}</Cell>
          </tr>
        )}
      </For>
    </Table>
  )
}

function VcfRecords(props: { file: VcfFile; query: string }): JSX.Element {
  const rows = () =>
    match(
      props.file.records,
      props.query,
      (record) =>
        `${record.chrom} ${record.pos} ${record.id} ${record.ref} ${record.alt} ${record.filter} ${record.type}`,
    )
  return (
    <Table columns={["locus", "ID", "REF", "ALT", "type", "QUAL", "filter", "depth"]}>
      <For each={rows()}>
        {(record) => (
          <tr>
            <Cell mono>
              {record.chrom}:{record.pos.toLocaleString()}
            </Cell>
            <Cell mono>{record.id || "—"}</Cell>
            <Cell mono>{record.ref}</Cell>
            <Cell mono>{short(record.alt, 34)}</Cell>
            <Cell>{record.type}</Cell>
            <Cell>{record.qual ?? "—"}</Cell>
            <Cell>{record.filter}</Cell>
            <Cell>{record.depth ?? "—"}</Cell>
          </tr>
        )}
      </For>
    </Table>
  )
}

function IntervalRecords(props: { file: IntervalFile; query: string }): JSX.Element {
  const rows = () =>
    match(
      props.file.records,
      props.query,
      (record) => `${record.chrom} ${record.start} ${record.end} ${record.name} ${record.type} ${record.strand}`,
    )
  return (
    <Table columns={["locus", "name", "type", "span", "score", "strand"]}>
      <For each={rows()}>
        {(record) => (
          <tr>
            <Cell mono>
              {record.chrom}:{record.start.toLocaleString()}–{record.end.toLocaleString()}
            </Cell>
            <Cell>{record.name || "—"}</Cell>
            <Cell>{record.type}</Cell>
            <Cell>{record.span.toLocaleString()} bp</Cell>
            <Cell>{record.score || "—"}</Cell>
            <Cell>{record.strand}</Cell>
          </tr>
        )}
      </For>
    </Table>
  )
}

function SamRecords(props: { file: SamFile; query: string }): JSX.Element {
  const rows = () =>
    match(
      props.file.records,
      props.query,
      (record) => `${record.name} ${record.reference} ${record.position} ${record.cigar}`,
    )
  return (
    <Table columns={["read", "locus", "flag", "MAPQ", "CIGAR", "length"]}>
      <For each={rows()}>
        {(record) => (
          <tr>
            <Cell mono>{record.name}</Cell>
            <Cell mono>
              {record.reference}:{record.position.toLocaleString()}
            </Cell>
            <Cell>{record.flag}</Cell>
            <Cell>{record.mapq}</Cell>
            <Cell mono>{record.cigar}</Cell>
            <Cell>{record.length} bp</Cell>
          </tr>
        )}
      </For>
    </Table>
  )
}

function Overview(props: { children: JSX.Element }): JSX.Element {
  return <div style={{ display: "grid", gap: "12px", padding: "14px" }}>{props.children}</div>
}

function Metrics(props: { children: JSX.Element }): JSX.Element {
  return (
    <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(150px, 1fr))", gap: "8px" }}>
      {props.children}
    </div>
  )
}

function Metric(props: { label: string; value: string; detail: string }): JSX.Element {
  return (
    <div style={card()}>
      <span style={muted()}>{sentence(props.label)}</span>
      <strong style={{ ...large(), "margin-top": "8px" }}>{props.value}</strong>
      <span
        title={props.detail}
        style={{
          ...muted(),
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
    <section style={{ ...card(), padding: "12px 14px" }}>
      <div style={{ display: "flex", "align-items": "baseline", gap: "8px", "margin-bottom": "12px" }}>
        <strong
          style={{
            "font-family": FONT_SANS,
            "font-size": SECTION_FONT_SIZE,
            "font-weight": "var(--font-weight-medium)",
            color: "var(--color-text)",
          }}
        >
          {props.title}
        </strong>
        <span style={muted()}>{props.note}</span>
      </div>
      {props.children}
    </section>
  )
}

function Bars(props: { items: Count[] }): JSX.Element {
  const max = () => Math.max(1, ...props.items.map((item) => item.count))
  return (
    <div style={{ display: "grid", gap: "7px" }}>
      <For each={props.items}>
        {(item) => (
          <div
            style={{ display: "grid", "grid-template-columns": "82px 1fr 54px", "align-items": "center", gap: "8px" }}
          >
            <span
              title={item.name}
              style={{ ...muted(), overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}
            >
              {item.name}
            </span>
            <div
              style={{ height: "5px", background: "var(--color-border)", "border-radius": "99px", overflow: "hidden" }}
            >
              <div
                style={{
                  width: `${(item.count / max()) * 100}%`,
                  height: "100%",
                  background: "var(--color-accent)",
                  "border-radius": "99px",
                }}
              />
            </div>
            <span style={{ ...muted(), "text-align": "right" }}>{item.count.toLocaleString()}</span>
          </div>
        )}
      </For>
    </div>
  )
}

function Line(props: { values: number[]; floor: number; ceiling: number }): JSX.Element {
  const width = 720
  const height = 120
  const points = () =>
    props.values
      .map((value, index) => {
        const x = props.values.length < 2 ? 0 : (index / (props.values.length - 1)) * width
        const y =
          height -
          ((Math.min(props.ceiling, Math.max(props.floor, value)) - props.floor) / (props.ceiling - props.floor)) *
            height
        return `${round(x)},${round(y)}`
      })
      .join(" ")
  return (
    <div style={{ position: "relative", height: `${height + 24}px` }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: `${height}px`, overflow: "visible" }}
      >
        <line x1="0" x2={width} y1={height / 3} y2={height / 3} stroke="var(--color-border)" stroke-dasharray="3 4" />
        <line
          x1="0"
          x2={width}
          y1={(height * 2) / 3}
          y2={(height * 2) / 3}
          stroke="var(--color-border)"
          stroke-dasharray="3 4"
        />
        <polyline
          points={points()}
          fill="none"
          stroke="var(--color-accent)"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <div style={{ display: "flex", "justify-content": "space-between", ...muted() }}>
        <span>Cycle 1</span>
        <span>Cycle {props.values.length}</span>
      </div>
    </div>
  )
}

function QualityGauge(props: { value: number }): JSX.Element {
  return (
    <div style={{ padding: "10px 0" }}>
      <div style={{ display: "flex", "justify-content": "space-between", "margin-bottom": "8px" }}>
        <span style={muted()}>Low</span>
        <strong style={{ ...large(), "font-size": "18px" }}>Q{props.value}</strong>
        <span style={muted()}>Excellent</span>
      </div>
      <div
        style={{
          height: "8px",
          background: "linear-gradient(90deg, #d65a4a, #d4a72c, #4ca56a)",
          "border-radius": "99px",
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            left: `${Math.min(100, (props.value / 40) * 100)}%`,
            top: "50%",
            width: "12px",
            height: "12px",
            background: "var(--color-bg)",
            border: "2px solid var(--color-text)",
            "border-radius": "50%",
            transform: "translate(-50%, -50%)",
          }}
        />
      </div>
    </div>
  )
}

function Rug(props: { values: number[] }): JSX.Element {
  const min = () => Math.min(0, ...props.values)
  const max = () => Math.max(1, ...props.values)
  return (
    <div
      style={{ height: "126px", position: "relative", border: "0", "border-bottom": "1px solid var(--color-border)" }}
    >
      <For each={props.values.slice(0, 2000)}>
        {(value, index) => (
          <span
            title={`${value}`}
            style={{
              position: "absolute",
              left: `${((value - min()) / Math.max(1, max() - min())) * 100}%`,
              bottom: 0,
              width: "1px",
              height: `${18 + ((index() * 17) % 88)}px`,
              background: "color-mix(in srgb, var(--color-accent) 62%, transparent)",
            }}
          />
        )}
      </For>
    </div>
  )
}

function Check(props: { ok: boolean; text: string }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        gap: "8px",
        "align-items": "center",
        "font-family": FONT_SANS,
        "font-size": CONTROL_FONT_SIZE,
        "font-weight": "var(--font-weight-regular)",
        color: "var(--color-text-muted)",
      }}
    >
      <span
        style={{
          display: "grid",
          "place-items": "center",
          width: "16px",
          height: "16px",
          "border-radius": "50%",
          background: props.ok ? "color-mix(in srgb, #4ca56a 15%, transparent)" : "var(--color-bg-subtle)",
          color: props.ok ? "#4ca56a" : "var(--color-text-faint)",
        }}
      >
        {props.ok ? "✓" : "·"}
      </span>
      {sentence(props.text)}
    </div>
  )
}

function Table(props: { columns: string[]; children: JSX.Element }): JSX.Element {
  return (
    <table
      style={{ width: "100%", "border-collapse": "collapse", "font-family": FONT_SANS, "font-size": TABLE_FONT_SIZE }}
    >
      <thead style={{ position: "sticky", top: "51px", "z-index": 3, background: "var(--color-bg)" }}>
        <tr>
          <For each={props.columns}>{(column) => <th style={head()}>{sentence(column)}</th>}</For>
        </tr>
      </thead>
      <tbody>{props.children}</tbody>
    </table>
  )
}

function Cell(props: { children: JSX.Element; mono?: boolean }): JSX.Element {
  return (
    <td
      style={{
        padding: "7px 10px",
        border: "0",
        "border-bottom": "1px solid var(--color-border)",
        "font-family": props.mono ? FONT_CODE : FONT_SANS,
        color: "var(--color-text-muted)",
        "white-space": "nowrap",
        "max-width": "320px",
        overflow: "hidden",
        "text-overflow": "ellipsis",
      }}
    >
      {props.children}
    </td>
  )
}

function noun(file: BiologicalFile): string {
  if (file.format === "fastq") return "reads"
  if (file.format === "vcf") return "variants"
  if (file.format === "sam") return "alignments"
  if (file.format === "mzml") return "spectra"
  return "features"
}

function match<T>(values: T[], query: string, content: (value: T) => string): T[] {
  const term = query.trim().toLowerCase()
  if (!term) return values
  return values.filter((value) => content(value).toLowerCase().includes(term))
}

function short(value: string, length: number): string {
  if (value.length <= length) return value
  return `${value.slice(0, length - 1)}…`
}

function compact(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function grid(): JSX.CSSProperties {
  return { display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }
}

function card(): JSX.CSSProperties {
  return {
    padding: "12px",
    border: "1px solid var(--color-border)",
    "border-radius": "7px",
    background: "var(--color-bg)",
    "min-width": 0,
  }
}

function muted(): JSX.CSSProperties {
  return {
    "font-family": FONT_SANS,
    "font-size": HELPER_FONT_SIZE,
    "font-weight": "var(--font-weight-regular)",
    color: "var(--color-text-faint)",
  }
}

function large(): JSX.CSSProperties {
  return {
    display: "block",
    "font-family": FONT_SANS,
    "font-size": "20px",
    "font-weight": "var(--font-weight-emphasis)",
    color: "var(--color-text)",
    "letter-spacing": "-0.02em",
  }
}

function formatBadge(): JSX.CSSProperties {
  return {
    padding: "2px 7px",
    "border-radius": "4px",
    background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
    color: "var(--color-accent)",
    "font-family": FONT_CODE,
    "font-size": HELPER_FONT_SIZE,
    "font-weight": "var(--font-weight-medium)",
    "letter-spacing": "0.05em",
  }
}

function warning(): JSX.CSSProperties {
  return {
    padding: "2px 7px",
    "border-radius": "4px",
    background: "color-mix(in srgb, #d4a72c 13%, transparent)",
    color: "#a57500",
    "font-family": FONT_SANS,
    "font-size": HELPER_FONT_SIZE,
    "font-weight": "var(--font-weight-regular)",
  }
}

function button(active = false): JSX.CSSProperties {
  return {
    padding: "5px 9px",
    border: "1px solid var(--color-border)",
    "border-radius": "5px",
    background: active ? "var(--color-bg-subtle)" : "transparent",
    color: active ? "var(--color-text)" : "var(--color-text-muted)",
    "font-family": FONT_SANS,
    "font-size": CONTROL_FONT_SIZE,
    "font-weight": active ? "var(--font-weight-medium)" : "var(--font-weight-regular)",
    cursor: "pointer",
  }
}

function input(): JSX.CSSProperties {
  return {
    width: "min(360px, 100%)",
    padding: "7px 10px",
    border: "1px solid var(--color-border)",
    "border-radius": "5px",
    outline: "none",
    background: "var(--color-bg-subtle)",
    color: "var(--color-text)",
    "font-family": FONT_SANS,
    "font-size": CONTROL_FONT_SIZE,
    "font-weight": "var(--font-weight-regular)",
  }
}

function head(): JSX.CSSProperties {
  return {
    padding: "7px 10px",
    border: "0",
    "border-bottom": "1px solid var(--color-border)",
    color: "var(--color-text-faint)",
    "font-family": FONT_SANS,
    "font-size": HELPER_FONT_SIZE,
    "font-weight": "var(--font-weight-medium)",
    "text-align": "left",
    "letter-spacing": "normal",
    "white-space": "nowrap",
  }
}

function empty(): JSX.CSSProperties {
  return {
    display: "grid",
    "place-items": "center",
    "align-content": "center",
    gap: "8px",
    height: "100%",
    padding: "36px",
    "text-align": "center",
  }
}

export default ScientificDataView
