/**
 * Documents renderer bundle.
 *
 * This folder ships three framework-agnostic science-artifact renderers:
 *   - "pdf"      → pdfjs-dist page rasterizer (canvases mounted via a ref)
 *   - "latex"    → KaTeX math typesetter
 *   - "sequence" → single linear nucleotide/protein sequence viewer
 *
 * It exports a plain `registrations` array mapping `kind → component` so the
 * integration stage can wire everything in a single loop without this file
 * touching the shared registry:
 *
 *   import { registrations } from "./documents"
 *   for (const r of registrations) register(r.kind, r.component)
 *
 * Per the science-framework rules, feature-agent folders do NOT edit
 * `../registry.ts`, `../index.ts`, or `../../ScienceArtifact.tsx`.
 */
import type { ArtifactKind, ArtifactRenderer } from "../registry"
import { LatexView } from "./LatexView"
import { PdfViewer } from "./PdfViewer"
import { SequenceViewer } from "./SequenceViewer"

export interface RendererRegistration {
  kind: ArtifactKind
  component: ArtifactRenderer
}

export const registrations: RendererRegistration[] = [
  { kind: "pdf", component: PdfViewer },
  { kind: "latex", component: LatexView },
  { kind: "sequence", component: SequenceViewer },
]

export { LatexView, PdfViewer, SequenceViewer }
export default registrations
