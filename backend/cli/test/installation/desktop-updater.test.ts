import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { asset, checksum, release, stage } from "../../../../frontend/desktop/src/updater.mjs"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("desktop update release contract", () => {
  test("selects the exact architecture payload and requires GitHub's digest", async () => {
    const name = asset("arm64")
    const server = Bun.serve({
      port: 0,
      routes: {
        "/releases/tags/v3.2.1": Response.json({
          tag_name: "v3.2.1",
          draft: false,
          prerelease: false,
          assets: [
            {
              name,
              digest: `sha256:${"a".repeat(64)}`,
              browser_download_url:
                "https://github.com/synthetic-sciences/openscience/releases/download/v3.2.1/update.zip",
            },
          ],
        }),
      },
    })

    expect(await release("3.2.1", { api: server.url, arch: "arm64" })).toEqual({
      version: "3.2.1",
      name,
      url: "https://github.com/synthetic-sciences/openscience/releases/download/v3.2.1/update.zip",
      digest: "a".repeat(64),
    })
    server.stop(true)
  })
})

describe.skipIf(process.platform !== "darwin")("macOS desktop update integration", () => {
  test("downloads, verifies, replaces, and validates an ad-hoc-signed app bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-update-test-"))
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

    const archive = path.join(root, asset(process.arch))
    expect((await Bun.$`ditto -c -k --sequesterRsrc --keepParent ${bundle} ${archive}`.quiet()).exitCode).toBe(0)
    const digest = await checksum(archive)
    const server = Bun.serve({
      port: 0,
      routes: {
        "/releases/tags/v9.8.7": (request) =>
          Response.json({
            tag_name: "v9.8.7",
            draft: false,
            prerelease: false,
            assets: [
              {
                name: asset(process.arch),
                digest: `sha256:${digest}`,
                browser_download_url: new URL("/asset", request.url).toString(),
              },
            ],
          }),
        "/asset": new Response(Bun.file(archive)),
      },
    })

    const update = await stage("9.8.7", {
      api: server.url,
      arch: process.arch,
      cache: path.join(root, "cache"),
    })
    server.stop(true)

    const current = path.join(root, "Installed.app")
    await Bun.$`ditto ${bundle} ${current}`.quiet()
    const helper = new URL("../../../../frontend/desktop/src/update-helper.mjs", import.meta.url)
    const payload = Buffer.from(
      JSON.stringify({
        parent: 2_147_483_647,
        current,
        staged: update.bundle,
        backup: path.join(root, "Installed.previous.app"),
        root: update.root,
      }),
    ).toString("base64url")
    const child = Bun.spawn([process.execPath, helper.pathname, payload], {
      env: { ...process.env, OPENSCIENCE_UPDATE_SKIP_LAUNCH: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(
      (
        await Bun.$`plutil -extract CFBundleShortVersionString raw ${path.join(current, "Contents", "Info.plist")}`.text()
      ).trim(),
    ).toBe("9.8.7")
    expect((await Bun.$`codesign --verify --deep --strict ${current}`.quiet()).exitCode).toBe(0)
  })
})
