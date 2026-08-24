import { expect, test } from "bun:test"
import path from "path"

test("production publish pushes the release commit before targeting it on GitHub", async () => {
  const script = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/publish.ts")).text()
  const tag = script.indexOf("git push origin refs/tags/")
  const release = script.indexOf("gh release edit v${Script.version} --target ${sha}")

  expect(tag).toBeGreaterThan(-1)
  expect(release).toBeGreaterThan(tag)
  expect(script.slice(tag, release)).not.toContain(".nothrow()")
})

test("publish source gates normalize GitHub's case-insensitive repository slug", async () => {
  const workflows = ["npm-test.yml", "publish.yml"]

  for (const workflow of workflows) {
    const source = await Bun.file(path.join(import.meta.dir, `../../../../.github/workflows/${workflow}`)).text()

    expect(source).toContain(
      '[[ "${GITHUB_REPOSITORY,,}" != "synthetic-sciences/openscience" || "$GITHUB_REF" != "refs/heads/main" ]]',
    )
    expect(source).not.toContain('[[ "$GITHUB_REPOSITORY" != "synthetic-sciences/OpenScience"')
  }
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

test("production publish derives stable versions only from a required monotonic bump", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()
  const bump = source.slice(source.indexOf("      bump:"), source.indexOf("# One release at a time"))

  expect(bump).toContain('required: true')
  expect(source).not.toContain("inputs.version")
  expect(source).not.toContain("Override version")
  expect(source).not.toContain('OPENSCIENCE_VERSION: ${{ inputs.version }}')
})

test("production release requires this build's cleaned launcher to publish before undrafting", async () => {
  const workflow = await Bun.file(path.join(import.meta.dir, "../../../../.github/workflows/publish.yml")).text()
  const script = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/publish.ts")).text()

  expect(workflow).toContain('OPENSCIENCE_REQUIRE_LAUNCHER_PUBLISH: "true"')
  expect(script).toContain("if (requireLauncherPublish)")
  expect(script).toContain("refusing to complete the release without publishing the cleaned launcher")
  expect(script).toContain("refusing to accept an unverified registry tarball")

  const launcher = script.indexOf("=== launcher (openscience) ===")
  const failureGate = script.indexOf("if (failures.length > 0)")
  const undraft = script.indexOf("--draft=false")
  expect(launcher).toBeGreaterThan(-1)
  expect(failureGate).toBeGreaterThan(launcher)
  expect(undraft).toBeGreaterThan(failureGate)
})
