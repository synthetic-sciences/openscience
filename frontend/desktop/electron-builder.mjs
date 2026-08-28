import path from "node:path"

const source = process.env.OPENSCIENCE_DESKTOP_SIDECAR
if (!source) throw new Error("OPENSCIENCE_DESKTOP_SIDECAR must point to the native OpenScience runtime")

const name = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux"
const signed = process.env.OPENSCIENCE_DESKTOP_SIGNED === "true"

export default {
  appId: "ai.syntheticsciences.openscience",
  productName: "OpenScience",
  artifactName: `OpenScience-${name}-\${arch}.\${ext}`,
  extraMetadata: {
    version: process.env.OPENSCIENCE_VERSION || "2.0.47",
  },
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
    target: ["dmg"],
    icon: "build/icon.icns",
    category: "public.app-category.developer-tools",
    identity: signed ? undefined : "-",
    forceCodeSigning: signed,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: signed && process.env.APPLE_ID ? true : false,
  },
  dmg: { sign: false },
  win: {
    target: ["nsis"],
    icon: "build/icon.ico",
    forceCodeSigning: signed,
    signExecutable: signed,
  },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: { target: ["AppImage"], category: "Science;Development", icon: "build/icon.png" },
}
