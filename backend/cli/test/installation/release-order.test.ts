import { expect, test } from "bun:test"
import path from "path"

test("production publish verifies every package before the one guarded release-tag move", async () => {
  const script = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/publish.ts")).text()
  const verify = script.indexOf("verifyPublishedPackage(artifact)")
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
})

test("production npm writes stage the complete set before latest promotion and release publication", async () => {
  const publish = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/publish.ts")).text()
  const helper = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/npm-release.ts")).text()

  const stage = publish.indexOf("publishPackage({ ...artifact, tag: stagingTag })")
  const verify = publish.indexOf("verifyPublishedPackage(artifact)")
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

test("source package versions remain 2.0.31 until the workflow release commit", async () => {
  const files = [
    "backend/cli/package.json",
    "tooling/sdk/js/package.json",
    "tooling/plugin/package.json",
    "tooling/launcher/package.json",
  ]

  for (const file of files) {
    const pkg = await Bun.file(path.join(import.meta.dir, "../../../..", file)).json()
    expect(pkg.version).toBe("2.0.31")
  }
})

test("native Windows file tests keep the repository test timeout", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/ci.yml")).text()

  expect(workflow).toContain(
    "bun test --timeout 15000 test/file/safe-io.test.ts test/file/rename.test.ts test/file/trash.test.ts",
  )
})
