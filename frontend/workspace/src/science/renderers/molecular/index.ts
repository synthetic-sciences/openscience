/**
 * Molecular renderer bundle — 3D structures (Mol*) and 2D chemistry (RDKit.js).
 *
 * This folder is a self-contained feature bundle: each renderer is a standalone
 * Solid component that drives a framework-agnostic vanilla-JS library through a
 * ref (`onMount`/`createEffect`/`onCleanup`) with NO React dependency.
 *
 * `registrations` maps each supported `ArtifactKind` to its component. The
 * integration stage imports this array and registers each entry with the shared
 * renderer registry, e.g.:
 *
 *   import { registrations as molecular } from "./molecular"
 *   for (const r of molecular) register(r.kind, r.component)
 *
 * A convenience `registerAll(register)` helper is also exported for callers that
 * prefer to pass the registry's `register` function directly. Neither this file
 * nor the components touch `../registry`, `../index.ts`, or `ScienceArtifact`.
 */
import type { ArtifactKind, ArtifactRenderer } from "../registry"
import { ProteinStructure } from "./ProteinStructure"
import { Chem2D } from "./Chem2D"

export interface RendererRegistration {
  kind: ArtifactKind
  component: ArtifactRenderer
}

export const registrations: RendererRegistration[] = [
  // Mol* (molstar) — 3D macromolecules and small molecules (.pdb / .cif / .sdf / …)
  { kind: "protein-structure", component: ProteinStructure },
  { kind: "chem-3d", component: ProteinStructure },
  // RDKit.js — 2D chemical depiction from SMILES / Mol block
  { kind: "chem-2d", component: Chem2D },
]

export function registerAll(register: (kind: ArtifactKind, renderer: ArtifactRenderer) => void): void {
  for (const r of registrations) register(r.kind, r.component)
}

export { ProteinStructure, Chem2D }
