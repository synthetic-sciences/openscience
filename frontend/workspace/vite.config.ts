import { defineConfig } from "vite"
import desktopPlugin from "./vite"

export default defineConfig({
  plugins: [desktopPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
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
