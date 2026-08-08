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
 * Project-scoped compute inventory.
 *
 * This surface never starts work. Agent execution creates kernels and shell
 * commands or governed remote GPU jobs; Compute only reflects what is live and
 * lets the user stop work that is already running. Completed remote results stay
 * readable without becoming a second launcher. Keeping that boundary here prevents a session switch
 * from turning this project-wide inspector into a second execution launcher.
 */
export function ComputeSurface(props: ComputeSurfaceProps = {}): JSX.Element {
  const strip = props.strip ?? HostStrip
  const kernels = props.kernels ?? KernelPanel

  return (
    <section class="compute-surface" aria-label="Compute">
      <Dynamic component={strip} />
      <div class="compute-surface__panel" data-compute-child="kernels">
        <Dynamic component={kernels} />
      </div>
    </section>
  )
}
