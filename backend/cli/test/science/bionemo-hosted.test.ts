import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { BioNemoHostedDispatch } from "../../src/science/bionemo/dispatch"
import { Global } from "../../src/global"

describe("hosted BioNeMo adapters", () => {
  test("uses bounded provider-aware polling backoff without tight-looping missing headers", async () => {
    const { retryAfterMilliseconds } = await import("../../src/science/bionemo/polling")
    const now = Date.parse("2026-08-28T12:00:00.000Z")
    expect(retryAfterMilliseconds(new Headers(), 0, now)).toBe(250)
    expect(retryAfterMilliseconds(new Headers({ "retry-after": "invalid" }), 1, now)).toBe(500)
    expect(retryAfterMilliseconds(new Headers({ "retry-after": "0.75" }), 0, now)).toBe(750)
    expect(retryAfterMilliseconds(new Headers({ "retry-after": "30" }), 0, now)).toBe(2_000)
    expect(retryAfterMilliseconds(new Headers({ "retry-after": "Fri, 28 Aug 2026 12:00:01 GMT" }), 0, now)).toBe(1_000)
    expect(retryAfterMilliseconds(new Headers({ "retry-after": "Fri, 28 Aug 2026 12:01:00 GMT" }), 0, now)).toBe(2_000)
  })

  test("publishes strict specs and request schemas for all ten hosted adapters", async () => {
    const { BioNemoHosted } = await import("../../src/science/bionemo/client")
    const { parseBioNemoInput } = await import("../../src/science/bionemo/schema")
    const versions = {
      boltz2: "api-schema-1.5.0",
      diffdock: "api-schema-2.3.0",
      evo2: "api-schema-1.0.0",
      genmol: "api-schema-1.0.0",
      molmim: "api-schema-0.0.1",
      "msa-search": "api-schema-1.2.0",
      openfold2: "api-schema-2.1.0",
      openfold3: "api-schema-1.0.0",
      proteinmpnn: "api-schema-1.1.0",
      rfdiffusion: "api-schema-2.3.0",
    } as const
    const cases = [
      [
        "boltz2",
        "https://health.api.nvidia.com/v1/biology/mit/boltz2/predict",
        { polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKK" }] },
      ],
      [
        "diffdock",
        "https://health.api.nvidia.com/v1/molecular-docking/diffdock/generate",
        { protein: "ATOM", ligand: "CCO", ligand_file_type: "txt" },
      ],
      ["evo2", "https://health.api.nvidia.com/v1/biology/arc/evo2-40b/generate", { sequence: "ACGTACGT" }],
      [
        "genmol",
        "https://health.api.nvidia.com/v1/biology/nvidia/genmol/generate",
        { smiles: "CCO", num_molecules: 2 },
      ],
      ["molmim", "https://health.api.nvidia.com/v1/biology/nvidia/molmim/generate", { smi: "CCO", num_molecules: 2 }],
      [
        "msa-search",
        "https://health.api.nvidia.com/v1/biology/colabfold/msa-search/predict",
        { sequence: "ARNDCQEGHILKMFPSTWYV" },
      ],
      [
        "openfold2",
        "https://health.api.nvidia.com/v1/biology/openfold/openfold2/predict-structure-from-msa-and-template",
        { sequence: "ARNDCQEGHILKMFPSTWYV" },
      ],
      [
        "openfold3",
        "https://health.api.nvidia.com/v1/biology/openfold/openfold3/predict",
        {
          inputs: [
            {
              molecules: [
                {
                  type: "protein",
                  sequence: "ARNDCQEGHILKMFPSTWYV",
                  msa: {
                    main: {
                      a3m: { alignment: ">query\nARNDCQEGHILKMFPSTWYV", format: "a3m" },
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
      [
        "proteinmpnn",
        "https://health.api.nvidia.com/v1/biology/ipd/proteinmpnn/predict",
        { input_pdb: "ATOM", num_seq_per_target: 1 },
      ],
      [
        "rfdiffusion",
        "https://health.api.nvidia.com/v1/biology/ipd/rfdiffusion/generate",
        { input_pdb: "HEADER    TEST\nATOM      1  CA  ALA A   1\n", contigs: "100-100" },
      ],
    ] as const
    for (const [id, endpoint, payload] of cases) {
      expect(BioNemoHosted.spec(id).endpoint).toBe(endpoint)
      expect(BioNemoHosted.spec(id).apiSchemaVersion).toBe(versions[id])
      expect(BioNemoHosted.spec(id).docs).toMatch(/^https:\/\/docs\.api\.nvidia\.com\/nim\/reference\//u)
      expect(parseBioNemoInput(id, payload)).toEqual(payload)
      const preview = await BioNemoHosted.plan(id, payload)
      expect(preview).toMatchObject({
        capability: id,
        provider: "nvidia",
        endpoint,
        api_schema_version: versions[id],
        method: "POST",
        status_endpoint_template: "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}",
        status_host: "api.nvcf.nvidia.com",
        dispatched: false,
      })
      expect(preview.request_sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(preview.approval_sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(preview).not.toHaveProperty("model_version")
    }
  })

  test("requires a bounded capability-specific terminal response for every adapter", async () => {
    const { parseBioNemoOutput } = await import("../../src/science/bionemo/schema")
    const pdb = "HEADER    TEST\nATOM      1  CA  ALA A   1      0.000   0.000   0.000\n"
    const cif = "data_test\n_atom_site.id 1\n"
    const valid = {
      boltz2: {
        structures: [{ structure: cif, format: "mmcif" }],
        confidence_scores: [0.91],
        ptm_scores: [0.8],
        complex_pde_scores: [0.2],
      },
      diffdock: { status: "success", ligand_positions: ["CCO\n$$$$\n"], position_confidence: [0.8] },
      evo2: { sequence: "ACGT", elapsed_ms: 4 },
      genmol: { status: "success", molecules: [{ smiles: "CCO", score: 0.7 }] },
      molmim: { molecules: JSON.stringify([{ sample: "CCO", score: 0.7 }]), score_type: "QED" },
      "msa-search": {
        alignments: { uniref30_2302: { a3m: { alignment: ">query\nARND\n", format: "a3m" } } },
      },
      openfold2: {
        structures_in_ranked_order: [
          { structure: pdb, format: "pdb", relaxed: false, rank_by_confidence: 1, confidence: 0.9 },
        ],
      },
      openfold3: {
        outputs: [
          {
            structures_with_scores: [
              {
                structure: "data_test\n_atom_site.id 1\n",
                format: "cif",
                confidence_score: 0.9,
                complex_plddt_score: 0.8,
                complex_pde_score: 0.2,
                ptm_score: 0.7,
                iptm_score: 0.6,
              },
            ],
          },
        ],
      },
      proteinmpnn: { mfasta: ">design_1\nARND\n", scores: [0.2] },
      rfdiffusion: { output_pdb: pdb, elapsed_ms: 12 },
    } as const
    for (const [id, response] of Object.entries(valid)) {
      expect(parseBioNemoOutput(id as keyof typeof valid, response)).toBeTruthy()
      for (const malformed of [null, {}, [], "ok", 1, { requestId: "nvcf-pending" }])
        expect(
          () => parseBioNemoOutput(id as keyof typeof valid, malformed),
          `${id}: ${JSON.stringify(malformed)}`,
        ).toThrow()
    }
    expect(() =>
      parseBioNemoOutput("boltz2", {
        structures: [
          { structure: cif, format: "mmcif" },
          { structure: cif, format: "mmcif" },
        ],
        confidence_scores: [0.9],
      }),
    ).toThrow("confidence")
    expect(() =>
      parseBioNemoOutput("boltz2", {
        structures: [{ structure: cif, format: "mmcif" }],
        confidence_scores: [0.9],
        affinities: {
          L1: {
            affinity_pic50: [6.2, 6.1],
            affinity_pred_value: [2.1],
            affinity_probability_binary: [0.94, 0.92],
          },
        },
      }),
    ).toThrow("equal lengths")
    expect(() =>
      parseBioNemoOutput("boltz2", {
        structures: [{ structure: cif, format: "pdb" }],
        confidence_scores: [0.9],
      }),
    ).toThrow()
    expect(() =>
      parseBioNemoOutput("boltz2", {
        structures: [{ structure: cif, format: "mmcif" }],
        confidence_scores: [0.9],
        ptm_scores: [0.8, 0.7],
      }),
    ).toThrow("structure count")
    const affinity = {
      affinity_pic50: [6.2],
      affinity_pred_value: [2.1],
      affinity_probability_binary: [0.94],
    }
    expect(() =>
      parseBioNemoOutput("boltz2", {
        structures: [{ structure: cif, format: "mmcif" }],
        confidence_scores: [0.9],
        affinities: { L1: affinity, L2: affinity },
      }),
    ).toThrow("Only one affinity ligand")
    expect(() =>
      parseBioNemoOutput("boltz2", {
        structures: [{ structure: cif, format: "mmcif" }],
        confidence_scores: [0.9],
        affinities: {
          L1: {
            ...affinity,
            affinity_pred_value: [2.1, 2.2],
            affinity_pic50: [6.2, 6.3],
            affinity_probability_binary: [0.94, 0.92],
            affinity_embedding: [Array(384).fill(0)],
          },
        },
      }),
    ).toThrow("affinity sample count")
    expect(() =>
      parseBioNemoOutput("boltz2", {
        structures: [{ structure: cif, format: "mmcif" }],
        confidence_scores: [0.9],
        affinities: {
          L1: {
            ...affinity,
            affinity_pred_value: [2.1, 2.2],
            affinity_pic50: [6.2, 6.3],
            affinity_probability_binary: [0.94, 0.92],
            model_1_affinity_pred_value: [2.1],
            model_1_affinity_probability_binary: [0.94],
          },
        },
      }),
    ).toThrow("affinity sample count")
  })

  test("accepts NVIDIA GenMol numeric parameters without rewriting legacy approved payloads", async () => {
    const { BioNemoHosted } = await import("../../src/science/bionemo/client")
    const { parseBioNemoInput } = await import("../../src/science/bionemo/schema")
    for (const payload of [
      { smiles: "CCO", temperature: 0.8, noise: 1.2 },
      { smiles: "CCO", temperature: "0.8", noise: "1.2" },
      { smiles: "CCO", temperature: 10, noise: 0 },
    ]) {
      expect(parseBioNemoInput("genmol", payload)).toEqual(payload)
      const preview = await BioNemoHosted.plan("genmol", payload)
      expect(preview.payload).toEqual(payload)
      expect(preview.request_sha256).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify(payload)).digest("hex"))
      expect(preview.dispatched).toBe(false)
    }
    for (const temperature of [0, 10.1, "", "11", "NaN", true])
      expect(() => parseBioNemoInput("genmol", { smiles: "CCO", temperature })).toThrow()
    for (const noise of [-0.1, 2.1, "", "-1", "Infinity", false])
      expect(() => parseBioNemoInput("genmol", { smiles: "CCO", noise })).toThrow()
    expect(parseBioNemoInput("boltz2", { polymers: [{ molecule_type: "protein", sequence: "ARNDX" }] })).toBeTruthy()
  })

  test("keeps the NVIDIA credential in-process, validates the request, and captures bounded artifacts", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const data = path.join(tmp.path, "data")
    const runner = path.join(tmp.path, "bionemo-runner.ts")
    await fs.mkdir(project)
    const credentials = new URL("../../src/server/routes/settings/credentials.ts", import.meta.url).href
    const hosted = new URL("../../src/science/bionemo/client.ts", import.meta.url).href
    const dispatch = new URL("../../src/science/bionemo/dispatch.ts", import.meta.url).href
    const instance = new URL("../../src/project/instance.ts", import.meta.url).href
    const trust = new URL("../../src/project/trust.ts", import.meta.url).href
    const sessionModule = new URL("../../src/session/index.ts", import.meta.url).href
    const filesystem = new URL("../../src/session/filesystem.ts", import.meta.url).href
    await Bun.write(
      runner,
      `
import fs from "node:fs/promises"
import path from "node:path"
import { CredentialsRoutes } from ${JSON.stringify(credentials)}
import { BioNemoHosted } from ${JSON.stringify(hosted)}
import { BioNemoHostedDispatch } from ${JSON.stringify(dispatch)}
import { Instance } from ${JSON.stringify(instance)}
import { ProjectTrust } from ${JSON.stringify(trust)}
import { Session } from ${JSON.stringify(sessionModule)}
import { SessionFilesystem } from ${JSON.stringify(filesystem)}

const secret = "nvapi-hosted-test-secret"
const app = CredentialsRoutes()
const saved = await app.request("/nvidia", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ fields: { api_key: secret } }),
})
const savedText = await saved.text()
if (!saved.ok || savedText.includes(secret)) throw new Error("NVIDIA credential save leaked or failed")
if (process.env.NVIDIA_API_KEY) throw new Error("NVIDIA credential entered process.env")

let requests = 0
globalThis.fetch = async (input, init) => {
  requests++
  if (String(input) !== "https://health.api.nvidia.com/v1/biology/mit/boltz2/predict") throw new Error("wrong endpoint")
  if (init?.method !== "POST") throw new Error("wrong method")
  if (init?.redirect !== "manual") throw new Error("redirect policy changed")
  if (new Headers(init?.headers).get("authorization") !== "Bearer " + secret) throw new Error("credential missing")
  const payload = JSON.parse(String(init?.body))
  if (payload.polymers?.[0]?.sequence !== "MVLTIYPDELVQIVSDKK") throw new Error("payload changed")
  return new Response(JSON.stringify({
    structures: [{
      structure: "data_test\\n_atom_site.id 1\\n# " + secret,
      format: "mmcif",
    }],
    confidence_scores: [0.91],
    echoed: { nested: [secret], [secret]: secret },
  }), {
    headers: { "content-type": "application/json", "x-request-id": secret },
  })
}

await Instance.provide({
  directory: process.argv[2],
  init: async () => {
    const current = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: true, root: current.root })
  },
  fn: async () => {
    const doctor = await BioNemoHosted.doctor("boltz2")
    if (
      !doctor.configured ||
      doctor.state !== "configured" ||
      doctor.live_request_sent ||
      doctor.api_schema_version !== "api-schema-1.5.0" ||
      "model_version" in doctor
    )
      throw new Error("doctor overstated or missed configuration")
    const session = await Session.create({})
    const result = await BioNemoHosted.start("boltz2", session.id, {
      polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKK" }],
    })
    if (requests !== 1 || result.artifacts.length !== 2 || !result.dispatch_id)
      throw new Error("unexpected hosted capture")
    const cached = await BioNemoHosted.start("boltz2", session.id, {
      polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKK" }],
    })
    if (requests !== 1 || cached.request_sha256 !== result.request_sha256) throw new Error("exact success did not replay locally")
    const sibling = await Session.create({})
    const siblingResult = await BioNemoHosted.start("boltz2", sibling.id, {
      polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKK" }],
    })
    if (requests !== 2 || siblingResult.dispatch_id === result.dispatch_id || siblingResult.root === result.root)
      throw new Error("hosted dispatch leaked across sessions")
    if (JSON.stringify(result).includes(secret) || result.provider_request_id?.includes(secret))
      throw new Error("result leaked NVIDIA credential")
    const root = path.join(await SessionFilesystem.workspace(session.id), result.root)
    const response = await fs.readFile(path.join(root, "response.json"), "utf8")
    const cif = await fs.readFile(path.join(root, "artifact-1.cif"), "utf8")
    const dispatchStore = await fs.readFile(path.join(process.env.OPENSCIENCE_DATA_DIR!, "scientific-capability-hosted-dispatches.json"), "utf8")
    if (!response.includes("structures") || response.includes(secret) || dispatchStore.includes(secret) || !cif.startsWith("data_") || cif.includes(secret))
      throw new Error("artifacts were not captured safely")

    const beforeUnsupported = requests
    let unsupportedTemplate = false
    try {
      await BioNemoHosted.start("openfold3", session.id, {
        inputs: [{
          molecules: [{
            type: "protein",
            sequence: "ARND",
            msa: { main: { a3m: { alignment: ">query\\nARND", format: "a3m" } } },
            structural_templates: [{ structure: "data_test\\n", format: "cif" }],
          }],
        }],
      })
    } catch {
      unsupportedTemplate = true
    }
    if (!unsupportedTemplate || requests !== beforeUnsupported)
      throw new Error("unsupported hosted OpenFold3 template reached NVIDIA")

    globalThis.fetch = async () => new Response("provider rejected " + secret, { status: 401 })
    let failure = ""
    try {
      await BioNemoHosted.start("boltz2", session.id, {
        polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKA" }],
      })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (!failure || failure.includes(secret)) throw new Error("provider failure leaked NVIDIA credential")

    globalThis.fetch = async () =>
      new Response("", { headers: { "content-length": String(26 * 1024 * 1024) } })
    let bounded = false
    try {
      await BioNemoHosted.start("boltz2", session.id, {
        polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKAA" }],
      })
    } catch (error) {
      bounded = String(error).includes("capture limit") || String(error).includes("will not be resent automatically")
    }
    if (!bounded) throw new Error("oversized response was accepted")

    globalThis.fetch = async () =>
      new Response("", { status: 307, headers: { location: "https://redirected.example" } })
    let redirected = false
    try {
      await BioNemoHosted.start("boltz2", session.id, {
        polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKAAG" }],
      })
    } catch (error) {
      redirected = String(error).includes("redirect")
    }
    if (!redirected) throw new Error("redirect was accepted")

    const preview = await BioNemoHosted.plan("boltz2", {
      polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKAAGG" }],
    })
    await BioNemoHostedDispatch.begin({ preview, sessionID: session.id })
    const beforePending = requests
    let pending = ""
    try {
      await BioNemoHosted.start("boltz2", session.id, {
        polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKAAGG" }],
      })
    } catch (error) {
      pending = error instanceof Error ? error.message : String(error)
    }
    if (!pending.includes("previously recorded this exact hosted") || requests !== beforePending)
      throw new Error("pending dispatch was resent")
  },
})
`,
    )

    const childEnv = { ...process.env }
    delete childEnv.NVIDIA_API_KEY
    const proc = Bun.spawn([process.execPath, runner, project], {
      cwd: project,
      env: {
        ...childEnv,
        OPENSCIENCE_DATA_DIR: data,
        OPENSCIENCE_CONFIG_DIR: path.join(tmp.path, "config"),
        OPENSCIENCE_TEST_HOME: path.join(tmp.path, "home"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(exit, `${stdout}\n${stderr}`).toBe(0)
    expect(await Bun.file(path.join(data, "credentials.json")).text()).not.toContain("nvapi-hosted-test-secret")
  }, 20_000)

  test("rejects unknown fields and over-broad request sizes before a provider call", async () => {
    const { BioNemoHosted } = await import("../../src/science/bionemo/client")
    const { parseBioNemoInput } = await import("../../src/science/bionemo/schema")
    const invalid = [
      ["boltz2", { polymers: [{ molecule_type: "protein", sequence: "A".repeat(4_097) }] }],
      ["boltz2", { polymers: [{ molecule_type: "protein", sequence: "AAAA" }], diffusion_samples: 26 }],
      [
        "boltz2",
        {
          polymers: [{ molecule_type: "protein", sequence: "AAAA" }],
          ligands: [
            { id: "L1", smiles: "CCO", predict_affinity: true },
            { id: "L2", smiles: "CCN", predict_affinity: true },
          ],
        },
      ],
      [
        "boltz2",
        {
          polymers: [{ molecule_type: "protein", sequence: "AAAA", modifications: [{ ccd: "ABCDEF", position: 1 }] }],
        },
      ],
      [
        "boltz2",
        {
          polymers: [
            { molecule_type: "dna", sequence: "ATCG", structural_templates: [{ structure: "data_x", format: "cif" }] },
          ],
        },
      ],
      ["boltz2", { polymers: [{ molecule_type: "rna", sequence: "ATCG" }] }],
      [
        "boltz2",
        {
          polymers: [
            {
              molecule_type: "protein",
              sequence: "AAAA",
              msa: { main: { a3m: { alignment: ">query\nAAAT", format: "a3m" } } },
            },
          ],
        },
      ],
      ["diffdock", { protein: "ATOM", ligand: "CCO", ligand_file_type: "smiles" }],
      ["diffdock", { protein: "ATOM", ligand: "CCO", ligand_file_type: "txt", unexpected: true }],
      ["evo2", { sequence: "ACGT", top_k: 7 }],
      ["genmol", { smiles: "CCO", temperature: 0.001 }],
      ["molmim", { smi: "CCO", min_similarity: 1.1 }],
      ["msa-search", { sequence: "ARND", output_alignment_formats: ["csv"] }],
      ["msa-search", { sequence: "ARND", search_type: "hmmsearch" }],
      ["msa-search", { sequence: "ARND", databases: ["invalid database name"] }],
      ["msa-search", { sequence: "ARND", max_msa_sequences: 10_002 }],
      ["msa-search", { sequence: "ARNDX" }],
      ["openfold2", { sequence: "ARND", selected_models: [6] }],
      ["openfold2", { sequence: "ARNDX" }],
      ["openfold3", { msa: {}, inputs: [{ molecules: [{ type: "protein", sequence: "ARND" }] }] }],
      ["openfold3", { inputs: [{ molecules: [{ type: "protein", sequence: "ARND" }], output_format: "mmcif" }] }],
      [
        "openfold3",
        {
          inputs: [
            {
              molecules: [
                {
                  type: "protein",
                  sequence: "ARND",
                  msa: { main: { a3m: { alignment: ">query\nARND", format: "a3m" } } },
                },
              ],
              diffusion_samples: 6,
            },
          ],
        },
      ],
      ["openfold3", { inputs: [{ molecules: [{ type: "ligand", ccd_codes: "ATP", smiles: "CCO" }] }] }],
      ["openfold3", { inputs: [{ molecules: [{ type: "dna", sequence: "ATUG" }] }] }],
      ["openfold3", { inputs: [{ molecules: [{ type: "rna", sequence: "ATCG" }] }] }],
      ["openfold3", { inputs: [{ molecules: [{ type: "protein", sequence: "ARND" }] }] }],
      ["openfold3", { inputs: [{ molecules: [{ type: "rna", sequence: "AUCG" }] }] }],
      [
        "openfold3",
        {
          inputs: [
            {
              molecules: [
                {
                  type: "protein",
                  sequence: "ARND",
                  msa: { main: { a3m: { alignment: ">query\nARND", format: "a3m" } } },
                  structural_templates: [{ structure: "data_test\n", format: "cif", chain_id: "A" }],
                },
              ],
            },
          ],
        },
      ],
      [
        "openfold3",
        {
          inputs: [
            {
              molecules: [
                {
                  type: "dna",
                  sequence: "ATCG",
                  msa: { main: { a3m: { alignment: ">query\nATCG", format: "a3m" } } },
                },
              ],
            },
          ],
        },
      ],
      [
        "openfold3",
        {
          inputs: [
            {
              molecules: [
                {
                  type: "protein",
                  sequence: "ARND",
                  msa: { main: { fasta: { alignment: ">query\nARND", format: "fasta" } } },
                },
              ],
            },
          ],
        },
      ],
      [
        "openfold3",
        {
          inputs: [
            {
              molecules: [
                {
                  type: "protein",
                  sequence: "ARND",
                  msa: { main: { a3m: { alignment: ">query\nARNE", format: "a3m" } } },
                },
              ],
            },
          ],
        },
      ],
      ["proteinmpnn", { num_seq_per_target: 1 }],
      ["rfdiffusion", { contigs: "100-100" }],
      [
        "rfdiffusion",
        { input_pdb: "HEADER    TEST\nATOM      1  CA  ALA A   1\n", contigs: "100-100", diffusion_steps: 51 },
      ],
    ] as const
    for (const [id, payload] of invalid)
      expect(() => parseBioNemoInput(id, payload), `${id}: ${JSON.stringify(payload).slice(0, 200)}`).toThrow()

    expect(
      parseBioNemoInput("boltz2", {
        polymers: [
          {
            molecule_type: "protein",
            sequence: "ARND",
            structural_templates: [{ structure: "data_test\n", format: "cif", name: "template" }],
          },
        ],
        recycling_steps: 10,
        diffusion_samples: 25,
        write_full_pae: true,
        write_full_pde: true,
        ligands: [{ id: "L1", ccd: "NADPH", predict_affinity: true, output_affinity_embedding: true }],
      }),
    ).toBeTruthy()
    expect(
      parseBioNemoInput("openfold3", {
        inputs: [
          {
            molecules: [
              {
                type: "protein",
                sequence: "ARND",
                msa: { main: { a3m: { alignment: ">query\nARND", format: "a3m" } } },
              },
            ],
            diffusion_samples: 5,
            output_format: "cif",
          },
        ],
      }),
    ).toBeTruthy()
    expect(
      parseBioNemoInput("openfold3", {
        inputs: [
          {
            molecules: [
              {
                type: "protein",
                sequence: "ARND",
                msa: {
                  main: {
                    csv: { alignment: "key,sequence\n-1,ARND", format: "csv" },
                  },
                },
              },
            ],
          },
        ],
      }),
    ).toBeTruthy()
    expect(
      parseBioNemoInput("openfold3", {
        inputs: [{ molecules: [{ type: "ligand", smiles: "CCO" }], output_format: "pdb" }],
      }),
    ).toBeTruthy()
    expect(
      parseBioNemoInput("msa-search", {
        sequence: "ARND",
        databases: ["Uniref30_2302"],
        max_msa_sequences: 10_001,
      }),
    ).toBeTruthy()

    const sensitiveMarker = "nvapi-must-not-appear-in-egress-summary"
    const largePdb = `HEADER    TEST\n${sensitiveMarker}\n${"A".repeat(1_500_000)}`
    const largePreview = await BioNemoHosted.plan("proteinmpnn", {
      input_pdb: largePdb,
      num_seq_per_target: 1,
    })
    const boundedSummary = JSON.stringify(largePreview.egress_summary)
    expect(boundedSummary.length).toBeLessThan(5_000)
    expect(boundedSummary).not.toContain(sensitiveMarker)
    expect(largePreview.egress_summary.structures).toMatchObject({
      count: 1,
      total_bytes: Buffer.byteLength(largePdb),
    })
    expect(largePreview.egress_summary.structures?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("records unknown dispatch state after a transport failure and blocks an identical retry", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    try {
      const { CredentialsRoutes } = await import("../../src/server/routes/settings/credentials")
      const { Instance } = await import("../../src/project/instance")
      const { ProjectTrust } = await import("../../src/project/trust")
      const { Session } = await import("../../src/session")
      const { BioNemoHosted } = await import("../../src/science/bionemo/client")
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          const current = await ProjectTrust.status(Instance.project)
          await ProjectTrust.update(Instance.project, { trusted: true, root: current.root })
        },
        fn: async () => {
          const app = CredentialsRoutes()
          await app.request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-hosted-test-secret" } }),
          })
          const session = await Session.create({})
          let requests = 0
          globalThis.fetch = (async () => {
            requests++
            throw new Error("socket hang up")
          }) as unknown as typeof fetch
          await expect(
            BioNemoHosted.start("boltz2", session.id, {
              polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKK" }],
            }),
          ).rejects.toThrow("socket hang up")
          await expect(
            BioNemoHosted.start("boltz2", session.id, {
              polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKK" }],
            }),
          ).rejects.toThrow("previously recorded this exact hosted")
          expect(requests).toBe(1)
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not persist a pending dispatch before NVIDIA credentials are configured", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    try {
      const { CredentialsRoutes } = await import("../../src/server/routes/settings/credentials")
      const { Instance } = await import("../../src/project/instance")
      const { ProjectTrust } = await import("../../src/project/trust")
      const { Session } = await import("../../src/session")
      const { BioNemoHosted } = await import("../../src/science/bionemo/client")
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          const current = await ProjectTrust.status(Instance.project)
          await ProjectTrust.update(Instance.project, { trusted: true, root: current.root })
        },
        fn: async () => {
          await CredentialsRoutes().request("/nvidia", { method: "DELETE" })
          const session = await Session.create({})
          const preview = await BioNemoHosted.plan("boltz2", {
            polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKAA" }],
          })
          let requests = 0
          globalThis.fetch = (async () => {
            requests++
            return new Response(
              JSON.stringify({
                structures: [{ structure: "data_test\n_atom_site.id 1\n", format: "mmcif" }],
                confidence_scores: [0.9],
              }),
              { headers: { "content-type": "application/json" } },
            )
          }) as unknown as typeof fetch
          await expect(
            BioNemoHosted.start("boltz2", session.id, {
              polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKAA" }],
            }),
          ).rejects.toThrow("credential is not configured")
          expect(
            await BioNemoHostedDispatch.get({ approvalSha256: preview.approval_sha256, sessionID: session.id }),
          ).toBeUndefined()
          const app = CredentialsRoutes()
          await app.request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-hosted-test-secret" } }),
          })
          const result = await BioNemoHosted.start("boltz2", session.id, {
            polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKAA" }],
          })
          expect(requests).toBe(1)
          expect(result.dispatch_id).toBeTruthy()
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("keeps a malformed 200 without a safe request identity unresolved and never fetches on exact retry", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    try {
      const { CredentialsRoutes } = await import("../../src/server/routes/settings/credentials")
      const { Instance } = await import("../../src/project/instance")
      const { ProjectTrust } = await import("../../src/project/trust")
      const { Session } = await import("../../src/session")
      const { BioNemoHosted } = await import("../../src/science/bionemo/client")
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          const current = await ProjectTrust.status(Instance.project)
          await ProjectTrust.update(Instance.project, { trusted: true, root: current.root })
        },
        fn: async () => {
          const app = CredentialsRoutes()
          await app.request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-hosted-test-secret" } }),
          })
          const session = await Session.create({})
          let requests = 0
          globalThis.fetch = (async () => {
            requests++
            return new Response("not-json", { headers: { "content-type": "application/json" } })
          }) as unknown as typeof fetch
          let first = ""
          try {
            await BioNemoHosted.start("boltz2", session.id, {
              polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKAAA" }],
            })
          } catch (error) {
            first = error instanceof Error ? error.message : String(error)
          }
          expect(first).toContain("will not be resent automatically")
          const dispatchID = first.match(/Dispatch ([0-9a-f-]+)/i)?.[1]
          expect(dispatchID).toBeTruthy()
          await expect(
            BioNemoHosted.start("boltz2", session.id, {
              polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKAAA" }],
            }),
          ).rejects.toThrow(dispatchID!)
          expect(requests).toBe(1)
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("polls accepted and request-ID-only replies without sending a second POST", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    try {
      const { CredentialsRoutes } = await import("../../src/server/routes/settings/credentials")
      const { Instance } = await import("../../src/project/instance")
      const { ProjectTrust } = await import("../../src/project/trust")
      const { Session } = await import("../../src/session")
      const { BioNemoHosted } = await import("../../src/science/bionemo/client")
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          const current = await ProjectTrust.status(Instance.project)
          await ProjectTrust.update(Instance.project, { trusted: true, root: current.root })
        },
        fn: async () => {
          await CredentialsRoutes().request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-hosted-test-secret" } }),
          })
          const session = await Session.create({})

          const payload = { smiles: "CCO", temperature: 0.8, noise: 1.2 }
          let posts = 0
          let polls = 0
          globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer nvapi-hosted-test-secret")
            if (init?.method === "POST") {
              expect(JSON.parse(String(init.body))).toEqual(payload)
              posts++
              return new Response(JSON.stringify({ requestId: "nvcf-queued-1", status: "pending" }), {
                status: 202,
                headers: {
                  "content-type": "application/json",
                  "nvcf-status": "pending",
                  "nvcf-reqid": "nvcf-queued-1",
                  "retry-after": "0",
                },
              })
            }
            expect(String(input)).toBe("https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/nvcf-queued-1")
            expect(init?.method).toBe("GET")
            polls++
            if (polls <= 3)
              return new Response(JSON.stringify({ requestId: "nvcf-queued-1", status: "running" }), {
                status: 202,
                headers: { "content-type": "application/json", "nvcf-status": "running", "retry-after": "0" },
              })
            return new Response(JSON.stringify({ status: "success", molecules: [{ smiles: "CCO", score: 0.7 }] }), {
              headers: { "content-type": "application/json", "nvcf-status": "fulfilled" },
            })
          }) as unknown as typeof fetch
          const pending = await BioNemoHosted.start("genmol", session.id, payload)
          expect(pending).toMatchObject({
            state: "pending",
            pollable: true,
            poll_attempts: 3,
            provider_request_id: "nvcf-queued-1",
          })
          if (!("next" in pending)) throw new Error("Expected a pending hosted result")
          expect(pending.next).toContain("will not send another POST")
          expect(posts).toBe(1)
          expect(polls).toBe(3)
          const completed = await BioNemoHosted.start("genmol", session.id, payload)
          if (!("artifacts" in completed)) throw new Error("Expected a completed hosted result")
          expect(completed.dispatch_id).toBe(pending.dispatch_id)
          expect(completed.artifacts.length).toBe(1)
          expect(posts).toBe(1)
          expect(polls).toBe(4)
          await BioNemoHosted.start("genmol", session.id, payload)
          expect(posts).toBe(1)
          expect(polls).toBe(4)

          const envelopeSession = await Session.create({})
          let envelopePosts = 0
          let envelopePolls = 0
          globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            if (init?.method === "POST") {
              envelopePosts++
              return new Response(JSON.stringify({ requestId: "nvcf-envelope-only" }), {
                status: 200,
                headers: { "content-type": "application/json", "nvcf-reqid": "nvcf-envelope-only" },
              })
            }
            expect(String(input)).toContain("/status/nvcf-envelope-only")
            envelopePolls++
            return new Response(JSON.stringify({ requestId: "nvcf-envelope-only", status: "running" }), {
              status: 202,
              headers: { "content-type": "application/json", "retry-after": "0" },
            })
          }) as unknown as typeof fetch
          const envelope = await BioNemoHosted.start("evo2", envelopeSession.id, { sequence: "ACGTACGTACGT" })
          expect(envelope).toMatchObject({ state: "pending", provider_request_id: "nvcf-envelope-only" })
          expect(envelopePosts).toBe(1)
          expect(envelopePolls).toBe(3)
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fails permanent POST errors, recovers status authorization, and rejects redirects", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    try {
      const { CredentialsRoutes } = await import("../../src/server/routes/settings/credentials")
      const { Instance } = await import("../../src/project/instance")
      const { ProjectTrust } = await import("../../src/project/trust")
      const { Session } = await import("../../src/session")
      const { BioNemoHosted } = await import("../../src/science/bionemo/client")
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          const current = await ProjectTrust.status(Instance.project)
          await ProjectTrust.update(Instance.project, { trusted: true, root: current.root })
        },
        fn: async () => {
          await CredentialsRoutes().request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-hosted-test-secret" } }),
          })
          const failedSession = await Session.create({})
          let posts = 0
          let polls = 0
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            if (init?.method === "POST") {
              posts++
              return new Response(JSON.stringify({ detail: "invalid input" }), { status: 422 })
            }
            polls++
            throw new Error("permanent POST error unexpectedly entered status polling")
          }) as unknown as typeof fetch
          await expect(BioNemoHosted.start("genmol", failedSession.id, { smiles: "CCN" })).rejects.toThrow("HTTP 422")
          expect(posts).toBe(1)
          expect(polls).toBe(0)
          await expect(BioNemoHosted.start("genmol", failedSession.id, { smiles: "CCN" })).rejects.toThrow("HTTP 422")
          expect(posts).toBe(1)
          expect(polls).toBe(0)

          const authSession = await Session.create({})
          let authPosts = 0
          let authPolls = 0
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            if (init?.method === "POST") {
              authPosts++
              return new Response(JSON.stringify({ requestId: "nvcf-auth-recovery", status: "pending" }), {
                status: 202,
                headers: { "nvcf-reqid": "nvcf-auth-recovery", "content-type": "application/json" },
              })
            }
            authPolls++
            return new Response(JSON.stringify({ detail: "expired credential" }), { status: 401 })
          }) as unknown as typeof fetch
          const authPending = await BioNemoHosted.start("genmol", authSession.id, { smiles: "CCCl" })
          expect(authPending).toMatchObject({
            state: "unknown",
            pollable: true,
            provider_request_id: "nvcf-auth-recovery",
          })
          expect(authPosts).toBe(1)
          expect(authPolls).toBe(1)
          await CredentialsRoutes().request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-hosted-refreshed-secret" } }),
          })
          globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            expect(init?.method).toBe("GET")
            expect(String(input)).toBe("https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/nvcf-auth-recovery")
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer nvapi-hosted-refreshed-secret")
            authPolls++
            return new Response(JSON.stringify({ status: "success", molecules: [{ smiles: "CCCl", score: 0.7 }] }), {
              headers: { "content-type": "application/json", "nvcf-status": "fulfilled" },
            })
          }) as unknown as typeof fetch
          const authCompleted = await BioNemoHosted.start("genmol", authSession.id, { smiles: "CCCl" })
          expect(authCompleted).toMatchObject({ dispatch_id: authPending.dispatch_id })
          expect(authPosts).toBe(1)
          expect(authPolls).toBe(2)

          const lifecycleSession = await Session.create({})
          let lifecyclePosts = 0
          let lifecyclePolls = 0
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            if (init?.method === "POST") {
              lifecyclePosts++
              return new Response(JSON.stringify({ requestId: "nvcf-terminal-failure", status: "pending" }), {
                status: 202,
                headers: { "nvcf-reqid": "nvcf-terminal-failure", "content-type": "application/json" },
              })
            }
            lifecyclePolls++
            return new Response(
              JSON.stringify({
                requestId: "nvcf-terminal-failure",
                status: "failed",
                message: "provider failed nvapi-hosted-test-secret",
              }),
              { headers: { "content-type": "application/json", "nvcf-status": "failed" } },
            )
          }) as unknown as typeof fetch
          let lifecycleFailure = ""
          try {
            await BioNemoHosted.start("genmol", lifecycleSession.id, { smiles: "CCF" })
          } catch (error) {
            lifecycleFailure = error instanceof Error ? error.message : String(error)
          }
          expect(lifecycleFailure).toContain("terminal status failed")
          expect(lifecycleFailure).not.toContain("nvapi-hosted-test-secret")
          expect(lifecyclePosts).toBe(1)
          expect(lifecyclePolls).toBe(1)
          await expect(BioNemoHosted.start("genmol", lifecycleSession.id, { smiles: "CCF" })).rejects.toThrow(
            "terminal status failed",
          )
          expect(lifecyclePosts).toBe(1)
          expect(lifecyclePolls).toBe(1)

          const handledSession = await Session.create({})
          let handledPosts = 0
          let handledPolls = 0
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            if (init?.method === "POST") {
              handledPosts++
              return new Response(JSON.stringify({ requestId: "nvcf-of2-handled", status: "pending" }), {
                status: 202,
                headers: { "nvcf-reqid": "nvcf-of2-handled", "content-type": "application/json" },
              })
            }
            handledPolls++
            return new Response(
              JSON.stringify({
                structures_in_ranked_order: [],
                of2_nim_handled_error_message: "template failed nvapi-hosted-test-secret",
              }),
              { headers: { "content-type": "application/json", "nvcf-status": "fulfilled" } },
            )
          }) as unknown as typeof fetch
          let handledFailure = ""
          try {
            await BioNemoHosted.start("openfold2", handledSession.id, { sequence: "ARNDCQEGHILKMFPSTWYV" })
          } catch (error) {
            handledFailure = error instanceof Error ? error.message : String(error)
          }
          expect(handledFailure).toContain("handled terminal error")
          expect(handledFailure).not.toContain("nvapi-hosted-test-secret")
          expect(handledPosts).toBe(1)
          expect(handledPolls).toBe(1)
          await expect(
            BioNemoHosted.start("openfold2", handledSession.id, { sequence: "ARNDCQEGHILKMFPSTWYV" }),
          ).rejects.toThrow("handled terminal error")
          expect(handledPosts).toBe(1)
          expect(handledPolls).toBe(1)

          const redirectSession = await Session.create({})
          let redirectPosts = 0
          let redirectPolls = 0
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            if (init?.method === "POST") {
              redirectPosts++
              return new Response(JSON.stringify({ requestId: "nvcf-large-result" }), {
                status: 202,
                headers: { "nvcf-reqid": "nvcf-large-result", "content-type": "application/json" },
              })
            }
            redirectPolls++
            return new Response("", { status: 302, headers: { location: "https://unapproved.example/result" } })
          }) as unknown as typeof fetch
          const redirected = await BioNemoHosted.start("genmol", redirectSession.id, { smiles: "CCC" })
          expect(redirected).toMatchObject({ state: "unknown", provider_request_id: "nvcf-large-result" })
          expect(redirectPosts).toBe(1)
          expect(redirectPolls).toBe(1)
          await BioNemoHosted.start("genmol", redirectSession.id, { smiles: "CCC" })
          expect(redirectPosts).toBe(1)
          expect(redirectPolls).toBe(2)
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rate-limit rejection requires a bounded newly approved one-POST retry and keeps durable state secret-free", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    try {
      const { CredentialsRoutes } = await import("../../src/server/routes/settings/credentials")
      const { Instance } = await import("../../src/project/instance")
      const { ProjectTrust } = await import("../../src/project/trust")
      const { Session } = await import("../../src/session")
      const { BioNemoHosted } = await import("../../src/science/bionemo/client")
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          const current = await ProjectTrust.status(Instance.project)
          await ProjectTrust.update(Instance.project, { trusted: true, root: current.root })
        },
        fn: async () => {
          const secret = "nvapi-rate-limit-durable-secret"
          await CredentialsRoutes().request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: secret } }),
          })
          const session = await Session.create({})
          const payload = { smiles: "CCBr" }
          const preview = await BioNemoHosted.plan("genmol", payload)
          let posts = 0
          let retryNotBefore = 0
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            expect(init?.method).toBe("POST")
            posts++
            if (posts === 1)
              return new Response(JSON.stringify({ detail: `slow down ${secret}` }), {
                status: 429,
                headers: { "content-type": "application/json", "retry-after": "30" },
              })
            expect(Date.now()).toBeGreaterThanOrEqual(retryNotBefore)
            return new Response(JSON.stringify({ status: "success", molecules: [{ smiles: "CCBr", score: 0.7 }] }), {
              headers: { "content-type": "application/json", "nvcf-status": "fulfilled" },
            })
          }) as unknown as typeof fetch

          await expect(BioNemoHosted.start("genmol", session.id, payload)).rejects.toThrow("bounded 2000 ms delay")
          expect(posts).toBe(1)
          const rejected = await BioNemoHostedDispatch.get({
            sessionID: session.id,
            approvalSha256: preview.approval_sha256,
          })
          expect(rejected).toMatchObject({
            status: "retryable",
            retry_reason: "rate_limit",
            retry_after_ms: 2_000,
            attempts: 1,
            http_status: 429,
          })
          expect(rejected?.provider_request_id).toBeUndefined()
          retryNotBefore = Date.parse(rejected?.retry_not_before ?? "")
          expect(Number.isFinite(retryNotBefore)).toBe(true)
          expect(JSON.stringify(rejected)).not.toContain(secret)

          const completed = await BioNemoHosted.start("genmol", session.id, payload)
          expect(completed).toMatchObject({ capability: "genmol", provider: "nvidia" })
          expect(posts).toBe(2)
          const succeeded = await BioNemoHostedDispatch.get({
            sessionID: session.id,
            approvalSha256: preview.approval_sha256,
          })
          expect(succeeded).toMatchObject({ status: "succeeded", attempts: 2 })
          await BioNemoHosted.start("genmol", session.id, payload)
          expect(posts).toBe(2)

          const store = await Bun.file(
            path.join(Global.Path.data, "scientific-capability-hosted-dispatches.json"),
          ).text()
          expect(store).not.toContain(secret)
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("resumes a durable NVCF dispatch after process restart with status GETs only", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const data = path.join(tmp.path, "data")
    const stateFile = path.join(tmp.path, "restart-state.json")
    const runner = path.join(tmp.path, "bionemo-restart-runner.ts")
    await fs.mkdir(project)
    const credentials = new URL("../../src/server/routes/settings/credentials.ts", import.meta.url).href
    const hosted = new URL("../../src/science/bionemo/client.ts", import.meta.url).href
    const instance = new URL("../../src/project/instance.ts", import.meta.url).href
    const trust = new URL("../../src/project/trust.ts", import.meta.url).href
    const sessionModule = new URL("../../src/session/index.ts", import.meta.url).href
    await Bun.write(
      runner,
      `
import crypto from "node:crypto"
import path from "node:path"
import { CredentialsRoutes } from ${JSON.stringify(credentials)}
import { BioNemoHosted } from ${JSON.stringify(hosted)}
import { Instance } from ${JSON.stringify(instance)}
import { ProjectTrust } from ${JSON.stringify(trust)}
import { Session } from ${JSON.stringify(sessionModule)}

const phase = process.argv[2]
const project = process.argv[3]
const stateFile = process.argv[4]
const secret = "nvapi-restart-test-secret"
const saved = await CredentialsRoutes().request("/nvidia", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ fields: { api_key: secret } }),
})
if (!saved.ok || (await saved.text()).includes(secret)) throw new Error("credential save leaked or failed")

await Instance.provide({
  directory: project,
  init: async () => {
    const current = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: true, root: current.root })
  },
  fn: async () => {
    const payload = { polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKR" }] }
    if (phase === "first") {
      const session = await Session.create({})
      const preview = await BioNemoHosted.plan("boltz2", payload)
      let posts = 0
      let polls = 0
      globalThis.fetch = async (input, init) => {
        if (new Headers(init?.headers).get("authorization") !== "Bearer " + secret)
          throw new Error("credential missing")
        if (init?.method === "POST") {
          posts++
          return new Response(JSON.stringify({ requestId: "nvcf-restart-1", status: "pending" }), {
            status: 202,
            headers: {
              "content-type": "application/json",
              "nvcf-reqid": "nvcf-restart-1",
              "nvcf-status": "pending",
              "retry-after": "0",
            },
          })
        }
        if (String(input) !== "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/nvcf-restart-1")
          throw new Error("wrong status endpoint")
        polls++
        return new Response(JSON.stringify({ requestId: "nvcf-restart-1", status: "running" }), {
          status: 202,
          headers: { "content-type": "application/json", "nvcf-status": "running", "retry-after": "0" },
        })
      }
      const pending = await BioNemoHosted.start("boltz2", session.id, payload)
      if (pending.state !== "pending" || !pending.pollable || posts !== 1 || polls !== 3)
        throw new Error("initial pending dispatch was not durable")
      const legacyApproval = crypto
        .createHash("sha256")
        .update(JSON.stringify({
          provider: preview.provider,
          endpoint: preview.endpoint,
          status_endpoint_template: preview.status_endpoint_template,
          status_host: preview.status_host,
          model_version: preview.api_schema_version,
          request_sha256: preview.request_sha256,
          terms_url: preview.terms_url,
          payload_bytes: preview.payload_bytes,
        }))
        .digest("hex")
      const dispatchFile = path.join(process.env.OPENSCIENCE_DATA_DIR, "scientific-capability-hosted-dispatches.json")
      const store = JSON.parse(await Bun.file(dispatchFile).text())
      const currentKey = "nvidia:" + session.id + ":" + preview.approval_sha256
      const legacyKey = "nvidia:" + session.id + ":" + legacyApproval
      const current = store[currentKey]
      if (!current || current.schema_version !== 2 || current.api_schema_version !== preview.api_schema_version)
        throw new Error("truthful dispatch record was not written")
      const { api_schema_version, ...legacyRest } = current
      store[legacyKey] = {
        ...legacyRest,
        schema_version: 1,
        model_version: api_schema_version,
        approval_sha256: legacyApproval,
      }
      delete store[currentKey]
      await Bun.write(dispatchFile, JSON.stringify(store))
      await Bun.write(stateFile, JSON.stringify({
        sessionID: session.id,
        dispatchID: pending.dispatch_id,
        legacyApproval,
      }))
      return
    }

    const state = JSON.parse(await Bun.file(stateFile).text())
    let posts = 0
    let polls = 0
    globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") {
        posts++
        throw new Error("restart attempted a second POST")
      }
      if (String(input) !== "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/nvcf-restart-1")
        throw new Error("wrong status endpoint")
      if (new Headers(init?.headers).get("authorization") !== "Bearer " + secret)
        throw new Error("credential missing")
      polls++
      return new Response(
        JSON.stringify({
          structures: [{
            structure: "data_test\\n_atom_site.id 1\\n",
            format: "mmcif",
          }],
          confidence_scores: [0.92],
        }),
        { headers: { "content-type": "application/json", "nvcf-status": "fulfilled" } },
      )
    }
    const completed = await BioNemoHosted.start("boltz2", state.sessionID, payload)
    if (completed.dispatch_id !== state.dispatchID || completed.artifacts.length !== 2 || posts !== 0 || polls !== 1)
      throw new Error("restart reconciliation did not complete safely")
    if (completed.api_schema_version !== "api-schema-1.5.0" || "model_version" in completed)
      throw new Error("completed provenance mislabeled the API schema")
    await BioNemoHosted.start("boltz2", state.sessionID, payload)
    if (posts !== 0 || polls !== 1) throw new Error("completed dispatch was fetched again")
    const migratedStore = await Bun.file(
      path.join(process.env.OPENSCIENCE_DATA_DIR, "scientific-capability-hosted-dispatches.json"),
    ).text()
    if (migratedStore.includes('"model_version"') || migratedStore.includes(state.legacyApproval))
      throw new Error("legacy provenance record was not migrated")
  },
})
`,
    )

    const childEnv = { ...process.env }
    delete childEnv.NVIDIA_API_KEY
    const environment = {
      ...childEnv,
      OPENSCIENCE_DATA_DIR: data,
      OPENSCIENCE_CONFIG_DIR: path.join(tmp.path, "config"),
      OPENSCIENCE_TEST_HOME: path.join(tmp.path, "home"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
    }
    for (const phase of ["first", "second"]) {
      const proc = Bun.spawn([process.execPath, runner, phase, project, stateFile], {
        cwd: project,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exit, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(exit, `${phase}\n${stdout}\n${stderr}`).toBe(0)
    }
    expect(await Bun.file(path.join(data, "scientific-capability-hosted-dispatches.json")).text()).not.toContain(
      "nvapi-restart-test-secret",
    )
    expect(await Bun.file(path.join(data, "scientific-capability-hosted-dispatches.json")).text()).not.toContain(
      '"model_version"',
    )
  }, 30_000)
})
