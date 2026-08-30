import { describe, expect, test } from "bun:test"

const publicSources = [
  "src/cli/onboard.ts",
  "src/cli/cmd/auth.ts",
  "src/cli/cmd/run.ts",
  "src/provider/provider.ts",
  "src/server/routes/session.ts",
  "src/tool/research-search.ts",
  "src/session/prompt/core.txt",
  "src/agent/prompt/research.txt",
  "src/skill/system/goal.txt",
  "skills/llm-tools/generate-image/scripts/generate_image.py",
  "skills/writing/scientific-slides/scripts/generate_slide_image.py",
  "skills/writing/scientific-slides/scripts/generate_slide_image_ai.py",
  "skills/visualization/infographics/scripts/generate_infographic_ai.py",
  "skills/visualization/scientific-schematics/scripts/generate_schematic.py",
  "skills/visualization/scientific-schematics/scripts/generate_schematic_ai.py",
  "skills/other/goal/SKILL.md",
  "README.md",
] as const

function renderedSource(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import\s.*$/gm, "")
}

describe("public Synthetic Sciences branding allowlist", () => {
  test("keeps internal Atlas identifiers but removes the old standalone brand from rendered surfaces", async () => {
    const violations: string[] = []
    for (const file of publicSources) {
      const source = renderedSource(await Bun.file(new URL(`../${file}`, import.meta.url)).text())
      if (/\bAtlas\b/.test(source)) violations.push(file)
    }
    expect(violations).toEqual([])
  })

  test("does not render retired package billing copy", async () => {
    const forbidden =
      /(?:Ace\+|Legacy (?:Pro|Starter)|\$100\/month|150 credits|research quota|Synthetic Scientists access|\$50 or \$200|recurring monthly|Current Synthetic Sciences plan|Manage plans?|Plan tab|plan entitlements|plan inactive|Subscription:|search allowance|allowance (?:used|unavailable|exhausted)|every plan)/i
    const violations: string[] = []
    for (const file of publicSources) {
      const source = renderedSource(await Bun.file(new URL(`../${file}`, import.meta.url)).text())
      if (forbidden.test(source)) violations.push(file)
    }
    expect(violations).toEqual([])
  })
})
