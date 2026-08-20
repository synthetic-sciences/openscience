import { describe, expect, test } from "bun:test"

const publicSources = [
  "src/cli/onboard.ts",
  "src/cli/cmd/auth.ts",
  "src/cli/cmd/billing.ts",
  "src/cli/cmd/connect.ts",
  "src/cli/cmd/github.ts",
  "src/cli/cmd/project.ts",
  "src/cli/cmd/run.ts",
  "src/provider/provider.ts",
  "src/server/routes/account.ts",
  "src/server/routes/atlas-bridge.ts",
  "src/server/routes/session.ts",
  "src/server/routes/settings/billing.ts",
  "src/tool/atlas.ts",
  "src/tool/atlas-record.ts",
  "src/session/prompt/core.txt",
  "src/agent/prompt/research.txt",
  "src/skill/system/goal.txt",
  "src/skill/system/initialize-atlas-graph.txt",
  "src/skill/migrate.ts",
] as const

function renderedSource(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import\s.*$/gm, "")
}

describe("public Gateway branding allowlist", () => {
  test("keeps internal Atlas identifiers but removes the old standalone brand from rendered surfaces", async () => {
    const violations: string[] = []
    for (const file of publicSources) {
      const source = renderedSource(await Bun.file(new URL(`../${file}`, import.meta.url)).text())
      if (/\bAtlas\b/.test(source)) violations.push(file)
    }
    expect(violations).toEqual([])
  })
})
