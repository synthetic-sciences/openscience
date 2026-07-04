#!/usr/bin/env python3
"""
Multi-objective molecule optimization.

Iteratively optimizes a set of compounds against multiple property objectives
with constraint satisfaction. Each iteration: generate analogs -> compute
properties -> filter by constraints -> rank by multi-objective score ->
select top compounds for next round.

Usage:
    python optimize.py --input hits.csv --objectives qed,logp,sa --constraints "mw<500,logp<5,qed>0.5" --output optimized.csv --num-iterations 3
"""

import argparse
import csv
import sys
import os
import re
from collections import OrderedDict

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, Descriptors, QED, DataStructs, RWMol
    from rdkit.Chem import rdMolDescriptors
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("ERROR: RDKit is required. Install with: pip install rdkit-pypi")
    sys.exit(1)

try:
    import numpy as np
except ImportError:
    print("WARNING: numpy not found. Install with: pip install numpy")
    np = None


# ---------------------------------------------------------------------------
# Property computation
# ---------------------------------------------------------------------------
def compute_all_properties(mol):
    """Compute all relevant molecular properties."""
    if mol is None:
        return None
    try:
        props = {
            "mw": round(Descriptors.MolWt(mol), 2),
            "logp": round(Descriptors.MolLogP(mol), 2),
            "qed": round(QED.qed(mol), 4),
            "hba": Descriptors.NumHAcceptors(mol),
            "hbd": Descriptors.NumHDonors(mol),
            "tpsa": round(Descriptors.TPSA(mol), 2),
            "rotbonds": Descriptors.NumRotatableBonds(mol),
            "sa": compute_sa_score(mol),
            "num_rings": rdMolDescriptors.CalcNumRings(mol),
            "num_aromatic_rings": rdMolDescriptors.CalcNumAromaticRings(mol),
            "heavy_atoms": mol.GetNumHeavyAtoms(),
        }
        return props
    except Exception:
        return None


def compute_sa_score(mol):
    """
    Estimate synthetic accessibility (1=easy, 10=hard).
    Uses a heuristic based on molecular complexity.
    """
    try:
        num_rings = rdMolDescriptors.CalcNumRings(mol)
        num_stereo = rdMolDescriptors.CalcNumAtomStereoCenters(mol)
        mw = Descriptors.MolWt(mol)
        num_rotbonds = Descriptors.NumRotatableBonds(mol)
        num_heavy = mol.GetNumHeavyAtoms()

        # Spiro/bridged ring penalty
        ring_info = mol.GetRingInfo()
        num_fused = 0
        if ring_info.NumRings() > 1:
            bond_rings = ring_info.BondRings()
            for i in range(len(bond_rings)):
                for j in range(i + 1, len(bond_rings)):
                    shared = set(bond_rings[i]) & set(bond_rings[j])
                    if shared:
                        num_fused += 1

        sa = 1.0 + 0.25 * num_rings + 0.5 * num_stereo + 0.002 * mw
        sa += 0.1 * num_rotbonds + 0.3 * num_fused
        sa = max(1.0, min(sa, 10.0))
        return round(sa, 2)
    except Exception:
        return 5.0


# ---------------------------------------------------------------------------
# Constraint parsing and evaluation
# ---------------------------------------------------------------------------
def parse_constraints(constraint_str):
    """
    Parse constraint strings like 'mw<500,logp<5,qed>0.5'.
    Returns list of (property, operator, value) tuples.
    """
    if not constraint_str:
        return []

    constraints = []
    for part in constraint_str.split(","):
        part = part.strip()
        if not part:
            continue
        # Match patterns like "mw<500", "logp>=2", "qed>0.5"
        match = re.match(r"(\w+)\s*(<=|>=|<|>|==|!=)\s*([\d.]+)", part)
        if match:
            prop = match.group(1).lower()
            op = match.group(2)
            val = float(match.group(3))
            constraints.append((prop, op, val))
        else:
            print(f"WARNING: Could not parse constraint: {part}")
    return constraints


def evaluate_constraints(props, constraints):
    """Check if a molecule's properties satisfy all constraints."""
    for prop, op, val in constraints:
        if prop not in props:
            continue
        mol_val = props[prop]
        if op == "<" and not (mol_val < val):
            return False
        elif op == "<=" and not (mol_val <= val):
            return False
        elif op == ">" and not (mol_val > val):
            return False
        elif op == ">=" and not (mol_val >= val):
            return False
        elif op == "==" and not (mol_val == val):
            return False
        elif op == "!=" and not (mol_val != val):
            return False
    return True


# ---------------------------------------------------------------------------
# Multi-objective scoring
# ---------------------------------------------------------------------------
def compute_objective_score(props, objectives):
    """
    Compute a multi-objective score from 0 to 1.
    Each objective contributes equally. Higher is better.
    """
    if not objectives:
        return props.get("qed", 0.5)

    scores = []
    for obj in objectives:
        obj = obj.lower().strip()

        if obj == "qed":
            # QED is already 0-1, higher is better
            scores.append(props.get("qed", 0.0))

        elif obj == "logp":
            # Ideal LogP is 1-3 (drug-like). Score peaks at 2.
            logp = props.get("logp", 0.0)
            if 1.0 <= logp <= 3.0:
                score = 1.0
            elif 0.0 <= logp < 1.0:
                score = 0.5 + 0.5 * logp
            elif 3.0 < logp <= 5.0:
                score = 1.0 - 0.25 * (logp - 3.0)
            else:
                score = max(0.0, 0.5 - 0.1 * abs(logp - 2.0))
            scores.append(score)

        elif obj == "sa":
            # SA: 1=easy, 10=hard. Lower is better.
            sa = props.get("sa", 5.0)
            score = max(0.0, 1.0 - (sa - 1.0) / 9.0)
            scores.append(score)

        elif obj == "mw":
            # Ideal MW 200-500.
            mw = props.get("mw", 400)
            if 200 <= mw <= 500:
                score = 1.0
            elif 150 <= mw < 200:
                score = 0.5 + 0.5 * (mw - 150) / 50
            elif 500 < mw <= 700:
                score = 1.0 - 0.5 * (mw - 500) / 200
            else:
                score = 0.1
            scores.append(score)

        elif obj == "tpsa":
            # Ideal TPSA 40-120.
            tpsa = props.get("tpsa", 80)
            if 40 <= tpsa <= 120:
                score = 1.0
            elif 20 <= tpsa < 40:
                score = 0.5 + 0.5 * (tpsa - 20) / 20
            elif 120 < tpsa <= 160:
                score = 1.0 - 0.5 * (tpsa - 120) / 40
            else:
                score = 0.1
            scores.append(score)

        elif obj == "hbd":
            # Ideal HBD 0-3.
            hbd = props.get("hbd", 2)
            if 0 <= hbd <= 3:
                score = 1.0
            elif hbd <= 5:
                score = 0.5
            else:
                score = 0.1
            scores.append(score)

        elif obj == "hba":
            # Ideal HBA 0-7.
            hba = props.get("hba", 4)
            if 0 <= hba <= 7:
                score = 1.0
            elif hba <= 10:
                score = 0.5
            else:
                score = 0.1
            scores.append(score)

    if not scores:
        return 0.5
    return round(sum(scores) / len(scores), 4)


# ---------------------------------------------------------------------------
# Analog generation for optimization
# ---------------------------------------------------------------------------
MUTATION_RGROUPS = [
    "C", "CC", "F", "Cl", "OC", "O", "N", "C#N", "C(F)(F)F",
    "C(=O)N", "N(C)C", "C(=O)C", "S(=O)(=O)C", "c1ccccc1",
]

POLAR_GROUPS = ["O", "N", "[NH2]", "OC", "C(=O)N", "C(=O)O", "NS(=O)(=O)C"]
NONPOLAR_GROUPS = ["C", "CC", "F", "Cl", "C(F)(F)F", "C(C)C"]


def generate_optimization_analogs(mol, props, objectives, max_analogs=30, seed=42):
    """
    Generate analogs with property-guided mutations.
    Bias modifications based on which objectives need improvement.
    """
    if np is not None:
        rng = np.random.RandomState(seed)
    else:
        import random
        rng = random.Random(seed)

    analogs = []
    parent_smi = Chem.MolToSmiles(mol)
    seen = set()
    seen.add(parent_smi)

    # Determine mutation bias
    preferred_groups = list(MUTATION_RGROUPS)

    for obj in objectives:
        obj = obj.lower().strip()
        if obj == "logp":
            logp = props.get("logp", 3.0)
            if logp > 3.0:
                preferred_groups.extend(POLAR_GROUPS * 2)
            elif logp < 1.0:
                preferred_groups.extend(NONPOLAR_GROUPS * 2)
        elif obj == "mw":
            mw = props.get("mw", 400)
            if mw > 450:
                preferred_groups = [g for g in preferred_groups if len(g) <= 3]
        elif obj == "tpsa":
            tpsa = props.get("tpsa", 80)
            if tpsa < 40:
                preferred_groups.extend(POLAR_GROUPS * 2)
            elif tpsa > 120:
                preferred_groups.extend(NONPOLAR_GROUPS * 2)

    max_attempts = max_analogs * 15

    for attempt in range(max_attempts):
        if len(analogs) >= max_analogs:
            break

        try:
            rw_mol = RWMol(Chem.RWMol(mol))
            num_atoms = rw_mol.GetNumAtoms()
            if num_atoms == 0:
                continue

            if np is not None:
                action = rng.choice(["add_group", "swap_atom", "remove_terminal"])
            else:
                action = rng.choice(["add_group", "swap_atom", "remove_terminal"])

            if action == "add_group":
                if np is not None:
                    group_smi = preferred_groups[rng.randint(0, len(preferred_groups))]
                else:
                    group_smi = rng.choice(preferred_groups)
                group_mol = Chem.MolFromSmiles(group_smi)
                if group_mol is None:
                    continue

                # Find attachment point
                pattern = Chem.MolFromSmarts("[cH]")
                matches = mol.GetSubstructMatches(pattern) if pattern else []
                if not matches:
                    pattern2 = Chem.MolFromSmarts("[CH3,CH2]")
                    matches = mol.GetSubstructMatches(pattern2) if pattern2 else []
                if not matches:
                    continue

                if np is not None:
                    pt = matches[rng.randint(0, len(matches))][0]
                else:
                    pt = rng.choice(matches)[0]

                combined = AllChem.CombineMols(mol, group_mol)
                rw = RWMol(combined)
                rw.AddBond(pt, num_atoms, Chem.BondType.SINGLE)
                try:
                    Chem.SanitizeMol(rw)
                except Exception:
                    continue
                new_mol = rw.GetMol()

            elif action == "swap_atom":
                if np is not None:
                    idx = rng.randint(0, num_atoms)
                else:
                    idx = rng.randint(0, num_atoms - 1)
                atom = rw_mol.GetAtomWithIdx(idx)
                old_num = atom.GetAtomicNum()
                swap_options = [6, 7, 8]
                candidates = [a for a in swap_options if a != old_num]
                if not candidates:
                    continue
                if np is not None:
                    new_num = rng.choice(candidates)
                else:
                    new_num = rng.choice(candidates)
                atom.SetAtomicNum(new_num)
                atom.SetFormalCharge(0)
                atom.SetNumExplicitHs(0)
                atom.SetNoImplicit(False)
                new_mol = rw_mol

            elif action == "remove_terminal":
                terminal_atoms = []
                for i in range(num_atoms):
                    a = rw_mol.GetAtomWithIdx(i)
                    if a.GetDegree() == 1 and a.GetAtomicNum() != 1:
                        terminal_atoms.append(i)
                if not terminal_atoms:
                    continue
                if np is not None:
                    rm_idx = rng.choice(terminal_atoms)
                else:
                    rm_idx = rng.choice(terminal_atoms)
                rw_mol.RemoveAtom(rm_idx)
                new_mol = rw_mol

            else:
                continue

            try:
                Chem.SanitizeMol(new_mol)
            except Exception:
                continue

            smi = Chem.MolToSmiles(new_mol)
            check = Chem.MolFromSmiles(smi)
            if check is None:
                continue
            can_smi = Chem.MolToSmiles(check)
            if can_smi in seen:
                continue

            mw = Descriptors.MolWt(check)
            if mw < 100 or mw > 800:
                continue

            seen.add(can_smi)
            analogs.append((can_smi, check))

        except Exception:
            continue

    return analogs


# ---------------------------------------------------------------------------
# Input loading
# ---------------------------------------------------------------------------
def load_input_molecules(input_file):
    """Load molecules from CSV (expects 'smiles' column) or plain SMILES file."""
    molecules = []

    if input_file.endswith(".csv"):
        with open(input_file, "r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                smi = row.get("smiles", row.get("SMILES", "")).strip()
                if smi:
                    mol = Chem.MolFromSmiles(smi)
                    if mol is not None:
                        molecules.append((Chem.MolToSmiles(mol), mol))
    else:
        with open(input_file, "r") as f:
            for line in f:
                smi = line.strip().split()[0] if line.strip() else ""
                if smi and not smi.startswith("#"):
                    mol = Chem.MolFromSmiles(smi)
                    if mol is not None:
                        molecules.append((Chem.MolToSmiles(mol), mol))

    return molecules


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Multi-objective molecule optimization through iterative analog generation and filtering."
    )
    parser.add_argument(
        "--input", required=True,
        help="Input CSV file with SMILES column, or plain SMILES file."
    )
    parser.add_argument(
        "--objectives", required=True,
        help="Comma-separated objectives: qed, logp, sa, mw, tpsa, hbd, hba."
    )
    parser.add_argument(
        "--constraints", default="",
        help="Comma-separated constraints (e.g., 'mw<500,logp<5,qed>0.5')."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output CSV file path."
    )
    parser.add_argument(
        "--num-iterations", type=int, default=3,
        help="Number of optimization iterations (default: 3)."
    )
    parser.add_argument(
        "--top-k", type=int, default=20,
        help="Number of top compounds to carry forward each iteration (default: 20)."
    )
    parser.add_argument(
        "--analogs-per-mol", type=int, default=15,
        help="Number of analogs to generate per molecule per iteration (default: 15)."
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for reproducibility (default: 42)."
    )
    args = parser.parse_args()

    # Parse objectives and constraints
    objectives = [o.strip() for o in args.objectives.split(",") if o.strip()]
    constraints = parse_constraints(args.constraints)

    print(f"Objectives: {objectives}")
    if constraints:
        print(f"Constraints: {[(p, o, v) for p, o, v in constraints]}")
    print(f"Iterations: {args.num_iterations}")
    print(f"Top-K per iteration: {args.top_k}")

    # Load input molecules
    if not os.path.isfile(args.input):
        print(f"ERROR: Input file not found: {args.input}")
        sys.exit(1)

    molecules = load_input_molecules(args.input)
    if not molecules:
        print("ERROR: No valid molecules found in input file.")
        sys.exit(1)

    print(f"\nLoaded {len(molecules)} molecules from {args.input}")

    # Score initial population
    population = []
    for smi, mol in molecules:
        props = compute_all_properties(mol)
        if props is None:
            continue
        obj_score = compute_objective_score(props, objectives)
        passes = evaluate_constraints(props, constraints)
        population.append({
            "smiles": smi,
            "mol": mol,
            "props": props,
            "obj_score": obj_score,
            "passes_constraints": passes,
            "iteration": 0,
        })

    print(f"Initial population: {len(population)} molecules")
    population.sort(key=lambda x: x["obj_score"], reverse=True)
    passing = sum(1 for p in population if p["passes_constraints"])
    print(f"  Passing constraints: {passing}")
    if population:
        scores = [p["obj_score"] for p in population]
        print(f"  Objective score: min={min(scores):.4f}, max={max(scores):.4f}, mean={sum(scores)/len(scores):.4f}")

    # Iterative optimization
    all_seen = set(p["smiles"] for p in population)
    best_ever = list(population)

    for iteration in range(1, args.num_iterations + 1):
        print(f"\n{'='*60}")
        print(f"Iteration {iteration}/{args.num_iterations}")
        print(f"{'='*60}")

        # Select top-K for analog generation
        # Prioritize those passing constraints, then by score
        passing_pop = [p for p in population if p["passes_constraints"]]
        failing_pop = [p for p in population if not p["passes_constraints"]]
        passing_pop.sort(key=lambda x: x["obj_score"], reverse=True)
        failing_pop.sort(key=lambda x: x["obj_score"], reverse=True)

        parents = passing_pop[:args.top_k]
        if len(parents) < args.top_k:
            parents.extend(failing_pop[:args.top_k - len(parents)])

        print(f"Selected {len(parents)} parents for analog generation")

        # Generate analogs
        new_molecules = []
        for pidx, parent in enumerate(parents):
            analogs = generate_optimization_analogs(
                parent["mol"], parent["props"], objectives,
                max_analogs=args.analogs_per_mol,
                seed=args.seed + iteration * 1000 + pidx
            )
            for smi, mol in analogs:
                if smi not in all_seen:
                    all_seen.add(smi)
                    new_molecules.append((smi, mol))

        print(f"Generated {len(new_molecules)} new unique analogs")

        # Evaluate new molecules
        new_entries = []
        for smi, mol in new_molecules:
            props = compute_all_properties(mol)
            if props is None:
                continue
            obj_score = compute_objective_score(props, objectives)
            passes = evaluate_constraints(props, constraints)
            entry = {
                "smiles": smi,
                "mol": mol,
                "props": props,
                "obj_score": obj_score,
                "passes_constraints": passes,
                "iteration": iteration,
            }
            new_entries.append(entry)
            best_ever.append(entry)

        # Merge and re-rank
        population = population + new_entries
        population.sort(key=lambda x: (x["passes_constraints"], x["obj_score"]), reverse=True)

        # Keep manageable population size
        max_pop = args.top_k * 5
        population = population[:max_pop]

        # Report
        passing = sum(1 for p in population if p["passes_constraints"])
        scores = [p["obj_score"] for p in population]
        print(f"Population size: {len(population)}")
        print(f"  Passing constraints: {passing}")
        print(f"  Objective score: min={min(scores):.4f}, max={max(scores):.4f}, mean={sum(scores)/len(scores):.4f}")

        if population:
            best = population[0]
            print(f"  Best: score={best['obj_score']:.4f}, SMILES={best['smiles'][:60]}")
            for prop_name in ["mw", "logp", "qed", "sa", "tpsa"]:
                if prop_name in best["props"]:
                    print(f"    {prop_name}: {best['props'][prop_name]}")

    # Final output: collect all unique molecules, ranked
    print(f"\n{'='*60}")
    print("Optimization complete")
    print(f"{'='*60}")

    # Deduplicate best_ever
    final_deduped = OrderedDict()
    for entry in sorted(best_ever, key=lambda x: (x["passes_constraints"], x["obj_score"]), reverse=True):
        smi = entry["smiles"]
        if smi not in final_deduped:
            final_deduped[smi] = entry

    output_rows = []
    for rank, (smi, entry) in enumerate(final_deduped.items()):
        props = entry["props"]
        row = {
            "rank": rank + 1,
            "id": f"opt_{rank+1:04d}",
            "smiles": smi,
            "obj_score": entry["obj_score"],
            "passes_constraints": "yes" if entry["passes_constraints"] else "no",
            "iteration_found": entry["iteration"],
            "mw": props.get("mw", ""),
            "logp": props.get("logp", ""),
            "qed": props.get("qed", ""),
            "hba": props.get("hba", ""),
            "hbd": props.get("hbd", ""),
            "tpsa": props.get("tpsa", ""),
            "rotbonds": props.get("rotbonds", ""),
            "sa": props.get("sa", ""),
            "heavy_atoms": props.get("heavy_atoms", ""),
        }
        output_rows.append(row)

    # Write output
    if output_rows:
        output_dir = os.path.dirname(args.output)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        fieldnames = ["rank", "id", "smiles", "obj_score", "passes_constraints",
                       "iteration_found", "mw", "logp", "qed", "hba", "hbd",
                       "tpsa", "rotbonds", "sa", "heavy_atoms"]
        with open(args.output, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(output_rows)
        print(f"\nWrote {len(output_rows)} molecules to {args.output}")
    else:
        print("\nWARNING: No molecules to write.")
        sys.exit(1)

    # Print final top 10
    print("\n=== Final Top 10 ===")
    print(f"{'Rank':<6}{'Score':<10}{'Pass':<6}{'Iter':<6}{'MW':<8}{'LogP':<8}{'QED':<8}{'SA':<6}{'SMILES':<50}")
    print("-" * 108)
    for row in output_rows[:10]:
        smi_display = row["smiles"][:47] + "..." if len(row["smiles"]) > 47 else row["smiles"]
        print(f"{row['rank']:<6}{row['obj_score']:<10.4f}{row['passes_constraints']:<6}"
              f"{row['iteration_found']:<6}{row['mw']:<8}{row['logp']:<8}"
              f"{row['qed']:<8}{row['sa']:<6}{smi_display:<50}")

    # Overall statistics
    passing_rows = [r for r in output_rows if r["passes_constraints"] == "yes"]
    print(f"\n=== Final Statistics ===")
    print(f"  Total unique molecules explored: {len(output_rows)}")
    print(f"  Passing all constraints: {len(passing_rows)}")
    if passing_rows:
        pass_scores = [r["obj_score"] for r in passing_rows]
        print(f"  Best passing score: {max(pass_scores):.4f}")
        print(f"  Mean passing score: {sum(pass_scores)/len(pass_scores):.4f}")


if __name__ == "__main__":
    main()
