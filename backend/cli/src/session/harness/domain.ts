import z from "zod"
import { HarnessContract } from "./contract"
import { HarnessPack } from "./pack"

export namespace HarnessDomain {
  export const Check = z
    .object({
      id: z.string().min(1).max(100),
      severity: z.enum(["blocking", "advisory"]),
      requirement: z.string().min(1).max(500),
    })
    .strict()
  export type Check = z.infer<typeof Check>

  export const Info = z
    .object({
      id: HarnessPack.Id,
      title: z.string().min(1).max(100),
      purpose: z.string().min(1).max(500),
      checks: z
        .array(Check)
        .min(1)
        .max(24)
        .refine(
          (items) => new Set(items.map((item) => item.id)).size === items.length,
          "Pack check IDs must be unique",
        ),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  export type Selection = { ids: HarnessPack.Id[]; source: "contract" | "recommended" | "none" }
  export type Actual = {
    id: string
    status: "passed" | "failed" | "inconclusive"
    blocking: boolean
    evidence: string[]
  }

  const gate = (id: string, requirement: string): Check => ({ id, severity: "blocking", requirement })
  const advise = (id: string, requirement: string): Check => ({ id, severity: "advisory", requirement })
  const estimand = gate("estimand", "State the target quantity, population, comparison, and time horizon.")
  const assumptions = gate("assumptions", "Check the assumptions that make the chosen method valid.")
  const multiplicity = gate("multiplicity", "Control multiple testing or document why it is not applicable.")
  const uncertainty = gate("uncertainty", "Report calibrated uncertainty, interval estimates, or justified bounds.")
  const heldout = gate("held-out", "Evaluate only on the declared untouched split or withheld outputs.")
  const baseline = gate("baseline", "Compare against the declared relevant baseline under the same setting.")
  const budget = gate("budget", "Report and respect the declared model, data, tool, and compute budget.")

  export const catalog: Record<HarnessPack.Id, Info> = {
    statistics: Info.parse({
      id: "statistics",
      title: "Statistical methodology",
      purpose: "Guard estimands, assumptions, effect interpretation, uncertainty, and multiplicity.",
      checks: [
        estimand,
        assumptions,
        gate("effect-size", "Report effect size and practical scale, not significance alone."),
        uncertainty,
        multiplicity,
        advise("sensitivity", "Probe sensitivity to defensible alternative specifications or assumptions."),
        gate("stat-replay", "Preserve exact inputs, exclusions, transformations, test definition, and seed."),
      ],
    }),
    biology: Info.parse({
      id: "biology",
      title: "Computational biology",
      purpose: "Guard biological identity, design, QC, batch structure, multiplicity, and interpretation.",
      checks: [
        gate("bio-identifiers", "Validate organism, assembly, feature namespace, aliases, and identifier versions."),
        gate("bio-design", "Recover groups, pairing, replicates, sampling unit, and experimental design."),
        gate("bio-qc", "Run modality-appropriate sample and feature QC without outcome-informed deletion."),
        gate("bio-batch", "Model or justify batch, donor, site, lane, and other technical structure."),
        gate("bio-covariates", "Predeclare relevant covariates and avoid post-outcome adjustment choices."),
        estimand,
        multiplicity,
        gate("bio-validity", "Separate statistical evidence from biological mechanism and validate key annotations."),
      ],
    }),
    physics: Info.parse({
      id: "physics",
      title: "Theoretical and physical reasoning",
      purpose: "Guard assumptions, dimensions, conventions, limits, conservation, and independent derivation.",
      checks: [
        assumptions,
        gate("units", "Verify dimensional consistency of every material equation and reported quantity."),
        gate("sign-convention", "Pin coordinate, metric, Fourier, phase, and sign conventions."),
        gate("limiting-case", "Recover known limits, asymptotics, bounds, or special cases."),
        gate("physics-conservation", "Check applicable conservation laws, symmetries, and physical bounds."),
        gate(
          "independent-derivation",
          "Verify the headline result through an independent derivation or equivalent route.",
        ),
      ],
    }),
    pde: Info.parse({
      id: "pde",
      title: "Numerical PDE and simulation",
      purpose: "Guard problem specification, discretization, stability, convergence, conservation, and error claims.",
      checks: [
        gate("pde-equation", "Pin the exact PDE, coefficients, source terms, and nondimensionalization."),
        gate("pde-domain", "Pin geometry, coordinate system, mesh domain, and material regions."),
        gate("pde-bc-ic", "Pin boundary and initial conditions and verify their compatibility."),
        gate("pde-discretization", "Record scheme, order, mesh, timestep, solver, tolerances, and stopping rules."),
        gate("pde-convergence", "Demonstrate mesh/time/order convergence in a declared error norm."),
        gate("pde-stability", "Check CFL, conditioning, solver convergence, or the applicable stability criterion."),
        gate(
          "pde-conservation",
          "Measure conservation, residual, positivity, maximum principle, or relevant invariants.",
        ),
        gate("pde-reference", "Compare with an analytic, manufactured, benchmark, or known-limit solution."),
        gate("pde-error", "Report error norms and tolerances on the claimed quantity, not visuals alone."),
      ],
    }),
    chemistry: Info.parse({
      id: "chemistry",
      title: "Chemistry and materials",
      purpose: "Guard chemical identity, representation, conditions, splits, physical validity, and uncertainty.",
      checks: [
        gate("chem-identity", "Pin compound/material identity, composition, phase, protonation, charge, and version."),
        gate(
          "chem-standardization",
          "Document canonicalization, salts, tautomers, duplicates, and structure normalization.",
        ),
        gate("chem-valence", "Validate valence, aromaticity, charge balance, sanitization, and impossible structures."),
        gate("chem-stereo", "Preserve or explicitly marginalize stereochemistry and regiochemistry."),
        gate("chem-units", "Pin units, assay/measurement conditions, temperature, pressure, solvent, and protocol."),
        heldout,
        gate("chem-split", "Audit scaffold, temporal, composition, and near-duplicate leakage across splits."),
        gate("chem-physical", "Check physical bounds, conservation, symmetry, and domain applicability."),
        uncertainty,
      ],
    }),
    ml: Info.parse({
      id: "ml",
      title: "Machine learning",
      purpose: "Guard data identity, held-out evaluation, leakage, baselines, metrics, variance, and compute.",
      checks: [
        gate("ml-data", "Pin dataset version, schema, target, exclusions, preprocessing, and sample unit."),
        heldout,
        gate(
          "ml-leakage",
          "Audit target, split, temporal, group, preprocessing, retrieval, and benchmark contamination.",
        ),
        baseline,
        gate("ml-metric", "Pin metric implementation, direction, aggregation, decoding, and tie handling."),
        gate("ml-seed-variance", "Report seeds and uncertainty or justify deterministic evaluation."),
        budget,
        gate("ml-model", "Pin model/checkpoint identity, templates, tokenizer, config, dependencies, and code state."),
        advise("ml-ablation", "Ablate the claimed improvement against the strongest measured parent or baseline."),
      ],
    }),
    forecast: Info.parse({
      id: "forecast",
      title: "Weather and spatiotemporal forecasting",
      purpose: "Guard forecast configuration, lead-dependent metrics, baselines, calibration, leakage, and compute.",
      checks: [
        gate("forecast-data", "Pin dataset, observation/reanalysis source, variables, units, and revision."),
        gate("forecast-init", "Pin initialization time, analysis cycle, ensemble members, and latency assumptions."),
        gate("forecast-grid", "Pin region, mask, vertical levels, grid/resolution, regridding, and weighting."),
        gate("forecast-leads", "Report the declared lead times without selecting only favorable horizons."),
        heldout,
        baseline,
        gate("forecast-metrics", "Report the full lead-dependent deterministic or probabilistic metric portfolio."),
        gate("forecast-mode", "Distinguish deterministic, ensemble, probabilistic, and nowcast settings."),
        gate("forecast-calibration", "Check calibration or explicitly document deterministic non-applicability."),
        gate(
          "forecast-leakage",
          "Audit future information, reanalysis revisions, temporal overlap, and normalization leakage.",
        ),
        budget,
        uncertainty,
      ],
    }),
    formal: Info.parse({
      id: "formal",
      title: "Formal theorem verification",
      purpose:
        "Guard statement identity, proof relation, environment closure, kernel acceptance, and trust assumptions.",
      checks: [
        gate("formal-challenge", "Bind the exact trusted challenge, canonical statement, declaration, and module."),
        gate("formal-relation", "Distinguish an exact proof, exact refutation, and repaired-statement proof."),
        gate("formal-environment", "Pin Lean, toolchain, package manifest, dependency tree, and checker artifacts."),
        gate("formal-manifest", "Commit the complete challenge, statement, proof, environment, and support manifest."),
        gate(
          "formal-kernel",
          "Build successfully with no warnings and replay the proof through the frozen Lean kernel.",
        ),
        gate(
          "formal-source",
          "Audit every manifest source with the frozen policy and reject all unchecked escape constructs.",
        ),
        gate(
          "formal-axioms",
          "Audit the transitive axiom closure, including axiom types, against the frozen allowlist.",
        ),
        gate("formal-tier", "Satisfy the contract's kernel, fresh-recheck, or independent external-checker tier."),
        advise(
          "formal-semantics",
          "Review that the frozen formal statement and definitions express the intended informal mathematics.",
        ),
      ],
    }),
  }

  export function compose(ids: HarnessPack.Id[]) {
    const checks = new Map<string, Check>()
    for (const id of ids) {
      for (const check of catalog[id].checks) {
        const current = checks.get(check.id)
        if (current && JSON.stringify(current) !== JSON.stringify(check)) {
          throw new Error(`Domain pack check ${check.id} has conflicting definitions`)
        }
        checks.set(check.id, check)
      }
    }
    return [...checks.values()]
  }

  export function audit(ids: HarnessPack.Id[], actual: Actual[]) {
    const expected = compose(ids)
    const duplicates = actual.filter((item, index) => actual.findIndex((other) => other.id === item.id) !== index)
    const byID = new Map(actual.map((item) => [item.id, item]))
    const missing = expected.filter((check) => check.severity === "blocking" && !byID.has(check.id))
    const failed = expected.flatMap((check) => {
      if (check.severity !== "blocking") return []
      const item = byID.get(check.id)
      if (!item) return []
      if (item.status !== "passed") return [{ check, actual: item, reason: `status:${item.status}` }]
      if (!item.blocking) return [{ check, actual: item, reason: "not-marked-blocking" }]
      if (!item.evidence.length) return [{ check, actual: item, reason: "missing-evidence" }]
      return []
    })
    const advisory = expected.filter((check) => check.severity === "advisory" && !byID.has(check.id))
    return { expected, missing, failed, advisory, duplicates }
  }

  export function assert(ids: HarnessPack.Id[], actual: Actual[]) {
    const result = audit(ids, actual)
    if (!result.missing.length && !result.failed.length && !result.duplicates.length) return result
    const issues = [
      ...result.missing.map((check) => `${check.id}:missing`),
      ...result.failed.map((item) => `${item.check.id}:${item.reason}`),
      ...result.duplicates.map((item) => `${item.id}:duplicate`),
    ]
    throw new Error(`Domain verification pack failed: ${issues.join(", ")}`)
  }

  export function recommend(input: { agent?: string; profile: HarnessContract.Profile; text: string }) {
    const text = input.text.toLowerCase()
    const active =
      /\b(analy[sz]e|calculate|compute|estimate|evaluate|fit|implement|model|run|simulate|train|benchmark)\b/.test(
        text,
      ) || /\btest\s+(whether|if)\b/.test(text)
    if (!active && input.profile === "react") return []
    const ids: HarnessPack.Id[] = []
    const add = (...items: HarnessPack.Id[]) => {
      for (const item of items) if (!ids.includes(item)) ids.push(item)
    }
    const stats =
      /\b(chi[- ]?square|p[- ]?value|hypothesis test|anova|regression|confidence interval|effect size|multiple testing|statistical)\b/.test(
        text,
      )
    if (stats) add("statistics")
    const biology =
      input.agent === "biology" && /\b(data|gene|genom|protein|cell|variant|omics|assay|cohort|sample)\b/.test(text)
    if (biology && active) add("biology")
    if (input.profile === "theory") add("physics")
    if (input.profile === "numerical") add("physics", "pde")
    const chemistry = /\b(chemi|molecul|compounds?|reactions?|materials?|crystal|polymer|cataly|smiles|inchi)/.test(
      text,
    )
    if (chemistry && active) add("chemistry")
    if (input.profile === "training" || (input.profile === "optimize" && input.agent === "ml")) add("ml")
    if (input.profile === "forecast") add("ml", "forecast")
    if (/\b(lean\s*4?|formal(?:ize|ization| proof)?|theorem prover|proof assistant|kernel[- ]checked)\b/.test(text)) {
      add("formal")
    }
    return ids
  }

  export async function resolve(input: {
    sessionID: string
    agent?: string
    profile: HarnessContract.Profile
    text: string
  }): Promise<Selection> {
    const contract = await HarnessContract.read(input.sessionID)
    if (contract?.packs?.length) return { ids: contract.packs, source: "contract" }
    const ids = recommend(input)
    return { ids, source: ids.length ? "recommended" : "none" }
  }

  export function prompt(selection: Selection) {
    if (!selection.ids.length) return ""
    const lines = [
      `<domain-verification source="${selection.source}">`,
      selection.source === "contract"
        ? "These checks are part of the immutable evaluator contract; every blocking ID needs a passing evidence-backed check."
        : "Use these checks for material claims when applicable; do not turn a simple task into process ceremony.",
    ]
    for (const id of selection.ids) {
      lines.push(`## ${catalog[id].title} (${id})`)
      for (const check of catalog[id].checks) {
        lines.push(`- [${check.severity}] ${check.id}: ${check.requirement}`)
      }
    }
    lines.push("</domain-verification>")
    return lines.join("\n")
  }
}
