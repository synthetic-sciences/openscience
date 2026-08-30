import { expect, test } from "bun:test"
import path from "path"

const root = path.join(import.meta.dir, "../../../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

test("pull requests use one fast product-level lane", async () => {
  const workflow = await read(".github/workflows/ci.yml")

  expect(workflow).toContain("name: Fast CI")
  expect(workflow).toContain("bun run typecheck")
  expect(workflow).toContain("bun run --cwd frontend/workspace build")
  expect(workflow).toContain("Smoke release entrypoints")
  expect(workflow).not.toContain("bun run --cwd backend/cli test")
  expect(workflow).not.toContain("matrix:")
})

test("exhaustive and native suites stay off the pull request path", async () => {
  const workflow = await read(".github/workflows/deep-ci.yml")

  expect(workflow).toContain("workflow_dispatch:")
  expect(workflow).toContain("schedule:")
  expect(workflow).toContain("bun run test")
  expect(workflow).toContain("test/process/darwin-responsibility.test.ts")
  expect(workflow).toContain("test/process/windows-job.test.ts")
  expect(workflow).not.toContain("pull_request:")
})

test("production is a single release pass without a rehearsal gate", async () => {
  const workflow = await read(".github/workflows/publish.yml")

  expect(workflow).toContain("name: Release")
  expect(workflow).toContain("Verify npm publisher")
  expect(workflow).toContain("needs: [version, sign-macos-cli, prepare-npm, build-desktop]")
  expect(workflow).not.toContain("npm-test-gate")
  expect(workflow).not.toContain("verify-native-cli")
  expect(workflow).not.toContain("verify-desktop-updater")
})

test("stable macOS artifacts remain signed, notarized, stapled, and smoked", async () => {
  const workflow = await read(".github/workflows/publish.yml")

  expect(workflow).toContain("runner: macos-15")
  expect(workflow).toContain("runner: macos-15-intel")
  expect(workflow).toContain("Apple-Actions/import-codesign-certs")
  expect(workflow).toContain("codesign --force --options runtime --timestamp")
  expect(workflow).toContain("xcrun notarytool submit")
  expect(workflow).toContain("xcrun stapler staple")
  expect(workflow).toContain("spctl -a -t open")
  expect(workflow).toContain("frontend/desktop/script/update-artifact-canary.mjs")
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
    "key: npm-release-${{ needs.version.outputs.version }}-${{ needs.version.outputs.artifact_source }}",
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

test("deep npm rehearsal gates are explicit opt-ins", async () => {
  const workflow = await read(".github/workflows/npm-test.yml")

  expect(workflow).toContain("name: Deep release rehearsal")
  expect(workflow).toContain("run_scientific_canary:")
  expect(workflow.match(/default: false/g)?.length).toBeGreaterThanOrEqual(3)
  expect(workflow).toContain("if: inputs.run_scientific_canary")
})

test("shared dependency cache is architecture-specific and excludes the Bun runtime", async () => {
  const action = await read(".github/actions/setup-bun/action.yml")

  expect(action).toContain("${{ runner.os }}-${{ runner.arch }}")
  expect(action).toContain("path: ~/.bun/install/cache")
  expect(action).not.toContain("path: ~/.bun\n")
  expect(action).toContain("bun install --frozen-lockfile")
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
