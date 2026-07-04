/**
 * Genomics renderer bundle.
 *
 * This folder ships two framework-agnostic science-artifact renderers:
 *   - "genome-track" → igv.js genome browser (mounted via a ref in onMount)
 *   - "msa"          → lightweight canvas multiple-sequence-alignment viewer
 *
 * It exports a plain `registrations` array mapping `kind → component` so the
 * integration stage can wire everything in a single loop without this file
 * touching the shared registry:
 *
 *   import { registrations } from "./genomics"
 *   for (const r of registrations) register(r.kind, r.component)
 *
 * Per the science-framework rules, feature-agent folders do NOT edit
 * `../registry.ts`, `../index.ts`, or `../../ScienceArtifact.tsx`.
 */
import type { ArtifactKind, ArtifactRenderer } from "../registry"
import { GenomeTrack } from "./GenomeTrack"
import { MsaViewer } from "./MsaViewer"

export interface RendererRegistration {
  kind: ArtifactKind
  component: ArtifactRenderer
}

export const registrations: RendererRegistration[] = [
  { kind: "genome-track", component: GenomeTrack },
  { kind: "msa", component: MsaViewer },
]

export { GenomeTrack, MsaViewer }
export default registrations
