# Tamarind Bio tool catalog

Tamarind exposes hundreds of tools through one uniform job API. The catalog changes frequently — **always enumerate at runtime** with `GET /tools` (or MCP `getAvailableTools`) rather than hardcoding names. This file is a map for interpreting what you get back.

## How to discover

**REST** `GET /tools` returns the **full list** (it does not filter server-side). Filter client-side:

```python
tools = requests.get(f"{BASE}/tools", headers=HEADERS).json()      # a list
docking = [t for t in tools if "vina" in t["name"].lower()]
```

Each REST tool entry carries: `name` (the `type` you submit), `displayName`, `description`, `github`, `paper`, and `settings` (the inline parameter schema). REST entries do **not** include `categories`/`tags`.

**MCP** `getAvailableTools(search=..., modality=..., function=...)` filters server-side and returns entries with `categories` and `tags` (`category`/`tag` are deprecated aliases of `modality`/`function`, still honored).

## Modalities and functions (the two filter axes)

Don't hardcode the filter vocabulary — it drifts as tools are added. Fetch it live: `listModalities()` returns the molecule-type axis (protein, antibody, enzyme, peptide, nucleic-acid, small-molecule, small-molecule-binding-protein, cryoem, …); `listTags()` returns the function axis (structure-prediction, protein-design, binder-design, protein-ligand-docking, binding-affinity, inverse-folding, developability, molecular-dynamics, finetuning, …). Each entry carries `value`, `label`, `description`, and a live `toolCount`. Every `getAvailableTools` response also includes `availableCategories` / `availableTags` arrays computed from the current catalog. Filter with `getAvailableTools(modality=..., function=...)`.

## Representative tool families

Verify exact names and availability with `/tools` — these are common anchors, not an exhaustive or guaranteed list.

**Structure prediction / folding**
- `alphafold` — AlphaFold; monomer + multimer, MSA + templates, recycles, relaxation.
- `boltz` — Boltz-2; structure + affinity, biomolecular complexes incl. ligands.
- `chai` — Chai-1; complex structure prediction with optional MSA.
- `esmfold` / `esmfold2` — fast single-sequence folding.

**Protein / binder design**
- `rfdiffusion` — protein/binder design and motif scaffolding.
- `boltzgen` — generative design.
- `bindcraft` — binder design.
- `proteinmpnn` / `ligandmpnn` — inverse folding (sequence given backbone; ligand-aware variant).

**Docking / affinity**
- `boltz` / `chai` — co-fold the ligand into the complex (predict the bound structure); the default for protein-small-molecule docking.
- `autodock-vina` — classical docking into a known pocket; the pick for fast, large-scale screening.
- Boltz/affinity tools — binding-affinity prediction.

**Antibody**
- Antibody language models and generators, humanization, developability, immunogenicity scoring.

**MSA / utilities**
- MSA generation tools feed downstream folding; utilities cover format conversion, scoring, and analysis.

## Reading a tool schema

`getJobSchema(jobType)` (MCP) or the `/tools` entry returns a `parameters` list. Each parameter has:

- `name`, `type` (`sequence`, `number`, `boolean`, `dropdown`, file types like `pdb`/`cif`/`sdf`, …)
- `descr`, `displayName`
- `required`, `default`
- `options` / `optionsDescr` (for dropdowns), `lowerBound` / `upperBound` / `lengthLimit`
- `conditionals` — applies only when another field has a given value
- `exclude` (`["api"]` / `["batch"]`) — omit on that surface
- `list: true` — accepts multiple values/files
- `example` — a sample value

(Org-gated parameters are filtered server-side: `getJobSchema` drops a param your account isn't authorized for and never returns the old `restrictOrgs` key.)

Top-level tool metadata also includes a `hint`, and `getJobSchema` returns an `exampleJob` built from each parameter's example/default — start from that (then `validateJob` it) rather than hand-building `settings`.

Always read the schema before constructing `settings`, and run `validateJob` to confirm before `submitJob`.
