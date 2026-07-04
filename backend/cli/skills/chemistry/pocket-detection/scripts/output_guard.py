#!/usr/bin/env python3
"""
Output guard: path containment + manifest logging.

Every skill script calls validate_output_path() before writing and
log_to_manifest() after writing. This ensures:

1. All outputs stay within the working directory (no path traversal)
2. Every script invocation is logged to _script_manifest.jsonl with:
   - script name, arguments, output path, timestamp

The critique agent reads this manifest to verify that every number in the
final report traces to a logged script output.
"""

import json
import os
import sys
import time


def validate_output_path(output_path):
    """
    Ensure the output path resolves to within the current working directory.

    Rejects:
    - Absolute paths outside CWD
    - Paths with .. traversal escaping CWD
    - Symlinks pointing outside CWD

    Returns the resolved absolute path if valid, exits with error if not.
    """
    cwd = os.path.realpath(os.getcwd())
    resolved = os.path.realpath(os.path.join(cwd, output_path))

    if not resolved.startswith(cwd + os.sep) and resolved != cwd:
        print(f"ERROR: Output path escapes working directory.", file=sys.stderr)
        print(f"  CWD:      {cwd}", file=sys.stderr)
        print(f"  Resolved: {resolved}", file=sys.stderr)
        print(f"  All outputs must stay within the project directory.",
              file=sys.stderr)
        sys.exit(1)

    return resolved


def log_to_manifest(script_name, args_dict, output_path):
    """
    Append an entry to _script_manifest.jsonl in the working directory.

    Each line is a JSON object:
    {
        "timestamp": "2026-02-28T12:34:56Z",
        "script": "predict.py",
        "args": {"--protein": "protein.pdb", "--poses": "poses.sdf", ...},
        "output": "affinity.json"
    }
    """
    manifest_path = os.path.join(os.getcwd(), "_script_manifest.jsonl")

    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "script": script_name,
        "args": args_dict,
        "output": os.path.relpath(output_path, os.getcwd()),
    }

    with open(manifest_path, "a") as f:
        f.write(json.dumps(entry) + "\n")
