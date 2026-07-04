#!/usr/bin/env python3
"""
Molecular RAG — Retrieve structurally similar compounds from ChEMBL.

Grounds predictions by finding analogs with experimentally measured properties.
Based on MolRAG (Xian et al., 2025, ACL).

Usage:
    python retrieve_analogs.py --smiles "c1ccccc1" --similarity-threshold 0.7 --output analogs.json
    python retrieve_analogs.py --smiles "c1ccccc1" --target CHEMBL25 --output target_analogs.json
"""

import argparse
import json
import sys
import time

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, DataStructs, Descriptors
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("Error: rdkit-pypi required.", file=sys.stderr)
    sys.exit(1)

try:
    import requests
except ImportError:
    print("Error: requests required. Install with: pip install requests", file=sys.stderr)
    sys.exit(1)


CHEMBL_BASE = "https://www.ebi.ac.uk/chembl/api/data"


def smiles_to_ecfp4(smiles, nbits=2048):
    """Convert SMILES to ECFP4 fingerprint."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    return AllChem.GetMorganFingerprintAsBitVect(mol, 2, nBits=nbits)


def search_chembl_similarity(smiles, threshold=70, max_results=20):
    """Search ChEMBL for similar molecules."""
    url = f"{CHEMBL_BASE}/similarity/{smiles}/{threshold}.json"
    params = {'limit': max_results, 'format': 'json'}

    try:
        resp = requests.get(url, params=params, timeout=30)
        if resp.status_code == 200:
            data = resp.json()
            return data.get('molecules', [])
        else:
            print(f"ChEMBL API returned {resp.status_code}", file=sys.stderr)
            return []
    except Exception as e:
        print(f"ChEMBL API error: {e}", file=sys.stderr)
        return []


def get_activities(chembl_id, limit=50):
    """Get bioactivity data for a ChEMBL compound."""
    url = f"{CHEMBL_BASE}/activity.json"
    params = {
        'molecule_chembl_id': chembl_id,
        'limit': limit,
        'format': 'json',
    }

    try:
        resp = requests.get(url, params=params, timeout=30)
        if resp.status_code == 200:
            data = resp.json()
            return data.get('activities', [])
        return []
    except Exception:
        return []


def get_target_activities(smiles, target_chembl_id, threshold=70, max_results=20):
    """Get activities for similar molecules against a specific target."""
    molecules = search_chembl_similarity(smiles, threshold, max_results * 2)
    results = []

    for mol_data in molecules:
        chembl_id = mol_data.get('molecule_chembl_id')
        if not chembl_id:
            continue

        activities = get_activities(chembl_id, limit=100)
        target_acts = [a for a in activities if a.get('target_chembl_id') == target_chembl_id]

        if target_acts:
            results.append({
                'chembl_id': chembl_id,
                'smiles': mol_data.get('molecule_structures', {}).get('canonical_smiles'),
                'pref_name': mol_data.get('pref_name'),
                'activities': [{
                    'type': a.get('standard_type'),
                    'value': a.get('standard_value'),
                    'units': a.get('standard_units'),
                    'relation': a.get('standard_relation'),
                    'assay_chembl_id': a.get('assay_chembl_id'),
                } for a in target_acts],
            })

        if len(results) >= max_results:
            break
        time.sleep(0.2)  # Rate limiting

    return results


def main():
    parser = argparse.ArgumentParser(description='Retrieve similar compounds from ChEMBL')
    parser.add_argument('--smiles', type=str, required=True, help='Query SMILES')
    parser.add_argument('--similarity-threshold', type=float, default=0.6,
                        help='Minimum Tanimoto similarity (0-1, converted to ChEMBL percentage)')
    parser.add_argument('--target', type=str, default=None, help='Target ChEMBL ID (e.g., CHEMBL25)')
    parser.add_argument('--include-activities', action='store_true', help='Fetch bioactivity data')
    parser.add_argument('--max-results', type=int, default=20)
    parser.add_argument('--output', type=str, default='analogs.json')

    args = parser.parse_args()

    # Validate input
    query_mol = Chem.MolFromSmiles(args.smiles)
    if query_mol is None:
        print(f"Error: Invalid SMILES: {args.smiles}", file=sys.stderr)
        return 1

    query_canonical = Chem.MolToSmiles(query_mol)
    query_fp = smiles_to_ecfp4(query_canonical)

    print(f"Query: {query_canonical}")
    print(f"Similarity threshold: {args.similarity_threshold}")

    # Convert threshold to ChEMBL percentage (0-100)
    chembl_threshold = int(args.similarity_threshold * 100)

    if args.target:
        print(f"Target: {args.target}")
        print(f"Searching for similar compounds with activity against {args.target}...")
        results = get_target_activities(query_canonical, args.target, chembl_threshold, args.max_results)
    else:
        print("Searching ChEMBL for similar compounds...")
        molecules = search_chembl_similarity(query_canonical, chembl_threshold, args.max_results)

        results = []
        for mol_data in molecules:
            mol_smiles = mol_data.get('molecule_structures', {}).get('canonical_smiles')
            if not mol_smiles:
                continue

            analog_mol = Chem.MolFromSmiles(mol_smiles)
            if analog_mol is None:
                continue

            analog_fp = smiles_to_ecfp4(mol_smiles)
            if analog_fp is None:
                continue

            sim = round(DataStructs.TanimotoSimilarity(query_fp, analog_fp), 4)

            entry = {
                'chembl_id': mol_data.get('molecule_chembl_id'),
                'smiles': mol_smiles,
                'pref_name': mol_data.get('pref_name'),
                'similarity': sim,
                'mw': mol_data.get('molecule_properties', {}).get('full_mwt'),
                'logp': mol_data.get('molecule_properties', {}).get('alogp'),
                'hba': mol_data.get('molecule_properties', {}).get('hba'),
                'hbd': mol_data.get('molecule_properties', {}).get('hbd'),
                'psa': mol_data.get('molecule_properties', {}).get('psa'),
            }

            if args.include_activities:
                activities = get_activities(entry['chembl_id'], limit=20)
                entry['activities'] = [{
                    'target': a.get('target_pref_name'),
                    'target_id': a.get('target_chembl_id'),
                    'type': a.get('standard_type'),
                    'value': a.get('standard_value'),
                    'units': a.get('standard_units'),
                } for a in activities[:10]]
                time.sleep(0.2)

            results.append(entry)

        results.sort(key=lambda x: x.get('similarity', 0), reverse=True)

    output = {
        'query': query_canonical,
        'threshold': args.similarity_threshold,
        'target': args.target,
        'num_results': len(results),
        'analogs': results,
    }

    # Print summary
    print(f"\n{'='*60}")
    print(f"Found {len(results)} analogs")
    print(f"{'='*60}")
    for i, r in enumerate(results[:10]):
        name = r.get('pref_name') or r.get('chembl_id', '?')
        sim = r.get('similarity', '?')
        print(f"  {i+1}. {name} (sim={sim}) — {r.get('smiles', '?')[:50]}")
        if r.get('activities'):
            for a in r['activities'][:3]:
                print(f"     {a.get('type', '?')}: {a.get('value', '?')} {a.get('units', '')}")

    with open(args.output, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"\nResults saved to {args.output}")
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
