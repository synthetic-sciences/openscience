import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import path from "path"
import { cp } from "node:fs/promises"

export default defineConfig(({ isSsrBuild }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: { overlay: false },
  },
  plugins: [
    react(),
    {
      name: "publish-openscience-docs",
      apply: (_config, env) => env.command === "build" && !env.isSsrBuild,
      async closeBundle() {
        await cp(path.resolve(__dirname, "../docs/dist"), path.resolve(__dirname, "dist/docs"), { recursive: true })
      },
    },
  ],
  build: {
    copyPublicDir: !isSsrBuild,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}))
