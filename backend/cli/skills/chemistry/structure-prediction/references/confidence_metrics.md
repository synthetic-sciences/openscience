# Confidence Metrics for Protein Structure Prediction

## pLDDT (predicted Local Distance Difference Test)

pLDDT is the primary per-residue confidence metric output by ESMFold (and AlphaFold2). It estimates the accuracy of each residue's predicted position relative to the true structure, based on the Local Distance Difference Test (lDDT) scoring scheme.

### Score Ranges and Interpretation

#### Very High Confidence: pLDDT > 90

- **What it means**: The model is highly confident in the predicted atomic positions for this residue. Both backbone and side-chain coordinates are expected to be accurate to within ~1-2 Angstroms of the true structure.
- **Typical regions**: Well-packed core residues, stable secondary structure elements (alpha helices, beta sheets), residues involved in strong intramolecular contacts.
- **Reliability**: Suitable for atomic-level analyses including molecular docking, binding site characterization, and detailed structural interpretation.

#### Confident: pLDDT 70-90

- **What it means**: The backbone topology is reliable, but side-chain rotamers may vary from the true structure. The predicted fold is likely correct at this position.
- **Typical regions**: Surface-exposed residues in stable secondary structures, well-defined loops with conserved contacts, moderately packed regions.
- **Reliability**: Backbone-level analyses are appropriate. Side-chain positions should be treated with some uncertainty. Useful for fold-level comparisons and general structural analysis.

#### Low Confidence: pLDDT 50-70

- **What it means**: The overall fold topology in this region may be approximately correct, but local structural details are uncertain. The model is not confident about the precise positions of atoms.
- **Typical regions**: Flexible loops, surface-exposed turns, regions with few intramolecular contacts, segments that adopt multiple conformations.
- **Reliability**: Only the general shape/topology should be considered reliable. Do not use for residue-level structural analysis. May indicate genuine structural flexibility rather than prediction error.

#### Very Low Confidence: pLDDT < 50

- **What it means**: The model has very low confidence in the predicted positions. The structure in this region should not be trusted for any quantitative analysis.
- **Typical regions**: Intrinsically disordered regions (IDRs), long flexible linkers, terminal tails, regions with no evolutionary or structural constraints.
- **Reliability**: These regions likely do not adopt a single stable structure in reality. The predicted coordinates are essentially meaningless at the atomic level. However, the *identification* of these regions as low-confidence is itself informative, as it suggests intrinsic disorder.

### Summary Table

| pLDDT Range | Confidence | Backbone | Side Chains | Use Cases |
|-------------|-----------|----------|-------------|-----------|
| > 90        | Very high | Accurate | Likely accurate | Docking, binding site analysis, mutagenesis design |
| 70 - 90     | Confident | Reliable | Approximate | Fold comparison, domain analysis, general structural biology |
| 50 - 70     | Low       | Approximate | Unreliable | Topology assessment only, loop modeling candidate |
| < 50        | Very low  | Unreliable | Unreliable | Disorder prediction, do not use for structural analysis |

## When to Trust Predictions

### High-Trust Scenarios

1. **Well-studied protein families**: If the target protein belongs to a family with many known structures, ESMFold's language model has likely learned the structural patterns well.
2. **Globular domains**: Compact, well-folded globular domains with pLDDT > 70 are generally reliable.
3. **Conserved structural motifs**: Catalytic sites, DNA-binding domains, and other evolutionarily constrained regions tend to be well-predicted.
4. **Short to medium sequences**: Sequences under 400 residues typically produce higher-quality predictions.

### Low-Trust Scenarios

1. **Intrinsically disordered proteins (IDPs)**: Proteins or regions that are natively unstructured will have low pLDDT but this is not a prediction "failure" -- it correctly identifies disorder.
2. **Membrane proteins**: Transmembrane regions may be predicted with moderate confidence, but the absence of a lipid bilayer context can affect accuracy.
3. **Multi-domain proteins with flexible linkers**: Individual domains may be well-predicted, but their relative orientation is often unreliable.
4. **Proteins with no homologs**: Novel folds with no detectable sequence similarity to training data are the hardest cases for ESMFold.
5. **Very long sequences (>800 residues)**: Prediction quality degrades for very long sequences due to memory constraints and model limitations.
6. **Metal-binding or cofactor-dependent structures**: Structures that require metal ions or cofactors for proper folding may be less accurately predicted.

## Comparison with AlphaFold2 Metrics

### pLDDT

Both ESMFold and AlphaFold2 use pLDDT as their primary per-residue confidence metric. The score ranges and interpretation are the same for both methods. However:

- **AlphaFold2 pLDDT** tends to be better calibrated because it leverages MSA information, which provides evolutionary constraints that improve both prediction accuracy and confidence estimation.
- **ESMFold pLDDT** is computed from a single-sequence language model. It is generally well-calibrated but may be overconfident in some cases (predicting moderate confidence for regions that are actually poorly predicted) or underconfident in others.

### PAE (Predicted Aligned Error)

AlphaFold2 also provides **PAE (Predicted Aligned Error)**, a pairwise metric that estimates the error in the relative position of every pair of residues. PAE is particularly useful for:

- Assessing domain-domain orientations
- Evaluating multi-chain complex predictions
- Identifying independently folded domains

**ESMFold does not output PAE by default** in its standard inference pipeline. If inter-domain or inter-chain confidence assessment is needed, AlphaFold2 with PAE output is recommended.

### pTM (predicted Template Modeling score)

AlphaFold2 provides a **pTM score** that estimates the overall quality of the predicted structure as a global metric. ESMFold also computes pTM internally, but it is not always exposed in the standard output pipeline. When available:

- pTM > 0.5 suggests the predicted fold is likely correct
- pTM > 0.8 suggests high overall quality

### Practical Guidelines for Method Selection

| Criterion | ESMFold | AlphaFold2 |
|-----------|---------|------------|
| Speed | Seconds (single GPU) | Minutes to hours (with MSA) |
| MSA required | No | Yes |
| Hardware | Single GPU (16+ GB) | Multiple GPUs recommended |
| Best for | Rapid screening, single-sequence targets | Maximum accuracy, difficult targets |
| Accuracy (easy targets) | Comparable | Slightly better |
| Accuracy (hard targets) | Lower | Significantly better |
| Multi-chain | Not supported | Supported (AlphaFold-Multimer) |
| PAE output | Not standard | Yes |

### Recommended Workflow

1. **Initial screening**: Use ESMFold for rapid structure prediction of all targets. This takes seconds per sequence and provides a first look at structural viability.
2. **Triage by pLDDT**: Sequences with mean pLDDT > 70 from ESMFold are likely well-predicted and may not need AlphaFold2 refinement.
3. **Refinement**: For critical targets or those with ESMFold pLDDT < 70, run AlphaFold2 with full MSA for maximum accuracy.
4. **Validation**: Compare ESMFold and AlphaFold2 predictions. If they agree (TM-score > 0.8), confidence in the predicted structure is high regardless of which method produced it.
