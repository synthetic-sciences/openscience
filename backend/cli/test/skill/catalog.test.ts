import { expect, test } from "bun:test"
import { ComputeCapabilities } from "../../src/compute/capabilities"
import { SkillCatalog } from "../../src/skill/catalog"
import { BioNemoWorkflow } from "../../src/skill/workflows/bionemo"

test("curated catalog pins upstream sources without installing them", () => {
  const bionemo = SkillCatalog.get("protein-binder-design")
  expect(bionemo?.upstream?.sha).toBe("0e67a612e4045f007e38fa77adc8f3ebfc5616b6")
  expect(bionemo?.status).toBe("experimental")
  expect(SkillCatalog.get("modal")?.replaced_by).toBe("compute_job")
})

test("skill shortlist admits one workflow and two supports", () => {
  const result = SkillCatalog.select(
    [
      { name: "protein-binder-design", score: 10 },
      { name: "literature-review", score: 9 },
      { name: "transformer-lens", score: 8 },
      { name: "saelens", score: 7 },
      { name: "nnsight", score: 6 },
      { name: "modal", explicit: true },
    ],
    ["nvidia_nim"],
  )
  expect(result.selected.map((skill) => skill.name)).toEqual(["protein-binder-design", "transformer-lens", "saelens"])
  expect(result.omitted).toContainEqual({ name: "literature-review", reason: "workflow_limit" })
  expect(result.omitted).toContainEqual({ name: "nnsight", reason: "support_limit" })
  expect(result.omitted).toContainEqual({ name: "modal", reason: "blocked" })
})

test("BioNeMo planner chooses hosted NIM honestly and blocks unsupported NGC pulls", () => {
  const hosted = ComputeCapabilities.describe({ modal: true, hosts: [], secrets: ["nvidia_nim"] })
  expect(BioNemoWorkflow.plan({ targets: hosted, gpu_memory_gb: 80 }).route).toBe("hosted_nim")

  const ngc = ComputeCapabilities.describe({ modal: true, hosts: [], secrets: ["nvidia_ngc"] })
  const blocked = BioNemoWorkflow.plan({ targets: ngc, gpu_memory_gb: 80 })
  expect(blocked.route).toBe("blocked")
  expect(blocked.missing).toContain("reviewed private-registry image adapter")

  const absent = ComputeCapabilities.describe({ modal: true, hosts: [], secrets: [] })
  expect(BioNemoWorkflow.plan({ targets: absent }).missing).toContain("NVIDIA hosted API key or NGC registry key")
})
