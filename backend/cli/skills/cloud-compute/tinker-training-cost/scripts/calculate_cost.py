#!/usr/bin/env python3
"""Calculate training costs for Tinker fine-tuning jobs."""

import argparse
import json
import sys

MODELS = {
    "Qwen3-4B-Instruct-2507": {"tokenizer": "Qwen/Qwen3-4B", "prefill": 0.07, "sample": 0.22, "train": 0.22},
    "Qwen3-8B": {"tokenizer": "Qwen/Qwen3-8B", "prefill": 0.13, "sample": 0.40, "train": 0.40},
    "Qwen3-30B-A3B": {"tokenizer": "Qwen/Qwen3-30B-A3B", "prefill": 0.12, "sample": 0.30, "train": 0.36},
    "Qwen3-VL-30B-A3B-Instruct": {"tokenizer": "Qwen/Qwen2.5-VL-7B-Instruct", "prefill": 0.18, "sample": 0.44, "train": 0.53},
    "Qwen3-32B": {"tokenizer": "Qwen/Qwen3-32B", "prefill": 0.49, "sample": 1.47, "train": 1.47},
    "Qwen3-235B-Instruct-2507": {"tokenizer": "Qwen/Qwen3-235B-A22B-Instruct", "prefill": 0.68, "sample": 1.70, "train": 2.04},
    "Qwen3-VL-235B-A22B-Instruct": {"tokenizer": "Qwen/Qwen2.5-VL-7B-Instruct", "prefill": 1.02, "sample": 2.56, "train": 3.07},
    "Llama-3.2-1B": {"tokenizer": "meta-llama/Llama-3.2-1B-Instruct", "prefill": 0.03, "sample": 0.09, "train": 0.09},
    "Llama-3.2-3B": {"tokenizer": "meta-llama/Llama-3.2-3B-Instruct", "prefill": 0.06, "sample": 0.18, "train": 0.18},
    "Llama-3.1-8B": {"tokenizer": "meta-llama/Llama-3.1-8B-Instruct", "prefill": 0.13, "sample": 0.40, "train": 0.40},
    "Llama-3.1-70B": {"tokenizer": "meta-llama/Llama-3.1-70B-Instruct", "prefill": 1.05, "sample": 3.16, "train": 3.16},
    "DeepSeek-V3.1": {"tokenizer": "deepseek-ai/DeepSeek-V3", "prefill": 1.13, "sample": 2.81, "train": 3.38},
    "GPT-OSS-120B": {"tokenizer": "Qwen/Qwen3-8B", "prefill": 0.18, "sample": 0.44, "train": 0.52},
    "GPT-OSS-20B": {"tokenizer": "Qwen/Qwen3-8B", "prefill": 0.12, "sample": 0.30, "train": 0.36},
    "Kimi-K2-Thinking": {"tokenizer": "moonshotai/Kimi-K2-Instruct", "prefill": 0.98, "sample": 2.44, "train": 2.93},
}


def extract_text(row):
    if "messages" in row:
        return " ".join(m.get("content", "") for m in row["messages"])
    if "text" in row:
        return row["text"]
    if "instruction" in row:
        parts = [row.get("instruction", ""), row.get("input", ""), row.get("output", "")]
        return " ".join(p for p in parts if p)
    return ""


def count_tokens(file_path, tokenizer):
    total = 0
    lines = 0
    with open(file_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            text = extract_text(row)
            total += len(tokenizer.encode(text))
            lines += 1
    return total, lines


def list_models():
    print(f"{'Model':<35} {'Train $/M':>10} {'Prefill $/M':>12} {'Sample $/M':>11}")
    print("-" * 70)
    for name, info in MODELS.items():
        print(f"{name:<35} ${info['train']:>8.2f} ${info['prefill']:>10.2f} ${info['sample']:>9.2f}")


def main():
    parser = argparse.ArgumentParser(description="Calculate Tinker training costs")
    parser.add_argument("file", nargs="?", help="JSONL training data file")
    parser.add_argument("--model", "-m", default="Qwen3-8B", help="Model name (default: Qwen3-8B)")
    parser.add_argument("--epochs", "-e", type=int, default=3, help="Number of epochs (default: 3)")
    parser.add_argument("--list-models", action="store_true", help="List available models and pricing")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    if args.list_models:
        list_models()
        return

    if not args.file:
        parser.error("Please provide a JSONL file or use --list-models")

    if args.model not in MODELS:
        print(f"Unknown model: {args.model}", file=sys.stderr)
        print(f"Available: {', '.join(MODELS.keys())}", file=sys.stderr)
        sys.exit(1)

    model_info = MODELS[args.model]

    try:
        from transformers import AutoTokenizer
    except ImportError:
        print("pip install transformers to use tokenization", file=sys.stderr)
        sys.exit(1)

    print(f"Loading tokenizer: {model_info['tokenizer']}...", file=sys.stderr)
    tokenizer = AutoTokenizer.from_pretrained(model_info["tokenizer"], trust_remote_code=True)

    print(f"Counting tokens in {args.file}...", file=sys.stderr)
    total_tokens, num_examples = count_tokens(args.file, tokenizer)

    training_tokens = total_tokens * args.epochs
    cost = (training_tokens * model_info["train"]) / 1_000_000

    result = {
        "model": args.model,
        "tokenizer": model_info["tokenizer"],
        "file": args.file,
        "examples": num_examples,
        "dataset_tokens": total_tokens,
        "epochs": args.epochs,
        "training_tokens": training_tokens,
        "train_price_per_million": model_info["train"],
        "estimated_cost_usd": round(cost, 4),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"\nModel:            {args.model}")
        print(f"Examples:         {num_examples:,}")
        print(f"Dataset tokens:   {total_tokens:,}")
        print(f"Epochs:           {args.epochs}")
        print(f"Training tokens:  {training_tokens:,}")
        print(f"Price:            ${model_info['train']}/M tokens")
        print(f"Estimated cost:   ${cost:.4f}")


if __name__ == "__main__":
    main()
