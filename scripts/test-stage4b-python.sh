#!/bin/sh
set -eu
REPO_ROOT="$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)"
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH="${REPO_ROOT}/stage4b/python:${REPO_ROOT}/stage4a/python" \
  python3 -m unittest discover -s "${REPO_ROOT}/stage4b/tests" -p 'test_*.py'
