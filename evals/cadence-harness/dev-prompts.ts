export type DevPromptID = "P21" | "P23" | "P24"

const source: Record<DevPromptID, { title: string; text: string }> = {
  P21: {
    title: "Structural Biology and Protein Engineering",
    text: `Using the NVIDIA BioNeMo Agent Toolkit, design and rank ten de novo protein binders against GFP using the best available supported workflow, including backbone generation, sequence design, structure prediction, and interface or affinity scoring where appropriate. Use Modal as the compute provider for orchestration, batching, analysis, and visualization, and execute the workflow rather than only proposing code. Preserve model versions, parameters, failures, and intermediate structures; assess sequence diversity and ranking stability. Deliver the ten candidate sequences, predicted complexes, Pareto-style ranking plots, and interactive 3D molecular visualizations. Finish with a publication-quality LaTeX scientific report and compiled PDF containing methods, results, uncertainty, limitations, and an experimental validation plan; do not present computational binding predictions as experimentally validated.`,
  },
  P23: {
    title: "Marine Ecology and Oceanography",
    text: `Using the Global Coral Bleaching Database NCEI accession 0228498 Version 1.1 and NOAA daily OISST v2.1 for 1982–2021, identify repeatedly surveyed reefs that bleached less or more than expected from antecedent heat exposure. Calculate 84-day cumulative positive thermal anomaly, maximum anomaly, and event duration relative to a fixed 1982–2011 local seasonal baseline; fit a grouped model with region and year effects and validate by site. Use Modal as the compute provider for NetCDF processing, geospatial joins, modeling, uncertainty analysis, and visualization. Rank only repeat-survey locations and test ranking stability under alternative thermal windows. Deliver resilient and sensitive candidate lists, observed-versus-expected plots, thermal-history figures, and an interactive reef map. Finish with a publication-quality LaTeX report and compiled PDF, mechanistic hypotheses, and a logger × symbiont × controlled-heat validation plan; do not claim causal resistance from temperature associations alone.`,
  },
  P24: {
    title: "Mechanistic Interpretability and Scientific Discovery",
    text: `For the NeurIPS 2026 Interpretability for Discovery workshop (https://interpretability4discovery.github.io/cfp.html), autonomously develop and execute a paper around whether interpretable features in protein language models can reveal novel, experimentally testable rules of mutation tolerance, epistasis, or functional specialization. Select appropriate open models and ProteinGym/DMS datasets, identify the strongest research question from the literature, and use methods such as sparse autoencoders, probing, activation interventions, or representation analysis to test it against strong predictive and conservation baselines. Use at most 4× H100 GPUs for all training and inference, adapt the direction if early experiments fail, and perform the necessary ablations, robustness checks, and statistical validation. Deliver reproducible code, publication-quality figures, interpretable biological hypotheses, and a fully anonymized submission-ready ≤5-page NeurIPS 2026 LaTeX paper plus compiled PDF, appendices, references, and responsible-use statement; work fully autonomously from research question through final manuscript.`,
  },
}

export function devPrompt(id: string) {
  const normalized = id.toUpperCase() as DevPromptID
  const prompt = source[normalized]
  if (!prompt) throw new Error(`Unknown prompt ${id}. Use P21, P23, or P24.`)
  const ordinal = Number(normalized.slice(1))
  const sha256 = new Bun.CryptoHasher("sha256").update(prompt.text).digest("hex")
  return {
    id: normalized,
    ordinal,
    title: prompt.title,
    text: prompt.text,
    sha256,
    batchIndex: 1,
    batchPosition: 0,
  }
}

export const DEV_PROMPT_IDS = Object.freeze(Object.keys(source) as DevPromptID[])
