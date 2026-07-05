import { For, Show, createMemo } from "solid-js"
import type { ArtifactRenderProps } from "../registry"

/**
 * `sequence` renderer — a single linear nucleotide/protein sequence viewer.
 *
 * No React, no heavy dependency: residues are laid out as fixed-width colored
 * DOM cells (so the text stays selectable/copyable), wrapped into rows of
 * `perRow` columns. Each row carries a left gutter with its 1-based start
 * position and a tens ruler above the residues, matching the layout of classic
 * sequence viewers (UniProt/EMBOSS).
 *
 * FASTA input is parsed (first record wins) and the alphabet is auto-detected as
 * nucleotide vs. protein for coloring; an explicit `type` overrides detection.
 *
 * Expected `props.data` — several shapes are accepted and normalized:
 * ```
 * { sequence: string }                 // preferred
 * { seq: string, id?: string }         // aliases
 * { fasta: ">sp|…\nMKT…" }             // FASTA text (first record)
 * ">header\nMKTAYIAK…"                  // bare FASTA string
 * "MKTAYIAKQR…"                         // bare sequence
 * ```
 * Optional: `type` ("dna" | "rna" | "protein" | "nucleotide"), `perRow`
 * (default 60), `id` / `name` (label).
 */

const CELL_W = 12
const CELL_H = 18
const RULER_H = 14
const GUTTER_W = 64
const MAX_RESIDUES = 20000

// Nucleotide palette (IUPAC core).
const NUC_COLORS: Record<string, string> = {
  A: "#4CAF50",
  C: "#2196F3",
  G: "#F5A623",
  T: "#E53935",
  U: "#E53935",
  N: "#9E9E9E",
}

// Clustal-style amino-acid grouping → color.
const AA_COLORS: Record<string, string> = {
  A: "#2f6fd0",
  I: "#2f6fd0",
  L: "#2f6fd0",
  M: "#2f6fd0",
  F: "#2f6fd0",
  W: "#2f6fd0",
  V: "#2f6fd0",
  C: "#2f6fd0",
  K: "#d64545",
  R: "#d64545",
  E: "#b455c9",
  D: "#b455c9",
  N: "#3aa66f",
  Q: "#3aa66f",
  S: "#3aa66f",
  T: "#3aa66f",
  G: "#e08a2e",
  P: "#c9b021",
  H: "#22a6b3",
  Y: "#22a6b3",
}

const NUC_ALPHABET = new Set(["A", "C", "G", "T", "U", "N", "R", "Y", "S", "W", "K", "M", "B", "D", "H", "V"])

interface SeqData {
  id?: string
  seq: string
  type?: string
}

function parseFasta(text: string): { id?: string; seq: string } {
  const lines = text.split(/\r?\n/)
  let id: string | undefined
  let started = false
  const parts: string[] = []
  for (const line of lines) {
    if (line.startsWith(">")) {
      if (started) break // second record — stop at first
      id = line.slice(1).trim().split(/\s+/)[0] || undefined
      started = true
      continue
    }
    parts.push(line)
  }
  return { id, seq: parts.join("") }
}

// Keep letters and gap/stop symbols; drop spaces, digits, and other noise so
// pasted numbered formats still render cleanly.
function clean(seq: string): string {
  return seq.replace(/[^A-Za-z\-.*]/g, "").toUpperCase()
}

function normalize(data: unknown): SeqData {
  if (typeof data === "string") {
    const f = parseFasta(data)
    return { id: f.id, seq: clean(f.seq) }
  }
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>
    const type = typeof d.type === "string" ? d.type.toLowerCase() : undefined
    const id = typeof d.id === "string" ? d.id : typeof d.name === "string" ? d.name : undefined
    if (typeof d.fasta === "string") {
      const f = parseFasta(d.fasta)
      return { id: id ?? f.id, seq: clean(f.seq), type }
    }
    const raw = typeof d.sequence === "string" ? d.sequence : typeof d.seq === "string" ? d.seq : ""
    if (raw.trimStart().startsWith(">")) {
      const f = parseFasta(raw)
      return { id: id ?? f.id, seq: clean(f.seq), type }
    }
    return { id, seq: clean(raw), type }
  }
  return { seq: "" }
}

function isNucleotide(seq: string, type?: string): boolean {
  if (type === "protein" || type === "aa") return false
  if (type === "dna" || type === "rna" || type === "nucleotide" || type === "nt") return true
  let seen = 0
  for (const ch of seq) {
    if (ch === "-" || ch === "." || ch === "*") continue
    seen++
    if (!NUC_ALPHABET.has(ch)) return false
    if (seen > 400) return true
  }
  return seen > 0
}

function colorFor(ch: string, nucleotide: boolean): string | undefined {
  if (ch === "-" || ch === "." || ch === "*") return undefined
  return nucleotide ? NUC_COLORS[ch] : AA_COLORS[ch]
}

const SAMPLE: SeqData = {
  id: "sp|P69905|HBA_HUMAN",
  seq: "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR",
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace"

export function SequenceViewer(props: ArtifactRenderProps) {
  const parsed = createMemo(() => normalize(props.data))
  const isSample = createMemo(() => parsed().seq.length === 0)
  const model = createMemo(() => (isSample() ? SAMPLE : parsed()))
  const nucleotide = createMemo(() => isNucleotide(model().seq, model().type))
  const truncated = createMemo(() => model().seq.length > MAX_RESIDUES)
  const seq = createMemo(() => (truncated() ? model().seq.slice(0, MAX_RESIDUES) : model().seq))

  const perRow = createMemo(() => {
    const d = props.data
    if (d && typeof d === "object" && typeof (d as Record<string, unknown>).perRow === "number") {
      return Math.max(10, Math.floor((d as { perRow: number }).perRow))
    }
    return 60
  })

  const rows = createMemo(() => {
    const s = seq()
    const n = perRow()
    const out: { start: number; chars: string }[] = []
    for (let i = 0; i < s.length; i += n) out.push({ start: i + 1, chars: s.slice(i, i + n) })
    return out
  })

  // Absolute tens-tick columns within a row (0-based col index → label).
  const ticksFor = (start: number, len: number) => {
    const out: { col: number; label: number }[] = []
    for (let c = 0; c < len; c++) {
      const pos = start + c
      if (pos % 10 === 0) out.push({ col: c, label: pos })
    }
    return out
  }

  return (
    <div
      data-component="science-sequence"
      style={{
        display: "flex",
        "flex-direction": "column",
        border: "1px solid rgba(128,128,128,0.28)",
        "border-radius": "4px",
        overflow: "hidden",
        "font-family": mono,
      }}
    >
      <div
        data-slot="sequence-header"
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          gap: "10px",
          padding: "5px 10px",
          "font-size": "11px",
          color: "#8a8a8a",
          background: "rgba(128,128,128,0.08)",
          "border-bottom": "1px solid rgba(128,128,128,0.2)",
        }}
      >
        <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
          {model().id ?? "sequence"} · {model().seq.length} {nucleotide() ? "nt" : "aa"} ·{" "}
          {nucleotide() ? "nucleotide" : "protein"}
        </span>
        <Show when={isSample()}>
          <span data-slot="sequence-sample-badge">sample · human hemoglobin α</span>
        </Show>
      </div>

      <div
        data-slot="sequence-body"
        style={{ "max-height": `${props.height ?? 360}px`, overflow: "auto", padding: "8px 10px" }}
      >
        <For each={rows()}>
          {(row) => (
            <div
              data-slot="sequence-row"
              style={{ display: "flex", "align-items": "flex-end", "margin-bottom": "6px" }}
            >
              <div
                data-slot="sequence-gutter"
                style={{
                  flex: `0 0 ${GUTTER_W}px`,
                  width: `${GUTTER_W}px`,
                  height: `${RULER_H + CELL_H}px`,
                  display: "flex",
                  "align-items": "flex-end",
                  "justify-content": "flex-end",
                  "padding-right": "8px",
                  "padding-bottom": "1px",
                  "font-size": "11px",
                  color: "#8a8a8a",
                  "user-select": "none",
                }}
              >
                {row.start}
              </div>
              <div data-slot="sequence-cols" style={{ position: "relative", width: `${row.chars.length * CELL_W}px` }}>
                <div data-slot="sequence-ruler" style={{ position: "relative", height: `${RULER_H}px` }}>
                  <For each={ticksFor(row.start, row.chars.length)}>
                    {(t) => (
                      <span
                        style={{
                          position: "absolute",
                          left: `${t.col * CELL_W}px`,
                          width: `${CELL_W}px`,
                          "text-align": "right",
                          "white-space": "nowrap",
                          "font-size": "9px",
                          "line-height": `${RULER_H}px`,
                          color: "#9a9a9a",
                          "user-select": "none",
                        }}
                      >
                        {t.label}
                      </span>
                    )}
                  </For>
                </div>
                <div data-slot="sequence-residues" style={{ display: "flex", height: `${CELL_H}px` }}>
                  <For each={[...row.chars]}>
                    {(ch) => {
                      const bg = colorFor(ch, nucleotide())
                      return (
                        <span
                          style={{
                            flex: `0 0 ${CELL_W}px`,
                            width: `${CELL_W}px`,
                            height: `${CELL_H}px`,
                            "line-height": `${CELL_H}px`,
                            "text-align": "center",
                            "font-size": "12px",
                            "font-weight": "bold",
                            background: bg ?? "transparent",
                            color: bg ? "#ffffff" : ch === "-" || ch === "." ? "#c7c7c7" : "#555",
                          }}
                        >
                          {ch}
                        </span>
                      )
                    }}
                  </For>
                </div>
              </div>
            </div>
          )}
        </For>

        <Show when={truncated()}>
          <div style={{ "font-size": "11px", color: "#8a8a8a", "padding-top": "2px" }}>
            showing first {MAX_RESIDUES.toLocaleString()} of {model().seq.length.toLocaleString()} residues
          </div>
        </Show>
      </div>
    </div>
  )
}

export default SequenceViewer
