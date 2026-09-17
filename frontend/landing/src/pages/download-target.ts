export const DOWNLOADS = {
  "mac-arm64": { platform: "mac", label: "macOS (Apple Silicon)", os: "macOS", file: "OpenScience-mac-arm64.dmg" },
  "mac-x64": { platform: "mac", label: "macOS (Intel)", os: "macOS", file: "OpenScience-mac-x64.dmg" },
  "windows-x64": { platform: "windows", label: "Windows (x64)", os: "Windows", file: "OpenScience-windows-x64.exe" },
  "linux-x64": {
    platform: "linux",
    label: "Linux (x64, AppImage)",
    os: "Linux",
    file: "OpenScience-linux-x64.AppImage",
  },
  "linux-arm64": {
    platform: "linux",
    label: "Linux (ARM64, AppImage)",
    os: "Linux",
    file: "OpenScience-linux-arm64.AppImage",
  },
} as const

export type Target = keyof typeof DOWNLOADS
export type Platform = (typeof DOWNLOADS)[Target]["platform"]
export type DetectedTarget = Target | "mac-unknown"

export function detectTarget(userAgent: string, platform = ""): DetectedTarget {
  const agent = `${userAgent} ${platform}`.toLowerCase()
  if (agent.includes("win")) return "windows-x64"

  const arm = /arm64|aarch64/.test(agent)
  if (agent.includes("linux") || agent.includes("x11")) return arm ? "linux-arm64" : "linux-x64"
  if (/x86_64|amd64/.test(agent)) return "mac-x64"
  if (arm) return "mac-arm64"
  return "mac-unknown"
}

export function targetForArchitecture(
  target: DetectedTarget,
  architecture: string | undefined,
): Target | undefined {
  const value = architecture?.toLowerCase()
  if (!value || !/^(arm|arm64|aarch64|x86|x64|x86_64|amd64)$/.test(value)) return

  const arm = value.includes("arm")
  if (target.startsWith("linux")) return arm ? "linux-arm64" : "linux-x64"
  if (target.startsWith("mac")) return arm ? "mac-arm64" : "mac-x64"
}
