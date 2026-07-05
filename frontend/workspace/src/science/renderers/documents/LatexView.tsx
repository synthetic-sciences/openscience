import { Show, createSignal, onCleanup, onMount } from "solid-js"
import type { ArtifactRenderProps } from "../registry"

/**
 * `latex` renderer — typesets a TeX/LaTeX math string with KaTeX.
 *
 * KaTeX is a framework-agnostic vanilla-JS library (no React). We render into a
 * ref'd element in `onMount` via `katex.render(tex, el, opts)`. BOTH the KaTeX
 * engine and its stylesheet (~790 CSS rules — the bulk of the app's CSS) are
 * pulled with a dynamic `import()` in parallel, so neither ships in the entry
 * bundle; they're fetched together only when a LaTeX artifact is first shown, and
 * the stylesheet resolves before `katex.render` runs so the math fonts are ready.
 *
 * Expected `props.data` — several shapes are accepted and normalized:
 * ```
 * { tex: string }            // preferred
 * { latex: string }          // alias
 * { math: string }           // alias
 * { expression: string }     // alias
 * "E = mc^2"                  // bare string
 * ```
 * Optional: `displayMode` (default true → centered block; false → inline).
 */

interface LatexData {
  tex: string
  displayMode: boolean
}

const SAMPLE = "\\hat{H}\\,\\psi = E\\,\\psi"

function normalize(data: unknown): { tex: string; displayMode: boolean; isSample: boolean } {
  if (typeof data === "string") {
    const t = data.trim()
    return { tex: t || SAMPLE, displayMode: true, isSample: t.length === 0 }
  }
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>
    const raw = d.tex ?? d.latex ?? d.math ?? d.expression
    const tex = typeof raw === "string" ? raw.trim() : ""
    const displayMode = typeof d.displayMode === "boolean" ? d.displayMode : d.inline === true ? false : true
    return { tex: tex || SAMPLE, displayMode, isSample: tex.length === 0 }
  }
  return { tex: SAMPLE, displayMode: true, isSample: true }
}

interface KatexLib {
  render(
    tex: string,
    el: HTMLElement,
    opts: { displayMode: boolean; throwOnError: boolean; errorColor?: string; output?: string },
  ): void
}

export function LatexView(props: ArtifactRenderProps) {
  let host!: HTMLDivElement
  const cfg = normalize(props.data)
  const [error, setError] = createSignal<string>()

  onMount(() => {
    let disposed = false
    ;(async () => {
      try {
        const [katexMod] = await Promise.all([
          import("katex") as unknown as Promise<{ default: KatexLib }>,
          import("katex/dist/katex.min.css"),
        ])
        const katex = katexMod.default
        if (disposed) return
        katex.render(cfg.tex, host, {
          displayMode: cfg.displayMode,
          throwOnError: false,
          errorColor: "#b00020",
          output: "html",
        })
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    onCleanup(() => {
      disposed = true
      if (host) host.innerHTML = ""
    })
  })

  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace"

  return (
    <div
      data-component="science-latex"
      style={{
        border: "1px solid rgba(128,128,128,0.28)",
        "border-radius": "4px",
        overflow: "hidden",
      }}
    >
      <div
        data-slot="latex-header"
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          padding: "5px 10px",
          "font-size": "11px",
          "font-family": mono,
          color: "#8a8a8a",
          background: "rgba(128,128,128,0.08)",
          "border-bottom": "1px solid rgba(128,128,128,0.2)",
        }}
      >
        <span>LaTeX · {cfg.displayMode ? "display" : "inline"}</span>
        <Show when={cfg.isSample}>
          <span data-slot="latex-sample-badge">sample</span>
        </Show>
      </div>
      <div
        data-slot="latex-body"
        style={{
          padding: cfg.displayMode ? "18px 14px" : "10px 14px",
          "overflow-x": "auto",
          "max-height": `${props.height ?? 320}px`,
          "font-size": "1.05rem",
          "line-height": "1.5",
        }}
      >
        <Show when={error()}>
          {(msg) => (
            <div data-slot="latex-error" style={{ "font-family": mono, "font-size": "12px", color: "#b00020" }}>
              Failed to typeset LaTeX: {msg()}
            </div>
          )}
        </Show>
        <div ref={host} data-slot="latex-render" />
      </div>
    </div>
  )
}

export default LatexView
