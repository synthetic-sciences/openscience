import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const python = Bun.which("python3") ?? Bun.which("python")
const script = path.resolve(
  import.meta.dir,
  "../../skills/research/market-research-reports/scripts/generate_market_visuals.py",
)

test.skipIf(!python)("market visuals filter the selected catalog and unpack every extended entry", async () => {
  await using tmp = await tmpdir()
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(
      [python!, "-B", script, "--topic", "Fixture", "--output-dir", tmp.path, "--dry-run", ...args],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString()
  }
  expect(run("--only", "01_")).toContain("01_")
  expect(run("--all", "--only", "08_")).toContain("08_regional_breakdown.png")
  expect(run("--all")).toContain("08_regional_breakdown.png")
})
