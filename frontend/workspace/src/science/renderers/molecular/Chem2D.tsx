import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import type { ArtifactRenderProps } from "../registry"

/**
 * 2D chemical structure renderer backed by RDKit.js (`@rdkit/rdkit`) for the
 * `chem-2d` artifact kind. RDKit is initialised once in a dedicated worker, so
 * every artifact shares one WASM instance without granting its Emscripten glue
 * permission to evaluate JavaScript strings in the application page.
 *
 * The library is framework-agnostic; here it renders to an SVG string that is
 * mounted via `innerHTML`. Depictions regenerate reactively through
 * `createEffect` when `props.data` changes; a stale-request token guards against
 * out-of-order async completions.
 *
 * Accepted `props.data` shapes (first match wins):
 *   { smiles: "CCO" }                    // SMILES string
 *   { smi | molblock | mol: "…" }        // aliases / a Mol block
 *   { smiles: "…", width?: number, height?: number }
 * A bare string is treated as SMILES.
 */

type Status = "idle" | "loading" | "ready" | "empty" | "error"

type WorkerResponse = { ok: true; svg: string } | { ok: false; error: string }

let rdkitWorker: Worker | undefined
const WORKER_TIMEOUT_MS = 30_000

function getRDKitWorker(): Worker {
  rdkitWorker ??= new Worker(new URL("./rdkit.worker.ts", import.meta.url), {
    type: "module",
    name: "openscience-rdkit",
  })
  return rdkitWorker
}

function renderMolecule(spec: Spec): Promise<string> {
  const worker = getRDKitWorker()
  const channel = new MessageChannel()

  return new Promise((resolve, reject) => {
    const discardWorker = () => {
      if (rdkitWorker !== worker) return
      worker.terminate()
      rdkitWorker = undefined
    }
    const cleanup = () => {
      clearTimeout(timeout)
      channel.port1.close()
      worker.removeEventListener("error", onWorkerError)
    }
    const onWorkerError = (event: ErrorEvent) => {
      cleanup()
      discardWorker()
      reject(new Error(event.message || "RDKit worker failed"))
    }
    const timeout = setTimeout(() => {
      cleanup()
      discardWorker()
      reject(new Error("RDKit worker timed out"))
    }, WORKER_TIMEOUT_MS)

    channel.port1.onmessage = (event: MessageEvent<WorkerResponse>) => {
      cleanup()
      if (event.data.ok) resolve(event.data.svg)
      else reject(new Error(event.data.error))
    }
    channel.port1.onmessageerror = () => {
      cleanup()
      discardWorker()
      reject(new Error("RDKit worker returned an unreadable response"))
    }
    worker.addEventListener("error", onWorkerError, { once: true })
    channel.port1.start()
    try {
      worker.postMessage(spec, [channel.port2])
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

interface Spec {
  input: string
  width: number
  height: number
}

function narrow(data: unknown, height: number): Spec | undefined {
  const w = 480
  const h = Math.max(160, Math.min(height, 420))
  if (typeof data === "string") {
    const s = data.trim()
    return s ? { input: s, width: w, height: h } : undefined
  }
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  const raw = d.smiles ?? d.smi ?? d.molblock ?? d.mol ?? d.input
  if (typeof raw !== "string" || !raw.trim()) return undefined
  const width = typeof d.width === "number" ? d.width : w
  const hh = typeof d.height === "number" ? d.height : h
  return { input: raw.trim(), width, height: hh }
}

/** Strip fixed width/height so the SVG scales to its container (viewBox is kept). */
function responsive(svg: string): string {
  return svg
    .replace(/(<svg[^>]*?)\s+width=(['"])[^'"]*\2/i, "$1")
    .replace(/(<svg[^>]*?)\s+height=(['"])[^'"]*\2/i, "$1")
}

export function Chem2D(props: ArtifactRenderProps): JSX.Element {
  const [svg, setSvg] = createSignal<string>("")
  const [status, setStatus] = createSignal<Status>("idle")
  const [error, setError] = createSignal<string>("")
  let token = 0
  let disposed = false

  createEffect(() => {
    const spec = narrow(props.data, props.height ?? 320)
    void render(spec)
  })

  async function render(spec: Spec | undefined) {
    const my = ++token
    if (!spec) {
      setStatus("empty")
      setSvg("")
      return
    }
    setStatus("loading")
    setError("")
    try {
      const out = await renderMolecule(spec)
      if (my !== token || disposed) return
      setSvg(responsive(out))
      setStatus("ready")
    } catch (e) {
      if (my === token && !disposed) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus("error")
      }
    }
  }

  onCleanup(() => {
    disposed = true
    token++
  })

  const height = () => props.height ?? 320

  return (
    <div
      data-component="chem-2d"
      data-kind={props.kind}
      style={{
        position: "relative",
        width: "100%",
        "min-height": `${height()}px`,
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        padding: "8px",
        "box-sizing": "border-box",
        background: "#ffffff",
        "border-radius": "4px",
      }}
    >
      <Show when={status() === "ready"}>
        <div
          style={{ width: "100%", "max-width": "520px", display: "flex", "justify-content": "center" }}
          innerHTML={svg()}
        />
      </Show>
      <Show when={status() !== "ready"}>
        <div
          style={{
            "text-align": "center",
            color: "#5b616e",
            font: "13px/1.5 ui-sans-serif, system-ui, sans-serif",
          }}
        >
          <Show when={status() === "loading"}>Rendering molecule…</Show>
          <Show when={status() === "empty"}>
            <span>No molecule to display. Provide a SMILES string or Mol block.</span>
          </Show>
          <Show when={status() === "error"}>
            <span style={{ color: "#c0392b" }}>Could not render molecule: {error()}</span>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default Chem2D
