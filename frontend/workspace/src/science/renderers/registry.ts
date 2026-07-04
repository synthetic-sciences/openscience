import type { Component } from "solid-js"

/**
 * Registry mapping a scientific artifact `kind` to the Solid component that
 * renders it inline in chat. Renderer feature agents implement ONE component
 * per kind in `./impl/<kind>.tsx` and register it in the integration stage.
 *
 * The dispatcher (`ScienceArtifact.tsx`) reads from this registry; nothing else
 * should. Keeping the mapping here means adding a renderer never touches the
 * chat rendering code path.
 */

/** Known artifact kinds. Extend as renderer agents add support. */
export type ArtifactKind =
  | "protein-structure" // molstar / 3dmol — .pdb / .cif / mmCIF
  | "genome-track" // igv.js — BAM/VCF/BED/bigWig tracks
  | "chem-2d" // RDKit — 2D molecule depiction from SMILES/MOL
  | "chem-3d" // 3Dmol — 3D molecule from MOL/SDF/XYZ
  | "msa" // multiple sequence alignment viewer
  | "sequence" // linear nucleotide/protein sequence
  | "pdf" // pdfjs-dist — inline PDF pages
  | "latex" // katex — rendered math / equations
  | (string & {})

/** Props every science renderer receives. */
export interface ArtifactRenderProps {
  /** The artifact kind (redundant with lookup key; handy for shared renderers). */
  kind: ArtifactKind
  /**
   * The artifact payload. Shape is kind-specific — e.g. { pdb: string } for
   * protein-structure, { smiles: string } for chem-2d, { tex: string } for latex.
   * Renderers validate/narrow this themselves.
   */
  data: unknown
  /** Optional display height hint in px. */
  height?: number
}

export type ArtifactRenderer = Component<ArtifactRenderProps>

const renderers = new Map<string, ArtifactRenderer>()

export function register(kind: ArtifactKind, renderer: ArtifactRenderer): void {
  renderers.set(kind, renderer)
}

export function get(kind: ArtifactKind): ArtifactRenderer | undefined {
  return renderers.get(kind)
}

export function has(kind: ArtifactKind): boolean {
  return renderers.has(kind)
}

export function kinds(): string[] {
  return [...renderers.keys()]
}

/**
 * Side-effect registrations live in `./index.ts` so `ScienceArtifact` can import
 * that module once and have every renderer registered.
 *
 * AUTO: renderers registered here by integration
 * (feature agents: create ./impl/<kind>.tsx exporting a renderer, then add a
 *  `register("<kind>", <Renderer>)` call in ./index.ts during integration — do
 *  NOT edit this registry file or the chat rendering path yourself.)
 */
