import type { BunPlugin } from "bun"
import path from "node:path"
import { realpathSync } from "node:fs"
import { NativeTargets, nativePackageName } from "./native-targets"

export function buildOptions(args: string[], host = { os: process.platform as string, arch: process.arch as string }) {
  const headless = args.includes("--headless")
  const single = args.includes("--single")
  const baseline = args.includes("--baseline")
  const selector = args.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
  const index = args.indexOf("--target")
  const target = selector ?? (index >= 0 ? args[index + 1] : undefined)
  if ((index >= 0 || selector !== undefined) && (!target || target.startsWith("--"))) {
    throw new Error("--target requires a native target, for example linux-x64-baseline")
  }
  if (target && (single || baseline)) throw new Error("Use --target or --single/--baseline, not both")
  const targets = NativeTargets.filter((item) => {
    if (target) return nativePackageName("", item) === target
    if (!single) return true
    return item.os === host.os && item.arch === host.arch && !item.abi && (item.avx2 !== false || baseline)
  })
  if (!targets.length) {
    throw new Error(
      `Unsupported native target. Choose one of: ${NativeTargets.map((item) => nativePackageName("", item)).join(", ")}`,
    )
  }
  return { headless, targets, output: headless ? "dist/headless" : "dist" }
}

/** Resolve before reading a previously generated manifest, so a headless build
 * never embeds stale web assets or requires the frontend directory to exist. */
export function headlessAssets(root: string): BunPlugin {
  const importer = path.join(realpathSync(root), "src/web/assets.ts")
  return {
    name: "openscience-headless-assets",
    setup(build) {
      build.onResolve({ filter: /assets\.generated(?:\.ts)?$/ }, (args) => {
        if (args.importer !== importer) return
        return { path: "assets", namespace: "openscience-headless" }
      })
      build.onLoad({ filter: /.*/, namespace: "openscience-headless" }, () => ({
        contents: "export const WEB_ASSETS = {}; export const WEB_INDEX = undefined;",
        loader: "js",
      }))
    },
  }
}
