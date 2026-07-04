#!/usr/bin/env python3
"""
Batch protein structure prediction using ESMFold.

Processes multiple sequences from a multi-FASTA or CSV file, predicting
structures one at a time to manage GPU memory.

Usage:
    python predict_batch.py --input sequences.fasta --output-dir results/
    python predict_batch.py --input sequences.csv --output-dir results/ --device cuda
"""

import argparse
import csv
import os
import sys
import time

try:
    import torch
except ImportError:
    print("ERROR: PyTorch is not installed. Install with: pip install torch", file=sys.stderr)
    sys.exit(1)

try:
    import esm
except ImportError:
    print(
        "ERROR: fair-esm is not installed. Install with: pip install fair-esm",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    import numpy as np
except ImportError:
    print(
        "ERROR: NumPy is not installed. Install with: pip install numpy",
        file=sys.stderr,
    )
    sys.exit(1)


VALID_AMINO_ACIDS = set("ACDEFGHIKLMNPQRSTVWY")


def parse_multi_fasta(filepath):
    """Parse a multi-sequence FASTA file. Returns list of (header, sequence) tuples."""
    sequences = []
    header = None
    seq_lines = []

    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if header is not None:
                    sequences.append((header, "".join(seq_lines).upper()))
                header = line[1:].strip()
                seq_lines = []
            else:
                seq_lines.append(line)

    # Don't forget the last sequence
    if header is not None:
        sequences.append((header, "".join(seq_lines).upper()))

    return sequences


def parse_csv(filepath):
    """Parse a CSV file with 'name' and 'sequence' columns.

    Returns list of (name, sequence) tuples.
    """
    sequences = []
    with open(filepath, "r", newline="") as f:
        reader = csv.DictReader(f)
        # Validate columns
        if reader.fieldnames is None:
            print("ERROR: CSV file is empty or has no header row.", file=sys.stderr)
            sys.exit(1)

        # Case-insensitive column lookup
        col_map = {col.lower().strip(): col for col in reader.fieldnames}
        name_col = col_map.get("name")
        seq_col = col_map.get("sequence")

        if name_col is None or seq_col is None:
            print(
                "ERROR: CSV must have 'name' and 'sequence' columns. "
                f"Found columns: {reader.fieldnames}",
                file=sys.stderr,
            )
            sys.exit(1)

        for row in reader:
            name = row[name_col].strip()
            sequence = row[seq_col].strip().upper()
            if name and sequence:
                sequences.append((name, sequence))

    return sequences


def sanitize_filename(name):
    """Sanitize a sequence name for use as a filename."""
    # Replace problematic characters
    safe = name.replace("/", "_").replace("\\", "_").replace(" ", "_")
    safe = safe.replace(":", "_").replace("|", "_").replace("?", "_")
    safe = safe.replace("*", "_").replace("<", "_").replace(">", "_")
    safe = safe.replace('"', "_")
    # Truncate if too long
    if len(safe) > 100:
        safe = safe[:100]
    return safe


def extract_plddt_from_pdb(pdb_string):
    """Extract per-residue pLDDT from B-factor column of CA atoms."""
    plddt_per_residue = []
    seen_residues = set()

    for line in pdb_string.splitlines():
        if line.startswith("ATOM") and line[12:16].strip() == "CA":
            res_id = line[21:26].strip()
            if res_id not in seen_residues:
                seen_residues.add(res_id)
                try:
                    bfactor = float(line[60:66].strip())
                    plddt_per_residue.append(bfactor)
                except (ValueError, IndexError):
                    pass

    return np.array(plddt_per_residue)


def resolve_device(device_arg):
    """Resolve the device string to an actual torch device."""
    if device_arg == "auto":
        if torch.cuda.is_available():
            device = torch.device("cuda")
            gpu_name = torch.cuda.get_device_name(0)
            gpu_mem = torch.cuda.get_device_properties(0).total_mem / (1024**3)
            print(f"Using GPU: {gpu_name} ({gpu_mem:.1f} GB)")
        else:
            device = torch.device("cpu")
            print(
                "WARNING: No CUDA GPU detected. Running on CPU. "
                "This will be significantly slower.",
                file=sys.stderr,
            )
    elif device_arg == "cuda":
        if not torch.cuda.is_available():
            print(
                "ERROR: CUDA requested but no GPU is available. "
                "Use --device cpu or --device auto.",
                file=sys.stderr,
            )
            sys.exit(1)
        device = torch.device("cuda")
    elif device_arg == "cpu":
        device = torch.device("cpu")
        print("Using CPU (this may be slow for large sequences).")
    else:
        print(f"ERROR: Unknown device '{device_arg}'.", file=sys.stderr)
        sys.exit(1)
    return device


def main():
    parser = argparse.ArgumentParser(
        description="Batch protein structure prediction using ESMFold.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python predict_batch.py --input seqs.fasta --output-dir results/\n"
            "  python predict_batch.py --input seqs.csv --output-dir results/ --device cuda\n"
        ),
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Input file: multi-FASTA (.fasta/.fa) or CSV (.csv) with name,sequence columns.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Output directory for predicted PDB files and summary CSV.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["cuda", "cpu", "auto"],
        help="Device for inference: cuda, cpu, or auto (default: auto).",
    )
    args = parser.parse_args()

    # Validate input file
    if not os.path.isfile(args.input):
        print(f"ERROR: Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    # Parse input sequences
    input_lower = args.input.lower()
    if input_lower.endswith(".csv"):
        sequences = parse_csv(args.input)
        print(f"Loaded {len(sequences)} sequences from CSV: {args.input}")
    elif input_lower.endswith((".fasta", ".fa", ".faa", ".fas")):
        sequences = parse_multi_fasta(args.input)
        print(f"Loaded {len(sequences)} sequences from FASTA: {args.input}")
    else:
        # Try FASTA first, fall back to CSV
        try:
            sequences = parse_multi_fasta(args.input)
            if len(sequences) == 0:
                sequences = parse_csv(args.input)
                print(f"Loaded {len(sequences)} sequences from CSV: {args.input}")
            else:
                print(f"Loaded {len(sequences)} sequences from FASTA: {args.input}")
        except Exception:
            sequences = parse_csv(args.input)
            print(f"Loaded {len(sequences)} sequences from CSV: {args.input}")

    if len(sequences) == 0:
        print("ERROR: No sequences found in input file.", file=sys.stderr)
        sys.exit(1)

    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)

    # Resolve device
    device = resolve_device(args.device)

    # Load model
    print("\nLoading ESMFold model... (this may take a minute on first run)")
    try:
        model = esm.pretrained.esmfold_v1()
        model = model.eval()
        model = model.to(device)
        model.set_chunk_size(128)
        print("Model loaded successfully.\n")
    except Exception as e:
        print(f"ERROR: Failed to load model: {e}", file=sys.stderr)
        sys.exit(1)

    # Process each sequence
    results = []
    total = len(sequences)
    total_start = time.time()
    failed = 0

    for i, (name, sequence) in enumerate(sequences, 1):
        print(f"[{i}/{total}] Predicting: {name} ({len(sequence)} residues)...", end=" ", flush=True)

        # Validate sequence
        invalid_chars = set(sequence) - VALID_AMINO_ACIDS
        if invalid_chars:
            print(
                f"\n  WARNING: Non-standard characters in '{name}': {invalid_chars}",
                file=sys.stderr,
            )
        if len(sequence) == 0:
            print("SKIPPED (empty sequence)")
            failed += 1
            continue

        # Predict
        start_time = time.time()
        try:
            with torch.no_grad():
                pdb_string = model.infer_pdb(sequence)
        except RuntimeError as e:
            if "out of memory" in str(e).lower():
                print(
                    f"FAILED (OOM - sequence too long at {len(sequence)} residues)"
                )
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                results.append({
                    "name": name,
                    "length": len(sequence),
                    "mean_plddt": "OOM_ERROR",
                    "output_path": "",
                })
                failed += 1
                continue
            else:
                print(f"FAILED ({e})")
                results.append({
                    "name": name,
                    "length": len(sequence),
                    "mean_plddt": "ERROR",
                    "output_path": "",
                })
                failed += 1
                continue
        except Exception as e:
            print(f"FAILED ({e})")
            results.append({
                "name": name,
                "length": len(sequence),
                "mean_plddt": "ERROR",
                "output_path": "",
            })
            failed += 1
            continue

        elapsed = time.time() - start_time

        # Extract pLDDT
        plddt_values = extract_plddt_from_pdb(pdb_string)
        mean_plddt = float(np.mean(plddt_values)) if len(plddt_values) > 0 else 0.0

        # Save PDB
        safe_name = sanitize_filename(name)
        output_path = os.path.join(args.output_dir, f"{safe_name}.pdb")

        # Avoid overwriting: append number if file exists
        counter = 1
        original_path = output_path
        while os.path.exists(output_path):
            base, ext = os.path.splitext(original_path)
            output_path = f"{base}_{counter}{ext}"
            counter += 1

        with open(output_path, "w") as f:
            f.write(pdb_string)

        print(f"pLDDT={mean_plddt:.1f}, {elapsed:.1f}s -> {os.path.basename(output_path)}")

        results.append({
            "name": name,
            "length": len(sequence),
            "mean_plddt": f"{mean_plddt:.2f}",
            "output_path": output_path,
        })

    total_elapsed = time.time() - total_start

    # Write summary CSV
    summary_path = os.path.join(args.output_dir, "summary.csv")
    with open(summary_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["name", "length", "mean_plddt", "output_path"])
        writer.writeheader()
        writer.writerows(results)

    # Print final summary
    successful = total - failed
    print("\n" + "=" * 60)
    print("BATCH PREDICTION COMPLETE")
    print("=" * 60)
    print(f"Total sequences:  {total}")
    print(f"Successful:       {successful}")
    print(f"Failed:           {failed}")
    print(f"Total time:       {total_elapsed:.1f} seconds")
    if successful > 0:
        print(f"Avg time/seq:     {total_elapsed / successful:.1f} seconds")
    print(f"Output directory: {args.output_dir}")
    print(f"Summary CSV:      {summary_path}")
    print("=" * 60)

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
