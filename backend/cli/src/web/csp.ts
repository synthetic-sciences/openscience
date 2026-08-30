const APP_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:; object-src 'self' data: blob:; frame-src 'self' blob:; worker-src 'self'"

// The upstream RDKit.js build uses Emscripten's Function constructor while
// registering its bindings. Keep that capability out of the application page:
// chemistry runs in this dedicated worker, whose only inputs and outputs are
// structured molecule data and an SVG string.
const RDKIT_WORKER_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'"

const RDKIT_WORKER_ASSET = /^\/assets\/rdkit\.worker-[A-Za-z0-9_-]+\.js$/

export function webAssetContentSecurityPolicy(path: string): string {
  return RDKIT_WORKER_ASSET.test(path) ? RDKIT_WORKER_CONTENT_SECURITY_POLICY : APP_CONTENT_SECURITY_POLICY
}
