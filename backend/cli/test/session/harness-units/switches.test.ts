import { afterEach, expect, test } from "bun:test"
import { Config } from "../../../src/config/config"
import { Harness } from "../../../src/harness"
import { HarnessState } from "../../../src/harness/state"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"

afterEach(() => HarnessState.reset())

test("every unit is on by default and a false switch removes its plugin and its behaviour", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      for (const unit of HarnessState.UNITS) expect(Harness.enabled(config, unit)).toBe(true)
      expect(Harness.units(config)).toHaveLength(4)
      const off: Config.Info = {
        ...config,
        harness: { redirect: false, budget: false, "headless-policy": false, "durable-jobs": false },
      }
      expect(Harness.units(off)).toHaveLength(2)
      Harness.headless("ses_h", { continueOnDeny: true })
      expect(Harness.continueOnDeny(config, "ses_h")).toBe(true)
      expect(Harness.continueOnDeny(off, "ses_h")).toBe(false)
      expect(Harness.continueOnDeny(config, "ses_other")).toBe(false)
      Harness.delegation("ses_h", false)
      expect(Harness.delegates(config, "ses_h")).toBe(false)
      expect(Harness.delegates(off, "ses_h")).toBe(true)
      expect(Harness.delegates(config, undefined)).toBe(true)
    },
  })
})
