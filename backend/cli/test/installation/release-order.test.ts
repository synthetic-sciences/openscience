import { expect, test } from "bun:test"
import path from "path"

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
    ["build-cli", "verify-native-cli"],
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

test("exact-version resumes stay pinned to their immutable workflow and artifact sources", async () => {
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
  expect(version).toContain("dispatch it from ${tag} so npm provenance stays truthful")
})

test("production release caches exact builds and packed npm artifacts by version", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()

  expect(workflow).toContain("key: cli-build-${{ needs.version.outputs.version }}")
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
