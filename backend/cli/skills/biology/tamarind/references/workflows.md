# Tamarind Bio workflow recipes

End-to-end examples using plain `requests`. All use `BASE = "https://app.tamarind.bio/api"` and
`HEADERS = {"x-api-key": os.environ["TAMARIND_API_KEY"]}`. For exact request/response
shapes, fetch the spec at `https://app.tamarind.bio/openapi.yaml`.

The canonical loop is always: **discover → schema → validate → submit → poll → results**.

## 1. Fold a single sequence (AlphaFold)

```python
import os, time, requests
BASE = "https://app.tamarind.bio/api"
HEADERS = {"x-api-key": os.environ["TAMARIND_API_KEY"]}

# discover + confirm the tool exists (REST returns the full list; filter client-side)
tools = requests.get(f"{BASE}/tools", headers=HEADERS).json()
assert any(t["name"] == "alphafold" for t in tools)

job = {
    "jobName": "ubiquitin-fold",
    "type": "alphafold",
    "settings": {
        "sequence": "MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG",
        "numModels": "5",
        "numRecycles": 3,
        "useMSA": True,
    },
}
requests.post(f"{BASE}/submit-job", headers=HEADERS, json=job).raise_for_status()

# poll. GET /jobs?jobName= returns the job ROW directly (no "jobs" wrapper).
while True:
    row = requests.get(f"{BASE}/jobs", headers=HEADERS,
                       params={"jobName": "ubiquitin-fold"}).json()
    if row["JobStatus"] in ("Complete", "Stopped", "Deleted"):
        break
    time.sleep(30)

print("status:", row["JobStatus"], "score:", row.get("Score"))

# results download is two-step: POST /result returns a presigned URL *string*,
# then GET that URL for the zip.
url = requests.post(f"{BASE}/result", headers=HEADERS,
                    json={"jobName": "ubiquitin-fold"}).text.strip('"')
open("ubiquitin-fold.zip", "wb").write(requests.get(url).content)
```

## 2. Multimer / complex (colon-separated chains)

For AlphaFold, a multimer is just one `sequence` with chains joined by `:`.

```python
job = {
    "jobName": "ab-ag-complex",
    "type": "alphafold",
    "settings": {
        # heavy:light:antigen — separate chains with ":"
        "sequence": "EVQLVESGGG...:DIQMTQSPSS...:MKTAYIAKQR...",
    },
}
requests.post(f"{BASE}/submit-job", headers=HEADERS, json=job).raise_for_status()
```

Other folding tools need more fields — `boltz`/`chai` require `inputFormat`
(`"sequence"`/`"list"`/`"molecules"`/`"yaml"`), e.g. boltz sequence-mode is
`{"inputFormat": "sequence", "sequence": "...:..."}`. **Always check required
fields with `getJobSchema`/`validateJob` first** — don't assume `sequence` alone
is enough.

## 3. Validate before submitting (MCP)

When your agent host has the Tamarind MCP server, dry-run first to catch errors
without spending a submission. Validate and submit **your own clean settings** —
build the submit from `my_settings`, not `verdict["normalized"]` (normalized is
informational: defaults filled in, sometimes platform-managed fields).

```
getJobSchema(jobType="boltz")               # learn required fields first
my_settings = {"inputFormat": "sequence", "sequence": "...:..."}
verdict = validateJob(jobName="x", type="boltz", settings=my_settings)
# verdict.valid == True  -> good; submit my_settings (NOT verdict.normalized)
# verdict.valid == False -> verdict.error is the first problem to fix
if verdict["valid"]:
    submitJob(jobName="x", type="boltz", settings=my_settings)
```

## 4. Upload a structure, then submit a job that uses it

```python
# REST: PUT the file to /upload/{filename}
with open("target.pdb", "rb") as fh:
    requests.put(f"{BASE}/upload/target.pdb", headers=HEADERS, data=fh).raise_for_status()
# the object's S3 key is "{your-email}/target.pdb", but you reference it by the
# BARE filename — the platform scopes it to your account. Do NOT email-prefix it.
job = {
    "jobName": "dock-run",
    "type": "diffdock",
    "settings": {
        "proteinFile": "target.pdb",   # bare filename, NOT inline content, NOT email-prefixed
        "ligandFormat": "SMILES",                       # required; gates ligandSmiles vs ligandFile
        "ligandSmiles": "CC(=O)Oc1ccccc1C(=O)O",
    },
}
requests.post(f"{BASE}/submit-job", headers=HEADERS, json=job).raise_for_status()
```

MCP variant: `uploadFile("target.pdb")` returns a presigned `uploadUrl`; then
`curl -X PUT -T target.pdb "<uploadUrl>"`.

**Reminder:** a bare *non-filename* string in a file-typed field is uploaded as inline content.
To point at an existing uploaded file, use its **bare filename** (`target.pdb`) — NOT the
`{email}/{filename}` S3-key form, which `submit-job` 400s as `"... has not been uploaded"`.
Confirm the registered name with `getFiles`/`GET /files`. For a prior job's output, use `JobName/...`.

For `autodock-vina` instead of DiffDock, the same upload-then-reference flow applies, but the
settings differ: it docks into a fixed pocket, so it needs `receptorFile` + a bounding box
(`boxX/Y/Z`, `width/height/depth`) and a **lowercase** `ligandFormat` (`"smiles"`/`"sdf"`).
Run `getJobSchema("autodock-vina")` for the full shape; see `examples.md` for a worked payload.

## 5. Chain jobs: design → fold

A sequence-design tool (ProteinMPNN) emits **sequences**, so you fold them by
passing each as a `sequence` — NOT via a template/file field. The cleanest way is
the MCP `submitBatch(fromJob=...)`, which reads the design job's generated
sequences and folds each as one job in a single call:

```
# Step 1: design sequences for a backbone
submitJob(jobName="design-step", type="proteinmpnn", settings={...})   # poll to Complete

# Step 2: fold every designed sequence (MCP reads them from the design job)
submitBatch(batchName="fold-designs", type="alphafold", fromJob="design-step")
```

Doing it over plain REST instead: read the design job's output sequences (MCP
`listJobFiles("design-step")` → `s3Path`, or download the FASTA via `/result`),
then submit one fold per sequence with `settings={"sequence": "<designed seq>"}`.

**Don't chain a designed sequence through a file/template field.** A file
parameter wants a *file of the right type*, and a template field is for structural
homology, not "fold this sequence." Example of the trap: AlphaFold's
`templateFiles` accepts only `.cif`, must be a **list**, and is gated behind
`templateMode: "custom"` — so `{"templateFiles": "design-step/out/x.pdb"}` fails
validation three ways and isn't how you fold a design anyway. When a chain really
does feed a file (e.g. a PDB into a docking tool), `getJobSchema`/`validateJob`
first to confirm the param's type and conditions.

For reusable multi-step flows, build a saved pipeline with `/submit-pipeline`
and run it with `/run-pipeline`.

## 6. Batch screen many sequences through one tool

Submit, then poll the batch **parent** on `batchStatus` (not subjob `JobStatus`)
— the batch aggregates results after subjobs finish computing.

```python
seqs = ["MKT...", "AVF...", "GEV..."]
requests.post(f"{BASE}/submit-batch", headers=HEADERS, json={
    "batchName": "binder-screen",
    "type": "alphafold",
    "jobNames":  [f"cand-{i}" for i in range(len(seqs))],
    "settings":  [{"sequence": s} for s in seqs],
    "weightedHoursBudget": 50,        # optional budget cap
}).raise_for_status()

# poll the parent until the aggregated output is ready
# (?jobName= returns the parent ROW directly — no "jobs" wrapper)
while True:
    parent = requests.get(f"{BASE}/jobs", headers=HEADERS,
                          params={"jobName": "binder-screen"}).json()
    bs = parent.get("batchStatus")
    if bs == "Complete":
        break
    if bs in ("Stopped", "AggregationFailed"):
        raise RuntimeError(parent.get("AggregationError", bs))
    time.sleep(15)        # Running / Aggregating -> keep waiting

print(parent["statuses"])  # e.g. {"Complete": 3, "Running": 0, "In Queue": 0, "Stopped": 0}
open("binder-screen.zip", "wb").write(requests.get(parent["resultUrl"]).content)

# Per-subjob rows (e.g. to read each candidate's Score):
subjobs = requests.get(f"{BASE}/jobs", headers=HEADERS,
                       params={"batch": "binder-screen", "includeSubjobs": "true"}).json()
```

## 7. Debug a stopped job

```python
# REST: pull results/log path; MCP gives logs directly
logs = getJobLogs("binder-screen-cand-2")   # MCP: last N lines of output log
# Inspect the tail for the failure reason (bad input, OOM, timeout, budget).
```

A `Stopped` status with no `Score` usually means a failure — read the log tail.
A `403` at submit means a budget cap was hit.

## 8. List every job (paginate past the 1000 limit)

The list query returns `{"jobs": [...], "startKey": ...}`; pass `startKey` back
until it's absent.

```python
jobs, params = [], {"limit": 1000}
while True:
    resp = requests.get(f"{BASE}/jobs", headers=HEADERS, params=params).json()
    jobs += resp["jobs"]
    if "startKey" not in resp:
        break
    params["startKey"] = resp["startKey"]
print(len(jobs))
```

## 9. Submit now, check back later (non-blocking)

Bio jobs run for minutes to hours — you don't have to hold a blocking poll loop
open. Jobs are addressable by `jobName` from any process, so submit, **persist the
names**, and reconnect in a separate session/process to collect results. This is the
right pattern for long campaigns or fire-and-forget pipelines.

```python
# --- Session 1: submit and save the job names ---
import os, json, requests
BASE = "https://app.tamarind.bio/api"
HEADERS = {"x-api-key": os.environ["TAMARIND_API_KEY"]}

seqs = {"cand-a": "MKT...", "cand-b": "AVF...", "cand-c": "GEV..."}
for name, seq in seqs.items():
    requests.post(f"{BASE}/submit-job", headers=HEADERS,
                  json={"jobName": name, "type": "alphafold",
                        "settings": {"sequence": seq}}).raise_for_status()
json.dump(list(seqs), open("pending_jobs.json", "w"))   # persist to disk/db
print("submitted; check back later")
```

```python
# --- Session 2 (later, fresh process): collect whatever is done ---
import os, json, requests
BASE = "https://app.tamarind.bio/api"
HEADERS = {"x-api-key": os.environ["TAMARIND_API_KEY"]}

names = json.load(open("pending_jobs.json"))
done, pending = [], []
for name in names:
    row = requests.get(f"{BASE}/jobs", headers=HEADERS,
                       params={"jobName": name}).json()   # bare row, by-name
    (done if row["JobStatus"] in ("Complete", "Stopped", "Deleted") else pending).append(name)

print(f"{len(done)} terminal, {len(pending)} still running")
for name in done:
    url = requests.post(f"{BASE}/result", headers=HEADERS,
                        json={"jobName": name}).text.strip('"')
    open(f"{name}.zip", "wb").write(requests.get(url).content)
```

Re-run session 2 until `pending` is empty. For a server-driven variant, poll a batch
parent's `batchStatus` (recipe 6) instead of looping job-by-job.

## Notes

- **Polling cadence:** 15-30s. `Complete` and `Stopped` are terminal.
- **Scores:** completed folding jobs return pLDDT / pTM / ipTM (and interface
  metrics like ipSAE / pDockQ for complexes) in the `Score` field.
