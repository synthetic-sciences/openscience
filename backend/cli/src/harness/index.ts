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

  /** A headless run registers its root session: denied tool calls continue
   * the loop instead of ending it. */
  export function headless(sessionID: string, input: { continueOnDeny: boolean }) {
    HarnessState.get(sessionID).continueOnDeny = input.continueOnDeny
  }

  export function continueOnDeny(config: Config.Info, sessionID: string) {
    if (!HarnessState.enabled(config, "headless-policy")) return false
    return HarnessState.get(sessionID).continueOnDeny === true
  }

  /** The loop records whether this session may delegate this turn so tool
   * hints (truncation) can offer Task only when it is actually available. */
  export function delegation(sessionID: string, enabled: boolean) {
    HarnessState.get(sessionID).delegation = enabled
  }

  export function delegates(config: Config.Info, sessionID: string | undefined) {
    if (!sessionID) return true
    if (!HarnessState.enabled(config, "durable-jobs")) return true
    return HarnessState.get(sessionID).delegation !== false
  }
}
