#!/usr/bin/env node

import fs from "fs"
import path from "path"
import os from "os"
import childProcess from "child_process"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function detectPlatformAndArch() {
  // Map platform names
  let platform
  switch (os.platform()) {
    case "darwin":
      platform = "darwin"
      break
    case "linux":
      platform = "linux"
      break
    case "win32":
      platform = "windows"
      break
    default:
      platform = os.platform()
      break
  }

  // Map architecture names
  let arch
  switch (os.arch()) {
    case "x64":
      arch = "x64"
      break
    case "arm64":
      arch = "arm64"
      break
    case "arm":
      arch = "arm"
      break
    default:
      arch = os.arch()
      break
  }

  return { platform, arch }
}

function detectMusl(platform) {
  if (platform !== "linux") return false
  try {
    return fs.readdirSync("/lib").some((entry) => entry.startsWith("ld-musl-"))
  } catch {
    return false
  }
}

function cpuSupportsAvx2(platform, arch, linuxInfo) {
  if (arch !== "x64") return undefined
  if (platform === "linux") {
    const info = (() => {
      if (linuxInfo !== undefined) return linuxInfo
      try {
        return fs.readFileSync("/proc/cpuinfo", "utf8")
      } catch {
        return undefined
      }
    })()
    if (!info) return undefined
    const flags = /^(?:flags|features)\s*:\s*(.+)$/im.exec(info)?.[1]
    if (!flags) return undefined
    return flags.toLowerCase().split(/\s+/).includes("avx2")
  }
  if (platform !== "darwin") return undefined
  const result = childProcess.spawnSync("sysctl", ["-n", "machdep.cpu.leaf7_features"], { encoding: "utf8" })
  if (result.status !== 0) return undefined
  return result.stdout.toLowerCase().split(/\s+/).includes("avx2")
}

function linuxKernelProblem(platform, release = os.release()) {
  if (platform !== "linux") return undefined
  const match = /^(\d+)\.(\d+)/.exec(release)
  if (!match) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major > 5 || (major === 5 && minor >= 1)) return undefined
  return `Linux kernel ${release} is unsupported; OpenScience's bundled runtime requires kernel 5.1 or newer`
}

function pageSize(platform) {
  if (platform !== "linux") return undefined
  const result = childProcess.spawnSync("getconf", ["PAGESIZE"], { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() || undefined : undefined
}

function linuxArm64PageSizeProblem(platform, arch, detectedPageSize) {
  if (platform !== "linux" || arch !== "arm64" || detectedPageSize === undefined) return undefined
  const bytes = Number.parseInt(String(detectedPageSize), 10)
  if (!Number.isFinite(bytes) || bytes === 4096) return undefined
  return [
    `Linux ARM64 page size ${bytes} is unsupported by OpenScience's Bun-compiled executable`,
    "use a kernel or VM configured with 4 KB pages",
    "upstream status: https://github.com/oven-sh/bun/issues/17627",
  ].join("; ")
}

function platformPackageNames(
  platform,
  arch,
  musl = detectMusl(platform),
  preferBaseline = cpuSupportsAvx2(platform, arch) === false,
) {
  const base = `openscience-${platform}-${arch}`
  const variants = musl ? [`${base}-musl`] : [base]
  if (arch === "x64") variants.push(musl ? `${base}-baseline-musl` : `${base}-baseline`)
  const ranked = preferBaseline
    ? variants.sort((a, b) => Number(b.includes("-baseline")) - Number(a.includes("-baseline")))
    : variants
  return ranked.flatMap((name) => [`@synsci/${name}`, name])
}

function findBinary() {
  const { platform, arch } = detectPlatformAndArch()
  const binaryName = platform === "windows" ? "openscience.exe" : "openscience"

  // Try the libc-compatible native package first, followed by an x64 baseline
  // build for older CPUs. Never select a package for the wrong architecture.
  const packageNames = platformPackageNames(platform, arch)

  for (const packageName of packageNames) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`)
      const packageDir = path.dirname(packageJsonPath)
      const binaryPath = path.join(packageDir, "bin", binaryName)

      if (!fs.existsSync(binaryPath)) {
        continue
      }

      return { binaryPath, binaryName }
    } catch {
      continue
    }
  }

  throw new Error(
    [
      `Could not find a native platform binary for ${platform}-${arch}.`,
      `Expected one of: ${packageNames.join(", ")}.`,
      `Detected node ${process.version} on kernel ${os.release()}.`,
      `Check npm selection with: npm config get cpu`,
      `Then inspect the install with: npm ls -g @synsci/openscience ${packageNames[0]} --depth=0`,
    ].join("\n"),
  )
}

function prepareBinDirectory(binaryName) {
  const binDir = path.join(__dirname, "bin")
  const targetPath = path.join(binDir, binaryName)

  // Ensure bin directory exists
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true })
  }

  // Remove existing binary/symlink if it exists
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath)
  }

  return { binDir, targetPath }
}

function symlinkBinary(sourcePath, binaryName) {
  const { targetPath } = prepareBinDirectory(binaryName)

  fs.symlinkSync(sourcePath, targetPath)
  console.log(`openscience binary symlinked: ${targetPath} -> ${sourcePath}`)

  // Verify the file exists after operation
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Failed to symlink binary to ${targetPath}`)
  }
}

function main() {
  try {
    if (os.platform() === "win32") {
      // On Windows, the .exe is already included in the package and bin field points to it
      // No postinstall setup needed
      console.log("Windows detected: binary setup not needed (using packaged .exe)")
      return
    }

    const { platform, arch } = detectPlatformAndArch()
    const kernelProblem = linuxKernelProblem(platform)
    if (kernelProblem) {
      throw new Error(`${kernelProblem}. CentOS 7's stock 3.10 kernel is not supported.`)
    }
    const pageSizeProblem = linuxArm64PageSizeProblem(platform, arch, pageSize(platform))
    if (pageSizeProblem) {
      throw new Error(pageSizeProblem)
    }

    // On non-Windows platforms, just verify the binary package exists
    // Don't replace the wrapper script - it handles binary execution
    const { binaryPath } = findBinary()
    console.log(`Platform binary verified at: ${binaryPath}`)
    console.log("Wrapper script will handle binary execution")
  } catch (error) {
    console.error("Failed to setup openscience binary:", error.message)
    process.exit(1)
  }
}

export {
  cpuSupportsAvx2,
  detectMusl,
  detectPlatformAndArch,
  findBinary,
  linuxArm64PageSizeProblem,
  linuxKernelProblem,
  platformPackageNames,
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
