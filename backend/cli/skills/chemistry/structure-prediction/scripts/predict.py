#!/usr/bin/env python3
"""
Predict protein 3D structure from amino acid sequence using ESMFold.

Usage:
    python predict.py --input sequence.fasta --output predicted.pdb
    python predict.py --input "MKFLILLFNILCLFPVLAADNHGVS" --output predicted.pdb
    python predict.py --input sequence.fasta --output predicted.pdb --device cpu
"""

import argparse
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


def parse_fasta(filepath):
    """Parse a single-sequence FASTA file. Returns (header, sequence)."""
    header = None
    sequence_lines = []
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if header is not None:
                    break  # Only read the first sequence
                header = line[1:].strip()
            else:
                sequence_lines.append(line.upper())
    sequence = "".join(sequence_lines)
    if header is None:
        header = "unknown"
    return header, sequence


def validate_sequence(sequence):
    """Validate that the sequence contains only standard amino acid letters."""
    invalid_chars = set(sequence) - VALID_AMINO_ACIDS
    if invalid_chars:
        print(
            f"WARNING: Sequence contains non-standard characters: {invalid_chars}. "
            "These will be passed to the model but may affect prediction quality.",
            file=sys.stderr,
        )
    if len(sequence) == 0:
        print("ERROR: Empty sequence provided.", file=sys.stderr)
        sys.exit(1)
    if len(sequence) > 800:
        print(
            f"WARNING: Sequence length ({len(sequence)}) exceeds 800 residues. "
            "Prediction may require significant GPU memory and produce lower-quality results.",
            file=sys.stderr,
        )


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
        print(f"ERROR: Unknown device '{device_arg}'. Use cuda, cpu, or auto.", file=sys.stderr)
        sys.exit(1)
    return device


def load_model(device):
    """Load the ESMFold v1 model."""
    print("Loading ESMFold model... (this may take a minute on first run)")
    model = esm.pretrained.esmfold_v1()
    model = model.eval()
    model = model.to(device)
    # Set chunk size for memory efficiency on long sequences
    model.set_chunk_size(128)
    print("Model loaded successfully.")
    return model


def predict_structure(model, sequence, device):
    """Run structure prediction and return PDB string and pLDDT scores."""
    print(f"Predicting structure for sequence of length {len(sequence)}...")
    start_time = time.time()

    with torch.no_grad():
        try:
            output = model.infer_pdb(sequence)
        except RuntimeError as e:
            if "out of memory" in str(e).lower():
                print(
                    f"\nERROR: GPU out of memory for sequence of length {len(sequence)}.\n"
                    "Suggestions:\n"
                    "  1. Try a shorter sequence (< 400 residues)\n"
                    "  2. Use --device cpu (slower but no VRAM limit)\n"
                    "  3. Use a GPU with more VRAM (32+ GB for long sequences)\n",
                    file=sys.stderr,
                )
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                sys.exit(1)
            else:
                raise

    elapsed = time.time() - start_time
    print(f"Prediction completed in {elapsed:.1f} seconds.")

    # Extract pLDDT from the model's output
    # ESMFold stores pLDDT in the B-factor column of the PDB output
    plddt_values = extract_plddt_from_pdb(output)

    return output, plddt_values, elapsed


def extract_plddt_from_pdb(pdb_string):
    """Extract per-residue pLDDT scores from B-factor column of PDB string.

    ESMFold writes pLDDT values into the B-factor field. We extract CA atoms
    to get one pLDDT value per residue.
    """
    plddt_per_residue = []
    seen_residues = set()

    for line in pdb_string.splitlines():
        if line.startswith("ATOM") and line[12:16].strip() == "CA":
            res_id = line[21:26].strip()  # chain + residue number
            if res_id not in seen_residues:
                seen_residues.add(res_id)
                try:
                    bfactor = float(line[60:66].strip())
                    plddt_per_residue.append(bfactor)
                except (ValueError, IndexError):
                    pass

    return np.array(plddt_per_residue)


def print_summary(header, sequence, plddt_values, elapsed):
    """Print a formatted prediction summary."""
    print("\n" + "=" * 60)
    print("STRUCTURE PREDICTION SUMMARY")
    print("=" * 60)
    print(f"Sequence ID:    {header}")
    print(f"Sequence length: {len(sequence)} residues")
    print(f"Prediction time: {elapsed:.1f} seconds")
    print("-" * 60)

    if len(plddt_values) > 0:
        mean_plddt = np.mean(plddt_values)
        median_plddt = np.median(plddt_values)
        min_plddt = np.min(plddt_values)
        max_plddt = np.max(plddt_values)

        print(f"Mean pLDDT:     {mean_plddt:.1f}")
        print(f"Median pLDDT:   {median_plddt:.1f}")
        print(f"Min pLDDT:      {min_plddt:.1f}")
        print(f"Max pLDDT:      {max_plddt:.1f}")
        print("-" * 60)

        # Confidence tier breakdown
        very_high = np.sum(plddt_values > 90) / len(plddt_values) * 100
        confident = np.sum((plddt_values > 70) & (plddt_values <= 90)) / len(plddt_values) * 100
        low = np.sum((plddt_values > 50) & (plddt_values <= 70)) / len(plddt_values) * 100
        very_low = np.sum(plddt_values <= 50) / len(plddt_values) * 100

        print("Confidence distribution:")
        print(f"  Very high (>90):  {very_high:5.1f}% ({int(np.sum(plddt_values > 90))} residues)")
        print(
            f"  Confident (70-90): {confident:5.1f}% "
            f"({int(np.sum((plddt_values > 70) & (plddt_values <= 90)))} residues)"
        )
        print(
            f"  Low (50-70):      {low:5.1f}% "
            f"({int(np.sum((plddt_values > 50) & (plddt_values <= 70)))} residues)"
        )
        print(
            f"  Very low (<50):   {very_low:5.1f}% "
            f"({int(np.sum(plddt_values <= 50))} residues)"
        )
        print("-" * 60)

        # Overall assessment
        if mean_plddt > 80:
            assessment = "HIGH QUALITY - Structure is likely reliable for most analyses."
        elif mean_plddt > 60:
            assessment = (
                "MODERATE QUALITY - Overall fold is likely correct, "
                "but local details may be unreliable."
            )
        else:
            assessment = (
                "LOW QUALITY - Structure should be treated with caution. "
                "The protein may be intrinsically disordered."
            )
        print(f"Assessment: {assessment}")
    else:
        print("WARNING: Could not extract pLDDT scores from output.")

    print("=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Predict protein 3D structure from amino acid sequence using ESMFold.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python predict.py --input seq.fasta --output pred.pdb\n"
            '  python predict.py --input "MKFLIL..." --output pred.pdb\n'
            "  python predict.py --input seq.fasta --output pred.pdb --device cpu\n"
        ),
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Input amino acid sequence: path to a FASTA file or a raw sequence string.",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output path for the predicted PDB file.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["cuda", "cpu", "auto"],
        help="Device for inference: cuda, cpu, or auto (default: auto).",
    )
    args = parser.parse_args()

    # Parse input: file or raw sequence
    if os.path.isfile(args.input):
        header, sequence = parse_fasta(args.input)
        print(f"Read sequence '{header}' from {args.input}")
    else:
        # Treat as raw sequence string
        sequence = args.input.strip().upper()
        header = "input_sequence"
        if not any(c in VALID_AMINO_ACIDS for c in sequence):
            print(
                f"ERROR: Input '{args.input}' is neither a valid file path nor "
                "a recognizable amino acid sequence.",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"Using raw sequence input ({len(sequence)} residues)")

    # Validate sequence
    validate_sequence(sequence)

    # Resolve device
    device = resolve_device(args.device)

    # Ensure output directory exists
    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    # Load model and predict
    try:
        model = load_model(device)
        pdb_string, plddt_values, elapsed = predict_structure(model, sequence, device)
    except Exception as e:
        print(f"ERROR: Prediction failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Save PDB
    with open(args.output, "w") as f:
        f.write(pdb_string)
    print(f"\nPDB structure saved to: {args.output}")

    # Print summary
    print_summary(header, sequence, plddt_values, elapsed)

    return 0


if __name__ == "__main__":
    sys.exit(main())
