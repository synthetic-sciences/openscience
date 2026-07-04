import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import type { ArtifactRenderProps } from "../registry"

/**
 * `msa` renderer — a lightweight multiple-sequence-alignment viewer.
 *
 * No React, no heavy dependency: rows are drawn as colored monospace cells on a
 * `<canvas>` (fast for wide alignments), with the sequence ids in a sticky HTML
 * gutter on the left. The alignment grid scrolls horizontally under the fixed
 * gutter; the whole block scrolls vertically when there are many sequences.
 *
 * Expected `props.data` — several shapes are accepted and normalized:
 * ```
 * { sequences: [{ id, seq }, …] }   // preferred
 * { rows:      [{ id, seq }, …] }
 * { alignment: [{ id, seq }, …] }
 * [{ id, seq }, …]                  // bare array
 * ```
 */

interface Row {
  id: string
  seq: string
}

const CELL_W = 15
const CELL_H = 18
const GUTTER_W = 128
const RULER_H = 16

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
  // hydrophobic
  A: "#2f6fd0",
  I: "#2f6fd0",
  L: "#2f6fd0",
  M: "#2f6fd0",
  F: "#2f6fd0",
  W: "#2f6fd0",
  V: "#2f6fd0",
  C: "#2f6fd0",
  // positive
  K: "#d64545",
  R: "#d64545",
  // negative
  E: "#b455c9",
  D: "#b455c9",
  // polar
  N: "#3aa66f",
  Q: "#3aa66f",
  S: "#3aa66f",
  T: "#3aa66f",
  // special / aromatic
  G: "#e08a2e",
  P: "#c9b021",
  H: "#22a6b3",
  Y: "#22a6b3",
}

const NUC_ALPHABET = new Set([
  "A",
  "C",
  "G",
  "T",
  "U",
  "N",
  "-",
  ".",
  " ",
  "R",
  "Y",
  "S",
  "W",
  "K",
  "M",
  "B",
  "D",
  "H",
  "V",
])

function coerceRows(value: unknown): Row[] {
  if (!Array.isArray(value)) return []
  const out: Row[] = []
  for (let i = 0; i < value.length; i++) {
    const r = value[i] as { id?: unknown; name?: unknown; seq?: unknown; sequence?: unknown }
    if (!r || typeof r !== "object") continue
    const seq = typeof r.seq === "string" ? r.seq : typeof r.sequence === "string" ? r.sequence : undefined
    if (seq === undefined) continue
    const id = typeof r.id === "string" ? r.id : typeof r.name === "string" ? r.name : `seq_${i + 1}`
    out.push({ id, seq: seq.toUpperCase() })
  }
  return out
}

function normalize(data: unknown): Row[] {
  if (Array.isArray(data)) return coerceRows(data)
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>
    return coerceRows(d.sequences ?? d.rows ?? d.alignment ?? d.seqs)
  }
  return []
}

function isNucleotide(rows: Row[]): boolean {
  let seen = 0
  for (const r of rows) {
    for (const ch of r.seq) {
      if (ch === "-" || ch === "." || ch === " ") continue
      seen++
      if (!NUC_ALPHABET.has(ch)) return false
      if (seen > 400) return true
    }
  }
  return seen > 0
}

function colorFor(ch: string, nucleotide: boolean): string | undefined {
  if (ch === "-" || ch === "." || ch === " ") return undefined
  return nucleotide ? NUC_COLORS[ch] : AA_COLORS[ch]
}

const SAMPLE: Row[] = [
  { id: "human", seq: "MKTAYIAKQR-QISFVKSHFSRQLEERLGLIEVQ" },
  { id: "mouse", seq: "MKTAYIAKQR-QISFVKSHFSRQLEDRLGLIEVQ" },
  { id: "chick", seq: "MKTAYIAKER-QISFVKSHFSKQLEERLGLIEVQ" },
  { id: "zfish", seq: "MKTAYIAKQK-QVSFVKSHFSRQLEERLGLIEVK" },
]

export function MsaViewer(props: ArtifactRenderProps) {
  let canvas!: HTMLCanvasElement
  const rows = createMemo(() => {
    const r = normalize(props.data)
    return r.length ? r : SAMPLE
  })
  const isSample = createMemo(() => normalize(props.data).length === 0)
  const cols = createMemo(() => rows().reduce((m, r) => Math.max(m, r.seq.length), 0))
  const nucleotide = createMemo(() => isNucleotide(rows()))

  createEffect(() => {
    const list = rows()
    const nCols = cols()
    const nuc = nucleotide()
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
    const w = nCols * CELL_W
    const h = list.length * CELL_H + RULER_H
    canvas.width = Math.max(1, Math.floor(w * dpr))
    canvas.height = Math.max(1, Math.floor(h * dpr))
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // Column ruler (ticks every 10 positions).
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx.fillStyle = "#8a8a8a"
    ctx.textBaseline = "middle"
    ctx.textAlign = "center"
    for (let c = 9; c < nCols; c += 10) {
      ctx.fillText(String(c + 1), c * CELL_W + CELL_W / 2, RULER_H / 2)
    }

    // Residue grid.
    ctx.font = "bold 12px ui-monospace, SFMono-Regular, Menlo, monospace"
    for (let r = 0; r < list.length; r++) {
      const seq = list[r].seq
      const y = RULER_H + r * CELL_H
      for (let c = 0; c < seq.length; c++) {
        const ch = seq[c]
        const bg = colorFor(ch, nuc)
        const x = c * CELL_W
        if (bg) {
          ctx.fillStyle = bg
          ctx.fillRect(x + 0.5, y + 0.5, CELL_W - 1, CELL_H - 1)
          ctx.fillStyle = "#ffffff"
        } else {
          ctx.fillStyle = ch === "-" || ch === "." ? "#c7c7c7" : "#555"
        }
        ctx.fillText(ch, x + CELL_W / 2, y + CELL_H / 2 + 1)
      }
    }
  })

  onCleanup(() => {
    const ctx = canvas?.getContext("2d")
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
  })

  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace"

  return (
    <div
      data-component="science-msa"
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
        data-slot="msa-header"
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          padding: "5px 10px",
          "font-size": "11px",
          color: "#8a8a8a",
          background: "rgba(128,128,128,0.08)",
          "border-bottom": "1px solid rgba(128,128,128,0.2)",
        }}
      >
        <span>
          MSA · {rows().length} seqs × {cols()} cols · {nucleotide() ? "nucleotide" : "protein"}
        </span>
        <Show when={isSample()}>
          <span data-slot="msa-sample-badge">sample</span>
        </Show>
      </div>
      <div data-slot="msa-body" style={{ display: "flex", "max-height": `${props.height ?? 320}px`, overflow: "auto" }}>
        <div
          data-slot="msa-gutter"
          style={{
            position: "sticky",
            left: "0",
            "z-index": "1",
            flex: "0 0 auto",
            width: `${GUTTER_W}px`,
            background: "var(--sci-msa-gutter-bg, #ffffff)",
            "border-right": "1px solid rgba(128,128,128,0.2)",
          }}
        >
          <div style={{ height: `${RULER_H}px` }} />
          <For each={rows()}>
            {(row) => (
              <div
                title={row.id}
                style={{
                  height: `${CELL_H}px`,
                  "line-height": `${CELL_H}px`,
                  padding: "0 8px",
                  "font-size": "12px",
                  "white-space": "nowrap",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  color: "#444",
                }}
              >
                {row.id}
              </div>
            )}
          </For>
        </div>
        <div data-slot="msa-grid" style={{ flex: "1 1 auto" }}>
          <canvas ref={canvas} style={{ display: "block" }} />
        </div>
      </div>
    </div>
  )
}

export default MsaViewer
