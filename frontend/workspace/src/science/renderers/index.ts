/**
 * Renderer registrations barrel.
 *
 * `ScienceArtifact.tsx` imports this module once (for side effects) so every
 * registered renderer is available before the first dispatch. Feature agents
 * add ONE import + `register(...)` line per kind below the AUTO marker during
 * the integration stage.
 *
 * Example (added by integration, NOT by feature agents):
 *
 *   import { ProteinStructure } from "./impl/protein-structure"
 *   register("protein-structure", ProteinStructure)
 */
import { register } from "./registry"

// keep `register` referenced so the import isn't tree-shaken before wiring
void register

// ── renderer registrations ─────────────────────────────────────────────────
// AUTO: renderers registered here by integration
import { registrations as molecular } from "./molecular"
import { registrations as genomics } from "./genomics"
import { registrations as documents } from "./documents"
import { registrations as media } from "./media"

for (const r of [...molecular, ...genomics, ...documents, ...media]) {
  register(r.kind, r.component)
}
// ────────────────────────────────────────────────────────────────────────────

export * from "./registry"
