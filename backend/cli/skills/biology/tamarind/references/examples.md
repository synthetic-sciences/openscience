# Tamarind Bio — validated examples & output shapes

**The freshest example for any tool is the `exampleJob` field MCP `getJobSchema(<tool>)`
now returns** — an `{jobName, type, settings}` built from each param's example/default
(with an `exampleJobNote`; org-gated params you can't use are omitted, file params get
placeholder filenames). It's the best starting point, but **run `validateJob` on it
before submitting** — it's assembled from per-param examples, not a guaranteed-valid
payload, so a given tool's `exampleJob` can need a tweak. The payloads below are a
`validateJob`-confirmed fallback for REST callers or when you want a worked example.
Tool schemas evolve — if one stops validating, re-fetch with `getJobSchema(<tool>)` /
`GET /tools`. Sequences here are illustrative; swap your own.

**File params (`proteinFile`, `pdbFile`, `ligandFile`, …) need a real file value** —
either the **bare filename** of an uploaded file (`target.pdb` — NOT email-prefixed),
a prior-job output **path** (`JobName/out/x.pdb`), or
**inline PDB/SDF-format text** (multi-line `ATOM`/`HETATM` records). The
`<...>` placeholders below are NOT valid as written — replace them. **Do not put an
amino-acid sequence in a file param** — `validateJob` rejects it with
`File ... must be of types: ["pdb"]`. (A sequence goes in `sequence`, a structure
goes in a file param.)

`BASE = "https://app.tamarind.bio/api"`, `HEADERS = {"x-api-key": <key>}`.

## Self-check (run this first to confirm the skill works for you)

Read-only + dry-run, no submission, no cost. Confirms the discover → schema →
validate loop end-to-end:

```python
import os, requests
BASE, HEADERS = "https://app.tamarind.bio/api", {"x-api-key": os.environ["TAMARIND_API_KEY"]}

# 1. discovery reachable?
tools = requests.get(f"{BASE}/tools", headers=HEADERS).json()
assert isinstance(tools, list) and any(t["name"] == "alphafold" for t in tools), "tools endpoint"

# 2. validate a known-good payload (MCP validateJob; or skip if REST-only)
#    expect {"valid": true, ...}
```

With the MCP server: `validateJob(jobName="selfcheck", type="alphafold",
settings={"sequence": "MKTAYIAKQRQISFVKSHFSRQLEERLGLIE"})` → `valid: true`.

## Validated input payloads

### AlphaFold — monomer
```json
{ "sequence": "MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQAPILSRVGDGTQDNLSGAEKAVQVKVKALPDAQFEVVHSLAKWKR",
  "numModels": "1", "numRecycles": 3 }
```
Only `sequence` is required; everything else has a default. `numModels` is a string
dropdown (`"1"`–`"5"`).

### AlphaFold — multimer (colon-separated chains)
```json
{ "sequence": "MKTAYIAKQRQISFVKSHFSRQLEERLGLIE:DIQMTQSPSSLSASVGDRVTITCRASQSISSYLN" }
```
Join chains with `:`. No separate "multimer" flag — chain count drives it.

### Boltz-2 — sequence mode
```json
{ "inputFormat": "sequence",
  "sequence": "MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQAPILSRVGDGTQDNLSGAEKAVQVKVKALP" }
```
`inputFormat` is **required** (`"sequence"` / `"list"` / `"molecules"` / `"yaml"`).
Omitting it fails — see "What fails" below.

### DiffDock — protein + SMILES ligand
```json
{ "ligandFormat": "SMILES",
  "ligandSmiles": "CC(=O)Oc1ccccc1C(=O)O",
  "proteinFile": "<uploaded-path-or-inline-PDB-text>" }
```
`ligandFormat` chooses the conditional field: `"SMILES"` → `ligandSmiles`;
`"sdf/mol2 file"` → `ligandFile`. `proteinFile` is a file param — pass an uploaded
file's bare filename (`target.pdb`, not email-prefixed), a prior-job path
(`JobName/...`), or inline PDB text (see file-input rules in `api_reference.md`).

### Autodock Vina — protein + SMILES ligand (classical docking into a pocket)
```json
{ "receptorFile": "receptor.pdb",
  "ligandFormat": "smiles",
  "ligandSmiles": "CC(=O)Oc1ccccc1C(=O)O",
  "boxX": 15.19, "boxY": 53.903, "boxZ": 16.917,
  "width": 20, "height": 20, "depth": 20 }
```
Unlike DiffDock, Autodock Vina docks into a **fixed pocket**, so it requires a bounding
box (`boxX/Y/Z` center + `width/height/depth`, all required) and the receptor in
`receptorFile` (not `proteinFile`). Its `ligandFormat` enum is **lowercase**
(`"smiles"` / `"sdf"`) — different from DiffDock's `"SMILES"` / `"sdf/mol2 file"`, so
don't copy DiffDock's value across. `exhaustiveness` (default 8) is optional. `validateJob`-confirmed.

### ProteinMPNN — design residues on a backbone
```json
{ "pdbFile": "<uploaded-path-or-inline-PDB-text>",
  "designedResidues": { "A": "1 2 3 4 5" },
  "numSequences": 4, "modelType": "proteinmpnn" }
```
Requires `pdbFile` + `designedResidues` (per-chain, space-separated resnums).
`modelType` ∈ `proteinmpnn`/`ligandmpnn`/`solublempnn`/`hypermpnn`/`abmpnn`.
Note `designedChains` is `exclude:["api"]` — don't send it over the API.

### Batch (same tool, many jobs)
```json
{ "batchName": "screen-1", "type": "alphafold",
  "jobNames": ["s1", "s2"],
  "settings": [ { "sequence": "MKT..." }, { "sequence": "AVF..." } ] }
```

## What fails (and the exact error) — confirmed live

- **Boltz without `inputFormat`** → `valid:false`, `Missing required boltz field "inputFormat"`. Always check required fields with `getJobSchema` first; `sequence` alone is not enough for boltz/chai.
- **Building a submit from `validateJob`'s `normalized` blob** — `normalized` is informational (defaults filled in, sometimes platform-managed fields). Submit the clean `settings` you validated, not the normalized echo.
- **File param given a bare string that isn't a real path** → treated as INLINE file content (uploaded as `<email>/<jobname>-<param>.<ext>`), not a reference. To point at an existing uploaded file use its **bare filename** (`target.pdb` — do NOT email-prefix it; `{email}/{filename}` is the S3 key and 400s as not-uploaded), or `JobName/...` for a prior job's output. Referencing a path that doesn't exist → `File ... has not been uploaded`.

## Output shapes (describe, don't expect exact values)

Outputs are non-deterministic (seed/model/MSA) — reason about the *shape*, not
golden numbers.

- **Job row `Score`** (JSON string on completed jobs): tool-family dependent.
  - Folding (alphafold/boltz/chai/esmfold): `plddt`, `ptm`, and for complexes
    `iptm` plus interface metrics (`ipSAE_*`, `pDockQ_*`). Higher pLDDT/pTM = more
    confident; iptm/ipSAE gauge interface quality.
  - Other families carry their own metrics — read the keys, don't assume.
- **Results zip** (`POST /result` → presigned URL → GET): per-tool, typically the
  structure files (`rank_*.pdb` / `*.cif`), a scores CSV, and logs. Use
  `listJobFiles(jobName)` (MCP) to enumerate exact filenames before downloading.
- **`WeightedHours`** on the row is the billing unit (see `usage-statistics`).

To learn a specific tool's exact outputs, run one small job and `listJobFiles` it —
don't hardcode filenames, which vary by tool and version.
