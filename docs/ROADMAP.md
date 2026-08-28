# OpenScience Roadmap

> Historical audit snapshot against commit `52845c3`. Its counts and statuses
> are not the current release matrix; consult the changelog and current product
> documentation before making shipped-capability claims.

110 agreed features and fixes, ranked by when they should ship, each with an audited status.

Ranking is **findings-first**: every item was checked against the tree at `52845c3` before being placed,
so "P0" means _users hit this today_, not _it sounded important_.

## Status at a glance

| Status            | Count  | Meaning                                                        |
| ----------------- | ------ | -------------------------------------------------------------- |
| ✅ **DONE**       | **1**  | Shipped and reachable by a user                                |
| 🟡 **PARTIAL**    | **29** | Real code exists, but incomplete or unreachable                |
| 📄 **SKILL-ONLY** | **33** | Markdown the agent reads before shelling out — no product code |
| ❌ **MISSING**    | **47** | Nothing                                                        |

**Zero of the 110 features have been built and shipped.** The single ✅ is item 100, and it is done because
the premise was wrong — the sandbox docs were never behind the code.

### 📄 SKILL-ONLY is not "implemented"

This is the most important distinction in this document, because 33 items hang on it.

`tool/skill.ts` **never executes anything.** Its entire `execute()` is a permission check, an optional cache
fetch, and `ConfigMarkdown.parse()` returning the SKILL.md prose plus a `**Base directory**: …` line. The
**280 helper `.py` scripts across 97 of the 293 skills are inert** — product code `chmod 0o755`s them
(`openscience/index.ts:1200`) and never runs them.

So a skill hands the model documentation and a directory path. The model must then decide on its own to
`bash python scripts/foo.py`, with nothing verifying that `torch`, `rdkit`, or `cellpose` is installed. That
is real value, and it is not the feature. **Counting skills as shipped capability would report 34/110 instead
of 1/110.**

---

# Wire what already exists

**Start here.** The dominant failure mode in this codebase is not missing work — it is capability that was
built and then never connected to anything a user can reach. Ten independent instances:

| Asset                                     | Built                                                      | Why it's unreachable                                                                                                                 | Unlocks        |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| **Connector `fetch()`**                   | 42 of 42 connectors implement it                           | `tool/science.ts` calls only `search()`. `grep 'connector.fetch'` → **0 hits** repo-wide                                             | 21, 28, 29, 97 |
| **Science renderers**                     | Mol\*, RDKit.js, igv.js, MSA, PDF, LaTeX, sequence         | Only backend emitters of `metadata.artifact` are `notebook.ts:507` / `rkernel.ts:471`, both `kind:"image"`                           | 16, 73         |
| **File preview dispatch**                 | `atlas/FilePreview.tsx`                                    | Routes 5 buckets (markdown/pdf/image/code/binary). `.pdb` opens as text, `.h5ad` as binary — **0 of item 16's 11 formats reachable** | 16, 75         |
| **`session-review.tsx`**                  | ~500 lines: diff view, line comments, focus                | `grep SessionReview frontend/workspace/src` → **0 hits**                                                                             | 12, 80         |
| **Command palette**                       | ⌘K, mounted both routes, e2e-tested                        | Contains exactly 3 commands (open folder, settings, back) — zero scientific actions                                                  | 66, 75         |
| **OpenTelemetry flag**                    | `experimental.openTelemetry` in `config.ts:1234`           | No `@opentelemetry` dep, no tracer, no exporter anywhere — **the flag emits no span**                                                | 110            |
| **SSH hosts + model endpoints**           | Settings panels, persisted to disk                         | No SSH client in the dep tree; nothing reads either store                                                                            | 58             |
| **`Run.inputs` / `Artifact.contentHash`** | Declared in `provenance/store.ts:38,47`                    | `ProvenanceRecordTool` exposes no parameter for either — never populated                                                             | 10, 18, 19     |
| **`open-bench/`**                         | 2 benches, real run artifacts (`chembench`, `biomnibench`) | Untracked by git; `src/openbench/**` has **only `.pyc`, zero `.py`**; no `pyproject.toml`                                            | 108            |
| **Artifact `type` / `summary`**           | Accepted by `register()`                                   | Not persisted — `list()` hardcodes `type:"unknown"` (`artifacts.ts:61`)                                                              | 13             |

Roughly a third of the 29 PARTIALs convert to DONE through wiring alone, without designing anything new.
Nothing on this list needs an architecture decision.

---

## How to read the tiers

| Tier                          | Meaning                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| **P0 — Now**                  | Shipped surfaces that are broken, stubbed, or misleading + the foundations everything else blocks on |
| **P1 — Next**                 | The product's reason to exist: real compute, real science data, the differentiating models           |
| **P2 — Then**                 | Breadth. Biomni-level coverage, model packs, compute depth, UX parity                                |
| **P3 — Later / nice to have** | Blocked on a business agreement, a legal review, or a prerequisite that hasn't shipped               |

## The five findings that set this order

1. **`bash` cannot run anything in the background.** `tool/bash.ts` is synchronous with a `timeout` that
   `killTree`s on expiry. No job registry, no output persistence, no SQLite. A training run cannot survive a
   single tool call. This is the keystone: items 2, 3, 4, 51, 52, 56, 57, 63 are all downstream of it.
2. **Six GPU providers are advertised; zero have an API client.** `settings/compute.ts` encrypts a key and
   injects an env var, then hopes a markdown skill shells out to the vendor CLI. **RunPod and Vast have no
   skill at all** — and `RUNPOD_API_KEY` is named to the model in **all six session prompts**, so the agent is
   told a capability exists that nothing implements. (Vast isn't even advertised — connecting it is a pure
   no-op.) Modal is stored in two panels where Credentials silently wins.
3. **Sharing is hard-disabled at three layers** (`disabled = true` in `share.ts:74` and `share-next.ts:18`,
   plus `Session.share` returning empty strings) while ~10 orphaned i18n strings per locale still describe the
   feature. We ship the vocabulary of a feature we don't have.
4. **The scientific substrate is better than it looks and worse than it's documented.** 42 real connectors —
   but `fetch()` is unreachable on all 42. Provenance is a real content-addressed DAG with no UI and no
   auto-capture. The artifact store discards the metadata you give it.
5. **Two docs actively lie about the review gate.** `CHANGELOG.md:55` advertises `experimental.reviewGate` and
   `docs/notes/deferred.md:20` marks it ✅ — it was reverted in `29e17e1`. `grep reviewGate` → 0 hits. (Note
   this is a _changelog_ defect, tracked under item 12. The **sandbox** docs, item 100, are accurate.)

## 110 items are ~70 workstreams

| Umbrella                           | Absorbs                                    | Note                                                     |
| ---------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| **6** Protein model pack           | 37, 38, 39, 40, 41, 43, 44                 | 6 _is_ these seven; ship as one pack                     |
| **51** Job abstraction             | 52, 2, and gates 55/61/103                 | One job system, one queue, one UI, one set of guardrails |
| **7** Benchling                    | 81                                         | Duplicated across P0-Critical and Partnerships           |
| **8** 10x Genomics Cloud           | 82                                         | Same                                                     |
| **9** BioRender                    | 83                                         | Same                                                     |
| **31** Clinical trial intelligence | 87 ClinicalTrials.gov                      | 87 is the connector, 31 is the workflow on top           |
| **10** Provenance                  | shares substrate with 13, 19               | All three need one content-hash + manifest layer         |
| **11** Citation verifier           | feeds 70 claim cards, 109 regression tests | Verifier is the engine; cards are its UI                 |
| **21/22** Coverage meta-goals      | 23–36                                      | Not separate work — they're the sum of the packs below   |

**MCP is a generic escape hatch worth knowing about.** `server/routes/mcp.ts` is a full CRUD + OAuth API for
user-supplied MCP servers, with a shipped Connectors settings UI. A user _can_ wire up any vendor shipping an
MCP server (Benchling, Databricks, Snowflake, Hugging Face, W&B all have third-party ones) with no code from
this repo. Nothing is pre-registered, discoverable, or vendor-aware — but it partially de-risks items 81, 88,
89, 91, 95, 96.

---

# P0 — Now

Fifteen items: **1 done · 6 partial · 1 skill-only · 7 missing.**

## Group A — Broken or misleading in the shipped product

| #       | Item                        | Status | Current state                                                                                                                                                                                                                                                   |
| ------- | --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5**   | Fix existing compute gaps   | ❌     | RunPod/Vast keys inject but **no consumer exists**, while `RUNPOD_API_KEY` is named to the model in all 6 `session/prompt/*.txt`; Modal double-stored vs `credentials.ts` (Credentials applies first at boot and wins); `last_used` rendered but never assigned |
| **14**  | Shared sessions             | 🟡     | Code written, then hard-disabled: `share.ts:74` + `share-next.ts:18` both `disabled = true`; `session/index.ts:253` returns empty strings. No permissions model. Orphaned i18n in every locale                                                                  |
| **13**  | Scientific artifact manager | 🟡     | `session/rlm/artifacts.ts` is a blob cache for context relief: IDs are `Date.now()+random`, **no checksums**, `list()` hardcodes `type:"unknown"` and drops your summary                                                                                        |
| **100** | Sandbox docs update         | ✅     | **No work needed — the premise was wrong.** `sandbox.mdx` (91 lines) matches `sandbox/sandbox.ts` (509 lines) including a Limitations section; both shipped in `a737ddc`, no drift since                                                                        |

## Group B — The job system (keystone)

One workstream. Guardrails ship **with** the runner — a job system that can spend money before it can stop
spending money is a liability.

| #       | Item                                 | Status | Current state                                                                                                                                  |
| ------- | ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **51**  | Provider-independent job abstraction | ❌     | `util/queue.ts` is an in-memory `AsyncQueue`; `scheduler/index.ts` is a 61-line `setInterval`. Start here                                      |
| **52**  | Queue/history database               | ❌     | No SQLite/Drizzle/Prisma anywhere; `storage/storage.ts` is JSON files. Use `bun:sqlite` — preserves the single-binary ship                     |
| **2**   | Real compute jobs page               | ❌     | No `/jobs` route. `app.tsx` has exactly 3 routes: `/`, `/:dir`, `/:dir/session/:id?`                                                           |
| **61**  | Per-job secrets, never into logs     | 🟡     | Log redaction exists (`OpenScience.redactSecrets` → `bash.ts:207`). **Per-job scoping does not** — injection is global via `applyComputeEnv()` |
| **55**  | Budget guardrails + kill switches    | ❌     | 0 hits for `costLimit\|spendLimit\|budget` outside a compaction comment. `cli/cmd/stats.ts` reports cost after the fact                        |
| **103** | Cost approval gates                  | ❌     | `session/billing-gate.ts` only _classifies_ calls managed/BYOK/free. No pre-flight estimate, cap, or prompt                                    |

## Group C — Core science UX that is half-built

Each has real machinery behind it. Finishing work, not greenfield.

| #      | Item                            | Status | Current state                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Full Jupyter notebook support   | 🟡     | `tool/notebook.ts` is a persistent **Python REPL**, not a notebook; `rkernel.ts` the same for R. No `.ipynb` I/O, no cell model, no kernel picker (`KernelStartOptions.binary` never passed), no restart op. `interrupt?()` is declared at `kernel/types.ts:78` and **implemented by neither kernel**. Frontend renders `.ipynb` read-only, and only when the agent _writes_ one |
| **10** | Provenance as a visible product | 🟡     | Real content-addressed DAG + 3 agent tools. **Zero frontend hits.** No auto-capture — exists only if the model chooses to call it. `sha256()` hashes the node's JSON, not file bytes                                                                                                                                                                                             |
| **11** | Citation verifier               | 📄     | No tool. `skills/writing/literature-review/scripts/verify_citations.py` does DOI existence; `citation-management/` does BibTeX linting. No quote accuracy, no claim support                                                                                                                                                                                                      |
| **12** | Reviewer gates beyond level 0   | ❌     | Level 0 **shipped then reverted** (`29e17e1` deleted `session/review.ts`); `grep reviewGate` → 0 hits, while CHANGELOG + `deferred.md` still advertise it. Only prose gates survive in agent prompts. `session-review.tsx` is built and imported nowhere                                                                                                                         |
| **15** | First-run UX overhaul           | 🟡     | Auth onboarding is genuinely good — `cli/onboard.ts` (285 lines, 4 paths) + `SetupGate.tsx`/`SetupDialog.tsx`. Covers **credentials only**: no templates, no example projects, no sample data                                                                                                                                                                                    |

---

# P1 — Next

Twenty-eight items: **0 done · 14 partial · 6 skill-only · 8 missing.**

## Compute, made real

| #      | Item                              | Status | Current state                                                                                                                                                                               |
| ------ | --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **4**  | Cloud GPU backends (real clients) | 🟡     | Credential plumbing is real, encrypted, and unit-tested — but grep for `api.runpod`/`modal.com`/`lambdalabs` outside skill markdown returns **0 hits**. AWS/GCP/Azure Batch absent entirely |
| **3**  | Slurm/HPC integration             | ❌     | 0 hits for `sbatch\|squeue\|scancel\|apptainer\|slurm` in any source tree. Prose in skill docs only                                                                                         |
| **57** | Multi-node training               | 📄     | Skills exist (`ray-train`, `deepspeed`, `torchtitan`, `megatron-core`). No product code. Needs **51**                                                                                       |
| **58** | Remote kernels over SSH/Jupyter   | 🟡     | The SSH-hosts panel persists data **nothing reads**; no SSH client in the dep tree. Make it real or remove the panel                                                                        |
| **59** | Interactive tunnels               | ❌     | JupyterLab, TensorBoard, MLflow, W&B                                                                                                                                                        |
| **53** | Artifact upload/download          | 📄     | No `@aws-sdk`/`@google-cloud`/`@azure`/`@huggingface` in any `package.json`. Skills shell out to `aws`/`gsutil`/`hf` CLIs                                                                   |
| **64** | Pre-launch runtime health checks  | ❌     | Cheapest possible way to stop burning GPU-hours on a bad environment                                                                                                                        |

## Scientific data as a first-class citizen

| #      | Item                        | Status | Current state                                                                                                                                                                                                                                  |
| ------ | --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **16** | Big scientific file viewers | 🟡     | **0 of 11 formats reachable end-to-end.** Renderers parse pdb/cif/sdf/mol2 but nothing routes a file to them; `.h5ad`/`.loom`/`.fastq`/`.mzML` have no renderer at all; `.vcf`/`.bam` need a hand-built igv `tracks[]` config no tool produces |
| **17** | Dataframe/table UX          | ❌     | No table renderer anywhere. No plotting lib in any `package.json`. Closest is a pandas `_repr_html_` passthrough in `notebook-cell.tsx:79`                                                                                                     |
| **76** | Large-file streaming        | ❌     | `file/index.ts:289` does `arrayBuffer()` → full base64; `GET /file/content` takes only `{path}`, no range. `read.ts:130` slurps the whole file _before_ applying offset/limit                                                                  |
| **18** | Environment reproducibility | 📄     | No lockfile, container, snapshot, or command-capture code. `Run.inputs` is declared and has no tool parameter                                                                                                                                  |
| **19** | Dataset/version integrity   | 🟡     | Provenance DAG is real, but `sha256()` hashes the node's canonical JSON, **not file bytes**. `Artifact.contentHash` never assigned. No manifests, no remote sync                                                                               |

## The differentiating model pack

Item 6 and its seven components, shipped as one pack. **RFdiffusion, ProteinMPNN, LigandMPNN, and foldseek
return zero hits repo-wide** — the pack is emptier than the skill count suggests.

| #      | Component                                 | Status | Current state                                                                 |
| ------ | ----------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| **6**  | Protein model pack (umbrella)             | 📄     | —                                                                             |
| **37** | ESM embeddings/search                     | 📄     | `skills/biology/esm/` — SKILL.md + 4 references, **no scripts**, no TS        |
| **38** | ESM inverse folding / sequence design     | 📄     | 3 markdown files                                                              |
| **39** | Chai-1/Chai-2 structure + antibody design | 📄     | No dedicated skill; documented indirectly via `coding/rowan/`. Chai-2: 0 hits |
| **40** | AlphaFold Server submission               | ❌     | Read path only (AFDB connector). 0 hits for submission                        |
| **41** | Boltz-2 structure + binding affinity      | 📄     | No dedicated skill; indirect via `coding/rowan/references/`                   |
| **43** | RFdiffusion binder/backbone generation    | ❌     | **0 hits repo-wide**                                                          |
| **44** | ProteinMPNN/LigandMPNN                    | ❌     | **0 hits repo-wide**                                                          |

## Reliability the connector layer already needs

| #       | Item                                          | Status | Current state                                                                                                                                                                                                                                          |
| ------- | --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **97**  | Connector conformance tests                   | 🟡     | 5 test files in `test/science/` cover 42 connectors — against 131 test files in `backend/cli/test` overall, so this is a coverage gap, not a testing-culture gap. Nothing iterates the registry to assert the contract                                 |
| **98**  | Rate-limit handling + persistent cache        | 🟡     | `connectors/http.ts` **has** retry, backoff, `Retry-After`, and per-host throttling — but `rateLimit` is opt-in and set by **1 of 42** connectors (arXiv). Cache is an in-process `Map`, 5-min TTL, dies with the process. Closer to config than build |
| **99**  | Typed scientific errors                       | 🟡     | Two ad-hoc string tags derived by regex on the message (`science.ts:97`) plus one `HttpStatusError` class. No taxonomy                                                                                                                                 |
| **110** | Observability                                 | 🟡     | Have: bus-event telemetry, token/cost accounting, rotating file logs. Missing: **traces don't exist** — the OTel flag has no dependency, tracer, or exporter, so no span is emitted. Provider-failure telemetry: 0                                     |
| **109** | Citation/provenance/artifact regression tests | 🟡     | One citation assertion (`science-tool.test.ts:81`). **Zero** tests for provenance or artifacts                                                                                                                                                         |
| **78**  | Error recovery UX                             | 🟡     | Generic recovery is real (`pages/error.tsx`, `stale-build-recovery.ts`, `DisconnectedPanel`). **No per-tool-failure affordance** — no retry/fix/run-smaller on a failed tool call                                                                      |

## Making the work legible

| #      | Item                             | Status | Current state                                                                                                                                                                                 |
| ------ | -------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **68** | Live agent timeline              | 🟡     | Pieces render inside the chat transcript (todo/plan parts, sub-agent tool lists, artifact envelopes). No combined view. A retired `timeline` mode exists as dead code in `AtlasCanvas.tsx:45` |
| **70** | Claim cards with evidence status | 🟡     | Backend model is real: `NodeKind` includes `claim`, edges `supports`/`refutes`, `Finding{claim,issue,severity,evidence}`. **No UI** — 0 hits repo-wide for `contradicted` or `unchecked`      |

---

# P2 — Then

Fifty items: **0 done · 8 partial · 21 skill-only · 21 missing.**

## Coverage expansion (21, 22 are the meta-goals over these)

Every pack below is 📄 or ❌. The parenthetical counts how many named tools in each item actually have a skill.

| #      | Pack                                                            | Status | Coverage                                                                                                                |
| ------ | --------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| **23** | Scanpy, Seurat/R, scVI, CellTypist, Geneformer, scGPT, CellRank | 📄     | **2 of 7** (scanpy, scvi-tools). CellTypist/Geneformer/scGPT: 0 hits. Seurat: mentions only                             |
| **24** | DESeq2, edgeR, limma, GSEA, fgsea, WGCNA                        | 📄     | **1 of 6** (pydeseq2). edgeR/fgsea/WGCNA: 0 hits                                                                        |
| **25** | GATK, bcftools, samtools, bwa, minimap2, STAR, Salmon, Kallisto | 📄     | **2 of 8** (pysam, deeptools). bwa/minimap2/STAR/Salmon: 0 hits                                                         |
| **26** | Nextflow/nf-core workflows                                      | ❌     | 4 incidental mentions. nf-core: 0 hits                                                                                  |
| **27** | Snakemake                                                       | ❌     | Same 4 files                                                                                                            |
| **28** | TCGA/GDC, cBioPortal, LINCS/L1000, PRIDE, MetaboLights, MassIVE | ❌     | LINCS/L1000/MetaboLights/MassIVE: 0 hits. No GDC API code                                                               |
| **29** | SRA/ENA full workflows                                          | 📄     | ENA metadata search doc only. No download, validate, or pipeline launch. No SRA skill                                   |
| **31** | Clinical trial intelligence (absorbs **87**)                    | 📄     | `clinicaltrials-database` skill + a domain allowlist entry. Endpoint comparison absent                                  |
| **32** | Open Targets workflows beyond lookup                            | 🟡     | Connector is real and reachable via `science_search`. The 7 workflows beyond lookup are skill-only                      |
| **33** | Assay templates: dose-response, IC50, QC, plate norm            | 📄     | `pharmacology-wetlab/scripts/dose_response.py` (4PL, IC50/EC50). Plate norm / Z'-factor: 0 hits                         |
| **34** | Microscopy: Cellpose, Stardist, Napari, QuPath, MONAI           | 📄     | **1 of 5** (Cellpose). Stardist/Napari/MONAI: 0 hits                                                                    |
| **35** | Mass spec: MaxQuant, OpenMS, DIA-NN                             | 📄     | **1 of 3** (pyopenms). DIA-NN: 0 hits                                                                                   |
| **36** | Cheminformatics: RDKit, ADMET, retrosynthesis, optimization     | 📄     | 8 skills. Retrosynthesis is reference-only. (The RDKit WASM in the frontend is a 2D depiction renderer, not a pipeline) |
| **21** | 100+ scientific tools/packages                                  | 🟡     | 42 connectors + 293 skills today. **Note: the bottleneck is reachability, not count** — see "Wire what exists"          |
| **22** | Workflow packs across all domains                               | 📄     | Meta-goal over 23–36                                                                                                    |

## Model integrations, second wave

| #      | Item                                                             | Status | Current state                                                                   |
| ------ | ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| **42** | ColabFold/OpenFold local runners                                 | ❌     | 4 passing mentions, no skill                                                    |
| **45** | DiffDock/GNINA/AutoDock Vina docking                             | 📄     | `chemistry/diffdock/` + `molecular-docking/` with scripts. GNINA: mentions only |
| **46** | OpenMM/GROMACS/AMBER molecular dynamics                          | ❌     | Mentions only, no skill, 0 TS hits                                              |
| **48** | DeepChem/TDC benchmark runners                                   | 📄     | Both have skills with scripts                                                   |
| **50** | Enformer, Borzoi, Nucleotide Transformer, DNABERT, HyenaDNA, Evo | ❌     | **0 hits repo-wide for all six**                                                |

## Compute depth

| #      | Item                                                 | Status | Current state                                |
| ------ | ---------------------------------------------------- | ------ | -------------------------------------------- |
| **54** | GPU availability planner (VRAM, CUDA, region, price) | ❌     |                                              |
| **56** | Spot/preemptible checkpointing                       | ❌     | Needs **51**                                 |
| **60** | Container builder/cache with CUDA base images        | 📄     | CUDA images appear only in Modal skill prose |
| **62** | Dataset locality planner                             | ❌     | No code, no skill, no doc                    |
| **63** | Workflow runners: Argo, Cromwell/WDL, Seqera         | ❌     |                                              |

## UX parity

| #      | Item                                                  | Status | Current state                                                                                                                                                             |
| ------ | ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **65** | Research mission-control dashboard                    | 🟡     | `pages/home.tsx` (990 lines) is a project **launcher**, not run/cost monitoring                                                                                           |
| **66** | Command palette for scientific actions                | 🟡     | **Palette already ships** — ⌘K, both routes, e2e-tested. Has 3 generic commands. Needs a command registry, not a palette. **One of the cheapest wins on the list**        |
| **67** | Workflow gallery                                      | 🟡     | `atlas/SkillsPage.tsx` is a category-shelved skill catalog, reachable as the Skills tab. No "gallery"; the 5 named workflows are skill markdown                           |
| **69** | Side-by-side source viewer + generated report         | ❌     | `centerTabs.ts` is a single-active-tab model; only one pane renders at a time                                                                                             |
| **71** | Scientific report composer with citations and figures | 📄     | Needs **11**                                                                                                                                                              |
| **72** | Figure/table gallery + export (PDF, DOCX, LaTeX, PPT) | 📄     | `cli/cmd/export.ts` dumps session JSON only. Export lives in `skills/writing/*`                                                                                           |
| **73** | Inline molecule/protein/genome viewers everywhere     | 🟡     | Renderers built, only `kind:"image"` ever emitted. **Wiring, not building**                                                                                               |
| **74** | Credential + connector setup wizard                   | 🟡     | Credential half is real (`SetupDialog.tsx` 380 lines + `Credentials.tsx` 626 lines). Connector half is an MCP add/edit form — it does not cover the 42 science connectors |
| **75** | "What can I do with this file?" contextual actions    | ❌     | No per-file context menu; clicking a file just opens a doc tab                                                                                                            |
| **77** | Project templates with sample data                    | ❌     | 0 hits for sample data / starter project. The other half of **15**                                                                                                        |
| **79** | Shareable read-only research packets                  | ❌     | **The right shape for the sharing need** — curated artifacts, not the raw session transcript that **14** would publish                                                    |

## Self-serve connectors (no partnership required)

Open APIs or the customer's own credentials, so no business-development risk. Today `credentials.ts` declares
exactly **8** services (aws, github, gcp, literature, azure, modal, nvidia, openalex) plus a `custom:<name>`
escape hatch — none of the below.

| #      | Item                                    | Status | Current state                                                             |
| ------ | --------------------------------------- | ------ | ------------------------------------------------------------------------- |
| **84** | Synapse.org                             | ❌     | 0 hits                                                                    |
| **88** | Databricks                              | ❌     | 0 hits (MCP escape hatch available)                                       |
| **89** | Snowflake                               | ❌     | 0 hits (MCP escape hatch available)                                       |
| **90** | BigQuery                                | 📄     | One reference guide. Generic `gcp` credential lets a subprocess `bq` work |
| **91** | Box, Google Drive, SharePoint           | ❌     | 0 hits, no OAuth for any data platform                                    |
| **92** | Zenodo, Figshare, OSF, Dryad, Dataverse | ❌     | BibTeX/DOI examples only                                                  |
| **95** | Hugging Face datasets/models            | 📄     | 8 skills; `HF_TOKEN` is an env passthrough, not a credential slot         |
| **96** | Weights & Biases, MLflow, Neptune       | 📄     | **2 of 3** skills; `WANDB_API_KEY` passthrough. Neptune: 0 hits           |

## Safety and rigor

| #       | Item                                          | Status | Current state                                                                                                                                                                                                                                                                                                                                                     |
| ------- | --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **101** | Network/file permission profiles per project  | 🟡     | **File/tool side is already per-project** (12 tool scopes, project `openscience.json`, per-project persisted approvals). **Network side is global only** — that's the gap                                                                                                                                                                                         |
| **104** | PII/PHI detection before sending to providers | ❌     | 0 hits for `PHI\|HIPAA\|de-identif`. Good as defense-in-depth; **not sound as the compliance control that unlocks 30**                                                                                                                                                                                                                                            |
| **105** | License/terms checker                         | ❌     | 0 hits for `license` in `backend/cli/src`                                                                                                                                                                                                                                                                                                                         |
| **106** | Reproducibility checker                       | 🟡     | Provenance substrate only — it records, nothing verifies. Zero tests                                                                                                                                                                                                                                                                                              |
| **107** | Offline mode and local model fallback         | 🟡     | **Much further along than it looks.** Local models are fully wired: `provider/local.ts` (Ollama/LM Studio/llama.cpp/vLLM presets + discovery), `cli/cmd/local.ts`, settings route, docs, 3 test files. Only the offline switch and auto-fallback are missing. **Local inference is also the compliant path for item 30** — no third-party transfer, no DUA breach |
| **108** | Agent benchmark suite (Biomni-style)          | 🟡     | Real: 2 benches, adapters for both `openscience` and `claude-code`, actual run artifacts. Blocked: untracked by git, `.py` sources stripped to `.pyc`, no packaging. **"Land it in tree" means recovering source**                                                                                                                                                |

---

# P3 — Later / nice to have

Seventeen items: **0 done · 1 partial · 5 skill-only · 11 missing.** Deferred for four _different_ reasons —
read the reason, not the tier.

## Partner-gated — blocked on access, not engineering

**Items 7, 8, and 9 appeared in the original P0 Critical block; they are ranked here deliberately.** Benchling
is a docs-only skill, and 10x Genomics Cloud and BioRender return zero hits repo-wide. Nothing about them is
engineering-ready to start.

| #              | Item                                    | Status | Current state                                                                                         |
| -------------- | --------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| **7** / **81** | Benchling (ELN, LIMS, registry, assays) | 📄     | `skills/biology/benchling-integration/`                                                               |
| **8** / **82** | 10x Genomics Cloud                      | ❌     | 0 hits (`cellranger`, `spaceranger` too)                                                              |
| **9** / **83** | BioRender                               | ❌     | 0 hits                                                                                                |
| **85**         | Wiley Scholar Gateway                   | ❌     | 0 hits                                                                                                |
| **86**         | Medidata                                | ❌     | 0 hits                                                                                                |
| **93**         | LabArchives, Labguru, Quartzy           | 📄     | **1 of 3** (labarchive-integration)                                                                   |
| **94**         | Opentrons/Tecan/Hamilton                | 📄     | **Split this.** Protocol _export_ is fine; an _execution bridge_ puts an LLM on physical lab hardware |

## Legally structured — not merely "later"

| #      | Item                                    | Status | Why                                                                                                                                                                                                                                                                                                                                                    |
| ------ | --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **30** | dbGaP, UK Biobank, MIMIC, eICU adapters | 📄     | dbGaP/UKB: 0 hits; MIMIC/eICU appear only as datasets a Python lib loads from local disk. **dbGaP and UK Biobank DUAs generally prohibit third-party transfer — an LLM API call is a third-party transfer.** 104 cannot fix this by scanning. The tractable shape is BYO-environment + local inference (**107**) where OpenScience never sees the data |

## Prerequisite-gated

| #       | Item                                                 | Status | Waiting on                                                                                                                                                                                                          |
| ------- | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **20**  | Team/collab primitives (comments, roles, SSO, audit) | ❌     | No auth, roles, tenants, or members anywhere in `server/`. The server binds `127.0.0.1` with no inbound auth — reachability equals shell access. **Build this Atlas-mediated, not bolted onto the loopback server** |
| **80**  | Team review mode for scientific claims               | ❌     | Needs **11**, **70**, **20**. `session-review.tsx` reviews diffs, not claims                                                                                                                                        |
| **102** | Wet-lab action approval gates                        | ❌     | Only meaningful once **94** exists — don't build the bridge, don't need the gate                                                                                                                                    |

## Genuine nice-to-have

| #      | Item                                   | Status | Current state                     |
| ------ | -------------------------------------- | ------ | --------------------------------- |
| **47** | BioNeMo/NVIDIA NIM integrations        | ❌     | BioNeMo: 0 hits                   |
| **49** | Chemprop, Uni-Mol, MolMIM, MegaMolBART | ❌     | **0 hits repo-wide for all four** |

---

# Sequencing notes

**Do first.** The "Wire what already exists" table at the top. It is the only work on this roadmap that
converts audited PARTIALs into DONEs without designing anything, and several entries are a day each.

**Then, in this order.** 51 → 52 → (55, 61, 103) → 2. The job system is on the critical path for 17 of the 110
items and nothing about it is started. Use `bun:sqlite` for 52 — reaching for Postgres or Prisma breaks the
single-binary distribution model.

**Cheapest credibility win.** P0 Group A minus item 100 is three items, all small, all costing trust right
now: a provider you can connect that does nothing, a share button backed by `disabled = true`, and an
artifact store that silently drops your metadata.

**One substrate, three items.** Provenance (10), artifact management (13), and dataset integrity (19) all want
the same content-hash + manifest layer. `Artifact.contentHash` is already declared and never written — build
that layer once and all three land together.

**Consolidate before extending.** `tool/biology/database.ts` hand-rolls 7 tools duplicating registry
connectors, with its own fetch layer and no shared rate limiting. `tool/biology/notebook.ts` duplicates
`tool/notebook.ts`. Delete both before item 21 adds anything on top.

**Watch the finish rate, not the start rate.** The audit found ten independent instances of built-but-unwired
capability. That is this codebase's characteristic failure mode, and it is the main risk to this roadmap:
executing breadth-first would add to a layer that already has more unreached capability than reached.
Item **110** (observability) is what would tell you which features are actually being used.
