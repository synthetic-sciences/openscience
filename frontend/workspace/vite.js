import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"
import thesisBridge from "./vite-thesis.js"
import folderResolve from "./vite-folder-resolve.js"
import repoBridge from "./vite-repo.js"

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "openscience-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  tailwindcss(),
  solidPlugin(),
  thesisBridge,
  folderResolve,
  repoBridge,
]
