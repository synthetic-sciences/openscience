import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Skill } from "../../src/skill"
import { ConfigMarkdown } from "../../src/config/markdown"
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

describe("skill metadata search", () => {
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
      "xarray",
      "geopandas",
    ])
  })

  test("weights distinctive terms above repeated common metadata and preserves exact names", () => {
    const indexed = [
      ...Array.from({ length: 20 }, (_, index) => ({
        ...skills[0],
        name: `data-pipeline-${index}`,
        description: "Data processing and data loading",
        category: "data-engineering",
        tags: ["data"],
        capability: "data",
      })),
      { ...skills[0], name: "plotting", description: "Statistical visualization", category: "visualization" },
    ]
    expect(searchSkills("data visualization", indexed)[0].name).toBe("plotting")
    expect(searchSkills("data-pipeline-3", indexed)[0].name).toBe("data-pipeline-3")
    expect(searchSkills("unrelated nonexistent concept", indexed)).toEqual([])
  })

  test("the bundled catalog surfaces visualization skills for the observed missing-name query", async () => {
    const root = path.join(import.meta.dir, "../../skills")
    const paths = await Array.fromAsync(new Bun.Glob("**/SKILL.md").scan({ cwd: root, absolute: true }))
    const indexed = await Promise.all(
      paths.map(async (location) =>
        Skill.Info.parse({ ...(await ConfigMarkdown.parse(location)).data, location, origin: "default" }),
      ),
    )
    const names = searchSkills("data-visualization", indexed, 5).map((skill) => skill.name)
    expect(names).toContain("scientific-visualization")
    expect(names).toContain("matplotlib")
    expect(names).not.toContain("ray-data")
    expect(names).not.toContain("hdf5-pde-data-loading")
    expect(names).not.toContain("training-data-pipeline")
    expect(searchSkills("data-visualization", [...indexed].reverse(), 5).map((skill) => skill.name)).toEqual(names)
    const plots = searchSkills(
      "exploratory data analysis and publication-quality statistical plots for tabular Titanic dataset",
      indexed.filter((skill) => skill.category === "visualization"),
    )
    expect(plots.slice(0, 3).map((skill) => skill.name)).toContain("seaborn")
  })
})
