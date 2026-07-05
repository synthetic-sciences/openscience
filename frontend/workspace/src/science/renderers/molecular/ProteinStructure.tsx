import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import type { PluginContext } from "molstar/lib/mol-plugin/context"
import type { BuiltInTrajectoryFormat } from "molstar/lib/mol-plugin-state/formats/trajectory"
import type { ArtifactRenderProps } from "../registry"

/**
 * 3D molecular structure renderer backed by Mol* (molstar), used for both the
 * `protein-structure` (proteins / macromolecules, .pdb / .cif / mmCIF) and
 * `chem-3d` (small molecules, .sdf / .mol / .xyz) artifact kinds.
 *
 * Mol* is a framework-agnostic vanilla-JS/WebGL library — it is driven here via
 * a plain `<div>` ref and its headless `PluginContext` (NO React UI layer, so no
 * `react`/`react-dom` peer dep is pulled in). The plugin is created once in
 * `onMount`, structures (re)load reactively via `createEffect` when `props.data`
 * changes, and the WebGL context is released in `onCleanup`.
 *
 * Accepted `props.data` shapes (all optional, first match wins):
 *   { id: "1CBS" }                       // PDB id → fetched from RCSB (mmCIF)
 *   { url: "https://…/model.cif" }       // any structure file URL
 *   { pdb: "<PDB text>" }                // inline PDB
 *   { cif: "<mmCIF text>" }              // inline mmCIF
 *   { sdf | mol | xyz | mol2: "…" }      // inline small-molecule formats
 *   { data: "<text>", format?: "pdb" }   // generic inline + explicit format
 * A bare string is treated as a 4-char PDB id, otherwise as inline text.
 */

type Status = "idle" | "loading" | "ready" | "empty" | "error"

interface Source {
  format: BuiltInTrajectoryFormat
  url?: string
  raw?: string
  binary?: boolean
}

const EXT_FORMAT: Record<string, { format: BuiltInTrajectoryFormat; binary?: boolean }> = {
  pdb: { format: "pdb" },
  ent: { format: "pdb" },
  cif: { format: "mmcif" },
  mmcif: { format: "mmcif" },
  bcif: { format: "mmcif", binary: true },
  pdbqt: { format: "pdbqt" },
  gro: { format: "gro" },
  xyz: { format: "xyz" },
  sdf: { format: "sdf" },
  mol: { format: "mol" },
  mol2: { format: "mol2" },
}

function formatFromUrl(url: string): { format: BuiltInTrajectoryFormat; binary?: boolean } | undefined {
  const clean = url.split(/[?#]/)[0]
  const ext = clean.slice(clean.lastIndexOf(".") + 1).toLowerCase()
  return EXT_FORMAT[ext]
}

function narrow(data: unknown, kind: string): Source | undefined {
  const fallback: BuiltInTrajectoryFormat = kind === "chem-3d" ? "sdf" : "pdb"
  if (typeof data === "string") {
    const s = data.trim()
    if (/^[0-9A-Za-z]{4}$/.test(s)) return { url: rcsbUrl(s), format: "mmcif" }
    return { raw: data, format: fallback }
  }
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  const inlineMap: Array<[string, BuiltInTrajectoryFormat]> = [
    ["pdb", "pdb"],
    ["cif", "mmcif"],
    ["mmcif", "mmcif"],
    ["sdf", "sdf"],
    ["mol2", "mol2"],
    ["mol", "mol"],
    ["xyz", "xyz"],
  ]
  for (const [key, format] of inlineMap) {
    if (typeof d[key] === "string") return { raw: d[key] as string, format }
  }
  const explicit = typeof d.format === "string" ? (d.format as BuiltInTrajectoryFormat) : undefined
  const inline = d.data ?? d.inline ?? d.text
  if (typeof inline === "string") return { raw: inline, format: explicit ?? fallback }
  if (typeof d.url === "string") {
    const guess = formatFromUrl(d.url)
    return {
      url: d.url,
      format: explicit ?? guess?.format ?? (kind === "chem-3d" ? "sdf" : "mmcif"),
      binary: guess?.binary,
    }
  }
  if (typeof d.id === "string") return { url: rcsbUrl(d.id), format: "mmcif" }
  if (typeof d.pdbId === "string") return { url: rcsbUrl(d.pdbId as string), format: "mmcif" }
  return undefined
}

function rcsbUrl(id: string): string {
  return `https://files.rcsb.org/download/${id.trim().toUpperCase()}.cif`
}

export function ProteinStructure(props: ArtifactRenderProps): JSX.Element {
  let host!: HTMLDivElement
  const [plugin, setPlugin] = createSignal<PluginContext | undefined>()
  const [status, setStatus] = createSignal<Status>("idle")
  const [error, setError] = createSignal<string>("")
  let disposed = false
  let token = 0

  onMount(async () => {
    setStatus("loading")
    try {
      const [ctxMod, specMod] = await Promise.all([
        import("molstar/lib/mol-plugin/context"),
        import("molstar/lib/mol-plugin/spec"),
      ])
      const p = new ctxMod.PluginContext(specMod.DefaultPluginSpec())
      await p.init()
      if (disposed) {
        p.dispose()
        return
      }
      const ok = await p.mountAsync(host)
      if (!ok) throw new Error("Mol* failed to initialise WebGL")
      if (disposed) {
        p.dispose()
        return
      }
      setPlugin(p)
    } catch (e) {
      if (!disposed) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus("error")
      }
    }
  })

  createEffect(() => {
    const p = plugin()
    const data = props.data
    const kind = props.kind
    if (!p) return
    void load(p, data, kind)
  })

  async function load(p: PluginContext, data: unknown, kind: string) {
    const my = ++token
    const src = narrow(data, kind)
    if (!src) {
      await p.clear().catch(() => {})
      if (my === token) setStatus("empty")
      return
    }
    setStatus("loading")
    setError("")
    try {
      await p.clear()
      if (my !== token || disposed) return
      const raw = src.url
        ? await p.builders.data.download({ url: src.url, isBinary: src.binary ?? false }, { state: { isGhost: true } })
        : await p.builders.data.rawData({ data: src.raw ?? "" })
      if (my !== token || disposed) return
      const trajectory = await p.builders.structure.parseTrajectory(raw, src.format)
      if (my !== token || disposed) return
      await p.builders.structure.hierarchy.applyPreset(trajectory, "default")
      if (my !== token || disposed) return
      p.handleResize()
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
    const p = plugin()
    if (!p) return
    try {
      p.dispose()
    } catch {
      /* ignore teardown errors — WebGL context may already be gone */
    }
  })

  const height = () => props.height ?? 420

  return (
    <div
      data-component="mol-structure"
      data-kind={props.kind}
      style={{
        position: "relative",
        width: "100%",
        height: `${height()}px`,
        overflow: "hidden",
        "border-radius": "4px",
        background: "#0b0d12",
      }}
    >
      <div ref={host} style={{ position: "absolute", inset: "0" }} />
      <Show when={status() !== "ready"}>
        <div
          style={{
            position: "absolute",
            inset: "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "text-align": "center",
            padding: "12px",
            "pointer-events": "none",
            color: "#c7ccd6",
            font: "13px/1.5 ui-sans-serif, system-ui, sans-serif",
          }}
        >
          <Show when={status() === "loading"}>Loading 3D structure…</Show>
          <Show when={status() === "empty"}>
            <span>
              No structure to display.
              <br />
              Provide a PDB id, a structure URL, or inline PDB/mmCIF text.
            </span>
          </Show>
          <Show when={status() === "error"}>
            <span style={{ color: "#ff8f8f" }}>Could not render structure: {error()}</span>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default ProteinStructure
