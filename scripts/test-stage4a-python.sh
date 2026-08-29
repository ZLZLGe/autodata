#!/bin/sh
set -eu
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$(pwd)/stage4a/python" python3 -m unittest discover -s stage4a/tests -p 'test_*.py'
