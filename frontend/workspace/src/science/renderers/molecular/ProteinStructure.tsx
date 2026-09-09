import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import type { PluginContext } from "molstar/lib/mol-plugin/context"
import type { BuiltInTrajectoryFormat } from "molstar/lib/mol-plugin-state/formats/trajectory"
import type { ArtifactRenderProps } from "../registry"
import { analyzeMolecularSource, narrowMolecularSource } from "./model"

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
type Preset = "auto" | "polymer-cartoon" | "atomic-detail" | "illustrative" | "molecular-surface"
type Granularity = "element" | "residue" | "chain"
type Theme = "dark" | "light"

export function ProteinStructure(props: ArtifactRenderProps): JSX.Element {
  let host!: HTMLDivElement
  const [plugin, setPlugin] = createSignal<PluginContext | undefined>()
  const [status, setStatus] = createSignal<Status>("idle")
  const [error, setError] = createSignal<string>("")
  const [preset, setPreset] = createSignal<Preset>("auto")
  const [granularity, setGranularity] = createSignal<Granularity>("element")
  const [theme, setTheme] = createSignal<Theme>("dark")
  const [selection, setSelection] = createSignal({ label: "", count: 0, history: 0 })
  const [measurements, setMeasurements] = createSignal(0)
  const summary = createMemo(() => analyzeMolecularSource(props.data, props.kind))
  const subscriptions: Array<{ unsubscribe(): void }> = []
  let disposed = false
  let token = 0

  onMount(async () => {
    setStatus("loading")
    try {
      const [ctxMod, specMod, configMod] = await Promise.all([
        import("molstar/lib/mol-plugin/context"),
        import("molstar/lib/mol-plugin/spec"),
        import("molstar/lib/mol-plugin/config"),
      ])
      const spec = specMod.DefaultPluginSpec()
      // Mol* otherwise asks WebGL to fail on software renderers. Chromium uses
      // SwiftShader in headless mode, and some user machines have no accepted
      // hardware context, so that default turns a usable 3D view into an error.
      spec.config = [...(spec.config ?? []), [configMod.PluginConfig.General.AllowMajorPerformanceCaveat, true]]
      const p = new ctxMod.PluginContext(spec)
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
      p.selectionMode = true
      p.managers.interactivity.setProps({ granularity: granularity() })
      const syncSelection = () => {
        const stats = p.managers.structure.selection.stats
        setSelection({
          label: stats.label,
          count: stats.elementCount,
          history: p.managers.structure.selection.additionsHistory.length,
        })
      }
      const syncMeasurements = () => {
        const state = p.managers.structure.measurement.state
        setMeasurements(
          state.distances.length +
            state.angles.length +
            state.dihedrals.length +
            state.orientations.length +
            state.planes.length,
        )
      }
      subscriptions.push(p.managers.structure.selection.events.changed.subscribe(syncSelection))
      subscriptions.push(p.managers.structure.selection.events.additionsHistoryUpdated.subscribe(syncSelection))
      subscriptions.push(p.managers.structure.measurement.behaviors.state.subscribe(syncMeasurements))
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

  createEffect(() => {
    const value = summary()
    const selected = selection()
    if (!value || !props.onInspect) return
    const facts = [
      { label: "format", value: value.format.toUpperCase() },
      ...(value.atomCount === undefined ? [] : [{ label: "atoms", value: `${value.atomCount} atoms` }]),
      ...(value.bondCount === undefined ? [] : [{ label: "bonds", value: `${value.bondCount} bonds` }]),
      ...(value.residueCount === undefined ? [] : [{ label: "residues", value: `${value.residueCount} residues` }]),
      ...(value.chainCount === undefined ? [] : [{ label: "chains", value: `${value.chainCount} chains` }]),
      ...(value.elements.length
        ? [{ label: "elements", value: value.elements.map((item) => `${item.element} ${item.count}`).join(" · ") }]
        : []),
    ]
    props.onInspect({
      facts,
      capabilities: [
        "5 representation presets",
        "Atom, residue, and chain selection",
        "Distance measurements",
        "Camera reset",
        "Background switching",
        "PNG export",
      ],
      ...(selected.count
        ? {
            selection: {
              kind: "molecule" as const,
              label: selected.label || `${selected.count} selected`,
              count: selected.count,
            },
          }
        : {}),
    })
  })

  async function load(p: PluginContext, data: unknown, kind: string) {
    const my = ++token
    const src = narrowMolecularSource(data, kind)
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
      const trajectory = await p.builders.structure.parseTrajectory(raw, src.format as BuiltInTrajectoryFormat)
      if (my !== token || disposed) return
      await p.builders.structure.hierarchy.applyPreset(trajectory, "default", {
        representationPreset: preset(),
      })
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

  async function changePreset(value: Preset) {
    setPreset(value)
    const p = plugin()
    if (!p || status() !== "ready") return
    await load(p, props.data, props.kind)
  }

  function changeGranularity(value: Granularity) {
    setGranularity(value)
    plugin()?.managers.interactivity.setProps({ granularity: value })
  }

  async function toggleTheme() {
    const p = plugin()
    const next: Theme = theme() === "dark" ? "light" : "dark"
    setTheme(next)
    if (!p?.canvas3d) return
    const { Color } = await import("molstar/lib/mol-util/color")
    p.canvas3d.setProps({
      renderer: {
        ...p.canvas3d.props.renderer,
        backgroundColor: Color(next === "light" ? 0xf5f6f8 : 0x0b0d12),
      },
    })
  }

  async function measureDistance() {
    const p = plugin()
    if (!p) return
    const history = p.managers.structure.selection.additionsHistory
    if (history.length < 2) return
    await p.managers.structure.measurement.addDistance(history[0].loci, history[1].loci)
  }

  function clearSelection() {
    const p = plugin()
    if (!p) return
    p.managers.interactivity.lociSelects.deselectAll()
    p.managers.structure.selection.clear()
  }

  async function clearMeasurements() {
    const p = plugin()
    if (!p) return
    const state = p.managers.structure.measurement.state
    const cells = [...state.distances, ...state.angles, ...state.dihedrals, ...state.orientations, ...state.planes]
    if (!cells.length) return
    const { PluginCommands } = await import("molstar/lib/mol-plugin/commands")
    await Promise.all(
      cells.map((cell) => {
        if (!cell.parent) return Promise.resolve()
        return PluginCommands.State.RemoveObject(p, {
          state: cell.parent,
          ref: cell.transform.parent,
          removeParentGhosts: true,
        })
      }),
    )
  }

  function exportName() {
    const src = narrowMolecularSource(props.data, props.kind)
    if (!src?.raw || src.format !== "xyz") return "molecule-structure.png"
    const name = src.raw
      .split(/\r?\n/)[1]
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
    return `${name || "molecule"}-structure.png`
  }

  async function exportPng() {
    await plugin()?.helpers.viewportScreenshot?.download(exportName())
  }

  onCleanup(() => {
    disposed = true
    token++
    subscriptions.forEach((subscription) => subscription.unsubscribe())
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
      data-status={status()}
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
      <div
        data-component="molecular-controls"
        data-preset={preset()}
        data-granularity={granularity()}
        data-background={theme()}
        style={{
          position: "absolute",
          top: "12px",
          left: "12px",
          right: "12px",
          display: "flex",
          "align-items": "center",
          gap: "6px",
          "flex-wrap": "wrap",
          "z-index": 3,
          "pointer-events": status() === "ready" ? "auto" : "none",
          opacity: status() === "ready" ? 1 : 0,
          transition: "opacity 160ms ease",
        }}
      >
        <select
          aria-label="Representation"
          value={preset()}
          onChange={(event) => void changePreset(event.currentTarget.value as Preset)}
          style={selectStyle()}
        >
          <option value="auto">Automatic</option>
          <option value="polymer-cartoon">Polymer cartoon</option>
          <option value="atomic-detail">Atomic detail</option>
          <option value="illustrative">Illustrative</option>
          <option value="molecular-surface">Molecular surface</option>
        </select>
        <select
          aria-label="Selection granularity"
          value={granularity()}
          onChange={(event) => changeGranularity(event.currentTarget.value as Granularity)}
          style={selectStyle()}
        >
          <option value="element">Atom selection</option>
          <option value="residue">Residue selection</option>
          <option value="chain">Chain selection</option>
        </select>
        <button type="button" style={buttonStyle()} onClick={() => plugin()?.managers.camera.reset()}>
          Reset camera
        </button>
        <button type="button" style={buttonStyle()} onClick={() => void toggleTheme()}>
          {theme() === "dark" ? "Light background" : "Dark background"}
        </button>
        <button type="button" style={buttonStyle()} onClick={() => void exportPng()}>
          Export PNG
        </button>
        <button
          type="button"
          style={buttonStyle()}
          disabled={selection().history < 2}
          onClick={() => void measureDistance()}
        >
          Measure distance
        </button>
        <Show when={selection().count > 0}>
          <button type="button" style={buttonStyle()} onClick={clearSelection}>
            Clear selection
          </button>
        </Show>
        <Show when={measurements() > 0}>
          <button type="button" style={buttonStyle()} onClick={() => void clearMeasurements()}>
            Clear measurements
          </button>
        </Show>
      </div>
      <Show when={selection().count > 0 || measurements() > 0}>
        <div
          data-component="molecular-selection"
          style={{
            position: "absolute",
            top: "58px",
            left: "12px",
            padding: "7px 9px",
            "border-radius": "6px",
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(9, 12, 18, 0.82)",
            color: "#e8ebf2",
            font: "11px/1.35 ui-sans-serif, system-ui, sans-serif",
            "backdrop-filter": "blur(12px)",
            "z-index": 2,
          }}
        >
          <Show when={selection().count > 0}>
            <span>{selection().label || `${selection().count} selected atoms`}</span>
          </Show>
          <Show when={selection().count > 0 && measurements() > 0}> · </Show>
          <Show when={measurements() > 0}>
            <span>
              {measurements()} measurement{measurements() === 1 ? "" : "s"}
            </span>
          </Show>
        </div>
      </Show>
      <Show when={summary()}>
        {(value) => (
          <div
            data-component="molecular-summary"
            style={{
              position: "absolute",
              left: "12px",
              bottom: "12px",
              display: "grid",
              gap: "7px",
              padding: "10px 11px",
              "max-width": "min(360px, calc(100% - 24px))",
              "border-radius": "7px",
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(9, 12, 18, 0.82)",
              "backdrop-filter": "blur(12px)",
              color: "#e8ebf2",
              "font-family": "ui-sans-serif, system-ui, sans-serif",
              "font-size": "11px",
              "line-height": 1.35,
              "z-index": 2,
            }}
          >
            <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
              <strong style={{ "font-size": "11px", "letter-spacing": "0.02em" }}>
                {value().format.toUpperCase()}
              </strong>
              <Show when={value().atomCount !== undefined}>
                <span>{value().atomCount} atoms</span>
              </Show>
              <Show when={value().bondCount !== undefined}>
                <span>{value().bondCount} bonds</span>
              </Show>
              <Show when={value().residueCount !== undefined}>
                <span>{value().residueCount} residues</span>
              </Show>
              <Show when={value().chainCount !== undefined}>
                <span>{value().chainCount} chains</span>
              </Show>
              <Show when={value().moleculeCount !== undefined}>
                <span>{value().moleculeCount} molecules</span>
              </Show>
            </div>
            <Show when={value().elements.length}>
              <div style={{ display: "flex", gap: "5px", "flex-wrap": "wrap", color: "#bac2d2" }}>
                <For each={value().elements}>
                  {(item) => (
                    <span
                      style={{
                        padding: "2px 5px",
                        "border-radius": "4px",
                        background: "rgba(255,255,255,0.08)",
                      }}
                    >
                      {item.element} {item.count}
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <For each={value().warnings}>{(warning) => <span style={{ color: "#f2c879" }}>{warning}</span>}</For>
          </div>
        )}
      </Show>
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

function selectStyle(): JSX.CSSProperties {
  return {
    height: "30px",
    padding: "0 27px 0 9px",
    border: "1px solid rgba(255,255,255,0.17)",
    "border-radius": "6px",
    background: "rgba(9, 12, 18, 0.88)",
    color: "#eef1f6",
    font: "11px/1 ui-sans-serif, system-ui, sans-serif",
    "backdrop-filter": "blur(12px)",
    cursor: "pointer",
  }
}

function buttonStyle(): JSX.CSSProperties {
  return {
    height: "30px",
    padding: "0 9px",
    border: "1px solid rgba(255,255,255,0.17)",
    "border-radius": "6px",
    background: "rgba(9, 12, 18, 0.88)",
    color: "#eef1f6",
    font: "11px/1 ui-sans-serif, system-ui, sans-serif",
    "backdrop-filter": "blur(12px)",
    cursor: "pointer",
  }
}
