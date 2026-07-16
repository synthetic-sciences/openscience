import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const script = path.resolve(
  import.meta.dir,
  "../../skills/chemistry/nmr-compound-inference/scripts/nmr_match.py",
)

test("NMR matcher ranks the candidate with the closest nucleus-specific peaks", async () => {
  await using tmp = await tmpdir({})
  const observed = path.join(tmp.path, "observed.json")
  const library = path.join(tmp.path, "library.json")
  await Promise.all([
    Bun.write(observed, JSON.stringify({ peaks: [{ position: 3.65 }, { position: 1.18 }, { position: 7.26 }] })),
    Bun.write(
      library,
      JSON.stringify({
        candidates: [
          { name: "ethanol", nucleus: "1H", solvent: "CDCl3", peaks: [3.64, 1.2] },
          { name: "acetone", nucleus: "1H", solvent: "CDCl3", peaks: [2.05] },
          { name: "ethanol-carbon", nucleus: "13C", solvent: "CDCl3", peaks: [18.3, 58.4] },
        ],
      }),
    ),
  ])
  const proc = Bun.spawn(
    ["python3", script, "--observed", observed, "--library", library, "--nucleus", "1H", "--solvent", "CDCl3"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  const result = JSON.parse(stdout)
  expect(result.candidates[0].name).toBe("ethanol")
  expect(result.candidates[0].matched_count).toBe(2)
  expect(result.candidates.some((candidate: { name: string }) => candidate.name === "ethanol-carbon")).toBe(false)
})

test("NMR region hints use distinct proton and carbon ranges", async () => {
  const dir = path.dirname(script)
  const code = [
    "import json,sys",
    `sys.path.insert(0, ${JSON.stringify(dir)})`,
    "from nmr_match import region_flags",
    "print(json.dumps({'proton': region_flags([{'position': 9.8}], '1H'), 'carbon': region_flags([{'position': 175.0}], '13C')}))",
  ].join(";")
  const proc = Bun.spawn(["python3", "-c", code], { stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(status).toBe(0)
  const result = JSON.parse(stdout)
  expect(result.proton.aldehyde).toBe(true)
  expect(result.carbon.carbonyl).toBe(true)
  expect(result.carbon.aldehyde).toBeUndefined()
})
