# Using Waypoint from Python

The CLI covers the standard paths. Drop to Python when you need a custom training loop, a different
head, or embeddings inside a larger pipeline.

## Package surface

`waypoint_bio` lazily re-exports:

```python
from waypoint_bio import (
    TaxonomicTokenizer,             # the tokenizer class
    load_tokenizer,                 # load one from a Hub id or local dir
    MicrobiomePretrainingDataset,   # causal-LM dataset
    MicrobiomeBenchmarkDataset,     # supervised dataset with targets/covariates
    load_waypoint_dataframe,        # read waypoint-format parquet/csv/tsv
    load_abundance_matrix,          # read a sample x taxa matrix
    matrix_to_waypoint_df,          # matrix -> waypoint format
)
```

Imports are deferred, so `import waypoint_bio` does not pull in torch.

## Loading a checkpoint directly with transformers

The tokenizer is custom and ships as remote code, so `trust_remote_code=True` is required for it.
The model itself is a stock GPT-2 and does not need it.

```python
from transformers import AutoTokenizer, AutoModel

tok = AutoTokenizer.from_pretrained("outpost-bio/Waypoint-45m", trust_remote_code=True)
model = AutoModel.from_pretrained("outpost-bio/Waypoint-45m")   # gated: needs HF_TOKEN
```

`trust_remote_code=True` executes the tokenizer code stored in the repo. Pin a revision when that
matters to you, so the code cannot change under a later run:

```python
tok = AutoTokenizer.from_pretrained(
    "outpost-bio/Waypoint-45m", trust_remote_code=True, revision="1664ab5"
)
```

`AutoModelForCausalLM` also works if you want the LM head for likelihood scoring or generation —
generation samples taxa, which is occasionally useful for probing what the model learned about
co-occurrence, but is not a validated use.

## Tokenizing by hand

```python
from waypoint_bio import load_tokenizer

tok = load_tokenizer("outpost-bio/Waypoint-6m")

lineage = "k__Bacteria; p__Firmicutes; c__Bacilli; o__Lactobacillales; f__Lactobacillaceae; g__Lactobacillus"
print(tok.tokenize(lineage))                    # ['g__Lactobacillus']
print(tok.convert_tokens_to_ids(["g__Lactobacillus"]))

# One sample = newline-separated lineages
sample = "\n".join([lineage, "k__Bacteria; p__Bacteroidota; g__Bacteroides"])
print(tok(sample)["input_ids"])
```

Checking whether a taxon is in vocabulary:

```python
vocab = tok.get_vocab()
"g__Lactobacillus" in vocab          # True for anything seen in Atlas
tok.convert_tokens_to_ids("g__Nonesuch") == tok.unk_token_id
```

`tok._extract(lineage)` applies the rank extraction and higher-rank fallback and returns the token
string, or `None`. It is private but stable across 1.0.x and is what the datasets and
`scripts/vocab_coverage.py` use.

## Building a dataset

```python
import pandas as pd
from waypoint_bio import MicrobiomePretrainingDataset, load_tokenizer, load_waypoint_dataframe
from waypoint_bio.dataset import try_load_token_std_means

df = load_waypoint_dataframe("dataset.parquet")
tok = load_tokenizer("outpost-bio/Waypoint-6m")
stats = try_load_token_std_means("outpost-bio/Waypoint-6m")   # None if absent

ds = MicrobiomePretrainingDataset(df, tok, max_length=512, token_std_means=stats)
ds[0]["input_ids"].shape        # torch.Size([512])
```

Each item is `[BOS] + z-score-ordered token ids + [EOS]`, right-padded.

Computing the ordering statistics for a corpus of your own:

```python
from waypoint_bio.dataset import compute_token_std_means

stats = compute_token_std_means(df, tok, show_progress=True)
stats.to_parquet("token_std_means.parquet")   # index name "token", columns mean/std
```

Drop that file next to a checkpoint and `embed`, `finetune`, and `benchmark` will pick it up.

## Embeddings without the CLI

```python
import torch
from transformers import AutoModel
from waypoint_bio.dataset import load_waypoint_dataframe, try_load_token_std_means
from waypoint_bio.embed import tokenize_for_embedding
from waypoint_bio.models import _pool
from waypoint_bio.tokenizer import load_tokenizer

model_id = "outpost-bio/Waypoint-45m"
df = load_waypoint_dataframe("dataset.parquet")
tok = load_tokenizer(model_id)
model = AutoModel.from_pretrained(model_id).eval()

samples = tokenize_for_embedding(df, tok, max_length=512,
                                 token_std_means=try_load_token_std_means(model_id))

input_ids = torch.stack([s["input_ids"] for s in samples])
attn = torch.stack([s["attention_mask"] for s in samples])

with torch.no_grad():
    hidden = model(input_ids=input_ids, attention_mask=attn).last_hidden_state
    emb = _pool(hidden, attn, "last_token")     # [n_samples, hidden_size]
```

`tokenize_for_embedding` preserves one output row per input row even when a row has no
in-vocabulary taxa, so `emb` stays aligned with `df.index`. Those rows encode as `[BOS][EOS]` and
their embeddings should be discarded, not interpreted.

## Custom heads

`waypoint_bio.models` provides the two heads used by `finetune` and `benchmark`:

```python
from waypoint_bio.models import ClassificationModel, RegressionModel

head = ClassificationModel(
    base_model=model,
    tokenizer=tok,
    label_dims=[3],                 # one entry per target column
    pooling_strategy="last_token",
    covariate_dim=0,                # width of the one-hot covariate block
    class_weights=None,             # list[torch.Tensor], one per target
)
```

Both pool `last_hidden_state`, concatenate the one-hot covariate block if present, and apply one
`nn.Linear` per target column. Multi-target classification masks label `-100` per target, so targets
with missing values in some rows are handled without dropping the row.

Pooling strategies: `mean` (mask-weighted average), `last_token` (last non-padding position — the
default and what the checkpoints were tuned for), `first_token` / `cls_token` (position 0, the BOS
token; weak in a causal LM).

## Loading Atlas and Compass

```python
from datasets import load_dataset

atlas = load_dataset("outpost-bio/Atlas", split="pretrain")       # 485,377 rows
atlas_bench = load_dataset("outpost-bio/Atlas", split="benchmark")  # 53,931 held out

compass = load_dataset("outpost-bio/Compass", "mastrorilli")
compass["train"], compass["validation"], compass["test"]
```

Atlas is ~5.6 GB. Stream it if you are only inspecting:

```python
atlas = load_dataset("outpost-bio/Atlas", split="pretrain", streaming=True)
first = next(iter(atlas))
```

Atlas rows carry `Taxa`, `Relative Abundances`, `Run Accession`, `Data Type`, `Sequencing Method`,
`Pipeline Version`, `Study Accession`. Filtering by `Data Type` or `Sequencing Method` before
pretraining is a reasonable way to build a modality-specific model; filtering by `Study Accession` is
how you would hold out whole studies.

Provenance: scraped from MGnify across pipeline versions v1.0–v5.0 and four modalities (16S amplicon,
whole-genome shotgun, metagenomic assembly, and metatranscriptomic), then filtered to a minimum
relative abundance of 1e-4 and a minimum of 10 taxa per sample. The pretrain/benchmark split is
random with `seed=42` — it is *not* a study-level holdout, so the Atlas `benchmark` split shares
studies with `pretrain`.

## Fine-tuning programmatically

There is no stable public function for the whole loop; `waypoint_bio.finetune` is written as a CLI
module. Two workable options:

1. Call the CLI with `subprocess` and read `finetune_results.json` — what the upstream webinar
   notebooks do.
2. Assemble it yourself from `MicrobiomeBenchmarkDataset` + `ClassificationModel`/`RegressionModel`
   and a `transformers.Trainer`, mirroring `benchmark.py`. Reuse `waypoint_bio.scoring.score_task`
   and `predictions_to_arrays` so your metrics match the published definitions.

```python
import json, subprocess

subprocess.run([
    "waypoint", "finetune",
    "--model", "outpost-bio/Waypoint-45m",
    "--data", "dataset.parquet",
    "--output_dir", "outputs/ft",
    "--task_type", "classification",
    "--target", "Group",
], check=True)

results = json.loads(open("outputs/ft/finetune_results.json").read())
print(results["test_score"], results["test_metrics"])
```

The upstream repo's `examples/webinar/` carries two worked notebooks — a regression walkthrough on
Compass task 6 and a classification walkthrough on task 8 that also plots PCA / t-SNE projections of
the embeddings against a logistic-regression baseline. Shared helpers live in `webinar_utils.py`.
