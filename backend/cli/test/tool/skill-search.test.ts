import { describe, expect, test } from "bun:test"
import type { Skill } from "../../src/skill"
import { searchSkills } from "../../src/tool/skill"

const skills = [
  {
    name: "geopandas",
    description: "Geospatial joins, projections, and vector analysis for environmental datasets",
    category: "data-analysis",
    location: "/skills/geopandas/SKILL.md",
  },
  {
    name: "xarray",
    description: "Analyze labelled multidimensional NetCDF climate and ocean data",
    category: "data-analysis",
    location: "/skills/xarray/SKILL.md",
  },
  {
    name: "molecular-docking",
    description: "Dock small molecules into protein structures",
    category: "chemistry",
    location: "/skills/molecular-docking/SKILL.md",
  },
] as Skill.Info[]

describe("skill semantic search", () => {
  test("uses tags, capability names, short scientific terms and known aliases", () => {
    const indexed = [
      { ...skills[0], name: "expression-analysis", tags: ["RNA", "QC"], capability: "transcriptomics" },
      { ...skills[1], name: "protein-binder-design", tags: ["蛋白质"] },
    ]
    for (const query of ["RNA QC", "transcriptomics"]) {
      expect(searchSkills(query, indexed).map((skill) => skill.name)).toEqual(["expression-analysis"])
    }
    for (const query of ["  bionemo-agent-toolkit  ", "蛋白质"]) {
      expect(searchSkills(query, indexed)[0].name).toBe("protein-binder-design")
    }
    expect(searchSkills("  ", indexed)).toEqual([])
  })

  test("ranks task-relevant instructions without browsing whole categories", () => {
    expect(searchSkills("geospatial NetCDF ocean analysis", skills).map((skill) => skill.name)).toEqual([
      "geopandas",
      "xarray",
    ])
  })
})
