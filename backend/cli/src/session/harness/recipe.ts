import path from "path"
import z from "zod"
import { HarnessBenchmark } from "./benchmark"

export namespace HarnessRecipe {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Name = z.string().regex(/^[a-z][a-zA-Z0-9]*$/)
  const Key = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  const Rel = z
    .string()
    .min(1)
    .max(1_000)
    .refine((value) => !path.posix.isAbsolute(value), "Recipe paths must be relative")
    .refine((value) => !value.split("/").includes(".."), "Recipe paths cannot escape the checkout")
    .refine((value) => !value.includes("\\"), "Recipe paths must use POSIX separators")
  const Template = z
    .string()
    .min(1)
    .max(2_048)
    .refine((value) => !path.posix.isAbsolute(value), "Recipe artifact paths must be relative")
    .refine((value) => !value.split("/").includes(".."), "Recipe artifact paths cannot escape the checkout")
    .refine((value) => !value.includes("\\"), "Recipe artifact paths must use POSIX separators")

  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (!input || typeof input !== "object") return input
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, canonical(value)]),
    )
  }

  export const digest = (input: unknown) =>
    new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(input))).digest("hex")

  export const Binding = z
    .object({
      name: Name,
      kind: z.enum(["path", "identifier", "integer", "choice"]),
      description: z.string().min(1).max(500),
      required: z.boolean().default(true),
      default: z.string().min(1).max(2_048).optional(),
      choices: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
      minimum: z.number().int().optional(),
      maximum: z.number().int().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.kind === "choice" && !value.choices) {
        ctx.addIssue({ code: "custom", path: ["choices"], message: "Choice bindings require allowed values" })
      }
      if (value.kind !== "choice" && value.choices) {
        ctx.addIssue({ code: "custom", path: ["choices"], message: "Only choice bindings may declare allowed values" })
      }
      if (value.kind !== "integer" && (value.minimum !== undefined || value.maximum !== undefined)) {
        ctx.addIssue({ code: "custom", message: "Only integer bindings may declare numeric bounds" })
      }
      if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
        ctx.addIssue({ code: "custom", path: ["minimum"], message: "Binding minimum exceeds its maximum" })
      }
      if (!value.required && value.default === undefined) {
        ctx.addIssue({ code: "custom", path: ["default"], message: "Optional bindings require a default" })
      }
    })
  export type Binding = z.infer<typeof Binding>

  export const Driver = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("argv"),
        entrypoint: Rel,
        cwd: Rel.or(z.literal(".")),
        argv: z.array(z.string().min(1).max(2_048)).min(1).max(128),
      })
      .strict(),
    z
      .object({
        kind: z.literal("python_api"),
        entrypoint: Rel,
        module: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/),
        symbol: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/),
        kwargs: z.record(Key, z.string().min(1).max(2_048)),
        runtimeInputs: z
          .array(Name)
          .max(32)
          .refine((items) => new Set(items).size === items.length, "Runtime inputs must be unique"),
      })
      .strict(),
  ])

  export const Stage = z
    .object({
      id: z.string().regex(/^[a-z][a-z0-9-]*$/),
      role: z.enum(["prepare", "execute", "evaluate", "aggregate"]),
      driver: Driver,
      inputs: z.array(Template).max(64),
      outputs: z.array(Template).max(64),
      environment: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(64),
    })
    .strict()

  const ArtifactBase = {
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    producedBy: z.string().regex(/^[a-z][a-z0-9-]*$/),
    owner: z.enum(["runner", "evaluator"]),
  }
  export const Artifact = z.discriminatedUnion("kind", [
    z
      .object({
        ...ArtifactBase,
        kind: z.literal("file"),
        path: Template,
        format: z.enum(["json", "jsonl", "csv", "text", "pickle", "directory"]),
      })
      .strict(),
    z
      .object({
        ...ArtifactBase,
        kind: z.literal("return"),
        format: z.literal("json"),
      })
      .strict(),
  ])

  export const Metric = z
    .object({
      name: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
      artifact: z.string().regex(/^[a-z][a-z0-9-]*$/),
      selector: z.string().min(1).max(500),
      direction: z.enum(["maximize", "minimize", "pass"]),
      aggregation: z.enum(["identity", "mean", "sum", "count"]),
    })
    .strict()

  export const Recipe = z
    .object({
      schemaVersion: z.literal(1),
      id: z.string().regex(/^[a-z][a-z0-9-]*-official-v1$/),
      benchmark: HarnessBenchmark.Id,
      maturity: z.literal("source_verified"),
      environment: z
        .object({
          manager: z.enum(["uv", "pip", "hatch", "setuptools", "conda"]),
          python: z.string().min(1).max(100),
          files: z.array(Rel).min(1).max(16),
        })
        .strict(),
      anchors: z.array(Rel).min(1).max(32),
      bindings: z.array(Binding).max(32),
      stages: z.array(Stage).min(1).max(16),
      launchStage: z.string().regex(/^[a-z][a-z0-9-]*$/),
      artifacts: z.array(Artifact).min(1).max(32),
      metrics: z.array(Metric).min(1).max(32),
      limitations: z.array(z.string().min(1).max(1_000)).min(1).max(16),
    })
    .strict()
    .superRefine((value, ctx) => {
      const names = value.bindings.map((item) => item.name)
      const stages = value.stages.map((item) => item.id)
      const artifacts = value.artifacts.map((item) => item.id)
      const fields = value.stages
        .flatMap((stage) => [
          ...(stage.driver.kind === "argv" ? [stage.driver.entrypoint, stage.driver.cwd, ...stage.driver.argv] : []),
          ...(stage.driver.kind === "python_api" ? Object.values(stage.driver.kwargs) : []),
          ...stage.inputs,
          ...stage.outputs,
        ])
        .concat(value.artifacts.flatMap((item) => (item.kind === "file" ? [item.path] : [])))
      const used = fields.flatMap((field) => [...field.matchAll(/\{([a-z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]!))
      if (new Set(names).size !== names.length) {
        ctx.addIssue({ code: "custom", path: ["bindings"], message: "Recipe bindings must be unique" })
      }
      if (new Set(stages).size !== stages.length) {
        ctx.addIssue({ code: "custom", path: ["stages"], message: "Recipe stages must be unique" })
      }
      if (!stages.includes(value.launchStage)) {
        ctx.addIssue({ code: "custom", path: ["launchStage"], message: "Launch stage does not exist" })
      }
      if (new Set(artifacts).size !== artifacts.length) {
        ctx.addIssue({ code: "custom", path: ["artifacts"], message: "Recipe artifacts must be unique" })
      }
      for (const item of value.artifacts) {
        const index = stages.indexOf(item.producedBy)
        if (index < 0) {
          ctx.addIssue({ code: "custom", path: ["artifacts"], message: `Artifact ${item.id} has no producer stage` })
          continue
        }
        if (item.kind === "return" && value.stages[index]?.driver.kind !== "python_api") {
          ctx.addIssue({
            code: "custom",
            path: ["artifacts"],
            message: `Return artifact ${item.id} must come from a Python API stage`,
          })
        }
      }
      for (const item of value.metrics) {
        if (artifacts.includes(item.artifact)) continue
        ctx.addIssue({ code: "custom", path: ["metrics"], message: `Metric ${item.name} has no source artifact` })
      }
      for (const name of used) {
        if (names.includes(name)) continue
        ctx.addIssue({ code: "custom", path: ["bindings"], message: `Recipe uses undeclared binding ${name}` })
      }
    })
  export type Recipe = z.infer<typeof Recipe>

  export const Selection = z
    .object({
      recipeID: z.string().regex(/^[a-z][a-z0-9-]*-official-v1$/),
      bindings: z.record(Name, z.string().min(1).max(2_048)),
    })
    .strict()
  export type Selection = z.infer<typeof Selection>

  export const Materialized = z
    .object({
      schemaVersion: z.literal(1),
      recipeID: z.string().regex(/^[a-z][a-z0-9-]*-official-v1$/),
      benchmark: HarnessBenchmark.Id,
      recipeSHA256: Hash,
      bindingsSHA256: Hash,
      driverSHA256: Hash,
      entrypoint: Rel,
      bindings: z.record(Name, z.string().min(1).max(2_048)),
      environment: Recipe.shape.environment,
      anchors: Recipe.shape.anchors,
      stages: z.array(Stage).min(1).max(16),
      launchStage: z.string().regex(/^[a-z][a-z0-9-]*$/),
      artifacts: z.array(Artifact).min(1).max(32),
      metrics: z.array(Metric).min(1).max(32),
      limitations: Recipe.shape.limitations,
    })
    .strict()
  export type Materialized = z.infer<typeof Materialized>

  const recipe = (input: z.input<typeof Recipe>) => Recipe.parse(input)

  export const catalog = {
    bixbench: recipe({
      schemaVersion: 1,
      id: "bixbench-official-v1",
      benchmark: "bixbench",
      maturity: "source_verified",
      environment: { manager: "uv", python: ">=3.12", files: ["pyproject.toml", "uv.lock"] },
      anchors: [
        "bixbench/generate_trajectories.py",
        "bixbench/postprocessing.py",
        "bixbench/models.py",
        "bixbench/run_configuration/v1.5_paper_results.yaml",
      ],
      bindings: [
        {
          name: "config",
          kind: "path",
          description: "BixBench trajectory-generation YAML",
          required: false,
          default: "bixbench/run_configuration/4o_no_image.yaml",
        },
        {
          name: "replica",
          kind: "integer",
          description: "Explicit replica index",
          required: false,
          default: "0",
          minimum: 0,
          maximum: 100,
        },
        {
          name: "postprocessConfig",
          kind: "path",
          description: "BixBench postprocessing YAML",
          required: false,
          default: "bixbench/run_configuration/v1.5_paper_results.yaml",
        },
        {
          name: "evalArtifact",
          kind: "path",
          description: "Evaluator-owned postprocessed result table",
          required: false,
          default: "bixbench-v1.5_results/eval_df.csv",
        },
      ],
      stages: [
        {
          id: "generate",
          role: "execute",
          driver: {
            kind: "argv",
            entrypoint: "bixbench/generate_trajectories.py",
            cwd: ".",
            argv: [
              "python",
              "bixbench/generate_trajectories.py",
              "--config_file",
              "{config}",
              "--replica_id",
              "{replica}",
            ],
          },
          inputs: ["{config}"],
          outputs: ["bixbench-v1.5_results/trajectories"],
          environment: [],
        },
        {
          id: "postprocess",
          role: "evaluate",
          driver: {
            kind: "argv",
            entrypoint: "bixbench/postprocessing.py",
            cwd: ".",
            argv: ["python", "bixbench/postprocessing.py", "--config_file", "{postprocessConfig}"],
          },
          inputs: ["{postprocessConfig}", "bixbench-v1.5_results/trajectories"],
          outputs: ["{evalArtifact}"],
          environment: [],
        },
      ],
      launchStage: "generate",
      artifacts: [
        {
          id: "evaluations",
          kind: "file",
          path: "{evalArtifact}",
          format: "csv",
          producedBy: "postprocess",
          owner: "evaluator",
        },
      ],
      metrics: [
        {
          name: "accuracy",
          artifact: "evaluations",
          selector: "column:correct",
          direction: "maximize",
          aggregation: "mean",
        },
      ],
      limitations: [
        "The upstream batch shell script uses an inclusive replica loop; this recipe binds one explicit replica per launch.",
        "Open-answer grading can invoke a configured grading model and must remain evaluator-owned.",
      ],
    }),
    biomni: recipe({
      schemaVersion: 1,
      id: "biomni-official-v1",
      benchmark: "biomni",
      maturity: "source_verified",
      environment: { manager: "setuptools", python: ">=3.11", files: ["pyproject.toml"] },
      anchors: ["README.md", "pyproject.toml", "biomni/eval/biomni_eval1.py"],
      bindings: [],
      stages: [
        {
          id: "load",
          role: "prepare",
          driver: {
            kind: "python_api",
            entrypoint: "biomni/eval/biomni_eval1.py",
            module: "biomni.eval",
            symbol: "BiomniEval1",
            kwargs: {},
            runtimeInputs: [],
          },
          inputs: [],
          outputs: [],
          environment: [],
        },
        {
          id: "evaluate",
          role: "evaluate",
          driver: {
            kind: "python_api",
            entrypoint: "biomni/eval/biomni_eval1.py",
            module: "biomni.eval",
            symbol: "BiomniEval1.batch_evaluate",
            kwargs: {},
            runtimeInputs: ["evaluator", "evaluations"],
          },
          inputs: [],
          outputs: [],
          environment: [],
        },
      ],
      launchStage: "evaluate",
      artifacts: [
        {
          id: "rewards",
          kind: "return",
          format: "json",
          producedBy: "evaluate",
          owner: "evaluator",
        },
      ],
      metrics: [
        {
          name: "mean-reward",
          artifact: "rewards",
          selector: "$[*]",
          direction: "maximize",
          aggregation: "mean",
        },
      ],
      limitations: [
        "Biomni-Eval1 returns a list of rewards instead of writing a score file; the evaluator must canonically serialize the return value before hashing its receipt.",
        "The pinned pyproject omits pandas and a parquet engine used by the evaluator, so launch readiness must bind a tested environment extension instead of assuming installation is complete.",
        "The public Hugging Face parquet contains reference answers, so held-out claims require evaluator-only dataset access despite the official loader's public default.",
      ],
    }),
    pde: recipe({
      schemaVersion: 1,
      id: "pdebench-official-v1",
      benchmark: "pde",
      maturity: "source_verified",
      environment: { manager: "hatch", python: ">=3.9,<3.11", files: ["pyproject.toml"] },
      anchors: [
        "pdebench/models/train_models_forward.py",
        "pdebench/models/metrics.py",
        "pdebench/models/run_forward_1D.sh",
        "pdebench/models/config/args/config_Adv.yaml",
      ],
      bindings: [
        {
          name: "dataRoot",
          kind: "path",
          description: "Prepared dataset directory relative to pdebench/models",
        },
        {
          name: "datasetStem",
          kind: "choice",
          description: "Official one-dimensional advection dataset stem",
          choices: [
            "1D_Advection_Sols_beta0.1",
            "1D_Advection_Sols_beta0.4",
            "1D_Advection_Sols_beta1.0",
            "1D_Advection_Sols_beta4.0",
          ],
        },
      ],
      stages: [
        {
          id: "evaluate",
          role: "evaluate",
          driver: {
            kind: "argv",
            entrypoint: "pdebench/models/train_models_forward.py",
            cwd: "pdebench/models",
            argv: [
              "python3",
              "train_models_forward.py",
              "+args=config_Adv.yaml",
              "++args.data_path={dataRoot}",
              "++args.filename={datasetStem}.hdf5",
              "++args.model_name=FNO",
              "++args.if_training=False",
            ],
          },
          inputs: ["pdebench/models/{dataRoot}/{datasetStem}.hdf5", "pdebench/models/{datasetStem}_FNO.pt"],
          outputs: ["pdebench/models/{datasetStem}_FNO.pickle", "pdebench/models/{datasetStem}_FNOmse_time.npz"],
          environment: ["CUDA_VISIBLE_DEVICES"],
        },
      ],
      launchStage: "evaluate",
      artifacts: [
        {
          id: "errors",
          kind: "file",
          path: "pdebench/models/{datasetStem}_FNO.pickle",
          format: "pickle",
          producedBy: "evaluate",
          owner: "evaluator",
        },
      ],
      metrics: [
        { name: "rmse", artifact: "errors", selector: "tuple[0]", direction: "minimize", aggregation: "mean" },
        {
          name: "normalized-rmse",
          artifact: "errors",
          selector: "tuple[1]",
          direction: "minimize",
          aggregation: "mean",
        },
        {
          name: "conserved-variable-error",
          artifact: "errors",
          selector: "tuple[2]",
          direction: "minimize",
          aggregation: "mean",
        },
        { name: "maximum-error", artifact: "errors", selector: "tuple[3]", direction: "minimize", aggregation: "mean" },
        {
          name: "boundary-error",
          artifact: "errors",
          selector: "tuple[4]",
          direction: "minimize",
          aggregation: "mean",
        },
        {
          name: "fourier-band-error",
          artifact: "errors",
          selector: "tuple[5]",
          direction: "minimize",
          aggregation: "mean",
        },
      ],
      limitations: [
        "The official evaluator emits a Python pickle tuple; the evaluator must deserialize it in a trusted environment.",
        "This verified recipe intentionally covers the official one-dimensional advection FNO path; other PDE families and model types remain pending source verification.",
        "Dataset and checkpoint bytes remain task-specific launch inputs and require the launch receipt hashes.",
      ],
    }),
    chembench: recipe({
      schemaVersion: 1,
      id: "chembench-official-v1",
      benchmark: "chembench",
      maturity: "source_verified",
      environment: { manager: "setuptools", python: ">=3.10", files: ["pyproject.toml"] },
      anchors: ["src/chembench/evaluate.py", "src/chembench/metrics.py", "src/chembench/task.py"],
      bindings: [
        {
          name: "dataset",
          kind: "identifier",
          description: "Hugging Face dataset identifier",
          required: false,
          default: "jablonkagroup/ChemBench",
        },
        {
          name: "reportDir",
          kind: "path",
          description: "Evaluator-owned report directory",
          required: false,
          default: "reports",
        },
        { name: "runID", kind: "identifier", description: "Immutable evaluation run identifier" },
        {
          name: "batchSize",
          kind: "integer",
          description: "Official evaluator batch size",
          required: false,
          default: "8",
          minimum: 1,
          maximum: 1024,
        },
      ],
      stages: [
        {
          id: "load",
          role: "prepare",
          driver: {
            kind: "python_api",
            entrypoint: "src/chembench/evaluate.py",
            module: "chembench.evaluate",
            symbol: "ChemBenchmark.from_huggingface",
            kwargs: { dataset_name: "{dataset}", report_dir: "{reportDir}", run_id: "{runID}" },
            runtimeInputs: [],
          },
          inputs: [],
          outputs: ["{reportDir}"],
          environment: [],
        },
        {
          id: "evaluate",
          role: "evaluate",
          driver: {
            kind: "python_api",
            entrypoint: "src/chembench/evaluate.py",
            module: "chembench.evaluate",
            symbol: "ChemBenchmark.bench",
            kwargs: { batch_size: "{batchSize}" },
            runtimeInputs: ["prompter", "modelKwargs"],
          },
          inputs: ["{reportDir}"],
          outputs: ["{reportDir}/submission_results.json"],
          environment: [],
        },
        {
          id: "submit",
          role: "aggregate",
          driver: {
            kind: "python_api",
            entrypoint: "src/chembench/evaluate.py",
            module: "chembench.evaluate",
            symbol: "ChemBenchmark.submit",
            kwargs: { submission_path: "{reportDir}/submission_results.json" },
            runtimeInputs: ["results"],
          },
          inputs: ["{reportDir}"],
          outputs: ["{reportDir}/submission_results.json"],
          environment: [],
        },
      ],
      launchStage: "evaluate",
      artifacts: [
        {
          id: "submission",
          kind: "file",
          path: "{reportDir}/submission_results.json",
          format: "json",
          producedBy: "submit",
          owner: "evaluator",
        },
      ],
      metrics: [
        {
          name: "all-correct",
          artifact: "submission",
          selector: "$[*].results[0].metrics.all_correct",
          direction: "maximize",
          aggregation: "mean",
        },
      ],
      limitations: [
        "ChemBench exposes a Python API, not a benchmark grading CLI; callers must preserve the declared runtime object inputs.",
        "Leaderboard submission remains a separate manual action and is never performed by the harness recipe.",
      ],
    }),
    matscibench: recipe({
      schemaVersion: 1,
      id: "matscibench-official-v1",
      benchmark: "matscibench",
      maturity: "source_verified",
      environment: { manager: "conda", python: "3.12.9", files: ["environment.yml"] },
      anchors: [
        "environment.yml",
        "evaluation/eval.py",
        "evaluation/auto_judge.py",
        "evaluation/model_registry.py",
        "evaluation/rule_judge.py",
        "utils/eval_data.py",
      ],
      bindings: [
        {
          name: "method",
          kind: "choice",
          description: "Official MatSciBench prompting method",
          required: false,
          default: "base",
          choices: ["base", "tool", "correction", "consistency"],
        },
        { name: "outputDir", kind: "path", description: "Evaluator-owned CSV output directory" },
        {
          name: "workers",
          kind: "integer",
          description: "Parallel model request count",
          required: false,
          default: "8",
          minimum: 1,
          maximum: 128,
        },
        {
          name: "maxTokens",
          kind: "integer",
          description: "Maximum generated tokens per question",
          required: false,
          default: "8192",
          minimum: 1,
          maximum: 131072,
        },
      ],
      stages: [
        {
          id: "evaluate",
          role: "evaluate",
          driver: {
            kind: "argv",
            entrypoint: "evaluation/eval.py",
            cwd: ".",
            argv: [
              "python",
              "evaluation/eval.py",
              "--model",
              "gemini-2.5-flash",
              "--method",
              "{method}",
              "--max_tokens",
              "{maxTokens}",
              "--num_workers",
              "{workers}",
              "--output_dir",
              "{outputDir}",
            ],
          },
          inputs: [],
          outputs: ["{outputDir}/gemini-2.5-flash_{method}_*.csv"],
          environment: ["GEMINI_API_KEY"],
        },
      ],
      launchStage: "evaluate",
      artifacts: [
        {
          id: "decisions",
          kind: "file",
          path: "{outputDir}/gemini-2.5-flash_{method}_*.csv",
          format: "csv",
          producedBy: "evaluate",
          owner: "evaluator",
        },
      ],
      metrics: [
        {
          name: "accuracy",
          artifact: "decisions",
          selector: "column:is_correct",
          direction: "maximize",
          aggregation: "mean",
        },
        {
          name: "rule-accuracy",
          artifact: "decisions",
          selector: "column:rule_is_correct",
          direction: "maximize",
          aggregation: "mean",
        },
      ],
      limitations: [
        "This verified slice fixes the registry key to the official default gemini-2.5-flash so its required secret and output filename are deterministic.",
        "The timestamped output glob must resolve to exactly one newly created CSV, and the model/judge calls require evaluator-owned network credentials.",
      ],
    }),
    mle: recipe({
      schemaVersion: 1,
      id: "mlebench-official-v1",
      benchmark: "mle",
      maturity: "source_verified",
      environment: { manager: "setuptools", python: ">=3.11", files: ["pyproject.toml"] },
      anchors: [
        "mlebench/cli.py",
        "mlebench/grade.py",
        "mlebench/grade_helpers.py",
        "experiments/aggregate_grading_reports.py",
      ],
      bindings: [
        { name: "competitionList", kind: "path", description: "Evaluator-owned list of competition IDs" },
        { name: "dataDir", kind: "path", description: "Prepared immutable MLE-bench data root" },
        { name: "submissionManifest", kind: "path", description: "JSONL mapping competition IDs to submission CSVs" },
        { name: "outputDir", kind: "path", description: "Evaluator-owned grading report directory" },
      ],
      stages: [
        {
          id: "prepare",
          role: "prepare",
          driver: {
            kind: "argv",
            entrypoint: "mlebench/cli.py",
            cwd: ".",
            argv: ["mlebench", "prepare", "--list", "{competitionList}", "--data-dir", "{dataDir}"],
          },
          inputs: ["{competitionList}"],
          outputs: ["{dataDir}"],
          environment: ["KAGGLE_USERNAME", "KAGGLE_KEY"],
        },
        {
          id: "grade",
          role: "evaluate",
          driver: {
            kind: "argv",
            entrypoint: "mlebench/cli.py",
            cwd: ".",
            argv: [
              "mlebench",
              "grade",
              "--submission",
              "{submissionManifest}",
              "--output-dir",
              "{outputDir}",
              "--data-dir",
              "{dataDir}",
            ],
          },
          inputs: ["{submissionManifest}", "{dataDir}"],
          outputs: ["{outputDir}/*_grading_report.json"],
          environment: [],
        },
      ],
      launchStage: "grade",
      artifacts: [
        {
          id: "grading-report",
          kind: "file",
          path: "{outputDir}/*_grading_report.json",
          format: "json",
          producedBy: "grade",
          owner: "evaluator",
        },
      ],
      metrics: [
        {
          name: "total-medals",
          artifact: "grading-report",
          selector: "$.total_medals",
          direction: "maximize",
          aggregation: "identity",
        },
        {
          name: "above-median",
          artifact: "grading-report",
          selector: "$.total_above_median",
          direction: "maximize",
          aggregation: "identity",
        },
        {
          name: "valid-submissions",
          artifact: "grading-report",
          selector: "$.total_valid_submissions",
          direction: "maximize",
          aggregation: "identity",
        },
      ],
      limitations: [
        "Preparing all competitions requires Kaggle access and can take multiple days; task lists and data bytes must be frozen before launch.",
        "The primary report counts medals and above-median submissions; cross-seed confidence intervals require the official aggregation script.",
      ],
    }),
    ale: recipe({
      schemaVersion: 1,
      id: "alebench-official-v1",
      benchmark: "ale",
      maturity: "source_verified",
      environment: { manager: "uv", python: ">=3.10,<3.15", files: ["pyproject.toml", "uv.lock"] },
      anchors: [
        "pyproject.toml",
        "uv.lock",
        "src/ale_bench_eval/__main__.py",
        "src/ale_bench_eval/evaluate.py",
        "src/ale_bench_eval/logger.py",
        "scripts/run_eval.sh",
      ],
      bindings: [
        { name: "configName", kind: "identifier", description: "Model configuration basename in llm_configs" },
        { name: "rootPath", kind: "path", description: "Evaluator-owned deterministic result root" },
        {
          name: "judgeVersion",
          kind: "choice",
          description: "Official AtCoder judge version",
          required: false,
          default: "202301",
          choices: ["201907", "202301", "202510"],
        },
      ],
      stages: [
        {
          id: "evaluate",
          role: "evaluate",
          driver: {
            kind: "argv",
            entrypoint: "scripts/run_eval.sh",
            cwd: ".",
            argv: [
              "bash",
              "scripts/run_eval.sh",
              "--root_path",
              "{rootPath}",
              "--judge_version",
              "{judgeVersion}",
              "{configName}",
            ],
          },
          inputs: ["llm_configs/{configName}.json"],
          outputs: ["{rootPath}/*/results/final_results.json", "{rootPath}/*/results/total_cost.json"],
          environment: [],
        },
      ],
      launchStage: "evaluate",
      artifacts: [
        {
          id: "results",
          kind: "file",
          path: "{rootPath}/*/results/final_results.json",
          format: "json",
          producedBy: "evaluate",
          owner: "evaluator",
        },
        {
          id: "costs",
          kind: "file",
          path: "{rootPath}/*/results/total_cost.json",
          format: "json",
          producedBy: "evaluate",
          owner: "evaluator",
        },
      ],
      metrics: [
        {
          name: "performance",
          artifact: "results",
          selector: "$.self_refine_16.performance",
          direction: "maximize",
          aggregation: "mean",
        },
        {
          name: "rank",
          artifact: "results",
          selector: "$.self_refine_16.rank",
          direction: "minimize",
          aggregation: "mean",
        },
        {
          name: "total-cost",
          artifact: "costs",
          selector: "$.self_refine_16.total_cost",
          direction: "minimize",
          aggregation: "sum",
        },
      ],
      limitations: [
        "The official shell fixes repeated sampling to 15, self-refinement to 16, public cases to 50, and median selection; those benchmark semantics are not exposed as mutable bindings.",
        "The model config selects its provider credential and ALE private evaluation requires Docker; both remain evaluator-owned launch inputs.",
      ],
    }),
    researchclaw: recipe({
      schemaVersion: 1,
      id: "researchclawbench-official-v1",
      benchmark: "researchclaw",
      maturity: "source_verified",
      environment: { manager: "pip", python: ">=3.10", files: ["evaluation/requirements.txt"] },
      anchors: ["evaluation/cli_eval.py", "evaluation/run_task.py", "evaluation/score.py", "evaluation/config.py"],
      bindings: [{ name: "config", kind: "path", description: "Frozen ResearchClawBench batch-evaluation YAML" }],
      stages: [
        {
          id: "preflight",
          role: "prepare",
          driver: {
            kind: "argv",
            entrypoint: "evaluation/cli_eval.py",
            cwd: ".",
            argv: [
              "python3",
              "-m",
              "evaluation.cli_eval",
              "{config}",
              "--dry-run",
              "--skip-secret-check",
              "--no-score",
            ],
          },
          inputs: ["{config}", "tasks"],
          outputs: [],
          environment: [],
        },
        {
          id: "run",
          role: "execute",
          driver: {
            kind: "argv",
            entrypoint: "evaluation/cli_eval.py",
            cwd: ".",
            argv: ["python3", "-m", "evaluation.cli_eval", "{config}"],
          },
          inputs: ["{config}", "tasks"],
          outputs: ["workspaces/cli_runs/cli_*"],
          environment: [
            "AGENT_MODEL_NAME",
            "AGENT_API_BASE",
            "AGENT_API_KEY",
            "JUDGE_MODEL_NAME",
            "JUDGE_API_BASE",
            "JUDGE_API_KEY",
          ],
        },
        {
          id: "score",
          role: "evaluate",
          driver: {
            kind: "python_api",
            entrypoint: "evaluation/score.py",
            module: "evaluation.score",
            symbol: "score_workspace",
            kwargs: {},
            runtimeInputs: ["workspace"],
          },
          inputs: ["workspaces/cli_runs/cli_*"],
          outputs: ["workspaces/cli_runs/cli_*/*/_score.json"],
          environment: ["JUDGE_MODEL_NAME", "JUDGE_API_BASE", "JUDGE_API_KEY"],
        },
      ],
      launchStage: "run",
      artifacts: [
        {
          id: "score",
          kind: "file",
          path: "workspaces/cli_runs/cli_*/*/_score.json",
          format: "json",
          producedBy: "score",
          owner: "evaluator",
        },
      ],
      metrics: [
        {
          name: "total-score",
          artifact: "score",
          selector: "$.total_score",
          direction: "maximize",
          aggregation: "mean",
        },
      ],
      limitations: [
        "The official score is a multimodal judge output; judge identity, prompt, and evaluator qualification must remain contract-bound.",
        "Agent and judge credentials are distinct runtime secrets and are never included in recipe bindings or digests.",
      ],
    }),
    paperbench: recipe({
      schemaVersion: 1,
      id: "paperbench-official-v1",
      benchmark: "paperbench",
      maturity: "source_verified",
      environment: {
        manager: "uv",
        python: ">=3.11",
        files: ["project/paperbench/pyproject.toml", "project/paperbench/uv.lock"],
      },
      anchors: [
        "project/paperbench/README.md",
        "project/paperbench/paperbench/grade.py",
        "project/paperbench/paperbench/paper_registry.py",
        "project/paperbench/paperbench/scripts/run_judge.py",
      ],
      bindings: [
        { name: "submissionDir", kind: "path", description: "Executed submission directory" },
        {
          name: "paperID",
          kind: "choice",
          description: "PaperBench paper identifier",
          choices: [
            "adaptive-pruning",
            "all-in-one",
            "bam",
            "bbox",
            "bridging-data-gaps",
            "fre",
            "ftrl",
            "lbcs",
            "lca-on-the-line",
            "mechanistic-understanding",
            "pinn",
            "rice",
            "robust-clip",
            "sample-specific-masks",
            "sapg",
            "self-composing-policies",
            "self-expansion",
            "semantic-self-consistency",
            "sequential-neural-score-estimation",
            "stay-on-topic-with-classifier-free-guidance",
            "stochastic-interpolants",
            "test-time-model-adaptation",
            "what-will-my-model-forget",
          ],
        },
        { name: "outputDir", kind: "path", description: "Evaluator-owned judge output directory" },
        {
          name: "judgeModel",
          kind: "identifier",
          description: "SimpleJudge completion model identifier",
          required: false,
          default: "gpt-4.1-mini",
        },
        {
          name: "maxDepth",
          kind: "integer",
          description: "Maximum rubric-tree grading depth",
          required: false,
          default: "999",
          minimum: 1,
          maximum: 999,
        },
      ],
      stages: [
        {
          id: "grade",
          role: "evaluate",
          driver: {
            kind: "argv",
            entrypoint: "project/paperbench/paperbench/scripts/run_judge.py",
            cwd: "project/paperbench",
            argv: [
              "uv",
              "run",
              "python",
              "-m",
              "paperbench.scripts.run_judge",
              "submission-path={submissionDir}",
              "paper-id={paperID}",
              "judge=simple",
              "max-depth={maxDepth}",
              "out-dir={outputDir}",
              "completer-config=preparedness_turn_completer.oai_completions_turn_completer:OpenAICompletionsTurnCompleter.Config",
              "completer-config.model={judgeModel}",
            ],
          },
          inputs: ["project/paperbench/{submissionDir}", "project/paperbench/data/papers/{paperID}/rubric.json"],
          outputs: ["project/paperbench/{outputDir}/grader_output.json"],
          environment: ["GRADER_OPENAI_API_KEY"],
        },
      ],
      launchStage: "grade",
      artifacts: [
        {
          id: "grade",
          kind: "file",
          path: "project/paperbench/{outputDir}/grader_output.json",
          format: "json",
          producedBy: "grade",
          owner: "evaluator",
        },
      ],
      metrics: [
        { name: "score", artifact: "grade", selector: "$.score", direction: "maximize", aggregation: "identity" },
        {
          name: "invalid-leaves",
          artifact: "grade",
          selector: "$.num_invalid_leaf_nodes",
          direction: "minimize",
          aggregation: "identity",
        },
      ],
      limitations: [
        "This recipe covers the official rubric-grading stage for an already executed submission; PaperBench rollout and GPU reproduction remain separately contract-bound stages.",
        "SimpleJudge requires an evaluator-owned completion model and key, and its validity must be established with the official JudgeEval suite.",
      ],
    }),
    scicode: recipe({
      schemaVersion: 1,
      id: "scicode-official-v1",
      benchmark: "scicode",
      maturity: "source_verified",
      environment: { manager: "setuptools", python: ">=3.10", files: ["pyproject.toml"] },
      anchors: [
        "pyproject.toml",
        "src/scicode/parse/parse.py",
        "eval/scripts/README.md",
        "eval/scripts/test_generated_code.py",
      ],
      bindings: [
        { name: "codeDir", kind: "path", description: "Parent directory containing generated code" },
        { name: "logDir", kind: "path", description: "Evaluator-owned per-step log directory" },
        { name: "outputDir", kind: "path", description: "Evaluator-owned aggregate output directory" },
        {
          name: "split",
          kind: "choice",
          description: "Official SciCode dataset split",
          required: false,
          default: "test",
          choices: ["validation", "test"],
        },
      ],
      stages: [
        {
          id: "evaluate",
          role: "evaluate",
          driver: {
            kind: "argv",
            entrypoint: "eval/scripts/test_generated_code.py",
            cwd: ".",
            argv: [
              "python",
              "eval/scripts/test_generated_code.py",
              "--model",
              "openscience",
              "--split",
              "{split}",
              "--code-dir",
              "{codeDir}",
              "--log-dir",
              "{logDir}",
              "--output-dir",
              "{outputDir}",
            ],
          },
          inputs: ["{codeDir}/openscience/without_background", "eval/data/test_data.h5"],
          outputs: [
            "{outputDir}/openscience_without_background.txt",
            "{outputDir}/openscience_without_background.json",
          ],
          environment: [],
        },
      ],
      launchStage: "evaluate",
      artifacts: [
        {
          id: "summary",
          kind: "file",
          path: "{outputDir}/openscience_without_background.txt",
          format: "text",
          producedBy: "evaluate",
          owner: "evaluator",
        },
        {
          id: "steps",
          kind: "file",
          path: "{outputDir}/openscience_without_background.json",
          format: "json",
          producedBy: "evaluate",
          owner: "evaluator",
        },
      ],
      metrics: [
        {
          name: "problem-pass-rate",
          artifact: "summary",
          selector: "line:correct problems",
          direction: "maximize",
          aggregation: "identity",
        },
        {
          name: "step-pass-rate",
          artifact: "summary",
          selector: "line:correct steps",
          direction: "maximize",
          aggregation: "identity",
        },
      ],
      limitations: [
        "The official evaluator requires the separately distributed eval/data/test_data.h5 numeric targets and downloads task metadata from SciCode1/SciCode.",
        "The fixed openscience label is only a directory key; measured model identity must come from the runtime-integrity receipt rather than this filename.",
      ],
    }),
  } satisfies Partial<Record<HarnessBenchmark.Id, Recipe>>

  export type Verified = keyof typeof catalog

  const replace = (value: string, bindings: Record<string, string>) =>
    value.replace(/\{([a-z][a-zA-Z0-9]*)\}/g, (_, name: string) => bindings[name]!)

  const validate = (binding: Binding, value: string) => {
    if (value.includes("\0")) throw new Error(`Recipe binding ${binding.name} contains a null byte`)
    if (binding.kind === "path") {
      if (path.posix.isAbsolute(value) || value.split("/").includes("..") || value.includes("\\")) {
        throw new Error(`Recipe binding ${binding.name} must be a checkout-relative POSIX path`)
      }
      return value
    }
    if (binding.kind === "identifier") {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)) {
        throw new Error(`Recipe binding ${binding.name} is not a valid identifier`)
      }
      return value
    }
    if (binding.kind === "choice") {
      if (!binding.choices?.includes(value)) throw new Error(`Recipe binding ${binding.name} is not an allowed choice`)
      return value
    }
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Recipe binding ${binding.name} must be an integer`)
    const number = Number(value)
    if (binding.minimum !== undefined && number < binding.minimum) {
      throw new Error(`Recipe binding ${binding.name} is below its minimum`)
    }
    if (binding.maximum !== undefined && number > binding.maximum) {
      throw new Error(`Recipe binding ${binding.name} exceeds its maximum`)
    }
    return value
  }

  export function resolve(benchmark: string) {
    const id = HarnessBenchmark.resolve(benchmark).id
    const result = catalog[id as Verified]
    if (!result) throw new Error(`No source-verified execution recipe exists for ${id}`)
    return result
  }

  export function materialize(benchmark: string, input: Selection) {
    const selection = Selection.parse(input)
    const source = resolve(benchmark)
    if (selection.recipeID !== source.id)
      throw new Error(`Execution recipe does not match benchmark ${source.benchmark}`)
    const names = source.bindings.map((item) => item.name)
    const extra = Object.keys(selection.bindings).filter((name) => !names.includes(name))
    if (extra.length) throw new Error(`Execution recipe received undeclared bindings: ${extra.toSorted().join(", ")}`)
    const bindings = Object.fromEntries(
      source.bindings.map((item) => {
        const value = selection.bindings[item.name] ?? item.default
        if (value === undefined) throw new Error(`Execution recipe is missing binding ${item.name}`)
        return [item.name, validate(item, value)]
      }),
    )
    const stages = source.stages.map((stage) =>
      Stage.parse({
        ...stage,
        driver:
          stage.driver.kind === "argv"
            ? {
                ...stage.driver,
                entrypoint: replace(stage.driver.entrypoint, bindings),
                cwd: replace(stage.driver.cwd, bindings),
                argv: stage.driver.argv.map((item) => replace(item, bindings)),
              }
            : {
                ...stage.driver,
                kwargs: Object.fromEntries(
                  Object.entries(stage.driver.kwargs).map(([key, value]) => [key, replace(value, bindings)]),
                ),
              },
        inputs: stage.inputs.map((item) => replace(item, bindings)),
        outputs: stage.outputs.map((item) => replace(item, bindings)),
      }),
    )
    const launch = stages.find((stage) => stage.id === source.launchStage)!
    return Materialized.parse({
      schemaVersion: 1,
      recipeID: source.id,
      benchmark: source.benchmark,
      recipeSHA256: digest(source),
      bindingsSHA256: digest(bindings),
      driverSHA256: digest(launch.driver),
      entrypoint: launch.driver.entrypoint,
      bindings,
      environment: source.environment,
      anchors: source.anchors,
      stages,
      launchStage: source.launchStage,
      artifacts: source.artifacts.map((item) =>
        Artifact.parse(item.kind === "file" ? { ...item, path: replace(item.path, bindings) } : item),
      ),
      metrics: source.metrics,
      limitations: source.limitations,
    })
  }
}
