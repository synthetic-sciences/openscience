/**
 * Media renderer bundle — raster image artifacts from compute kernels.
 *
 * Exports a plain `registrations` array mapping `kind → component` so the
 * integration barrel (`../index.ts`) can wire it in a single loop without this
 * file touching the shared registry.
 */
import type { ArtifactKind, ArtifactRenderer } from "../registry"
import { ImageView } from "./ImageView"

export interface RendererRegistration {
  kind: ArtifactKind
  component: ArtifactRenderer
}

export const registrations: RendererRegistration[] = [{ kind: "image", component: ImageView }]

export { ImageView }
export default registrations
