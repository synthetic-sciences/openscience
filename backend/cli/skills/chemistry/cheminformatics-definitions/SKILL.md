---
name: cheminformatics-definitions
description: Pins down the RDKit definitions that differ between conventions before computing molecular descriptors, including Lipinski donor and acceptor counts (Lipinski.NumHDonors and NumHAcceptors versus rdMolDescriptors.CalcNumLipinskiHBD and HBA), TPSA with or without sulfur and phosphorus, QED weighting, standard versus non-standard InChI and InChIKey, standardization order (cleanup, salt stripping, uncharging, tautomer canonicalization), canonical versus isomeric SMILES and aromaticity models, and states which definition produced each number. Use whenever a task computes, filters or compares small-molecule properties or identifiers; use the rdkit skill for general API usage and medchem or admet skills for interpretation.
summary: "RDKit descriptor definitions that differ by convention; state which one was used."
category: chemistry
allowed-tools: [Read, Bash, python]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Cheminformatics definitions

The same molecule has several hydrogen-bond acceptor counts, several polar surface areas
and several canonical SMILES, all correct under some definition. RDKit implements more than
one of each. Compute with the definition the question uses, and print the definition next
to the number; a bare "HBA = 7" is not reproducible.

## Rules

1. **Lipinski counts.** The original rule of five counts donors as the number of N-H and
   O-H bonds and acceptors as the number of N and O atoms. In RDKit these are
   `rdMolDescriptors.CalcNumLipinskiHBD` and `CalcNumLipinskiHBA` (also exposed as
   `Lipinski.NHOHCount` and `Lipinski.NOCount`). `Lipinski.NumHDonors` and
   `Lipinski.NumHAcceptors` (same as `rdMolDescriptors.CalcNumHBD` and `CalcNumHBA`) use
   SMARTS-based pharmacophore definitions that exclude, for example, amide nitrogens and
   include some sulfur; the two acceptor counts often differ by two or three. The rule's
   thresholds are MW <= 500, cLogP <= 5, HBD <= 5, HBA <= 10, with "at most one violation"
   in the original formulation. cLogP in RDKit is Wildman-Crippen (`Crippen.MolLogP`),
   which differs from XLogP3 or other predictors by up to a log unit; name the method.
2. **Molecular weight.** `Descriptors.MolWt` is the average isotopic mass,
   `Descriptors.ExactMolWt` the monoisotopic mass; both depend on whether the counterion
   was stripped first.
3. **TPSA.** Ertl's fragment method. RDKit's default (`Descriptors.TPSA(mol)` or
   `rdMolDescriptors.CalcTPSA(mol)`) sums N and O contributions only, matching the
   reference values in the original paper; `includeSandP=True` adds S and P. Sulfonamides
   and phosphates shift by roughly 10 square angstroms between the two.
4. **QED.** `QED.qed(mol)` uses Bickerton's mean weights by default; `QED.weights_max` and
   `QED.weights_none` give different values, and `QED.properties(mol)` exposes the eight
   underlying components (which use RDKit's own HBA, HBD and alert definitions). Report
   "QED, RDKit, mean weights".
5. **Rotatable bonds.** `rdMolDescriptors.CalcNumRotatableBonds(mol, strict)` has
   `NumRotatableBondsOptions.NonStrict`, `Strict` (excludes amide C-N and similar) and
   `StrictLinkages`; Veber-style filters were derived with a particular definition, so
   state which was used.
6. **InChI and InChIKey.** `Chem.MolToInchi(mol)` with no options yields standard InChI
   (`InChI=1S/`); any option such as `/FixedH` yields a non-standard InChI (`InChI=1/`)
   whose key is not comparable to standard keys. `Chem.MolToInchiKey(mol)` gives the
   27-character key: a 14-character skeleton block, an 8-character block for stereo and
   isotopes, a version and standard flag, then a protonation character. Stereoisomers
   share the first block, so matching on it is skeleton matching. Standard InChI
   normalizes mobile hydrogens, so some tautomers collapse to one key and others do not.
7. **SMILES.** `Chem.MolToSmiles(mol)` is canonical and isomeric by default
   (`isomericSmiles=True` keeps stereo and isotopes; `False` drops them;
   `kekuleSmiles=True` after `Chem.Kekulize` writes explicit bond orders). Canonical means
   canonical within one toolkit and version; never join tables from different toolkits on
   SMILES text. Recanonicalize everything through the same RDKit build or join on
   InChIKey.
8. **Standardization order.** `rdMolStandardize.Cleanup` (sanitize, disconnect metals,
   normalize functional groups, reionize), `FragmentParent` (largest organic fragment,
   which is the usual salt stripping), `ChargeParent` (uncharged fragment parent, or
   `Uncharger().uncharge`), `TautomerEnumerator().Canonicalize` (or `TautomerParent`).
   `Chem.SaltRemover.SaltRemover` strips a fixed list of counterions instead and behaves
   differently for solvates and mixed salts. Uncharging is not protonation at pH 7.4; a
   pKa-based protonation step is a different, separately named operation. Descriptors on
   the parent differ from descriptors on the drawn salt form; say which was profiled.
9. **Aromaticity.** RDKit's default model differs from the MDL model
   (`Chem.SetAromaticity(mol, Chem.AromaticityModel.AROMATICITY_MDL)` after
   `Chem.Kekulize(mol, clearAromaticFlags=True)`) and from OpenBabel or Daylight
   perception. Aromatic ring counts, aromatic-atom fractions and lowercase SMARTS matches
   all change with the model. Inputs with unusual valences may need
   `Chem.MolFromSmiles(smi, sanitize=False)` followed by `Chem.SanitizeMol` with explicit
   flags; record any molecule that failed to parse rather than dropping it silently.
10. **Hydrogens and stereo.** Descriptors that count hydrogens need the implicit-H graph,
    3D work needs `Chem.AddHs`; write canonical SMILES after `Chem.RemoveHs`.
    `Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False)`
    reveals unspecified centers that will make "same molecule" comparisons ambiguous.
11. **Always state** `rdkit.__version__`, the function and arguments, the standardization
    steps and their order, and whether values are for the parent or the drawn form. Put a
    definitions footnote under every property table.

## Snippet

```python
from rdkit import Chem
from rdkit.Chem import Lipinski, QED, rdMolDescriptors
from rdkit.Chem.MolStandardize import rdMolStandardize

def profile(smiles: str) -> dict:
    # Descriptors on the drawn salt form would count the counterion's atoms.
    mol = rdMolStandardize.ChargeParent(Chem.MolFromSmiles(smiles))
    return {
        "hbd_lipinski_nhoh": rdMolDescriptors.CalcNumLipinskiHBD(mol),
        "hba_lipinski_no": rdMolDescriptors.CalcNumLipinskiHBA(mol),
        "hbd_smarts": Lipinski.NumHDonors(mol),
        "hba_smarts": Lipinski.NumHAcceptors(mol),
        "tpsa_no": rdMolDescriptors.CalcTPSA(mol),
        "tpsa_nosp": rdMolDescriptors.CalcTPSA(mol, includeSandP=True),
        "qed_mean_weights": QED.qed(mol),
        "inchikey_standard": Chem.MolToInchiKey(mol),
    }
```

## Sources

- RDKit Book (aromaticity models, TPSA implementation notes): https://www.rdkit.org/docs/RDKit_Book.html
- RDKit `rdMolDescriptors` API: https://www.rdkit.org/docs/source/rdkit.Chem.rdMolDescriptors.html
- RDKit `Lipinski` module: https://www.rdkit.org/docs/source/rdkit.Chem.Lipinski.html
- RDKit `rdMolStandardize` API: https://www.rdkit.org/docs/source/rdkit.Chem.MolStandardize.rdMolStandardize.html
- RDKit `QED` module: https://www.rdkit.org/docs/source/rdkit.Chem.QED.html
- InChI Trust technical FAQ (standard InChI, InChIKey layout): https://www.inchi-trust.org/technical-faq/
- Lipinski et al. (2001), Adv. Drug Deliv. Rev. 46, 3-26: https://doi.org/10.1016/S0169-409X(00)00129-0
- Ertl, Rohde and Selzer (2000), J. Med. Chem. 43, 3714-3717: https://doi.org/10.1021/jm000942e
