import { expect, test } from "bun:test"
import path from "node:path"
import { ACE_CONTRACT, aceActivationCopy } from "../../src/openscience/ace-contract"

const root = path.resolve(import.meta.dir, "../../../..")

async function source(relative: string) {
  return (await Bun.file(path.join(root, relative)).text()).replace(/\s+/g, " ")
}

test("local Ace terms expose the one current server contract", () => {
  expect(ACE_CONTRACT).toEqual({
    activationAuthorizationUsd: 0,
    reloadThresholdUsd: 5,
    reloadAmountUsd: 20,
    serviceMarginPercent: 2,
    processingFeeDisclosedSeparately: true,
    reloadControlledByAce: true,
  })
  expect(aceActivationCopy()).toBe(
    "Ace is a $0 authorization, not a purchase or subscription. While Ace is on, a purchased Wallet balance below $5 triggers one fixed $20 reload; the processing fee is disclosed separately before payment.",
  )
})

test("README, docs, spec, CLI, and workspace reject the retired reload contracts", async () => {
  const files = await Promise.all(
    [
      "README.md",
      "frontend/docs/src/content/openscience/gateway.mdx",
      "docs/specs/openscience-ace-design.md",
      "backend/cli/src/cli/cmd/billing.ts",
      "frontend/workspace/src/components/settings/ManagedInference.tsx",
    ].map(source),
  )
  const docsIndex = await source("frontend/landing/public/docs/index.html")
  const asset = docsIndex.match(/assets\/(index-[^"']+\.js)/)?.[1]
  if (!asset) throw new Error("Built docs index does not reference a JavaScript bundle")
  const builtDocs = await source(`frontend/landing/public/docs/assets/${asset}`)
  const combined = [...files, builtDocs].join("\n")

  for (const publicTerms of [...files.slice(0, 3), builtDocs]) {
    expect(publicTerms).toMatch(/\$0 authorization/)
    expect(publicTerms).toMatch(/purchased Wallet balance below (?:\*\*)?5/)
    expect(publicTerms).toMatch(/fixed [^.]{0,40}(?:\*\*)?20/)
    expect(publicTerms).toMatch(/processing fee/i)
  }
  expect(combined).not.toMatch(/below (?:a )?2(?:-credit| credits?)/i)
  expect(combined).not.toMatch(/change the reload amount/i)
  expect(combined).not.toMatch(/turn (?:auto-reload|it) on or off anytime/i)
  expect(combined).not.toMatch(/funds only the gap/i)
})
