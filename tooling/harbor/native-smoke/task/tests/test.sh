#!/bin/bash
set -euo pipefail
python - <<'PY'
import json
from pathlib import Path

workspace = Path('/workspace/harbor-native-fixture')
path = workspace / 'fixture-result.json'
result = json.loads(path.read_text()) if path.is_file() else None
passed = result == {'value': 42, 'cwd': str(workspace)} and Path.cwd() == workspace
Path('/logs/verifier/evidence.json').write_text(json.dumps({
    'grader_cwd': str(Path.cwd()), 'artifact': str(path), 'result': result, 'passed': passed,
}, indent=2))
Path('/logs/verifier/reward.txt').write_text('1' if passed else '0')
assert passed, 'Native working directory or independently checked output is incorrect'
PY
