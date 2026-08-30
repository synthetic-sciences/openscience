#!/usr/bin/env bun

import { Script } from "@synsci/script"
import { $ } from "bun"
import { buildNotes, getLatestRelease } from "./changelog"

const output = [`version=${Script.version}`]

if (!Script.preview) {
  let body = "Initial release"
  try {
    const previous = await getLatestRelease()
    const notes = await buildNotes(previous, "HEAD")
    body = notes.join("\n") || "No notable changes"
  } catch (e) {
    console.log("No previous release found, creating initial release")
  }
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const file = `${dir}/openscience-release-notes.txt`
  const tag = `v${Script.version}`
  const checkout = await $`git rev-parse HEAD`.text().then((value) => value.trim())
  if (!/^[0-9a-f]{40}$/i.test(checkout)) throw new Error(`Could not resolve the release checkout: ${checkout}`)
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== checkout) {
    throw new Error(`Release checkout mismatch: GITHUB_SHA is ${process.env.GITHUB_SHA}, but HEAD is ${checkout}`)
  }
  output.push(`workflow_source=${checkout}`)
  await Bun.write(file, `${body}\n\n<!-- openscience-release-source:${checkout} -->\n`)

  const lookup = await $`gh release view ${tag} --json id,tagName,isDraft,targetCommitish,body`.quiet().nothrow()
  const release = await (async () => {
    if (lookup.exitCode === 0) {
      const existing = JSON.parse(lookup.stdout.toString()) as {
        id: string
        isDraft: boolean
        tagName: string
        targetCommitish: string
        body: string
      }
      if (!existing.isDraft) throw new Error(`${tag} is already public; refusing to resume a completed release`)
      if (existing.tagName !== tag)
        throw new Error(`Existing release tag mismatch: expected ${tag}, received ${existing.tagName}`)
      console.log(`Reusing existing draft release ${tag}`)
      return existing
    }
    const detail = lookup.stderr.toString()
    if (!/release not found/i.test(detail)) throw new Error(`Could not inspect ${tag}: ${detail.trim()}`)
    await $`gh release create ${tag} -d --target ${checkout} --title ${tag} --notes-file ${file}`
    return await $`gh release view ${tag} --json id,tagName,isDraft,targetCommitish,body`.json()
  })()

  const tagCommit = await $`git rev-parse --verify refs/tags/${tag}^{commit}`.quiet().nothrow()
  const tagged = tagCommit.exitCode === 0 ? tagCommit.stdout.toString().trim() : undefined
  const target = release.targetCommitish
  const targetIsSha = /^[0-9a-f]{40}$/i.test(target)
  const source = tagged ?? (targetIsSha ? target : undefined)
  if (!source) {
    throw new Error(
      `Draft release ${tag} does not identify an immutable source commit (target is '${target}', and no tag exists)`,
    )
  }
  const sourceExists = await $`git cat-file -e ${source}^{commit}`.quiet().nothrow()
  if (sourceExists.exitCode !== 0) throw new Error(`Draft release source ${source} is not present in the checkout`)
  const marker = release.body.match(/<!-- openscience-release-source:([0-9a-f]{40}) -->/i)?.[1]
  if (!marker) throw new Error(`Draft release ${tag} is missing its immutable artifact-source marker`)
  const artifactSource = marker
  const artifactSourceExists = await $`git cat-file -e ${artifactSource}^{commit}`.quiet().nothrow()
  if (artifactSourceExists.exitCode !== 0) {
    throw new Error(`Draft release artifact source ${artifactSource} is not present in the checkout`)
  }
  if (source !== artifactSource) {
    const subject = await $`git show -s --format=%s ${source}`.text().then((value) => value.trim())
    const parent = await $`git rev-parse ${source}^`.text().then((value) => value.trim())
    if (subject !== `release: ${tag}` || parent !== artifactSource) {
      throw new Error(`${source} is not the guarded ${tag} release commit derived from ${artifactSource}`)
    }
  }
  if (source !== checkout) {
    const exactVersion = process.env.OPENSCIENCE_VERSION?.trim()
    if (!exactVersion || process.env.GITHUB_REF !== "refs/heads/main") {
      throw new Error(
        `Release ${tag} is pinned to ${source}, but this workflow runs at ${checkout}. Only an exact-version main-branch resume is allowed.`,
      )
    }
    const artifactAncestor = await $`git merge-base --is-ancestor ${artifactSource} ${checkout}`.quiet().nothrow()
    if (artifactAncestor.exitCode !== 0) {
      throw new Error(`Release workflow checkout ${checkout} is not descended from artifact source ${artifactSource}`)
    }
    const sourceAncestor = await $`git merge-base --is-ancestor ${source} ${checkout}`.quiet().nothrow()
    const repairBase = sourceAncestor.exitCode === 0 ? source : artifactSource
    const changed = await $`git diff --name-only ${repairBase}..${checkout}`
      .text()
      .then((value) => value.trim().split("\n").filter(Boolean))
    const allowed = new Set([
      ".github/workflows/publish.yml",
      "backend/cli/test/installation/desktop-updater.test.ts",
      "backend/cli/test/installation/release-order.test.ts",
      "frontend/desktop/script/update-lifecycle-canary.mjs",
      "tooling/repo/npm-release.ts",
      "tooling/repo/prepare-npm.ts",
      "tooling/repo/publish.ts",
      "tooling/repo/version.ts",
    ])
    const unexpected = changed.filter((file) => !allowed.has(file))
    if (unexpected.length) {
      throw new Error(
        `Exact-version resume checkout changes files outside guarded release infrastructure: ${unexpected.join(", ")}`,
      )
    }
    console.log(`Using repaired release workflow ${checkout} to resume release source ${source}`)
  }
  if (tagged && targetIsSha && target !== tagged && target !== artifactSource) {
    throw new Error(
      `Draft release source mismatch: ${tag} resolves to ${tagged}, its artifact source is ${artifactSource}, but its target is ${target}`,
    )
  }

  output.push(`release=${release.id}`)
  output.push(`tag=${release.tagName}`)
  output.push(`source=${source}`)
  output.push(`artifact_source=${artifactSource}`)
}

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
