import { readFileSync } from "node:fs"
import path from "node:path"

const source = process.env.OPENSCIENCE_DESKTOP_SIDECAR
if (!source) throw new Error("OPENSCIENCE_DESKTOP_SIDECAR must point to the native OpenScience runtime")
// Local builds follow the CLI version instead of a hardcoded fallback that
// silently goes stale between releases.
const version =
  process.env.OPENSCIENCE_VERSION ||
  JSON.parse(readFileSync(new URL("../../backend/cli/package.json", import.meta.url), "utf8")).version

const name = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux"
const signed = process.env.OPENSCIENCE_DESKTOP_SIGNED === "true"

export default {
  appId: "ai.syntheticsciences.openscience",
  productName: "OpenScience",
  executableName: "openscience",
  artifactName: `OpenScience-${name}-\${arch}.\${ext}`,
  extraMetadata: { version },
  directories: { output: "dist" },
  files: ["src/**/*", "package.json"],
  extraResources: [
    {
      from: path.resolve(source),
      to: process.platform === "win32" ? "sidecar/openscience.exe" : "sidecar/openscience",
    },
  ],
  asar: true,
  mac: {
    // Keep the CLI/process executable lowercase on every platform, but brand
    // the macOS bundle exactly as the updater's immutable staging contract.
    // electron-builder otherwise derives `openscience.app` from the global
    // executableName even though productName is OpenScience.
    executableName: "OpenScience",
    target: ["dmg", "zip"],
    icon: "build/icon.icns",
    category: "public.app-category.developer-tools",
    identity: signed ? undefined : "-",
    forceCodeSigning: signed,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: signed && process.env.APPLE_ID ? true : false,
    extendInfo: {
      NSDesktopFolderUsageDescription:
        "OpenScience accesses Desktop files only when you choose a project or file there.",
      NSDocumentsFolderUsageDescription:
        "OpenScience accesses Documents files only when you choose a project or file there.",
      NSDownloadsFolderUsageDescription:
        "OpenScience accesses Downloads files only when you choose a project or file there.",
      NSRemovableVolumesUsageDescription:
        "OpenScience accesses removable volumes only when you choose a project or file there.",
      NSNetworkVolumesUsageDescription:
        "OpenScience accesses network volumes only when you choose a project or file there.",
    },
  },
  // Sign the outermost installer as well as the app bundle. The release
  // workflow notarizes and staples this signed DMG after electron-builder
  // finishes so Gatekeeper can validate the exact downloaded container.
  dmg: { sign: signed },
  win: {
    target: ["nsis"],
    icon: "build/icon.ico",
    forceCodeSigning: signed,
    signExecutable: signed,
  },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: { target: ["AppImage"], category: "Science;Development", icon: "build/icon.png" },
}
