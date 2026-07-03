#!/usr/bin/env python3
"""
SMILES Verification Tool

Validates proposed SMILES strings and checks whether claimed structural
modifications actually exist in the generated molecule. Catches the #1
LLM molecular generation failure mode.

Based on MT-Mol verifier agent (Kim et al., 2025).

Usage:
    python verify_smiles.py --original "c1ccccc1" --proposed "c1ccc(O)cc1" --claimed-modification "Added hydroxyl"
    python verify_smiles.py --smiles "invalid_smiles"
    python verify_smiles.py --input candidates.csv --reference "c1ccccc1"
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
    print("Error: rdkit-pypi required. Install with: pip install rdkit-pypi", file=sys.stderr)
    sys.exit(1)


def validate_smiles(smiles):
    """Validate a SMILES string. Returns detailed report."""
    report = {
        'smiles': smiles,
        'valid': False,
        'canonical': None,
        'issues': [],
    }

    if not smiles or not isinstance(smiles, str):
        report['issues'].append('Empty or non-string SMILES')
        return report

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        report['issues'].append('RDKit failed to parse SMILES')
        # Try to identify common issues
        if smiles.count('(') != smiles.count(')'):
            report['issues'].append('Unbalanced parentheses')
        if smiles.count('[') != smiles.count(']'):
            report['issues'].append('Unbalanced brackets')
        return report

    report['valid'] = True
    report['canonical'] = Chem.MolToSmiles(mol)

    # Check for unusual valences
    try:
        Chem.SanitizeMol(mol)
    except Exception as e:
        report['issues'].append(f'Sanitization warning: {str(e)}')

    # Basic stats
    report['num_atoms'] = mol.GetNumAtoms()
    report['num_bonds'] = mol.GetNumBonds()
    report['molecular_formula'] = Chem.rdMolDescriptors.CalcMolFormula(mol)
    report['mw'] = round(Descriptors.MolWt(mol), 1)

    if report['num_atoms'] < 3:
        report['issues'].append('Very small molecule (<3 atoms)')
    if report['num_atoms'] > 100:
        report['issues'].append('Very large molecule (>100 atoms)')

    return report


def compare_structures(original_smiles, proposed_smiles):
    """Compare two molecules structurally."""
    mol1 = Chem.MolFromSmiles(original_smiles)
    mol2 = Chem.MolFromSmiles(proposed_smiles)

    if mol1 is None or mol2 is None:
        return {'error': 'One or both SMILES are invalid'}

    # Tanimoto similarity
    fp1 = AllChem.GetMorganFingerprintAsBitVect(mol1, 2, nBits=2048)
    fp2 = AllChem.GetMorganFingerprintAsBitVect(mol2, 2, nBits=2048)
    similarity = round(DataStructs.TanimotoSimilarity(fp1, fp2), 4)

    # Scaffold comparison
    try:
        scaff1 = Chem.MolToSmiles(MurckoScaffold.MakeScaffoldGeneric(
            MurckoScaffold.GetScaffoldForMol(mol1)))
        scaff2 = Chem.MolToSmiles(MurckoScaffold.MakeScaffoldGeneric(
            MurckoScaffold.GetScaffoldForMol(mol2)))
        scaffold_match = scaff1 == scaff2
    except Exception:
        scaff1 = scaff2 = None
        scaffold_match = None

    # Maximum common substructure
    try:
        mcs = rdFMCS.FindMCS([mol1, mol2], timeout=10)
        mcs_smarts = mcs.smartsString if mcs else None
        mcs_atoms = mcs.numAtoms if mcs else 0
    except Exception:
        mcs_smarts = None
        mcs_atoms = 0

    # Atom count changes
    atom_diff = mol2.GetNumAtoms() - mol1.GetNumAtoms()

    # Descriptor changes
    desc_changes = {}
    for name, func in [('MW', Descriptors.MolWt), ('LogP', Descriptors.MolLogP),
                        ('TPSA', Descriptors.TPSA), ('HBA', Descriptors.NumHAcceptors),
                        ('HBD', Descriptors.NumHDonors), ('RotBonds', Descriptors.NumRotatableBonds)]:
        v1 = func(mol1)
        v2 = func(mol2)
        delta = v2 - v1
        if abs(delta) > 0.01:
            desc_changes[name] = {'original': round(v1, 2), 'proposed': round(v2, 2), 'delta': round(delta, 2)}

    classification = 'optimization'
    if similarity < 0.4:
        classification = 'de_novo_design'
    elif similarity < 0.6:
        classification = 'significant_modification'

    return {
        'tanimoto_similarity': similarity,
        'scaffold_preserved': scaffold_match,
        'original_scaffold': scaff1,
        'proposed_scaffold': scaff2,
        'mcs_atoms': mcs_atoms,
        'atom_count_delta': atom_diff,
        'descriptor_changes': desc_changes,
        'classification': classification,
    }


def check_modification(original_smiles, proposed_smiles, claimed_modification):
    """Check if a claimed modification is reflected in the actual structure."""
    mol1 = Chem.MolFromSmiles(original_smiles)
    mol2 = Chem.MolFromSmiles(proposed_smiles)

    if mol1 is None or mol2 is None:
        return {'verified': False, 'reason': 'Invalid SMILES'}

    # Check for common claimed modifications
    claim_lower = claimed_modification.lower()
    checks = []

    if 'hydroxyl' in claim_lower or 'oh' in claim_lower:
        had_oh = mol1.HasSubstructMatch(Chem.MolFromSmarts('[OH]'))
        has_oh = mol2.HasSubstructMatch(Chem.MolFromSmarts('[OH]'))
        if 'add' in claim_lower or 'introduc' in claim_lower:
            checks.append(('hydroxyl_added', has_oh and not had_oh))
        elif 'remov' in claim_lower:
            checks.append(('hydroxyl_removed', had_oh and not has_oh))

    if 'fluorin' in claim_lower or 'fluoro' in claim_lower or '→f' in claim_lower:
        had_f = mol1.HasSubstructMatch(Chem.MolFromSmarts('[F]'))
        has_f = mol2.HasSubstructMatch(Chem.MolFromSmarts('[F]'))
        checks.append(('fluorine_present', has_f))

    if 'chlor' in claim_lower:
        had_cl = mol1.HasSubstructMatch(Chem.MolFromSmarts('[Cl]'))
        has_cl = mol2.HasSubstructMatch(Chem.MolFromSmarts('[Cl]'))
        if 'remov' in claim_lower:
            checks.append(('chlorine_removed', had_cl and not has_cl))
        else:
            checks.append(('chlorine_present', has_cl))

    if 'pyridine' in claim_lower:
        has_pyridine = mol2.HasSubstructMatch(Chem.MolFromSmarts('c1ccncc1'))
        checks.append(('pyridine_present', has_pyridine))

    if 'nitrogen' in claim_lower or 'amine' in claim_lower:
        n_count_1 = sum(1 for a in mol1.GetAtoms() if a.GetAtomicNum() == 7)
        n_count_2 = sum(1 for a in mol2.GetAtoms() if a.GetAtomicNum() == 7)
        if 'add' in claim_lower:
            checks.append(('nitrogen_added', n_count_2 > n_count_1))

    passed = all(c[1] for c in checks) if checks else None

    return {
        'claimed_modification': claimed_modification,
        'checks_performed': [{'check': c[0], 'passed': c[1]} for c in checks],
        'verified': passed,
        'note': 'No specific structural checks matched the claim' if not checks else None,
    }


def main():
    parser = argparse.ArgumentParser(description='SMILES verification and structural comparison')
    parser.add_argument('--smiles', type=str, help='Single SMILES to validate')
    parser.add_argument('--original', type=str, help='Original molecule SMILES')
    parser.add_argument('--proposed', type=str, help='Proposed modified SMILES')
    parser.add_argument('--claimed-modification', type=str, default=None, help='Description of claimed change')
    parser.add_argument('--input', type=str, help='CSV file with SMILES to validate')
    parser.add_argument('--reference', type=str, help='Reference SMILES for batch comparison')
    parser.add_argument('--output', type=str, default=None, help='Output JSON file')

    args = parser.parse_args()

    result = {}

    if args.smiles:
        result = validate_smiles(args.smiles)
        print(json.dumps(result, indent=2))

    elif args.original and args.proposed:
        # Validate both
        val_orig = validate_smiles(args.original)
        val_prop = validate_smiles(args.proposed)

        result = {
            'original_validation': val_orig,
            'proposed_validation': val_prop,
        }

        if val_orig['valid'] and val_prop['valid']:
            result['comparison'] = compare_structures(args.original, args.proposed)
            if args.claimed_modification:
                result['modification_check'] = check_modification(
                    args.original, args.proposed, args.claimed_modification)

        print(json.dumps(result, indent=2))

        # Summary
        if result.get('comparison'):
            comp = result['comparison']
            print(f"\n{'='*50}")
            print(f"VERIFICATION SUMMARY")
            print(f"{'='*50}")
            print(f"Similarity: {comp['tanimoto_similarity']}")
            print(f"Scaffold preserved: {comp['scaffold_preserved']}")
            print(f"Classification: {comp['classification']}")
            if comp['descriptor_changes']:
                print(f"Property changes:")
                for prop, vals in comp['descriptor_changes'].items():
                    direction = '↑' if vals['delta'] > 0 else '↓'
                    print(f"  {prop}: {vals['original']} → {vals['proposed']} ({direction}{abs(vals['delta'])})")

    elif args.input:
        import pandas as pd
        df = pd.read_csv(args.input)
        smiles_col = 'SMILES' if 'SMILES' in df.columns else df.columns[0]
        results = []
        for smi in df[smiles_col]:
            val = validate_smiles(smi)
            if args.reference and val['valid']:
                val['comparison'] = compare_structures(args.reference, smi)
            results.append(val)
        valid_count = sum(1 for r in results if r['valid'])
        print(f"Validated {len(results)} SMILES: {valid_count} valid, {len(results)-valid_count} invalid")
        result = results

    else:
        print("Error: Provide --smiles, --original/--proposed, or --input", file=sys.stderr)
        return 1

    if args.output:
        with open(args.output, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"Results saved to {args.output}")

    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
