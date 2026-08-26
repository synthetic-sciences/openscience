import { describe, expect, test } from "bun:test"
import { ContractProgress } from "../../src/session/contract-progress"

const trace = (readiness = 50): ContractProgress.Trace => ({
  research: {
    status: "running",
    readiness,
    missing: ["report.pdf"],
    failedCandidates: 0,
    gates: [{ id: "deliverables", status: "pending", complete: 0, total: 1, detail: "1 required Result missing" }],
    contract: { stages: [{ id: "analysis", status: "active" }] },
  },
  artifacts: [],
  jobs: [],
  kernels: [],
})

describe("contract progress controller", () => {
  test("continues while semantic evidence changes, repairs once when it does not, then awaits the user", () => {
    const first = ContractProgress.fingerprint(trace())
    const changed = ContractProgress.fingerprint(trace(75))
    expect(ContractProgress.decide({ pending: 1, progress: first })).toBe("continue")
    expect(ContractProgress.decide({ pending: 1, progress: changed, prior: { progress: first, repair: false } })).toBe(
      "continue",
    )
    expect(
      ContractProgress.decide({ pending: 1, progress: changed, prior: { progress: changed, repair: false } }),
    ).toBe("repair")
    expect(ContractProgress.decide({ pending: 1, progress: changed, prior: { progress: changed, repair: true } })).toBe(
      "await_user",
    )
    expect(ContractProgress.decide({ pending: 0, progress: changed })).toBe("ready")
  })

  test("awaits user input immediately for an explicitly blocked research stage", () => {
    const blocked = trace()
    blocked.research.contract!.stages[0]!.status = "blocked"
    expect(ContractProgress.terminal(blocked)).toBe(true)
    expect(
      ContractProgress.decide({ pending: 1, progress: ContractProgress.fingerprint(blocked), terminal: true }),
    ).toBe("await_user")
  })
})
