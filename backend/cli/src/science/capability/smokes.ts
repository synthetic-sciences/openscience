import crypto from "node:crypto"
import { CapabilitySmoke } from "./schema"

export type SmokeProfile = {
  source: string
  contract: CapabilitySmoke
}

const RESULT = "capability-result.json"

const scripts = {
  scipy: `import json
from scipy.optimize import minimize
result = minimize(lambda x: (x[0] - 3.0) ** 2 + 2.0, [0.0], method="BFGS")
payload = {"schema_version": 1, "capability_id": "scipy", "ok": bool(result.success), "metrics": {"x": float(result.x[0]), "objective": float(result.fun)}}
open("${RESULT}", "w", encoding="utf-8").write(json.dumps(payload, sort_keys=True))
`,
  matplotlib: `import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image, ImageStat
fig, ax = plt.subplots(figsize=(3, 2), dpi=100)
ax.plot([0, 1, 2, 3], [0, 1, 4, 9], color="#3b82f6", linewidth=2)
fig.tight_layout()
fig.savefig("capability-figure.png")
plt.close(fig)
image = Image.open("capability-figure.png").convert("RGB")
variance = sum(ImageStat.Stat(image).var)
payload = {"schema_version": 1, "capability_id": "matplotlib", "ok": image.size == (300, 200) and variance > 1.0, "metrics": {"width": image.width, "height": image.height, "variance": variance}}
open("${RESULT}", "w", encoding="utf-8").write(json.dumps(payload, sort_keys=True))
`,
  "scikit-learn": `import json
from sklearn.datasets import load_iris
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
x, y = load_iris(return_X_y=True)
x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=0.25, random_state=17, stratify=y)
model = LogisticRegression(max_iter=500, random_state=17).fit(x_train, y_train)
predictions = model.predict(x_test)
accuracy = float(accuracy_score(y_test, predictions))
payload = {"schema_version": 1, "capability_id": "scikit-learn", "ok": len(predictions) == 38 and len(set(predictions.tolist())) == 3 and accuracy >= 0.89, "metrics": {"accuracy": accuracy, "predictions": len(predictions), "classes": len(set(predictions.tolist()))}}
open("${RESULT}", "w", encoding="utf-8").write(json.dumps(payload, sort_keys=True))
`,
  biopython: `import json
from io import StringIO
from Bio import SeqIO
record = SeqIO.read(StringIO(">fixture\\nATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG\\n"), "fasta")
reverse = str(record.seq.reverse_complement())
translation = str(record.seq.translate(to_stop=True))
payload = {"schema_version": 1, "capability_id": "biopython", "ok": reverse == "CTATCGGGCACCCTTTCAGCGGCCCATTACAATGGCCAT" and translation == "MAIVMGR", "metrics": {"records": 1, "length": len(record.seq), "reverse_complement": reverse, "translation": translation}}
open("${RESULT}", "w", encoding="utf-8").write(json.dumps(payload, sort_keys=True))
`,
  rdkit: `import json
from rdkit import Chem
from rdkit.Chem import Descriptors, rdMolDescriptors
smiles = "Cn1c(=O)c2c(ncn2C)n(C)c1=O"
mol = Chem.MolFromSmiles(smiles)
formula = rdMolDescriptors.CalcMolFormula(mol)
weight = float(Descriptors.MolWt(mol))
writer = Chem.SDWriter("capability-molecule.sdf")
writer.write(mol)
writer.close()
roundtrip = next((item for item in Chem.SDMolSupplier("capability-molecule.sdf") if item is not None), None)
payload = {"schema_version": 1, "capability_id": "rdkit", "ok": formula == "C8H10N4O2" and 194.0 < weight < 195.0 and roundtrip is not None, "metrics": {"formula": formula, "molecular_weight": weight, "sdf_roundtrip": roundtrip is not None}}
open("${RESULT}", "w", encoding="utf-8").write(json.dumps(payload, sort_keys=True))
`,
} as const

function contract(id: keyof typeof scripts, artifacts: string[], invariants: string[]) {
  return CapabilitySmoke.parse({
    id: `${id}-bounded-v1`,
    script_digest: crypto.createHash("sha256").update(scripts[id]).digest("hex"),
    language: "python",
    result_path: RESULT,
    artifacts,
    max_artifact_bytes: 1024 * 1024,
    timeout_seconds: 120,
    summary: invariants[0] ?? `${id} bounded smoke`,
    invariants,
  })
}

export type CoreSmokeID = keyof typeof scripts

export const CORE_SMOKES: Record<CoreSmokeID, CapabilitySmoke> = {
  scipy: contract("scipy", [RESULT], ["BFGS converges", "x is approximately 3", "objective is approximately 2"]),
  matplotlib: contract(
    "matplotlib",
    [RESULT, "capability-figure.png"],
    ["PNG signature", "300 by 200 pixels", "nonzero variance"],
  ),
  "scikit-learn": contract(
    "scikit-learn",
    [RESULT],
    ["38 predictions", "all three Iris classes", "accuracy at least 0.89"],
  ),
  biopython: contract("biopython", [RESULT], ["one FASTA record", "exact reverse complement", "exact translation"]),
  rdkit: contract(
    "rdkit",
    [RESULT, "capability-molecule.sdf"],
    ["caffeine formula", "molecular weight range", "SDF round trip"],
  ),
}

export const smokeProfiles: Record<CoreSmokeID, SmokeProfile> = {
  scipy: { source: scripts.scipy, contract: CORE_SMOKES.scipy },
  matplotlib: { source: scripts.matplotlib, contract: CORE_SMOKES.matplotlib },
  "scikit-learn": { source: scripts["scikit-learn"], contract: CORE_SMOKES["scikit-learn"] },
  biopython: { source: scripts.biopython, contract: CORE_SMOKES.biopython },
  rdkit: { source: scripts.rdkit, contract: CORE_SMOKES.rdkit },
}

export function capabilitySmokeScript(id: string) {
  const smoke = smokeProfiles[id as CoreSmokeID]
  if (!smoke) throw new Error(`Unknown packaged smoke capability: ${id}`)
  return smoke.source
}
