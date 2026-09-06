#!/bin/bash
set -euo pipefail
mkdir -p /logs/agent
python /opt/native-fixture/provider.py > /logs/agent/fixture-provider.stderr 2>&1 &
exec "$@"
