import type { Component, JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { HostStrip } from "@/atlas/HostStrip"
import { KernelPanel } from "@/atlas/KernelPanel"
import "@/atlas/ComputeSurface.css"

type ComputeSurfaceProps = {
  strip?: Component
  kernels?: Component
}

/**
 * Project-scoped Compute inventory.
 *
 * This surface is a read-only instrument panel. Agent execution creates
 * kernels, shell commands, or governed remote jobs; Compute only tracks what
 * is live or still needs operational attention. It intentionally owns no
 * configuration, lifecycle controls, or completed-history workflow.
 */
export function ComputeSurface(props: ComputeSurfaceProps = {}): JSX.Element {
  const strip = props.strip ?? HostStrip
  const kernels = props.kernels ?? KernelPanel

  return (
    <section class="activity-surface compute-surface" aria-label="Compute">
      <Dynamic component={strip} />
      <div class="compute-surface__panel" data-compute-child="kernels">
        <Dynamic component={kernels} />
      </div>
    </section>
  )
}

/** @deprecated Kept for extensions that briefly imported the transitional name. */
export const ActivitySurface = ComputeSurface
