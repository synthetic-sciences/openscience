#!/usr/bin/env bun

import { $ } from "bun"
import { Script } from "@synsci/script"
import {
  ensureReleaseStagingTags,
  loadReleaseArtifacts,
  preflightRelease,
  promoteRelease,
  publishPackage,
  releasePromotionNames,
  releaseStagingTag,
  verifyPublishedPackage,
} from "./npm-release"
import { assertReleaseSource, releaseRoot, setWorkspaceVersion } from "./release-workspace"

if (Script.preview) {
  await import("./publish-preview")
} else {
  console.log("=== npm ownership preflight ===\n")
  await preflightRelease()

  const source = await assertReleaseSource()
  const artifactSource = process.env.OPENSCIENCE_ARTIFACT_SOURCE
  if (!artifactSource || !/^[0-9a-f]{40}$/i.test(artifactSource)) {
    throw new Error("OPENSCIENCE_ARTIFACT_SOURCE must be an immutable commit SHA")
  }
  const artifactDirectory = process.env.OPENSCIENCE_NPM_ARTIFACT_DIR
  if (!artifactDirectory) throw new Error("OPENSCIENCE_NPM_ARTIFACT_DIR is required")
  const artifacts = await loadReleaseArtifacts({
    directory: artifactDirectory,
    source: artifactSource,
    version: Script.version,
  })
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
  const ordered = releasePromotionNames().map((name) => {
    const artifact = byName.get(name)
    if (!artifact) throw new Error(`Missing cached npm artifact for ${name}`)
    return artifact
  })
  const stagingTag = releaseStagingTag(Script.version)
  const promotionOnly = source !== artifactSource

  if (!promotionOnly) {
    console.log(`\n=== publishing ${artifacts.length} packages under ${stagingTag} ===\n`)
    for (const artifact of ordered) await publishPackage({ ...artifact, tag: stagingTag })
  } else {
    console.log(`\n=== promotion-only resume from ${source}; no npm package writes are allowed ===\n`)
  }

  console.log("\n=== verifying the complete npm release set ===\n")
  for (const artifact of ordered) {
    await verifyPublishedPackage(artifact)
    console.log(`  verified ${artifact.name}@${artifact.version}`)
  }
  await ensureReleaseStagingTags(ordered, stagingTag)

  let releaseSha = source
  if (Script.release) {
    await setWorkspaceVersion(Script.version)
    const changed = await $`git diff --quiet HEAD --`.cwd(releaseRoot).nothrow()
    if (changed.exitCode === 1) await $`git commit -am ${`release: v${Script.version}`}`.cwd(releaseRoot)
    if (changed.exitCode > 1) throw new Error(`Could not inspect release changes (git diff exited ${changed.exitCode})`)
    releaseSha = await $`git rev-parse HEAD`
      .cwd(releaseRoot)
      .text()
      .then((value) => value.trim())

    const tag = `v${Script.version}`
    const existingTag = await $`git rev-parse --verify refs/tags/${tag}^{commit}`.cwd(releaseRoot).quiet().nothrow()
    if (existingTag.exitCode === 0) {
      const tagged = existingTag.stdout.toString().trim()
      if (tagged !== releaseSha) {
        if (tagged !== source || source !== artifactSource) {
          throw new Error(`Refusing to move ${tag}: existing tag is ${tagged}, release source is ${source}`)
        }
        await $`git tag -f ${tag} ${releaseSha}`.cwd(releaseRoot)
        await $`git push origin refs/tags/${tag} --force --no-verify`.cwd(releaseRoot)
      }
    } else {
      await $`git tag ${tag} ${releaseSha}`.cwd(releaseRoot)
      await $`git push origin refs/tags/${tag} --no-verify`.cwd(releaseRoot)
    }

    const release = (await $`gh release view ${tag} --json isDraft,targetCommitish`.cwd(releaseRoot).json()) as {
      isDraft: boolean
      targetCommitish: string
    }
    if (!release.isDraft) throw new Error(`${tag} is already public; refusing to mutate a completed release`)
    if (![source, artifactSource, releaseSha].includes(release.targetCommitish)) {
      throw new Error(
        `Draft release target changed unexpectedly: ${release.targetCommitish} is not ${source}, ${artifactSource}, or ${releaseSha}`,
      )
    }
    await $`gh release edit ${tag} --target ${releaseSha}`.cwd(releaseRoot)

    const push = await $`git push origin HEAD:main --no-verify`.cwd(releaseRoot).nothrow()
    if (push.exitCode !== 0) {
      const branch = `release/v${Script.version}`
      console.warn(`main push rejected by branch protection — opening a release PR from ${branch}`)
      await $`git push origin HEAD:refs/heads/${branch} --force --no-verify`.cwd(releaseRoot)
      const existing = await $`gh pr list --base main --head ${branch} --state open --json url --jq '.[0].url // ""'`
        .cwd(releaseRoot)
        .text()
        .then((value) => value.trim())
      const url = existing
        ? existing
        : await $`gh pr create --base main --head ${branch} --title ${`release: v${Script.version}`} --body ${`Version bumps from the v${Script.version} release.`}`
            .cwd(releaseRoot)
            .text()
            .then((value) => value.trim())
      if (!url) throw new Error(`Failed to create or resolve the release PR for ${branch}`)
      console.log(`release PR: ${url}`)
    }
  }

  console.log("\n=== promoting npm latest tags (launcher last) ===\n")
  await promoteRelease(ordered)

  if (Script.release) {
    const current = await $`git rev-parse HEAD`
      .cwd(releaseRoot)
      .text()
      .then((value) => value.trim())
    if (current !== releaseSha) throw new Error(`Release checkout moved from ${releaseSha} to ${current}`)
    await $`gh release edit v${Script.version} --draft=false`.cwd(releaseRoot)
    await $`./backend/cli/script/publish.ts --homebrew-only`.cwd(releaseRoot)
  }
}
