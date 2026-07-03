#!/usr/bin/env python3
"""
SMILES Validation — Strict validation, comparison, and modification checking.

Catches invalid LLM-generated molecules and verifies claimed modifications.

Usage:
    python validate.py --smiles "c1ccccc1"
    python validate.py --original "c1ccccc1" --proposed "c1ccc(O)cc1" --check-modification "Added hydroxyl"
    python validate.py --input molecules.csv --output report.json
"""

import argparse
import json
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, AllChem, DataStructs, rdFMCS
    from rdkit.Chem.Scaffolds import MurckoScaffold
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("Error: rdkit-pypi required.", file=sys.stderr)
    sys.exit(1)


def validate(smiles):
    """Validate a SMILES string with detailed diagnostics."""
    result = {'smiles': smiles, 'valid': False, 'issues': []}

    if not smiles or not isinstance(smiles, str):
        result['issues'].append('Empty or non-string input')
        return result

    smiles = smiles.strip()

    # Syntax checks
    if smiles.count('(') != smiles.count(')'):
        result['issues'].append(f"Unbalanced parentheses: {smiles.count('(')} open, {smiles.count(')')} close")
    if smiles.count('[') != smiles.count(']'):
        result['issues'].append(f"Unbalanced brackets: {smiles.count('[')} open, {smiles.count(']')} close")

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        result['issues'].append('RDKit parse failure')
        return result

    try:
        Chem.SanitizeMol(mol)
    except Exception as e:
        result['issues'].append(f'Sanitization error: {e}')
        return result

    result['valid'] = True
    result['canonical'] = Chem.MolToSmiles(mol)
    result['num_atoms'] = mol.GetNumAtoms()
    result['num_heavy_atoms'] = Descriptors.HeavyAtomCount(mol)
    result['mw'] = round(Descriptors.MolWt(mol), 1)
    result['formula'] = Chem.rdMolDescriptors.CalcMolFormula(mol)

    # Warnings
    if mol.GetNumAtoms() < 3:
        result['issues'].append('Very small molecule (<3 atoms)')
    if mol.GetNumAtoms() > 150:
        result['issues'].append('Very large molecule (>150 atoms)')
    if Descriptors.MolWt(mol) > 1000:
        result['issues'].append('MW > 1000 — beyond typical drug-like space')

    return result


def compare(original_smiles, proposed_smiles):
    """Compare two molecules."""
    mol1 = Chem.MolFromSmiles(original_smiles)
    mol2 = Chem.MolFromSmiles(proposed_smiles)
    if not mol1 or not mol2:
        return {'error': 'One or both SMILES invalid'}

    fp1 = AllChem.GetMorganFingerprintAsBitVect(mol1, 2, nBits=2048)
    fp2 = AllChem.GetMorganFingerprintAsBitVect(mol2, 2, nBits=2048)
    sim = round(DataStructs.TanimotoSimilarity(fp1, fp2), 4)

    try:
        s1 = Chem.MolToSmiles(MurckoScaffold.MakeScaffoldGeneric(MurckoScaffold.GetScaffoldForMol(mol1)))
        s2 = Chem.MolToSmiles(MurckoScaffold.MakeScaffoldGeneric(MurckoScaffold.GetScaffoldForMol(mol2)))
        scaffold_match = s1 == s2
    except Exception:
        s1 = s2 = None
        scaffold_match = None

    try:
        mcs = rdFMCS.FindMCS([mol1, mol2], timeout=10)
        mcs_atoms = mcs.numAtoms if mcs else 0
    except Exception:
        mcs_atoms = 0

    if sim >= 0.6:
        classification = 'lead_optimization'
    elif sim >= 0.4:
        classification = 'significant_modification'
    else:
        classification = 'de_novo_design'

    return {
        'tanimoto': sim,
        'scaffold_preserved': scaffold_match,
        'mcs_atoms': mcs_atoms,
        'atom_delta': mol2.GetNumAtoms() - mol1.GetNumAtoms(),
        'classification': classification,
    }


def check_modification(original_smiles, proposed_smiles, claim):
    """Verify a claimed modification exists."""
    mol1 = Chem.MolFromSmiles(original_smiles)
    mol2 = Chem.MolFromSmiles(proposed_smiles)
    if not mol1 or not mol2:
        return {'verified': False, 'reason': 'Invalid SMILES'}

    claim_lower = claim.lower()
    checks = []

    # Functional group checks
    group_checks = [
        (['hydroxyl', 'oh', 'hydroxy'], '[OH]'),
        (['fluorine', 'fluoro', 'f'], '[F]'),
        (['chlorine', 'chloro', 'cl'], '[Cl]'),
        (['bromine', 'bromo', 'br'], '[Br]'),
        (['amine', 'amino', 'nh2'], '[NH2]'),
        (['methyl', 'ch3'], '[CH3]'),
        (['nitro', 'no2'], '[N+](=O)[O-]'),
        (['cyano', 'nitrile', 'cn'], 'C#N'),
        (['pyridine'], 'c1ccncc1'),
        (['piperazine'], 'C1CNCCN1'),
        (['morpholine'], 'C1COCCN1'),
    ]

    for keywords, smarts in group_checks:
        if any(k in claim_lower for k in keywords):
            pat = Chem.MolFromSmarts(smarts)
            if pat is None:
                pat = Chem.MolFromSmiles(smarts)
            if pat is None:
                continue
            had = mol1.HasSubstructMatch(pat)
            has = mol2.HasSubstructMatch(pat)
            if 'add' in claim_lower or 'introduc' in claim_lower or 'insert' in claim_lower:
                checks.append({'group': keywords[0], 'expected': 'added', 'passed': has and not had})
            elif 'remov' in claim_lower or 'delet' in claim_lower:
                checks.append({'group': keywords[0], 'expected': 'removed', 'passed': had and not has})
            elif 'replac' in claim_lower:
                checks.append({'group': keywords[0], 'expected': 'present_in_new', 'passed': has})
            else:
                checks.append({'group': keywords[0], 'expected': 'present', 'passed': has})

    all_passed = all(c['passed'] for c in checks) if checks else None

    return {
        'claim': claim,
        'checks': checks,
        'verified': all_passed,
        'note': 'No matching structural checks for this claim' if not checks else None,
    }


def main():
    parser = argparse.ArgumentParser(description='SMILES validation and verification')
    parser.add_argument('--smiles', type=str, help='Single SMILES to validate')
    parser.add_argument('--original', type=str, help='Original SMILES for comparison')
    parser.add_argument('--proposed', type=str, help='Proposed SMILES')
    parser.add_argument('--check-modification', type=str, help='Claimed modification to verify')
    parser.add_argument('--input', type=str, help='CSV input file')
    parser.add_argument('--smiles-col', type=str, default='SMILES')
    parser.add_argument('--output', type=str, default=None)

    args = parser.parse_args()
    result = {}

    if args.smiles:
        result = validate(args.smiles)
        status = 'VALID' if result['valid'] else 'INVALID'
        print(f"[{status}] {args.smiles}")
        if result.get('canonical'):
            print(f"  Canonical: {result['canonical']}")
            print(f"  Formula: {result.get('formula')} | MW: {result.get('mw')} | Atoms: {result.get('num_atoms')}")
        for issue in result.get('issues', []):
            print(f"  Warning: {issue}")

    elif args.original and args.proposed:
        v1 = validate(args.original)
        v2 = validate(args.proposed)
        result = {'original': v1, 'proposed': v2}

        if v1['valid'] and v2['valid']:
            result['comparison'] = compare(args.original, args.proposed)
            comp = result['comparison']
            print(f"Similarity: {comp['tanimoto']}")
            print(f"Scaffold preserved: {comp['scaffold_preserved']}")
            print(f"Classification: {comp['classification']}")
            print(f"Atom delta: {comp['atom_delta']:+d}")

            if args.check_modification:
                result['modification'] = check_modification(args.original, args.proposed, args.check_modification)
                mod = result['modification']
                status = 'VERIFIED' if mod['verified'] else ('FAILED' if mod['verified'] is False else 'INCONCLUSIVE')
                print(f"\nModification check [{status}]: {args.check_modification}")
                for c in mod.get('checks', []):
                    icon = '✓' if c['passed'] else '✗'
                    print(f"  {icon} {c['group']}: expected {c['expected']}")
        else:
            if not v1['valid']:
                print(f"Original INVALID: {v1['issues']}")
            if not v2['valid']:
                print(f"Proposed INVALID: {v2['issues']}")

    elif args.input:
        import pandas as pd
        df = pd.read_csv(args.input)
        results = [validate(smi) for smi in df[args.smiles_col]]
        valid = sum(1 for r in results if r['valid'])
        print(f"Validated {len(results)}: {valid} valid, {len(results)-valid} invalid")
        result = results

    else:
        print("Error: Provide --smiles, --original/--proposed, or --input", file=sys.stderr)
        return 1

    if args.output:
        with open(args.output, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"Saved to {args.output}")

    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
