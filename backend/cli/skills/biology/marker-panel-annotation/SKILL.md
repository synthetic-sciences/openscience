---
name: marker-panel-annotation
description: Assigns cell-type labels to clusters from a protein marker panel (multiplexed imaging such as MIBI, CODEX, IMC and CyCIF; mass and flow cytometry; CITE-seq protein), where the labels are judged against an expert reference. Within-dataset normalisation of cluster summaries, lineage first by positive defining markers, subtype only as far as the panel can determine it, marker-poor clusters assigned by exclusion, class-coverage sanity checks, and two independent annotators with adjudication. Use when the output is one label per cluster and the grader is agreement with an expert; for gating single cells in FCS data use flow-cytometry-analysis, and for transcript-based annotation use scanpy or scvi-tools.
summary: "Cluster labels from a marker panel: lineage by positive markers, subtype only as far as the panel determines it, marker-poor by exclusion, two annotators."
category: biology
tags: [Cell Type Annotation, Multiplexed Imaging, MIBI, CODEX, IMC, Cytometry, Immunophenotyping]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Marker-panel cluster annotation

An expert annotating clusters from a marker panel gets two things right that a
first-pass reading gets wrong: the *level* at which each label is stated, and
the clusters that carry almost nothing. Both directions cost equally under an
expert-agreement grader: a subtype the panel cannot support scores like a
wrong lineage, and a broad label where the panel determines the subtype
scores like a miss. Everything below follows from that.

## 1. Summarise within the dataset, never across

- Work one dataset (panel, platform, run) at a time. Intensities are not
  comparable across platforms or panels; a threshold or z-score computed on
  the pooled data is wrong for every dataset in it.
- For each cluster and marker compute three summaries: the mean or median
  intensity, the z-score of that cluster's mean across the clusters of the
  same dataset (which marker is *high for this dataset*), and the fraction of
  the cluster's cells above a per-marker positivity cut taken from the
  marker's own distribution (a bimodal split, or a high percentile of the
  whole dataset when the marker is unimodal). Read all three: a marker with a
  modest mean but 80% of cells positive is a positive marker.
- Print the full cluster-by-marker table before labelling anything. Decide
  from the table, not from the first two markers that come to mind.

## 2. Lineage first, by positive defining markers

Assign the broad lineage from the markers that define it positively, in this
order of precedence, each one excluding the ones below unless the panel says
otherwise:

| Lineage | Defining positives | Typical negatives |
| --- | --- | --- |
| Tumour / epithelial | the tumour's own markers in the panel: pan-cytokeratin, E-cadherin, EpCAM for carcinoma; SOX10, MelanA/MART-1, S100, HMB45 for melanoma; CD30 with CD15 and weak PAX5 for Hodgkin Reed-Sternberg cells; Ki-67 often high | CD45, CD3, CD20, CD68 |
| T cell | CD3 with CD4 or CD8; FoxP3 (and CD25) for regulatory; CD4 and CD8 together for double-positive | CD20, CD68 |
| B cell / plasma | CD20, CD19, PAX5; CD138 (and CD38, IRF4/MUM1) for plasma cells, which lose CD20 | CD3 |
| NK | CD56, CD57, granzyme B without CD3 | CD3 |
| Myeloid: macrophage / monocyte / DC | CD68, CD163, CD14, CD11b, CD11c, HLA-DR; CD11c with HLA-DR and without CD68 for dendritic cells; CD123 or CD303 for plasmacytoid DC | CD3, CD20, cytokeratin |
| Granulocyte / mast | CD15 or CD66b (neutrophil), CD117 or tryptase (mast), eosinophil peroxidase | CD3, CD68 |
| Endothelium | CD31, CD34, VWF; podoplanin or LYVE-1 for lymphatic | keratin |
| Fibroblast / stroma / smooth muscle | vimentin, collagen I, PDGFR-β, FAP; α-SMA (with desmin for muscle) | CD45, keratin |

Read the panel first and write down which of these markers it actually
contains; the table above is a menu, not a checklist. A lineage whose
defining marker is absent from the panel can only be inferred by exclusion
(section 4).

## 3. Specificity is bounded by the panel

A subtype label is correct only when the panel contains the marker that
defines the subtype and the cluster is positive for it. The rule cuts both
ways and both cuts are scored:

- **Do not state what the panel cannot show.** "Memory CD4 T cell" needs
  CD45RO (or CD45RA-negative with CCR7 or CD27 read); "naive" needs CD45RA
  and CCR7; "exhausted" needs PD-1 with TIM-3, LAG-3 or TOX; "cytotoxic CD8"
  needs granzyme or perforin beside CD8; "activated" needs Ki-67, HLA-DR or
  CD69 on the lineage. With none of the defining markers present, the
  correct label is the lineage ("CD4+ T cell", "macrophage"), and the finer
  word is a guess the grader charges for. T-cell differentiation states in
  particular are stated conservatively: expert references keep "CD4+ T cell"
  unless the memory or naive marker is unambiguous and the reference scheme
  uses that level.
- **Macrophage polarisation is read on the CD163 axis.** In imaging panels
  the conventional split is CD68+ CD163-high → M2 (macrophage) and CD68+
  CD163-low or negative → M1 (macrophage); HLA-DR, CD86, iNOS or CD80 refine
  it when present but are not required. When CD163 is in the panel and CD68+
  clusters separate on it, every macrophage cluster gets a polarised label;
  "macrophage" alone is the label only when CD163 is absent from the panel or
  the cluster is genuinely intermediate.
- **The tumour gets its own name.** When the vocabulary carries the disease's
  own malignant-cell term (a Hodgkin Reed-Sternberg cell, a melanoma cell, a
  plasma cell in myeloma), that term is the label for the tumour clusters;
  the generic "tumor cell" is for a vocabulary that has nothing more
  specific.
- **Do state what the panel does show.** When the panel carries the
  polarisation or functional markers and the cluster is clearly positive
  for one side (CD163 on CD68+ cells; FoxP3+ CD4+ → regulatory; granzyme B+
  CD8+ → cytotoxic; CD56 or CD57 without CD3 → NK, never a granulocyte),
  retreating to the broad label loses the credit the evidence earned. Write
  the subtype and cite the marker in the evidence file.
- When the two sides of a polarisation axis are both positive or both
  absent, the lineage label is the honest one.

## 4. Marker-poor clusters: assign by exclusion, not by abundance

Every dataset has clusters that are low on everything. They are the clusters
that decide a 0.95 agreement gate.

- A cluster negative for the tumour's defining markers is **not tumour**,
  however many tumour cells the tissue holds and however large the cluster.
  Abundance is not evidence; a positive marker is.
- A cluster negative for the lymphoid markers (CD3, CD20, CD56) and for
  epithelial and stromal markers, with even low-level CD68, CD163, CD14,
  CD11c or HLA-DR, is a **marker-poor myeloid** cluster (macrophage/DC in a
  coarse scheme). Myeloid populations are the classic low-signal lineage in
  imaging panels; when the scheme has one myeloid class, this is where the
  marker-poor cluster goes.
- Cell size and shape help as tie-breakers where the table has them: tumour
  and macrophage cells are large, lymphocytes small; a large marker-poor
  cluster with vimentin is stroma, with CD68 traces is myeloid.
- The scheme's generic "unassigned" or "other" label is for a cluster whose
  markers contradict each other or are uniformly at background, and for
  nothing else. A cluster whose lineage is clear but whose subtype is not
  gets the lineage.

## 5. Sanity checks before writing

- **Class coverage.** Every class the scheme names should appear on at least
  one cluster unless the tissue genuinely lacks it; a scheme with eight
  classes and a table with two of them unused is a table with mistakes in
  it. Look at which clusters could carry the missing class.
- **Prevalence plausibility.** Tumour clusters should hold most cells in a
  tumour section; T cells outnumber B cells in most solid tumours; regulatory
  T cells and dendritic cells are small clusters. A class assignment that
  makes 60% of a lymphoma section "endothelial" is wrong before any marker is
  re-read.
- **Spatial plausibility** when positions exist: tumour clusters form
  contiguous territories; immune clusters sit at borders and in aggregates;
  endothelium traces vessels.
- **Vocabulary exactness.** Copy each label byte for byte from the vocabulary
  file; a paraphrase scores zero. One label per cluster; every cluster
  labelled.

## 6. Two annotators, then adjudicate

Under an expert-agreement grader, label each dataset twice, independently,
by two workers who see the protocol, the vocabulary and the cluster-by-marker
table and not each other's calls, with the rare classes named to both before
they start. Then adjudicate every disagreement yourself by re-reading the
table for that cluster against sections 2–4 — never by majority, never by
splitting the difference. Record the deciding marker per cluster in an
evidence file beside the output; a call you cannot justify from a marker is
a call to revisit.

## Minimal table code

```python
import numpy as np, pandas as pd
df = pd.read_csv(path)                       # one row per cell: cluster + marker columns
markers = [c for c in df.columns if c not in ("cellLabel", "cluster")]
means = df.groupby("cluster")[markers].mean()
z = (means - means.mean()) / means.std(ddof=0)                     # high for this dataset
cuts = {m: np.percentile(df[m], 90) for m in markers}              # or a bimodal split per marker
frac = df.groupby("cluster")[markers].apply(lambda g: (g > pd.Series(cuts)).mean())
table = pd.concat({"mean": means, "z": z, "frac_pos": frac}, axis=1)
print(table.round(2).to_string())
```

## Pitfalls

- Several panels, one positivity threshold: every call on the dimmer panel
  shifts. Normalise per dataset.
- Differentiation words written from lineage markers alone ("memory",
  "naive", "exhausted" from CD4 and CD8); the broad word written where the
  panel carried the polarisation markers and they split the clusters cleanly.
- Marker-poor clusters called by the tissue's dominant class instead of by
  exclusion; they are usually myeloid.
- One annotator, one pass, against an agreement gate a second reader would
  have cleared: the wrong clusters are the ones two readers disagree on.
