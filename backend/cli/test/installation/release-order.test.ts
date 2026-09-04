import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const root = path.join(import.meta.dir, "../../../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

test("pull requests use one fast product-level lane", async () => {
  const workflow = await read(".github/workflows/ci.yml")
  const parsed = Bun.YAML.parse(workflow) as { jobs: Record<string, { name: string; if?: string }> }

  expect(workflow).toContain("name: Fast CI")
  expect(workflow).toContain("bun run typecheck")
  expect(workflow).toContain("bun run --cwd frontend/workspace build")
  expect(workflow).toContain("Smoke release entrypoints")
  expect(workflow).toContain("bun tooling/repo/test-shards.ts affected")
  expect(workflow).toContain('bun test --timeout 15000 "${paths[@]}"')
  expect(workflow).toContain("--cache-strategy content")
  expect(workflow).not.toContain("bun run --cwd backend/cli test")
  expect(workflow).not.toContain("matrix:")
  // Branch protection requires these exact check names; none may be skipped.
  expect(Object.values(parsed.jobs).map((job) => job.name)).toEqual(["Typecheck", "Format", "Build (web)", "Test"])
  for (const job of Object.values(parsed.jobs)) expect(job.if).toBeUndefined()
})

test("exhaustive and native suites stay off the pull request path", async () => {
  const workflow = await read(".github/workflows/deep-ci.yml")
  const parsed = Bun.YAML.parse(workflow) as { jobs: Record<string, { needs?: string[]; if?: string }> }

  expect(workflow).toContain("workflow_dispatch:")
  expect(workflow).toContain("schedule:")
  expect(workflow).toContain('matrix="$(bun tooling/repo/test-shards.ts)"')
  expect(workflow).toContain("shard: ${{ fromJSON(needs.plan.outputs.matrix) }}")
  expect(workflow).toContain('bun test --timeout 15000 "${paths[@]}"')
  expect(workflow).toContain("sudo apt-get install --yes bubblewrap openssh-server")
  expect(parsed.jobs.backend.needs).toEqual(["plan"])
  expect(parsed.jobs.suite.needs).toEqual(["plan", "backend"])
  expect(parsed.jobs.suite.if).toBe("always()")
  expect(workflow).toContain("test/process/darwin-responsibility.test.ts")
  expect(workflow).toContain("test/process/windows-job.test.ts")
  expect(workflow).not.toContain("pull_request:")
})

test("production requires an exact artifact-source deep release rehearsal", async () => {
  const workflow = await read(".github/workflows/publish.yml")
  const script = await read("tooling/repo/version.ts")
  const source = workflow.indexOf("Resolve release rehearsal source")
  const rehearsal = workflow.indexOf("Verify exact artifact-source release rehearsal")
  const version = workflow.indexOf("Resolve version and draft release")

  expect(workflow).toContain("name: Release")
  expect(workflow).toContain("Verify npm publisher")
  expect(source).toBeGreaterThan(-1)
  expect(rehearsal).toBeGreaterThan(source)
  expect(version).toBeGreaterThan(rehearsal)
  expect(workflow).toContain('OPENSCIENCE_SOURCE_PREFLIGHT: "true"')
  expect(workflow).toContain("SOURCE: ${{ steps.rehearsal.outputs.rehearsal_source }}")
  expect(workflow).toContain("OPENSCIENCE_EXPECTED_ARTIFACT_SOURCE: ${{ steps.rehearsal.outputs.rehearsal_source }}")
  expect(workflow).toContain("head_sha: process.env.SOURCE")
  expect(workflow).toContain("const missing = expected.filter((name) => !passed.has(name))")
  expect(workflow).toContain("if (missing.length === 0) {")
  expect(workflow).not.toContain("SOURCE: ${{ github.sha }}")
  expect(script).toContain('process.env.OPENSCIENCE_SOURCE_PREFLIGHT === "true"')
  expect(script).toContain("rehearsal_source=${source}")
  expect(script).toContain("OPENSCIENCE_EXPECTED_ARTIFACT_SOURCE")
  expect(script).toContain("Release artifact source changed after rehearsal")
  expect(script.match(/already exists at \$\{tagged\} without a GitHub release/g)).toHaveLength(2)
  expect(workflow).toContain(
    "needs: [version, sign-macos-cli, prepare-npm, build-desktop-mac, build-desktop-other, verify-desktop-updater]",
  )
  expect(workflow).not.toContain("npm-test-gate")
  expect(workflow).not.toContain("verify-native-cli")
})

test("the release gate expects every rehearsal gate job by exact name", async () => {
  const publish = await read(".github/workflows/publish.yml")
  const rehearsal = Bun.YAML.parse(await read(".github/workflows/npm-test.yml")) as {
    jobs: Record<
      string,
      { name?: string; strategy?: { matrix: { os?: string[]; capability?: string[]; include?: { name: string }[] } } }
    >
  }
  const list = (source: string, name: string) => {
    const match = source.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`))
    if (!match) throw new Error(`publish.yml no longer derives ${name}`)
    return match[1].split(",").map((value) => value.trim().replace(/^"|"$/g, ""))
  }
  const canary = rehearsal.jobs["scientific-capability-canary"]
  const smoke = rehearsal.jobs["os-smoke"]

  expect(canary.name).toBe("scientific capability canary (${{ matrix.os }}, ${{ matrix.capability }})")
  expect(smoke.name).toBe("os-smoke (${{ matrix.name }})")
  expect(canary.strategy?.matrix.os).toEqual(list(publish, "runners"))
  expect(canary.strategy?.matrix.capability).toEqual(list(publish, "capabilities"))
  expect(smoke.strategy?.matrix.include?.map((item) => item.name)).toEqual(list(publish, "smokes"))
  expect(canary.strategy?.matrix.capability).toHaveLength(5)
  expect(canary.strategy?.matrix.os).toHaveLength(3)
  expect(publish).toContain(
    '"publish-test",\n              "packaged-e2e",\n              "musl-baseline-smoke",\n              "promote-test",',
  )
  expect(publish).toContain("`scientific capability canary (${os}, ${capability})`")
  expect(publish).toContain("`os-smoke (${os})`")
  for (const name of ["publish-test", "packaged-e2e", "musl-baseline-smoke", "promote-test"]) {
    expect(rehearsal.jobs[name]).toBeDefined()
    expect(rehearsal.jobs[name].name).toBeUndefined()
  }
})

test("a stale release tag cannot create or preflight a draft", async () => {
  await using tmp = await tmpdir({ git: true })
  const bin = path.join(tmp.path, "bin")
  const log = path.join(tmp.path, "gh.log")
  const gh = path.join(bin, "gh")
  await fs.mkdir(bin)
  await Bun.write(gh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_LOG"\nprintf "release not found\\n" >&2\nexit 1\n')
  await fs.chmod(gh, 0o700)
  await Bun.$`git tag v9.9.9`.cwd(tmp.path).quiet()
  const commit = await Bun.$`git rev-parse HEAD`
    .cwd(tmp.path)
    .text()
    .then((value) => value.trim())
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GH_LOG: log,
    GITHUB_SHA: commit,
    OPENSCIENCE_VERSION: "9.9.9",
  }
  const run = async (preflight: boolean) => {
    const child = Bun.spawn([process.execPath, path.join(root, "tooling/repo/version.ts")], {
      cwd: tmp.path,
      env: { ...env, ...(preflight ? { OPENSCIENCE_SOURCE_PREFLIGHT: "true" } : {}) },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exit).not.toBe(0)
    expect(error).toContain("already exists at")
    expect(error).toContain("without a GitHub release")
  }
  await run(true)
  await run(false)
  expect(await Bun.file(log).text()).not.toContain("release create")
})

test("stable macOS artifacts remain entitled, signed, notarized, stapled, and smoked", async () => {
  const workflow = await read(".github/workflows/publish.yml")
  const entitlements = await read("frontend/desktop/build/entitlements.mac.plist")

  expect(workflow).toContain("runner: macos-15")
  expect(workflow).toContain("runner: macos-15-intel")
  expect(workflow).toContain("Apple-Actions/import-codesign-certs")
  expect(workflow).toContain("codesign --force --options runtime --timestamp")
  expect(workflow).toContain("--entitlements frontend/desktop/build/entitlements.mac.plist")
  expect(workflow).toContain("codesign -d --entitlements :-")
  expect(workflow).toContain("name: Smoke native macOS desktop sidecar")
  expect(workflow).toContain('execFileSync(process.env.OPENSCIENCE_DESKTOP_SIDECAR, ["--version"]')
  expect(workflow).toContain("timeout: 15_000")
  const smoke = workflow.slice(
    workflow.indexOf("- name: Smoke native macOS desktop sidecar"),
    workflow.indexOf("- name: Make sidecar executable"),
  )
  expect(smoke).toContain("execFileSync")
  expect(smoke).not.toContain("GH_TOKEN")
  for (const key of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ]) {
    expect(workflow).toContain(key)
    expect(entitlements).toContain(`<key>${key}</key>\n  <true/>`)
  }
  expect(workflow).toContain("xcrun notarytool submit")
  expect(workflow).toContain("xcrun stapler staple")
  expect(workflow).toContain("spctl -a -t open")
  expect(workflow).toContain("frontend/desktop/script/update-artifact-canary.mjs")
})

test("stable publication waits for both native updater lifecycle canaries", async () => {
  const workflow = await read(".github/workflows/publish.yml")
  const start = workflow.indexOf("  verify-desktop-updater:")
  const publication = workflow.indexOf("  publish:", start)
  const updater = workflow.slice(start, publication)
  const publish = workflow.slice(publication, workflow.indexOf("  deployment:", publication))

  expect(start).toBeGreaterThan(-1)
  expect(publication).toBeGreaterThan(start)
  expect(updater).toContain("name: Verify desktop updater (${{ matrix.arch }})")
  expect(updater).toContain("runner: macos-15\n            arch: arm64\n            machine: arm64")
  expect(updater).toContain("runner: macos-15-intel\n            arch: x64\n            machine: x86_64")
  expect(updater).toContain("needs: [version, build-desktop-mac]")
  expect(updater).toContain('install: "false"')
  expect(updater).toContain("Resolve an immutable previous signed stable install")
  expect(updater).toContain("Stable publication fails closed until a signed baseline is available.")
  expect(updater).toContain("bun frontend/desktop/script/update-lifecycle-canary.mjs")
  expect(updater).toContain('--previous-zip "$OPENSCIENCE_PREVIOUS_ZIP"')
  expect(updater).toContain('--previous-version "$OPENSCIENCE_PREVIOUS_VERSION"')
  expect(publish).toContain(
    "needs: [version, sign-macos-cli, prepare-npm, build-desktop-mac, build-desktop-other, verify-desktop-updater]",
  )
})

test("both desktop packaging jobs keep the resumable-asset and Electron cache contract", async () => {
  const workflow = await read(".github/workflows/publish.yml")
  const parsed = Bun.YAML.parse(workflow) as {
    jobs: Record<string, { needs?: string[]; strategy?: { matrix: { include: { runner: string; arch: string }[] } } }>
  }
  const mac = parsed.jobs["build-desktop-mac"]
  const other = parsed.jobs["build-desktop-other"]

  expect(mac.strategy?.matrix.include.map((item) => `${item.runner}/${item.arch}`)).toEqual([
    "macos-15/arm64",
    "macos-15-intel/x64",
  ])
  expect(other.strategy?.matrix.include.map((item) => item.runner)).toEqual([
    "windows-2025",
    "ubuntu-24.04",
    "ubuntu-24.04-arm",
  ])
  expect(parsed.jobs["verify-desktop-updater"].needs).toEqual(["version", "build-desktop-mac"])
  expect(parsed.jobs.publish.needs).toContain("build-desktop-mac")
  expect(parsed.jobs.publish.needs).toContain("build-desktop-other")
  expect(workflow.match(/- name: Check for resumable assets/g)).toHaveLength(2)
  expect(workflow.match(/- name: Cache Electron downloads/g)).toHaveLength(2)
  expect(workflow.match(/- name: Notarize and staple macOS DMG/g)).toHaveLength(1)
  expect(workflow.match(/- name: Build unsigned Windows installer/g)).toHaveLength(1)
})

test("release caches and resumed mac assets are bound and reverified", async () => {
  const workflow = await read(".github/workflows/publish.yml")
  const version = await read("tooling/repo/version.ts")

  expect(workflow).toContain('gh release view "$OPENSCIENCE_TAG" --repo "$GITHUB_REPOSITORY" --json assets')
  expect(workflow).toContain('gh release download "$OPENSCIENCE_TAG" --repo "$GITHUB_REPOSITORY" --pattern "$name"')

  expect(workflow).toContain(
    "key: cli-build-${{ needs.version.outputs.version }}-${{ needs.version.outputs.artifact_source }}",
  )
  expect(workflow).toContain(
    "key: cli-signed-jit-v1-${{ needs.version.outputs.version }}-${{ needs.version.outputs.artifact_source }}",
  )
  expect(workflow).toContain(
    "key: npm-release-jit-v1-${{ needs.version.outputs.version }}-${{ needs.version.outputs.artifact_source }}",
  )
  expect(workflow).toContain("Verify resumed macOS assets")
  expect(workflow).toContain("TeamIdentifier=$APPLE_TEAM_ID")
  expect(workflow).toContain("CFBundleShortVersionString")
  expect(workflow).toContain("workflow_source")
  expect(workflow).toContain('git show "$WORKFLOW_SOURCE:$file" > "$file"')
  expect(version).toContain('"tooling/repo/publish.ts"')
})

test("publication freezes the complete immutable release asset set", async () => {
  const workflow = await read(".github/workflows/publish.yml")

  for (const asset of [
    "OpenScience-mac-arm64.dmg",
    "OpenScience-mac-arm64.zip",
    "OpenScience-mac-x64.dmg",
    "OpenScience-mac-x64.zip",
    "OpenScience-windows-x64.exe",
    "OpenScience-linux-x64.AppImage",
    "OpenScience-linux-arm64.AppImage",
  ]) {
    expect(workflow).toContain(asset)
  }
  expect(workflow).toContain('== "20"')
  expect(workflow).toContain("desktop-checksums.txt")
  expect(workflow).toContain("checksums.txt")
})

test("npm staging batches immutable writes but verifies before public promotion", async () => {
  const publish = await read("tooling/repo/publish.ts")

  const stage = publish.indexOf("batch.map((artifact) => publishPackage")
  const verify = publish.indexOf("await verifyPublishedPackages(ordered)")
  const tags = publish.indexOf("await ensureReleaseStagingTags(ordered, stagingTag)")
  const promote = publish.indexOf("await promoteRelease(ordered)")
  const publicRelease = publish.indexOf("--draft=false")

  expect(stage).toBeGreaterThan(-1)
  expect(stage).toBeLessThan(verify)
  expect(verify).toBeLessThan(tags)
  expect(tags).toBeLessThan(promote)
  expect(promote).toBeLessThan(publicRelease)
  expect(publish).toContain("if (Script.release && !promotionOnly)")
  expect(publish).toContain("Promotion-only resume expected")
})

test("the rehearsal builds and packs on one runner, keeps both immutable caches, and caches Playwright", async () => {
  const workflow = await read(".github/workflows/npm-test.yml")
  const parsed = Bun.YAML.parse(workflow) as { jobs: Record<string, { needs?: string | string[] }> }

  expect(parsed.jobs["test-source"]).toBeUndefined()
  expect(parsed.jobs["prepare-npm"]).toBeUndefined()
  expect(parsed.jobs.version.needs).toBeUndefined()
  expect(parsed.jobs["build-cli"].needs).toBe("version")
  expect(parsed.jobs["publish-test"].needs).toEqual(["version", "build-cli"])
  expect(workflow.indexOf("Require the protected default branch")).toBeLessThan(workflow.indexOf("id: version"))
  expect(workflow.match(/key: npm-test-cli-v2-/g)).toHaveLength(2)
  expect(workflow.match(/key: npm-test-artifacts-v2-/g)).toHaveLength(4)
  expect(workflow).toContain("fail-on-cache-miss: true")
  for (const file of [".github/workflows/npm-test.yml", ".github/workflows/e2e.yml"]) {
    const text = await read(file)
    expect(text).toContain("name: Cache Playwright browsers")
    expect(text).toContain("playwright-${{ steps.playwright.outputs.version }}-chromium")
    expect(text).toContain("bunx playwright install --with-deps chromium")
    expect(text).toContain("bunx playwright install-deps chromium")
  }
})

test("deep npm rehearsal gates are explicit opt-ins", async () => {
  const workflow = await read(".github/workflows/npm-test.yml")

  expect(workflow).toContain("name: Deep release rehearsal")
  expect(workflow).toContain("run_scientific_canary:")
  expect(workflow.match(/default: false/g)?.length).toBeGreaterThanOrEqual(3)
  expect(workflow).toContain("if: inputs.run_scientific_canary")
})

test("shared dependency cache is architecture-specific and excludes the Bun runtime", async () => {
  const action = await read(".github/actions/setup-bun/action.yml")
  const parsed = Bun.YAML.parse(action) as {
    inputs: Record<string, { default: string }>
    runs: { steps: { name: string; if?: string }[] }
  }

  expect(action).toContain("${{ runner.os }}-${{ runner.arch }}")
  expect(action).toContain("path: ~/.bun/install/cache")
  expect(action).not.toContain("path: ~/.bun\n")
  expect(action).toContain("bun install --frozen-lockfile")
  expect(parsed.inputs.install.default).toBe("true")
  expect(parsed.inputs.filter.default).toBe("")
  for (const name of ["Cache Bun", "Install dependencies"]) {
    expect(parsed.runs.steps.find((step) => step.name === name)?.if).toBe("inputs.install == 'true'")
  }
  expect(parsed.runs.steps.find((step) => step.name === "Setup Bun")?.if).toBeUndefined()
})

test("desktop packaging installs the whole workspace and caches Electron downloads", async () => {
  const workflow = await read(".github/workflows/publish.yml")

  // electron-builder validates the root package's production dependencies, so
  // a --filter install fails with "Production dependency @synsci/plugin not
  // found for package @synsci/monorepo". Desktop jobs install everything.
  expect(workflow).not.toContain('filter: "@synsci/desktop"')
  expect(workflow).toContain("name: Cache Electron downloads")
  expect(workflow).toContain("electron-${{ hashFiles('frontend/desktop/package.json') }}")
  expect(workflow).not.toContain("Smoke packaged signed macOS app")
  expect(workflow).toContain("Verify the exact signed ZIP and DMG structure")
})

test("heavy security analysis is scheduled rather than duplicated on every PR", async () => {
  const codeql = await read(".github/workflows/codeql.yml")
  const scorecard = await read(".github/workflows/scorecard.yml")
  const secrets = await read(".github/workflows/gitleaks.yml")

  expect(codeql).not.toContain("pull_request:")
  expect(codeql).toContain("schedule:")
  expect(scorecard).not.toContain("push:")
  expect(secrets).toContain("pull_request:")
})
