import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import pkg from "../../package.json"
import { NativeTargets, nativePackageName } from "../../script/native-targets"
import { createWrapperPackageManifest } from "../../script/publish-manifest"

async function pack(dir: string, output: string) {
  const proc = Bun.spawn(["npm", "pack", "--json", "--pack-destination", output], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  const result = JSON.parse(stdout) as { filename?: string }[]
  const file = result[0]?.filename
  if (!file) throw new Error(`npm pack did not return a tarball for ${dir}`)
  return path.join(output, file)
}

// This exercises seven real, sequential npm resolver installs. Their combined
// runtime legitimately exceeds Bun's 5s unit-test default on a loaded runner.
test("npm selects every supported native package contract with lifecycle scripts disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-native-matrix-"))
  const source = path.join(root, "packages")
  const wrapper = path.join(root, "wrapper")
  const tarballs = path.join(root, "tarballs")
  const npmrc = path.join(root, "npmrc")
  const specs = NativeTargets.map((target) => ({
    name: nativePackageName(pkg.name, target),
    os: target.os,
    cpu: target.arch,
    libc: target.os === "linux" ? (target.abi ?? "glibc") : undefined,
  }))
  const cases = [
    { os: "darwin", cpu: "arm64" },
    { os: "darwin", cpu: "x64" },
    { os: "linux", cpu: "x64", libc: "glibc" },
    { os: "linux", cpu: "x64", libc: "musl" },
    { os: "linux", cpu: "arm64", libc: "glibc" },
    { os: "linux", cpu: "arm64", libc: "musl" },
    { os: "win32", cpu: "x64" },
  ]

  try {
    await Promise.all([
      fs.mkdir(source, { recursive: true }),
      fs.mkdir(wrapper, { recursive: true }),
      fs.mkdir(tarballs, { recursive: true }),
      Bun.write(npmrc, ""),
    ])

    const binaries: Record<string, string> = {}
    for (const spec of specs) {
      const dir = path.join(source, spec.name)
      await fs.mkdir(path.join(dir, "bin"), { recursive: true })
      await Bun.write(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: spec.name,
          version: "1.2.3",
          os: [spec.os],
          cpu: [spec.cpu],
          ...(spec.libc ? { libc: [spec.libc] } : {}),
        }),
      )
      await Bun.write(path.join(dir, "bin", spec.os === "win32" ? "openscience.exe" : "openscience"), "")
      binaries[spec.name] = `file:${await pack(dir, tarballs)}`
    }

    await fs.mkdir(path.join(wrapper, "bin"), { recursive: true })
    await Bun.write(path.join(wrapper, "bin", "openscience"), "")
    await Bun.write(
      path.join(wrapper, "package.json"),
      JSON.stringify(
        createWrapperPackageManifest({
          source: { name: pkg.name },
          version: "1.2.3",
          binaries,
        }),
      ),
    )
    const wrapperTarball = await pack(wrapper, tarballs)

    for (const target of cases) {
      const dir = path.join(root, "installs", [target.os, target.cpu, target.libc].filter(Boolean).join("-"))
      await fs.mkdir(dir, { recursive: true })
      await Bun.write(
        path.join(dir, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: {
            [pkg.name]: `file:${wrapperTarball}`,
          },
        }),
      )

      const proc = Bun.spawn(
        [
          "npm",
          "install",
          "--ignore-scripts",
          "--package-lock=false",
          "--no-audit",
          "--no-fund",
          `--os=${target.os}`,
          `--cpu=${target.cpu}`,
          ...(target.libc ? [`--libc=${target.libc}`] : []),
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            HOME: path.join(root, "home"),
            NPM_CONFIG_CACHE: path.join(root, "cache"),
            NPM_CONFIG_USERCONFIG: npmrc,
            NPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
            NPM_CONFIG_UPDATE_NOTIFIER: "false",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(code, stderr || stdout).toBe(0)

      const expected = specs
        .filter(
          (spec) =>
            spec.os === target.os && spec.cpu === target.cpu && (target.os !== "linux" || spec.libc === target.libc),
        )
        .map((spec) => spec.name.replace("@synsci/", ""))
        .concat("openscience")
        .sort()
      const installed = await fs.readdir(path.join(dir, "node_modules", "@synsci"))
      expect(installed.toSorted()).toEqual(expected)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
