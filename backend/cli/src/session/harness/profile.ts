import { HarnessContract } from "./contract"

export namespace HarnessProfile {
  export type Selection = {
    id: HarnessContract.Profile
    source: "contract" | "heuristic" | "control"
    confidence: number
    reasons: string[]
    prompt: string
  }

  const instructions: Record<HarnessContract.Profile, string[]> = {
    react: [
      "Use the direct ReAct control: take the smallest reliable path to the requested result.",
      "Do not create candidate populations, review panels, or process artifacts unless the task itself requires them.",
    ],
    optimize: [
      "Treat this as evaluator-driven optimization. Pin the metric, direction, budget, and baseline before changing the candidate.",
      "Preserve candidate lineage and failed approaches; explore distinct branches before exploiting the strongest measured branch.",
      "Never call a candidate better without running the declared evaluator, and stop when the budget or terminal criterion is reached.",
    ],
    reproduce: [
      "Treat this as research reproduction. Extract the target claims, protocol, inputs, outputs, and success criteria before execution.",
      "Keep claims linked to observable evidence and finish with an independent clean replay or an explicit reproducibility blocker.",
    ],
    theory: [
      "Treat this as theoretical physics. Track assumptions, units, sign conventions, limiting cases, and the exact quantity to derive.",
      "Use an independent derivation or adversarial check before accepting the final result; disagreement remains visible until resolved.",
    ],
    numerical: [
      "Treat this as numerical science. Pin equations, domains, boundary and initial conditions, discretization, tolerances, and invariants.",
      "Require a convergence, stability, conservation, manufactured-solution, or known-limit check appropriate to the claimed result.",
    ],
    training: [
      "Treat this as a bounded training experiment. Validate data splits, model identity, chat template, decoding, seed, and baseline first.",
      "Checkpoint recoverably, compare methods through the declared evaluator, and audit leakage or benchmark-targeted data before claiming progress.",
    ],
    forecast: [
      "Treat this as forecast-model evaluation. Pin dataset, initialization, variables, region, resolution, lead times, and deterministic or probabilistic mode.",
      "Report the full metric portfolio and compute budget; do not collapse incompatible forecast settings into one SOTA claim.",
    ],
  }

  const prompt = (selection: Omit<Selection, "prompt">) =>
    [
      `<harness-profile id="${selection.id}" source="${selection.source}" confidence="${selection.confidence.toFixed(2)}">`,
      ...instructions[selection.id].map((line) => `- ${line}`),
      "This profile refines the normal OpenScience contract; safety, user instructions, and actual tool evidence remain authoritative.",
      "</harness-profile>",
    ].join("\n")

  const select = (selection: Omit<Selection, "prompt">): Selection => ({ ...selection, prompt: prompt(selection) })

  export function classify(input: { agent?: string; text: string; contract?: HarnessContract.Info | null }): Selection {
    if (input.contract) {
      return select({
        id: input.contract.profile,
        source: "contract",
        confidence: 1,
        reasons: [`contract:${input.contract.runID}`],
      })
    }

    const text = input.text.toLowerCase()
    const agent = input.agent ?? "research"
    const has = (pattern: RegExp) => pattern.test(text)
    const reproduction =
      has(/\b(reproduce|replicate|rediscover|re-create)\b/) && has(/\b(paper|study|result|experiment)\b/)
    if (reproduction) {
      return select({ id: "reproduce", source: "heuristic", confidence: 0.94, reasons: ["reproduction-language"] })
    }

    const weather =
      has(/\b(weather|forecast|forecasting|nowcast)\b/) && has(/\b(model|train|evaluate|benchmark|skill)\b/)
    if ((agent === "ml" || agent === "research") && weather) {
      return select({ id: "forecast", source: "heuristic", confidence: 0.92, reasons: ["forecast-contract"] })
    }

    const training = has(/\b(post[- ]?train|fine[- ]?tun|rlhf|grpo|dpo|sft|preference training)\b/)
    if ((agent === "ml" || agent === "research") && training) {
      return select({ id: "training", source: "heuristic", confidence: 0.9, reasons: ["training-language"] })
    }

    const numerical = has(/\b(pde|finite element|finite volume|spectral method|numerical simulation|cfd|solver)\b/)
    if ((agent === "physics" || agent === "research") && numerical) {
      return select({ id: "numerical", source: "heuristic", confidence: 0.9, reasons: ["numerical-physics-language"] })
    }

    const theory =
      has(/\b(derive|derivation|prove|proof|theoretical)\b/) &&
      has(/\b(physics|hamiltonian|lagrangian|field theory|quantum|relativ|thermodynamic)\b/)
    if ((agent === "physics" || agent === "research") && theory) {
      return select({ id: "theory", source: "heuristic", confidence: 0.86, reasons: ["theory-language"] })
    }

    const objective =
      has(/\b(leaderboard|kaggle|submission)\b/) ||
      (has(/\bbenchmark\b/) && has(/\b(metric|score|objective|medal|accuracy|loss|reward)\b/))
    const optimize = has(/\b(optimi[sz]e|improve|iterate|evolve|search)\b/) && objective
    if (optimize) {
      return select({ id: "optimize", source: "heuristic", confidence: 0.88, reasons: ["measurable-optimization"] })
    }

    return select({ id: "react", source: "control", confidence: 1, reasons: ["conservative-default"] })
  }

  export async function resolve(input: { sessionID: string; agent?: string; text: string }) {
    const contract = await HarnessContract.read(input.sessionID)
    return classify({ ...input, contract })
  }
}
