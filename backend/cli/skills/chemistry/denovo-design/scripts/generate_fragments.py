#!/usr/bin/env python3
"""
Fragment-based molecule design.

Builds drug-like molecules from fragment hits using three modes:
  - Grow: add substituents to a single fragment
  - Link: connect two fragments with chemical linkers
  - Merge: combine pharmacophoric features of two fragments

Usage:
    python generate_fragments.py --fragments "c1cc[nH]c1" --mode grow --output grown.csv --num 50
    python generate_fragments.py --fragments "c1cc[nH]c1,c1ccccc1O" --mode link --output linked.csv --num 50
    python generate_fragments.py --fragments "c1cc[nH]c1,c1ccccc1O" --mode merge --output merged.csv --num 50
"""

import argparse
import csv
import sys
import os

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, Descriptors, QED, DataStructs, RWMol
    from rdkit.Chem import rdmolops, rdFMCS
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("ERROR: RDKit is required. Install with: pip install rdkit-pypi")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Substituents for fragment growing
# ---------------------------------------------------------------------------
GROWTH_SUBSTITUENTS = [
    ("methyl", "C"),
    ("ethyl", "CC"),
    ("isopropyl", "C(C)C"),
    ("cyclopropyl", "C1CC1"),
    ("phenyl", "c1ccccc1"),
    ("pyridyl", "c1ccncc1"),
    ("fluorine", "F"),
    ("chlorine", "Cl"),
    ("trifluoromethyl", "C(F)(F)F"),
    ("methoxy", "OC"),
    ("hydroxyl", "O"),
    ("amino", "N"),
    ("dimethylamino", "N(C)C"),
    ("cyano", "C#N"),
    ("acetamido", "NC(=O)C"),
    ("carboxamide", "C(=O)N"),
    ("sulfonamide", "NS(=O)(=O)C"),
    ("morpholino", "N1CCOCC1"),
    ("piperidyl", "C1CCNCC1"),
    ("piperazinyl", "N1CCNCC1"),
    ("imidazolyl", "c1c[nH]cn1"),
    ("oxazolyl", "c1cocn1"),
    ("thiazolyl", "c1cscn1"),
    ("tetrazolyl", "c1nn[nH]n1"),
    ("ethanol", "CCO"),
    ("propargyl", "CC#C"),
]

# Linkers for fragment linking (SMILES fragments with two attachment points)
LINKER_LIBRARY = [
    ("methylene", "C"),
    ("ethylene", "CC"),
    ("propylene", "CCC"),
    ("butylene", "CCCC"),
    ("amide", "C(=O)N"),
    ("reverse_amide", "NC(=O)"),
    ("urea", "NC(=O)N"),
    ("ether", "COC"),
    ("thioether", "CSC"),
    ("amine", "CNC"),
    ("piperazine", "CN1CCN(CC1)"),
    ("piperidine", "CC1CCNCC1"),
    ("sulfonamide", "CS(=O)(=O)N"),
    ("ester", "C(=O)OC"),
    ("hydrazide", "C(=O)NN"),
    ("triazole", "Cc1cn(nn1)"),
    ("oxadiazole", "Cc1nnoc1"),
    ("ethylamine", "CCNC"),
    ("propylamine", "CCCNC"),
    ("glycine", "NCC(=O)"),
    ("beta_alanine", "NCCC(=O)"),
]


def compute_properties(mol):
    """Compute standard molecular properties for a molecule."""
    if mol is None:
        return None
    try:
        return {
            "mw": round(Descriptors.MolWt(mol), 2),
            "logp": round(Descriptors.MolLogP(mol), 2),
            "qed": round(QED.qed(mol), 4),
            "hba": Descriptors.NumHAcceptors(mol),
            "hbd": Descriptors.NumHDonors(mol),
            "rotbonds": Descriptors.NumRotatableBonds(mol),
            "tpsa": round(Descriptors.TPSA(mol), 2),
        }
    except Exception:
        return None


def tanimoto_similarity(mol1, mol2, radius=2, n_bits=2048):
    """Compute Tanimoto similarity between two molecules."""
    try:
        fp1 = AllChem.GetMorganFingerprintAsBitVect(mol1, radius, nBits=n_bits)
        fp2 = AllChem.GetMorganFingerprintAsBitVect(mol2, radius, nBits=n_bits)
        return round(DataStructs.TanimotoSimilarity(fp1, fp2), 4)
    except Exception:
        return 0.0


def parse_fragments(fragment_input):
    """Parse fragment input: comma-separated SMILES or a file path."""
    if os.path.isfile(fragment_input):
        with open(fragment_input, "r") as f:
            lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]
        smiles_list = []
        for line in lines:
            # Handle CSV-like input (take first column)
            parts = line.split(",")
            smiles_list.append(parts[0].strip())
        return smiles_list
    else:
        return [s.strip() for s in fragment_input.split(",") if s.strip()]


# ---------------------------------------------------------------------------
# Mode 1: Grow
# ---------------------------------------------------------------------------
def grow_fragment(frag_mol, frag_smiles, max_analogs=50):
    """
    Grow a fragment by attaching substituents at available positions.
    Targets aromatic C-H and heteroatom positions.
    """
    results = []
    seen = set()
    frag_canonical = Chem.MolToSmiles(frag_mol)
    seen.add(frag_canonical)

    # Find attachment points: aromatic C-H atoms
    aromatic_h_pattern = Chem.MolFromSmarts("[cH]")
    aliphatic_h_pattern = Chem.MolFromSmarts("[CH2,CH3]")
    nh_pattern = Chem.MolFromSmarts("[NH]")

    patterns = [
        ("aromatic", aromatic_h_pattern),
        ("aliphatic", aliphatic_h_pattern),
        ("nh", nh_pattern),
    ]

    for sub_name, sub_smi in GROWTH_SUBSTITUENTS:
        sub_mol = Chem.MolFromSmiles(sub_smi)
        if sub_mol is None:
            continue

        for pos_name, pattern in patterns:
            if pattern is None:
                continue
            matches = frag_mol.GetSubstructMatches(pattern)
            for match_idx, match in enumerate(matches):
                if len(results) >= max_analogs:
                    return results
                try:
                    atom_idx = match[0]
                    combined = AllChem.CombineMols(frag_mol, sub_mol)
                    rw = RWMol(combined)
                    new_atom_start = frag_mol.GetNumAtoms()
                    rw.AddBond(atom_idx, new_atom_start, Chem.BondType.SINGLE)
                    try:
                        Chem.SanitizeMol(rw)
                    except Exception:
                        continue
                    smi = Chem.MolToSmiles(rw)
                    check_mol = Chem.MolFromSmiles(smi)
                    if check_mol is None:
                        continue
                    can_smi = Chem.MolToSmiles(check_mol)
                    if can_smi in seen:
                        continue
                    seen.add(can_smi)
                    results.append((can_smi, check_mol, f"grow_{sub_name}_{pos_name}"))
                except Exception:
                    continue

    return results


# ---------------------------------------------------------------------------
# Mode 2: Link
# ---------------------------------------------------------------------------
def link_fragments(frag1_mol, frag2_mol, max_analogs=50):
    """
    Link two fragments using a library of chemical linkers.
    Connects fragments at available attachment points.
    """
    results = []
    seen = set()

    # Find attachment points on each fragment
    patterns = [
        Chem.MolFromSmarts("[cH]"),    # aromatic C-H
        Chem.MolFromSmarts("[CH3]"),   # terminal methyl
        Chem.MolFromSmarts("[NH]"),    # NH
        Chem.MolFromSmarts("[OH]"),    # OH
    ]

    frag1_points = []
    frag2_points = []
    for pat in patterns:
        if pat is None:
            continue
        for match in frag1_mol.GetSubstructMatches(pat):
            frag1_points.append(match[0])
        for match in frag2_mol.GetSubstructMatches(pat):
            frag2_points.append(match[0])

    # Deduplicate attachment points
    frag1_points = list(set(frag1_points))[:5]
    frag2_points = list(set(frag2_points))[:5]

    if not frag1_points:
        frag1_points = [0]
    if not frag2_points:
        frag2_points = [0]

    for linker_name, linker_smi in LINKER_LIBRARY:
        linker_mol = Chem.MolFromSmiles(linker_smi)
        if linker_mol is None:
            continue

        for pt1 in frag1_points:
            for pt2 in frag2_points:
                if len(results) >= max_analogs:
                    return results
                try:
                    # Combine frag1 + linker
                    combined1 = AllChem.CombineMols(frag1_mol, linker_mol)
                    rw1 = RWMol(combined1)
                    linker_start = frag1_mol.GetNumAtoms()
                    rw1.AddBond(pt1, linker_start, Chem.BondType.SINGLE)

                    # Now combine with frag2
                    try:
                        Chem.SanitizeMol(rw1)
                    except Exception:
                        continue
                    intermediate = rw1.GetMol()

                    combined2 = AllChem.CombineMols(intermediate, frag2_mol)
                    rw2 = RWMol(combined2)
                    linker_end = linker_start + linker_mol.GetNumAtoms() - 1
                    frag2_start = intermediate.GetNumAtoms()
                    rw2.AddBond(linker_end, frag2_start + pt2, Chem.BondType.SINGLE)

                    try:
                        Chem.SanitizeMol(rw2)
                    except Exception:
                        continue

                    smi = Chem.MolToSmiles(rw2)
                    check_mol = Chem.MolFromSmiles(smi)
                    if check_mol is None:
                        continue
                    can_smi = Chem.MolToSmiles(check_mol)
                    if can_smi in seen:
                        continue
                    seen.add(can_smi)

                    # Sanity check on MW
                    mw = Descriptors.MolWt(check_mol)
                    if mw > 800 or mw < 150:
                        continue

                    results.append((can_smi, check_mol, f"link_{linker_name}"))
                except Exception:
                    continue

    return results


# ---------------------------------------------------------------------------
# Mode 3: Merge
# ---------------------------------------------------------------------------
def merge_fragments(frag1_mol, frag2_mol, max_analogs=50):
    """
    Merge two fragments by finding common substructure (MCS) and combining
    the unique portions of each fragment. Also generates hybrid molecules
    by overlaying pharmacophoric features.
    """
    results = []
    seen = set()

    # Strategy A: MCS-based merge
    try:
        mcs_result = rdFMCS.FindMCS(
            [frag1_mol, frag2_mol],
            threshold=0.5,
            ringMatchesRingOnly=True,
            completeRingsOnly=True,
            timeout=10
        )
        if mcs_result.numAtoms > 0:
            mcs_mol = Chem.MolFromSmarts(mcs_result.smartsString)
            if mcs_mol is not None:
                # Try to build merged molecule using the MCS as scaffold
                match1 = frag1_mol.GetSubstructMatch(mcs_mol)
                match2 = frag2_mol.GetSubstructMatch(mcs_mol)

                if match1 and match2:
                    # Use frag1 as base, add unique atoms from frag2
                    rw = RWMol(frag1_mol)
                    frag2_unique_atoms = set(range(frag2_mol.GetNumAtoms())) - set(match2)

                    # Map frag2's MCS atoms to frag1's MCS atoms
                    mcs_map = {}
                    for i, (a1, a2) in enumerate(zip(match1, match2)):
                        mcs_map[a2] = a1

                    atom_map = dict(mcs_map)  # frag2_idx -> merged_idx

                    for frag2_idx in frag2_unique_atoms:
                        atom = frag2_mol.GetAtomWithIdx(frag2_idx)
                        new_idx = rw.AddAtom(Chem.Atom(atom.GetAtomicNum()))
                        atom_map[frag2_idx] = new_idx

                    for bond in frag2_mol.GetBonds():
                        begin_idx = bond.GetBeginAtomIdx()
                        end_idx = bond.GetEndAtomIdx()
                        if begin_idx in atom_map and end_idx in atom_map:
                            mapped_begin = atom_map[begin_idx]
                            mapped_end = atom_map[end_idx]
                            if rw.GetBondBetweenAtoms(mapped_begin, mapped_end) is None:
                                try:
                                    rw.AddBond(mapped_begin, mapped_end, bond.GetBondType())
                                except Exception:
                                    pass

                    try:
                        Chem.SanitizeMol(rw)
                        smi = Chem.MolToSmiles(rw)
                        check_mol = Chem.MolFromSmiles(smi)
                        if check_mol is not None:
                            can_smi = Chem.MolToSmiles(check_mol)
                            if can_smi not in seen:
                                seen.add(can_smi)
                                results.append((can_smi, check_mol, "merge_mcs"))
                    except Exception:
                        pass
    except Exception:
        pass

    # Strategy B: Direct combination at pharmacophoric positions
    # Connect fragments at H-bond donor/acceptor sites
    donor_pattern = Chem.MolFromSmarts("[NH,OH,nH]")
    acceptor_pattern = Chem.MolFromSmarts("[N,O,n,o]")

    frag1_donors = frag1_mol.GetSubstructMatches(donor_pattern) if donor_pattern else []
    frag2_acceptors = frag2_mol.GetSubstructMatches(acceptor_pattern) if acceptor_pattern else []
    frag1_acceptors = frag1_mol.GetSubstructMatches(acceptor_pattern) if acceptor_pattern else []
    frag2_donors = frag2_mol.GetSubstructMatches(donor_pattern) if donor_pattern else []

    connection_pairs = []
    for d in frag1_donors:
        for a in frag2_acceptors:
            connection_pairs.append((d[0], a[0], "donor_acceptor"))
    for a in frag1_acceptors:
        for d in frag2_donors:
            connection_pairs.append((a[0], d[0], "acceptor_donor"))

    # Also try aromatic-aromatic connections
    ar_pattern = Chem.MolFromSmarts("[cH]")
    if ar_pattern:
        frag1_ar = frag1_mol.GetSubstructMatches(ar_pattern)
        frag2_ar = frag2_mol.GetSubstructMatches(ar_pattern)
        for a1 in frag1_ar[:3]:
            for a2 in frag2_ar[:3]:
                connection_pairs.append((a1[0], a2[0], "aromatic"))

    for pt1, pt2, conn_type in connection_pairs:
        if len(results) >= max_analogs:
            return results
        try:
            combined = AllChem.CombineMols(frag1_mol, frag2_mol)
            rw = RWMol(combined)
            frag2_offset = frag1_mol.GetNumAtoms()
            rw.AddBond(pt1, frag2_offset + pt2, Chem.BondType.SINGLE)
            try:
                Chem.SanitizeMol(rw)
            except Exception:
                continue
            smi = Chem.MolToSmiles(rw)
            check_mol = Chem.MolFromSmiles(smi)
            if check_mol is None:
                continue
            can_smi = Chem.MolToSmiles(check_mol)
            if can_smi in seen:
                continue
            seen.add(can_smi)
            mw = Descriptors.MolWt(check_mol)
            if mw > 700 or mw < 100:
                continue
            results.append((can_smi, check_mol, f"merge_{conn_type}"))
        except Exception:
            continue

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Fragment-based molecule design: grow, link, or merge fragments."
    )
    parser.add_argument(
        "--fragments", required=True,
        help="Fragment SMILES (comma-separated) or path to a file with one SMILES per line."
    )
    parser.add_argument(
        "--mode", required=True, choices=["grow", "link", "merge"],
        help="Design mode: grow (expand single fragment), link (connect two fragments), merge (combine pharmacophores)."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output CSV file path."
    )
    parser.add_argument(
        "--num", type=int, default=50,
        help="Target number of molecules to generate (default: 50)."
    )
    args = parser.parse_args()

    # Parse fragments
    fragment_smiles = parse_fragments(args.fragments)
    if not fragment_smiles:
        print("ERROR: No valid fragments provided.")
        sys.exit(1)

    print(f"Input fragments: {fragment_smiles}")
    print(f"Mode: {args.mode}")

    # Parse molecules
    fragment_mols = []
    for smi in fragment_smiles:
        mol = Chem.MolFromSmiles(smi)
        if mol is None:
            print(f"WARNING: Could not parse fragment SMILES: {smi}")
        else:
            fragment_mols.append((smi, mol))
            can = Chem.MolToSmiles(mol)
            props = compute_properties(mol)
            if props:
                print(f"  Fragment: {can} (MW={props['mw']}, LogP={props['logp']})")

    if not fragment_mols:
        print("ERROR: No valid fragment molecules parsed.")
        sys.exit(1)

    # Generate molecules based on mode
    all_results = []

    if args.mode == "grow":
        for frag_smi, frag_mol in fragment_mols:
            print(f"\n--- Growing fragment: {Chem.MolToSmiles(frag_mol)} ---")
            grown = grow_fragment(frag_mol, frag_smi, max_analogs=args.num)
            print(f"  Generated: {len(grown)} molecules")
            all_results.extend(grown)

    elif args.mode == "link":
        if len(fragment_mols) < 2:
            print("ERROR: Link mode requires at least 2 fragments.")
            sys.exit(1)
        for i in range(len(fragment_mols)):
            for j in range(i + 1, len(fragment_mols)):
                frag1_smi, frag1_mol = fragment_mols[i]
                frag2_smi, frag2_mol = fragment_mols[j]
                print(f"\n--- Linking: {Chem.MolToSmiles(frag1_mol)} + {Chem.MolToSmiles(frag2_mol)} ---")
                linked = link_fragments(frag1_mol, frag2_mol, max_analogs=args.num)
                print(f"  Generated: {len(linked)} molecules")
                all_results.extend(linked)

    elif args.mode == "merge":
        if len(fragment_mols) < 2:
            print("ERROR: Merge mode requires at least 2 fragments.")
            sys.exit(1)
        for i in range(len(fragment_mols)):
            for j in range(i + 1, len(fragment_mols)):
                frag1_smi, frag1_mol = fragment_mols[i]
                frag2_smi, frag2_mol = fragment_mols[j]
                print(f"\n--- Merging: {Chem.MolToSmiles(frag1_mol)} + {Chem.MolToSmiles(frag2_mol)} ---")
                merged = merge_fragments(frag1_mol, frag2_mol, max_analogs=args.num)
                print(f"  Generated: {len(merged)} molecules")
                all_results.extend(merged)

    # Deduplicate
    deduped = {}
    for smi, mol, strategy in all_results:
        can = Chem.MolToSmiles(mol)
        if can not in deduped:
            deduped[can] = (mol, strategy)

    print(f"\nTotal unique molecules after deduplication: {len(deduped)}")

    # Compute properties and build output
    output_rows = []
    ref_mols = [mol for _, mol in fragment_mols]

    for idx, (can_smi, (mol, strategy)) in enumerate(deduped.items()):
        props = compute_properties(mol)
        if props is None:
            continue

        # Compute max similarity to input fragments
        max_sim = max(tanimoto_similarity(mol, ref) for ref in ref_mols)

        output_rows.append({
            "id": f"frag_{idx+1:04d}",
            "smiles": can_smi,
            "mw": props["mw"],
            "logp": props["logp"],
            "qed": props["qed"],
            "hba": props["hba"],
            "hbd": props["hbd"],
            "rotbonds": props["rotbonds"],
            "tpsa": props["tpsa"],
            "max_frag_similarity": max_sim,
            "strategy": strategy,
        })

    # Trim to requested count
    output_rows = output_rows[:args.num]

    # Write output
    if output_rows:
        output_dir = os.path.dirname(args.output)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        fieldnames = ["id", "smiles", "mw", "logp", "qed", "hba", "hbd",
                       "rotbonds", "tpsa", "max_frag_similarity", "strategy"]
        with open(args.output, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(output_rows)
        print(f"\nWrote {len(output_rows)} molecules to {args.output}")
    else:
        print("\nWARNING: No valid molecules generated.")
        sys.exit(1)

    # Summary
    if output_rows:
        mw_vals = [r["mw"] for r in output_rows]
        logp_vals = [r["logp"] for r in output_rows]
        qed_vals = [r["qed"] for r in output_rows]

        print("\n=== Summary ===")
        print(f"  Total molecules: {len(output_rows)}")
        print(f"  MW   range: {min(mw_vals):.1f} - {max(mw_vals):.1f} (mean: {sum(mw_vals)/len(mw_vals):.1f})")
        print(f"  LogP range: {min(logp_vals):.2f} - {max(logp_vals):.2f} (mean: {sum(logp_vals)/len(logp_vals):.2f})")
        print(f"  QED  range: {min(qed_vals):.3f} - {max(qed_vals):.3f} (mean: {sum(qed_vals)/len(qed_vals):.3f})")

        strategy_counts = {}
        for r in output_rows:
            base = r["strategy"].split("_")[0]
            strategy_counts[base] = strategy_counts.get(base, 0) + 1
        print(f"  Strategy breakdown: {strategy_counts}")


if __name__ == "__main__":
    main()
