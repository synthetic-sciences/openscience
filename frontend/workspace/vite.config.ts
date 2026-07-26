import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const MOLSTAR_PACKAGE_ROOT = "/node_modules/molstar/"

export function workspaceManualChunks(id: string): string | undefined {
  const normalized = id.replaceAll("\\", "/")
  if (normalized.startsWith("node_modules/molstar/") || normalized.includes(MOLSTAR_PACKAGE_ROOT)) {
    return "molstar"
  }
}

export default defineConfig({
  plugins: [desktopPlugin] as any,
  // @pierre/diffs and the workspace both depend on Shiki. Resolve them to one
  // runtime so Vite emits each language/theme chunk once instead of twice.
  resolve: {
    dedupe: ["shiki"],
  },
  // Vite's dependency scanner does not traverse module workers. Without an
  // explicit include, the first RDKit render discovers and optimizes the
  // Emscripten bundle on demand, which can exceed the worker's timeout on a
  // cold checkout. Pre-bundle it while the dev server starts instead.
  optimizeDeps: {
    include: ["@rdkit/rdkit"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        // Molstar has circular re-exports throughout its package. Its three
        // lazy entry imports must share one chunk or Rollup can split those
        // cycles across chunks and produce an unsafe execution order. Keep
        // dependency merging explicit so this does not pull Molstar into the
        // application entry or absorb unrelated packages into its chunk.
        onlyExplicitManualChunks: true,
        manualChunks: workspaceManualChunks,
      },
    },
    // sourcemap: true,
    // Never inline audio (notification sounds) as base64 — sound.ts imports ~45
    // alert clips, and inlining the small ones baked ~58KB gzip of base64 into
    // the entry chunk for sounds that (a) are off by default and (b) only ever
    // play on an event, never at first paint. As separate assets they're fetched
    // on demand when a sound actually plays.
    assetsInlineLimit(filePath) {
      if (/\.(aac|mp3|wav|ogg|m4a)$/.test(filePath)) return false
      return undefined
    },
  },
})
