import type { Plugin } from "@synsci/plugin"
import type { Config } from "@/config/config"
import { HarnessState } from "./state"
import { RedirectUnit } from "./redirect"
import { DeliverablesUnit } from "./deliverables"
import { BudgetUnit } from "./budget"
import { CostUnit } from "./cost"

/**
 * The harness units: small plugins that deliver context at the point in the
 * loop where it matters. Each has a switch under `harness.<unit>` and is on by
 * default. `headless-policy`, `durable-jobs` and `workers` have no hooks of
 * their own: they gate behaviour that lives in the run command, the
 * truncation hint and the Task streaming, so they are switches here.
 */
export namespace Harness {
  // Resolved on call, not at module load: the units import session modules
  // that import this namespace, so a module-level table would read them
  // before their initialization in some import orders.
  function plugins(): Partial<Record<HarnessState.Unit, Plugin>> {
    return {
      redirect: RedirectUnit,
      deliverables: DeliverablesUnit,
      budget: BudgetUnit,
      cost: CostUnit,
    }
  }

  export function units(config: Config.Info): Plugin[] {
    const table = plugins()
    return HarnessState.UNITS.filter((unit) => HarnessState.enabled(config, unit)).flatMap((unit) => {
      const plugin = table[unit]
      return plugin ? [plugin] : []
    })
  }

  export function enabled(config: Config.Info, unit: HarnessState.Unit) {
    return HarnessState.enabled(config, unit)
  }

  // The per-session predicates the loop, the processor and the truncation
  // hint consult live on the leaf HarnessState module so those modules never
  // import the units (and, through them, the session modules) themselves.
  export const headless = HarnessState.headless
  export const continueOnDeny = HarnessState.continueOnDeny
  export const delegation = HarnessState.delegation
  export const delegates = HarnessState.delegates
}
