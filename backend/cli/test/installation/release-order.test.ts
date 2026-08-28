import { expect, test } from "bun:test"
import path from "path"
import { releaseRoot, resolveReleasePath } from "../../../../tooling/repo/release-workspace"

test("npm artifact output remains rooted at the release checkout after nested builds change cwd", async () => {
  const relative = ".release/npm-test/2.0.32-test.example"
  const absolute = path.join(releaseRoot, relative)
  const prepare = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/prepare-npm.ts")).text()

  expect(resolveReleasePath(relative)).toBe(absolute)
  expect(resolveReleasePath(absolute)).toBe(absolute)
  expect(prepare).toContain("const output = resolveReleasePath(outputInput)")
})

test("production publish verifies every package before the one guarded release-tag move", async () => {
  const script = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/publish.ts")).text()
  const verify = script.indexOf("verifyPublishedPackages(ordered)")
  const tag = script.indexOf("git tag -f")
  const release = script.indexOf("gh release edit ${tag} --target ${releaseSha}")

  expect(verify).toBeGreaterThan(-1)
  expect(tag).toBeGreaterThan(verify)
  expect(tag).toBeGreaterThan(-1)
  expect(release).toBeGreaterThan(tag)
  expect(script).toContain("tagged !== source || source !== artifactSource")
})

test("publish source gates normalize GitHub's case-insensitive repository slug", async () => {
  const test = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/npm-test.yml")).text()
  const release = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()

  expect(test).toContain(
    '[[ "${GITHUB_REPOSITORY,,}" != "synthetic-sciences/openscience" || "$GITHUB_REF" != "refs/heads/main" ]]',
  )
  expect(release).toContain('[[ "${GITHUB_REPOSITORY,,}" != "synthetic-sciences/openscience" ]]')
  expect(release).toContain('"$GITHUB_REF" != "refs/tags/v$EXACT_VERSION"')
  expect(test).not.toContain('[[ "$GITHUB_REPOSITORY" != "synthetic-sciences/OpenScience"')
  expect(release).not.toContain('[[ "$GITHUB_REPOSITORY" != "synthetic-sciences/OpenScience"')
})

test("production release preparation jobs can write their draft GitHub release", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()
  const jobs = [
    ["version", "build-cli"],
    ["sign-macos-cli", "verify-native-cli"],
    ["desktop-resume", "build-desktop"],
  ]

  for (const item of jobs) {
    const start = source.indexOf(`\n  ${item[0]}:`)
    const end = source.indexOf(`\n  ${item[1]}:`)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const job = source.slice(start, end)
    expect(job).toContain("permissions:")
    expect(job).toContain("contents: write")
  }
})

test("production publish requires the synsci launcher to ship with the wrapper", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()
  const publish = source.slice(source.indexOf("\n  publish:"), source.indexOf("\n  deployment:"))

  expect(publish).toContain('OPENSCIENCE_REQUIRE_LAUNCHER_PUBLISH: "true"')
})

test("exact-version resumes keep artifacts pinned while allowing guarded release-infrastructure repairs", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()
  const version = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/version.ts")).text()

  expect(workflow).toContain("version:")
  expect(workflow).toContain('"refs/tags/v$EXACT_VERSION"')
  expect(workflow).toContain("source: ${{ steps.version.outputs.source }}")
  expect(workflow).toContain("artifact_source: ${{ steps.version.outputs.artifact_source }}")
  expect(workflow.match(/ref: \$\{\{ needs\.version\.outputs\.source \}\}/g)?.length).toBeGreaterThanOrEqual(4)
  expect(version).toContain("--target ${checkout}")
  expect(version).toContain("targetCommitish")
  expect(version).toContain("openscience-release-source:${checkout}")
  expect(version).toContain("source !== checkout")
  expect(version).toContain('process.env.GITHUB_REF !== "refs/heads/main"')
  expect(version).toContain("source !== artifactSource")
  expect(version).toContain("git merge-base --is-ancestor ${source} ${checkout}")
  expect(version).toContain("git diff --name-only ${source}..${checkout}")
  expect(version).toContain('".github/workflows/publish.yml"')
  expect(version).toContain('"backend/cli/test/installation/release-order.test.ts"')
  expect(version).toContain('"tooling/repo/version.ts"')
  expect(version).toContain("changes files outside guarded release infrastructure")
})

test("production release caches exact builds and packed npm artifacts by version", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()

  expect(workflow).toContain("key: cli-build-${{ needs.version.outputs.version }}")
  expect(workflow).toContain("key: cli-build-signed-${{ needs.version.outputs.version }}")
  expect(workflow).toContain("key: npm-release-${{ needs.version.outputs.version }}")
  expect(workflow).toContain("run: ./tooling/repo/prepare-npm.ts")
  expect(workflow).toContain("OPENSCIENCE_NPM_ARTIFACT_DIR: .release/npm/${{ needs.version.outputs.version }}")
  expect(workflow).not.toContain("cli-build-${{ github.run_id }}")
  expect(workflow.indexOf("Cache immutable CLI build")).toBeLessThan(
    workflow.indexOf("Verify or upload immutable draft assets"),
  )
  const prepare = workflow.slice(workflow.indexOf("\n  prepare-npm:"), workflow.indexOf("\n  publish:"))
  expect(prepare).toContain('node-version: "24"')
  expect(prepare.indexOf("Pack the complete npm release set")).toBeLessThan(
    prepare.indexOf("Verify packed SDK and plugin exports before publication"),
  )
  expect(prepare.indexOf("Verify packed SDK and plugin exports before publication")).toBeLessThan(
    prepare.indexOf("Cache immutable npm artifacts"),
  )
})

test("production release keeps signed publishing as the default and ships installers in unsigned mode", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()
  const input = workflow.slice(workflow.indexOf("      release_mode:"), workflow.indexOf("# One release at a time"))
  const preflight = workflow.slice(workflow.indexOf("\n  macos-signing-preflight:"), workflow.indexOf("\n  version:"))
  const sign = workflow.slice(workflow.indexOf("\n  sign-macos-cli:"), workflow.indexOf("\n  verify-native-cli:"))
  const desktop = workflow.slice(workflow.indexOf("\n  build-desktop:"), workflow.indexOf("\n  verify-native-cli:"))
  const desktopUpload = desktop.slice(desktop.indexOf("Verify or upload immutable desktop installer"))
  const prepare = workflow.slice(workflow.indexOf("\n  prepare-npm:"), workflow.indexOf("\n  publish:"))
  const publish = workflow.slice(workflow.indexOf("\n  publish:"), workflow.indexOf("\n  deployment:"))

  expect(input).toContain("default: signed")
  expect(input).toContain("- signed")
  expect(input).toContain("- unsigned")
  expect(input).toContain("desktop_resume_manifest:")
  expect(workflow.indexOf("macos-signing-preflight:")).toBeLessThan(workflow.indexOf("\n  version:"))
  expect(preflight).toContain("if: inputs.release_mode == 'signed'")
  expect(preflight).toContain("Publishing unsigned native CLI archives and desktop installers")
  expect(sign).toContain("Developer ID sign and notarize macOS binaries")
  expect(sign).toContain("if: inputs.release_mode == 'signed' && steps.signed-cli-cache.outputs.cache-hit != 'true'")
  expect(sign).toContain("--identifier ai.syntheticsciences.openscience")
  expect(sign).toContain("codesign --verify --strict")
  expect(sign).toContain("xcrun notarytool submit")
  expect(sign).toContain("TeamIdentifier=$APPLE_TEAM_ID")
  expect(sign).toContain("if: inputs.release_mode == 'unsigned'")
  expect(sign).toContain("The native CLI archives and desktop installers in this release are unsigned.")
  expect(sign).not.toContain("Desktop installers are not included.")
  expect(sign.indexOf("xcrun notarytool submit")).toBeLessThan(sign.indexOf("Cache immutable signed CLI build"))
  expect(sign.indexOf("Cache immutable signed CLI build")).toBeLessThan(
    sign.indexOf("Verify or upload immutable draft assets"),
  )
  expect(sign.indexOf("Verify or upload immutable draft assets")).toBeLessThan(
    sign.indexOf("Mark unsigned CLI archives in the release notes"),
  )
  expect(sign).toContain("format('cli-build-signed-{0}', needs.version.outputs.version)")
  expect(sign).toContain("format('cli-build-{0}', needs.version.outputs.version)")
  expect(desktop).not.toContain("build-desktop:\n    if: inputs.release_mode == 'signed'")
  expect(desktop).toContain("key: ${{ needs.sign-macos-cli.outputs.cache_key }}")
  expect(desktop).toContain("enableCrossOsArchive: ${{ runner.os == 'Windows' }}")
  expect(desktop).toContain(
    "if: steps.existing.outputs.found != 'true' && inputs.release_mode == 'signed' && matrix.signing != 'none'",
  )
  expect(desktop).toContain("Build signed desktop installer")
  expect(desktop).toContain("Build unsigned desktop installer")
  expect(desktop).toContain('OPENSCIENCE_DESKTOP_SIGNED: "true"')
  expect(desktop).toContain('OPENSCIENCE_DESKTOP_SIGNED: "false"')
  expect(desktop).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"')
  expect(desktop).toContain("unset CSC_LINK CSC_KEY_PASSWORD")
  expect(desktop).toContain('gh release upload "$OPENSCIENCE_TAG"')
  expect(desktop).not.toContain('gh release upload "$OPENSCIENCE_RELEASE"')
  expect(desktop).not.toContain("--clobber")
  expect(desktopUpload).toContain('produced="frontend/desktop/dist/OpenScience-linux-x86_64.AppImage"')
  expect(desktopUpload).toContain('mv "$produced" "$installer"')
  expect(desktopUpload.indexOf('mv "$produced" "$installer"')).toBeLessThan(
    desktopUpload.indexOf('existing="$(gh release view "$OPENSCIENCE_TAG"'),
  )
  expect(prepare).toContain("key: ${{ needs.sign-macos-cli.outputs.cache_key }}")
  expect(publish).toContain("key: ${{ needs.sign-macos-cli.outputs.cache_key }}")
  expect(publish).toContain("!cancelled() &&")
  expect(publish).toContain("needs.build-desktop.result == 'success'")
  expect(publish).not.toContain("inputs.release_mode == 'unsigned' || needs.build-desktop.result == 'success'")
})

test("production desktop resume freezes an exact reviewed asset set before any rebuild", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()
  const plan = workflow.slice(workflow.indexOf("\n  desktop-resume:"), workflow.indexOf("\n  build-desktop:"))
  const desktop = workflow.slice(workflow.indexOf("\n  build-desktop:"), workflow.indexOf("\n  verify-native-cli:"))
  const steps = desktop.split("\n      - ").slice(1)
  const findStep = (marker: string) => steps.find((step) => step.includes(marker)) ?? ""
  const check = findStep("Check for an existing immutable desktop installer")

  expect(plan).toContain("DESKTOP_RESUME_MANIFEST: ${{ inputs.desktop_resume_manifest }}")
  expect(plan).toContain(".version == $version")
  expect(plan).toContain(".source == $source")
  expect(plan).toContain(".release_mode == $mode")
  expect(plan).toContain("manifest entries must exactly match the pre-existing desktop installers")
  expect(plan).toContain('actual="$(jq -cS')
  expect(plan).toContain('expected="$(jq -cS')
  expect(plan).toContain('all(.assets[]; type == "string"')
  expect(plan).toContain('echo "trusted_assets=$expected"')
  expect(desktop).toContain("- desktop-resume")
  expect(desktop.indexOf("Check for an existing immutable desktop installer")).toBeLessThan(
    desktop.indexOf("uses: actions/checkout@"),
  )
  expect(check).toContain("GH_REPO: ${{ github.repository }}")
  expect(check).toContain("TRUSTED_DESKTOP_ASSETS: ${{ needs.desktop-resume.outputs.trusted_assets }}")
  expect(check).toContain('echo "found=false" >> "$GITHUB_OUTPUT"')
  expect(check).toContain('echo "found=true" >> "$GITHUB_OUTPUT"')
  expect(check).toContain('$(jq -r .state <<<"$existing")')
  expect(check).toContain("(( size <= 0 ))")
  expect(check).toContain("^sha256:[0-9a-f]{64}$")
  expect(check).toContain("appeared after the desktop resume plan was frozen")
  expect(check).toContain("vanished after the desktop resume plan was frozen")
  expect(check).toContain('[[ "$digest" != "$expected_digest" ]]')
  expect(check).not.toContain("|| true")

  for (const marker of [
    "uses: actions/checkout@",
    "uses: ./.github/actions/setup-bun",
    "uses: actions/setup-node@",
    "uses: actions/cache/restore@",
    "run: bun install --frozen-lockfile",
    "name: Require release signing credentials",
    "name: Make sidecar executable",
    "name: Build signed desktop installer",
    "name: Build unsigned desktop installer",
    "name: Verify or upload immutable desktop installer",
  ]) {
    expect(findStep(marker)).toContain("steps.existing.outputs.found != 'true'")
  }
})

test("production publish finalizes a complete immutable desktop checksum manifest", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()
  const publish = workflow.slice(workflow.indexOf("\n  publish:"), workflow.indexOf("\n  deployment:"))
  const finalize = publish.slice(
    publish.indexOf("Verify desktop assets and checksum manifest"),
    publish.indexOf("      - name: Publish"),
  )

  expect(finalize).toContain("OpenScience-mac-arm64.dmg")
  expect(finalize).toContain("OpenScience-mac-x64.dmg")
  expect(finalize).toContain("OpenScience-windows-x64.exe")
  expect(finalize).toContain("OpenScience-linux-x64.AppImage")
  expect(finalize).toContain("OpenScience-linux-arm64.AppImage")
  expect(finalize).toContain('[[ "$(jq -r .state <<<"$asset")" == "uploaded" ]]')
  expect(finalize).toContain("(( size <= 0 ))")
  expect(finalize).toContain('[[ "$digest" == sha256:* ]]')
  expect(finalize).toContain("printf '%s  %s\\n'")
  expect(finalize).toContain('actual_digest="sha256:$(sha256sum desktop-checksums.txt')
  expect(finalize).toContain('[[ "$existing_digest" == "$actual_digest" ]]')
  expect(finalize).toContain('cmp --silent desktop-checksums.txt "$RUNNER_TEMP/desktop-checksums.txt"')
  expect(finalize).toContain('gh release upload "$OPENSCIENCE_TAG" desktop-checksums.txt')
  expect(finalize).not.toContain("--clobber")
})

test("desktop packaging explicitly separates signed and unsigned installers", async () => {
  const config = await Bun.file(path.join(import.meta.dir, "../../../../frontend/desktop/electron-builder.mjs")).text()

  expect(config).toContain('process.env.OPENSCIENCE_DESKTOP_SIGNED === "true"')
  expect(config).toContain('executableName: "openscience"')
  expect(config).toContain('identity: signed ? undefined : "-"')
  expect(config).toContain("forceCodeSigning: signed")
  expect(config).toContain("hardenedRuntime: true")
  expect(config).toContain("notarize: signed && process.env.APPLE_ID ? true : false")
  expect(config).toContain("signExecutable: signed")
})

test("desktop backfill wraps the immutable public runtime without release or npm mutation", async () => {
  const workflow = await Bun.file(
    path.join(import.meta.dir, "../../../../.github/workflows/desktop-backfill.yml"),
  ).text()

  expect(workflow).toContain("ref: refs/tags/v${{ inputs.version }}")
  expect(workflow).toContain("GH_REPO: ${{ github.repository }}")
  expect(workflow).toContain("openscience-release-source:")
  expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"')
  expect(workflow).toContain('args+=("-c.mac.identity=-" "-c.mac.notarize=false")')
  expect(workflow).toContain('args+=("-c.win.signExecutable=false")')
  expect(workflow).toContain('args+=("-c.executableName=openscience")')
  expect(workflow).toContain('bun run --cwd frontend/desktop dist -- "${args[@]}"')
  expect(workflow).toContain("Expand-Archive")
  expect(workflow).toContain('unzip -q "$OPENSCIENCE_ARCHIVE"')
  expect(workflow).toContain('gh release upload "$OPENSCIENCE_TAG" "$installer"')
  expect(workflow).not.toContain("--clobber")
  expect(workflow).not.toContain("NPM_TOKEN")
  expect(workflow).not.toContain("id-token: write")
  expect(workflow).not.toContain("version.ts")
  expect(workflow).not.toContain("publish.ts")
  expect(workflow).not.toContain("git tag")
  expect(workflow).not.toContain("--target")
  expect(workflow).toContain("OpenScience-mac-arm64.dmg")
  expect(workflow).toContain("OpenScience-mac-x64.dmg")
  expect(workflow).toContain("OpenScience-windows-x64.exe")
  expect(workflow).toContain("OpenScience-linux-x64.AppImage")
  expect(workflow).toContain("OpenScience-linux-arm64.AppImage")
})

test("production npm writes stage the complete set before latest promotion and release publication", async () => {
  const publish = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/publish.ts")).text()
  const helper = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/npm-release.ts")).text()

  const stage = publish.indexOf("publishPackage({ ...artifact, deferVerification: true, tag: stagingTag })")
  const verify = publish.indexOf("verifyPublishedPackages(ordered)")
  const tagMove = publish.indexOf("git tag -f")
  const promote = publish.indexOf("promoteRelease(ordered)")
  const undraft = publish.indexOf("--draft=false")

  expect(stage).toBeGreaterThan(-1)
  expect(verify).toBeGreaterThan(stage)
  expect(tagMove).toBeGreaterThan(verify)
  expect(promote).toBeGreaterThan(tagMove)
  expect(undraft).toBeGreaterThan(promote)
  expect(publish).toContain("promotion-only resume")
  expect(helper).toContain('return `release-${version.replaceAll(".", "-")}`')
  expect(helper.indexOf("sdk.name, plugin.name, cli.name, launcher.name")).toBeGreaterThan(-1)
  expect(helper).toContain("Promise.allSettled(inputs.map((input) => verifyPublishedPackage(input, options)))")
})

test("large CLI packages upload sequentially and then verify as one concurrent set", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "../../../../backend/cli/script/publish.ts")).text()

  expect(source).toContain("deferVerification: true")
  expect(source).toContain("await verifyPublishedPackages(artifacts)")
})

test("draft release assets are immutable across resumptions", async () => {
  const build = await Bun.file(path.join(import.meta.dir, "../../../../backend/cli/script/build.ts")).text()
  const assets = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/release-assets.ts")).text()
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()

  expect(build).not.toContain("gh release upload")
  expect(assets).toContain("already exists with different bytes; refusing to clobber")
  expect(assets).not.toContain("--clobber")
  expect(workflow).toContain("Verify or upload immutable draft assets")
})

test("source package versions stay aligned before and after the workflow release commit", async () => {
  const files = [
    "backend/cli/package.json",
    "tooling/sdk/js/package.json",
    "tooling/plugin/package.json",
    "tooling/launcher/package.json",
  ]
  const versions = []

  for (const file of files) {
    const pkg = await Bun.file(path.join(import.meta.dir, "../../../..", file)).json()
    versions.push(pkg.version)
  }
  expect(new Set(versions).size).toBe(1)
  expect(versions[0]).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
})

test("preview SDK and plugin publishers transform the live manifest rather than a cached JSON module", async () => {
  const files = ["tooling/sdk/js/script/publish.ts", "tooling/plugin/script/publish.ts"]

  for (const file of files) {
    const source = await Bun.file(path.join(import.meta.dir, "../../../..", file)).text()
    expect(source).toContain("const original = await Bun.file(packageFile).text()")
    expect(source).toContain("createCompiledPackageManifest(original, Script.version")
    expect(source).not.toContain('import("../package.json")')
  }
  const sdk = await Bun.file(path.join(import.meta.dir, "../../../../tooling/sdk/js/script/publish.ts")).text()
  expect(sdk).toContain("preserveSourceDirectory: true")
})

test("packaged npm rehearsal imports every public SDK and plugin export", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/npm-test.yml")).text()
  for (const spec of [
    "@synsci/sdk",
    "@synsci/sdk/client",
    "@synsci/sdk/server",
    "@synsci/sdk/v2",
    "@synsci/sdk/v2/client",
    "@synsci/sdk/v2/server",
    "@synsci/plugin",
    "@synsci/plugin/tool",
  ]) {
    expect(workflow).toContain(`await import(\"${spec}\")`)
  }
})

test("packaged npm rehearsal pins one account data root and waits for the seeded session", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/npm-test.yml")).text()
  const readiness = workflow.slice(
    workflow.indexOf("      - name: Wait for published OpenScience server"),
    workflow.indexOf("      - name: Run packaged E2E"),
  )

  expect(workflow).toContain('echo "OPENSCIENCE_DATA_DIR=$RUNNER_TEMP/openscience-e2e/data"')
  expect(workflow).toContain('echo "OPENSCIENCE_E2E_PROJECT_DIR=$GITHUB_WORKSPACE"')
  expect(workflow).toContain('echo "OPENSCIENCE_E2E_RUNTIME=$(command -v bun)"')
  expect(workflow).toContain("printf '%s\\n' \"SYNSC_API_BASE=http://127.0.0.1:4097\"")
  expect(workflow).toContain('test -s "$OPENSCIENCE_DATA_DIR/openscience-session.json"')
  expect(readiness).toContain('"http://127.0.0.1:4096/account/session" || true)')
  expect(readiness).toContain('[[ "$SESSION" == \'{"session":true}\' ]]')
  expect(readiness.match(/sleep 1/g)).toHaveLength(1)
  expect(readiness.match(/exit 1/g)).toHaveLength(1)
  expect(readiness.indexOf("sleep 1")).toBeLessThan(readiness.indexOf("never loaded the isolated account session"))
})

test("npm test candidates advance from the public stable version, not the static workspace manifest", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/npm-test.yml")).text()
  const versionJob = workflow.slice(workflow.indexOf("\n  version:"), workflow.indexOf("\n  build-cli:"))

  expect(versionJob).toContain("npm view @synsci/openscience@latest version")
  expect(versionJob).not.toContain('require("./backend/cli/package.json").version')
})

test("npm test rehearsal stages immutable exact artifacts and promotes only after every smoke gate", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/npm-test.yml")).text()
  const helper = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/npm-test-release.ts")).text()
  const release = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/npm-release.ts")).text()
  const versionJob = workflow.slice(workflow.indexOf("\n  version:"), workflow.indexOf("\n  build-cli:"))
  const build = workflow.slice(workflow.indexOf("\n  build-cli:"), workflow.indexOf("\n  prepare-npm:"))
  const prepare = workflow.slice(workflow.indexOf("\n  prepare-npm:"), workflow.indexOf("\n  publish-test:"))
  const stage = workflow.slice(workflow.indexOf("\n  publish-test:"), workflow.indexOf("\n  packaged-e2e:"))
  const promotion = workflow.slice(workflow.indexOf("\n  promote-test:"))

  expect(versionJob).toContain("-test.${GITHUB_RUN_ID}")
  expect(versionJob).not.toContain("GITHUB_RUN_ATTEMPT")
  expect(build).toContain("lookup-only: true")
  expect(build).toContain(
    "if: steps.npm-artifacts-cache.outputs.cache-hit != 'true' && steps.cli-build-cache.outputs.cache-hit != 'true'",
  )
  expect(prepare).toContain(
    "key: npm-test-artifacts-v2-${{ needs.version.outputs.source }}-${{ needs.version.outputs.version }}",
  )
  expect(prepare.indexOf("Fail closed if an uncached version is occupied")).toBeLessThan(
    prepare.indexOf("Pack the complete 15-package candidate once"),
  )
  expect(prepare.indexOf("Restore immutable npm test artifacts")).toBeLessThan(
    prepare.indexOf("Restore immutable CLI build"),
  )
  expect(prepare).toContain("run: ./tooling/repo/prepare-npm.ts")
  expect(stage).toContain("run: ./tooling/repo/npm-test-release.ts stage")
  expect(stage).not.toContain("./tooling/repo/publish.ts")
  expect(workflow).toContain("@synsci/openscience-linux-x64-baseline-musl@${{ needs.publish-test.outputs.version }}")
  expect(promotion).toContain("- packaged-e2e")
  expect(promotion).toContain("- os-smoke")
  expect(promotion).toContain("- musl-baseline-smoke")
  expect(promotion).toContain("run: ./tooling/repo/npm-test-release.ts promote-test")
  expect(helper.indexOf("verifyReleaseTags(artifacts, releaseCandidateTag(version))")).toBeLessThan(
    helper.indexOf('promoteReleaseToTag(artifacts, "test")'),
  )
  expect(release).toContain('createHash("sha256").update(version).digest("hex").slice(0, 12)')
  expect(release).toContain('await promoteReleaseToTag(artifacts, "latest", options)')
})

test("compiled plugin source uses Node-compatible local ESM specifiers", async () => {
  const directory = path.join(import.meta.dir, "../../../../tooling/plugin/src")
  for (const file of ["index.ts", "example.ts"]) {
    const source = await Bun.file(path.join(directory, file)).text()
    const local = source.matchAll(/(?:from|export \*)\s+["'](\.\/.+?)["']/g)
    for (const match of local) expect(match[1]).toEndWith(".js")
  }
})

test("native Windows file tests keep the repository test timeout", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/ci.yml")).text()

  expect(workflow).toContain(
    "bun test --timeout 15000 test/file/safe-io.test.ts test/file/rename.test.ts test/file/trash.test.ts",
  )
})
