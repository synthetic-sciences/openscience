import { expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Skill } from "../../src/skill"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

const name = "shared-skill-dedupe"

function skill(description: string) {
  return `---
name: ${name}
description: ${description}
---

# Shared

Instructions here.
`
}

test("a colliding skill name warns once per pair across catalog rebuilds", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, ".openscience", "skill", "alpha", "SKILL.md"), skill("First copy."))
      await Bun.write(path.join(dir, ".openscience", "skill", "beta", "SKILL.md"), skill("Second copy."))
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const status = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })

      expect((await Skill.all()).filter((item) => item.name === name)).toHaveLength(1)
      await Skill.invalidate()
      expect((await Skill.all()).filter((item) => item.name === name)).toHaveLength(1)
      await Skill.invalidate()
      expect((await Skill.all()).filter((item) => item.name === name)).toHaveLength(1)

      await Log.flush()
      const lines = (await Bun.file(Log.file()).text())
        .split("\n")
        .filter((line) => line.includes("duplicate skill name") && line.includes(`name=${name}`))
      expect(lines.filter((line) => line.startsWith("WARN"))).toHaveLength(1)
      expect(lines.filter((line) => line.startsWith("DEBUG"))).toHaveLength(2)
    },
  })
})
