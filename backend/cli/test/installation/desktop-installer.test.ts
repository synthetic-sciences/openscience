import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { asset, checksum } from "../../../../frontend/desktop/src/updater.mjs"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== "darwin")("certificate-free macOS desktop installer", () => {
  test("verifies, replaces, clears quarantine, and installs the real bundle shape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-installer-test-"))
    roots.push(root)
    const build = path.join(root, "build")
    const bundle = path.join(build, "OpenScience.app")
    const contents = path.join(bundle, "Contents")
    const binary = path.join(contents, "MacOS", "openscience")
    await mkdir(path.dirname(binary), { recursive: true })
    await Bun.write(
      path.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>openscience</string>
<key>CFBundleIdentifier</key><string>ai.syntheticsciences.openscience</string>
<key>CFBundleName</key><string>OpenScience</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>9.8.7</string>
<key>CFBundleVersion</key><string>9.8.7</string>
</dict></plist>`,
    )
    await Bun.write(binary, "#!/bin/sh\nexit 0\n")
    await chmod(binary, 0o755)
    expect((await Bun.$`codesign --force --deep --sign - ${bundle}`.quiet()).exitCode).toBe(0)
    expect((await Bun.$`xattr -w com.apple.quarantine "0081;test;OpenScience;" ${bundle}`.quiet()).exitCode).toBe(0)

    const name = asset(process.arch)
    const archive = path.join(root, name)
    expect((await Bun.$`ditto -c -k --sequesterRsrc --keepParent ${bundle} ${archive}`.quiet()).exitCode).toBe(0)
    const digest = await checksum(archive)
    const server = Bun.serve({
      port: 0,
      routes: {
        [`/${name}`]: new Response(Bun.file(archive)),
        "/desktop-checksums.txt": new Response(`${digest}  ${name}\n`),
      },
    })

    const target = path.join(root, "Applications", "OpenScience.app")
    const script = new URL("../../../../frontend/landing/public/install-desktop", import.meta.url).pathname
    const child = Bun.spawn(["/bin/bash", script], {
      env: {
        ...process.env,
        OPENSCIENCE_DESKTOP_RELEASE_ROOT: server.url.toString().replace(/\/$/, ""),
        OPENSCIENCE_DESKTOP_DESTINATION: target,
        OPENSCIENCE_DESKTOP_SKIP_LAUNCH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    server.stop(true)

    expect(stderr).toBe("")
    expect(status).toBe(0)
    expect(stdout).toContain("OpenScience 9.8.7 is installed")
    expect(
      (
        await Bun.$`plutil -extract CFBundleShortVersionString raw ${path.join(target, "Contents", "Info.plist")}`.text()
      ).trim(),
    ).toBe("9.8.7")
    expect((await Bun.$`codesign --verify --deep --strict ${target}`.quiet()).exitCode).toBe(0)
    expect((await Bun.$`xattr -p com.apple.quarantine ${target}`.quiet().nothrow()).exitCode).not.toBe(0)
  })
})
