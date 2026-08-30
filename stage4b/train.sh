#!/bin/bash
set -euo pipefail

: "${AUTODATA_EXPERIMENT_REQUEST:?AUTODATA_EXPERIMENT_REQUEST is required}"
SCRIPT_ROOT="$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)"
TEMP_ROOT="$(mktemp -d /tmp/autodata-stage4b-train.XXXXXX)"
DEPS_ROOT="${TEMP_ROOT}/deps"
CACHE_ROOT="${TEMP_ROOT}/cache"

finish() {
  exit_code=$?
  trap - EXIT INT TERM
  case "$TEMP_ROOT" in
    /tmp/autodata-stage4b-train.*) rm -rf -- "$TEMP_ROOT" ;;
    *) printf 'refusing to remove unexpected temp path: %s\n' "$TEMP_ROOT" >&2 ;;
  esac
  exit "$exit_code"
}
trap finish EXIT INT TERM

mkdir -p "$DEPS_ROOT" "$CACHE_ROOT"
export PYTHONNOUSERSITE=1
export PYTHONPATH="${SCRIPT_ROOT}/python:${DEPS_ROOT}"

python3 -m autodata_stage4b.worker prepare-train "$AUTODATA_EXPERIMENT_REQUEST"
mapfile -t CONTRACT_VALUES < <(python3 - "$SCRIPT_ROOT/experiment-contract.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    contract = json.load(handle)
print(contract["execution"]["training_wheelhouse"]["path"])
PY
)
test "${#CONTRACT_VALUES[@]}" -eq 1
WHEEL_ROOT="${CONTRACT_VALUES[0]}"
OUTPUT_ROOT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["output"]["root"])' "$AUTODATA_EXPERIMENT_REQUEST")"
CONFIG_PATH="$(dirname -- "$AUTODATA_EXPERIMENT_REQUEST")/train-config.json"
RUN_LOG="${OUTPUT_ROOT}/run.log"
exec > >(tee "$RUN_LOG") 2>&1

test -d "$WHEEL_ROOT"
shopt -s nullglob
WHEELS=("$WHEEL_ROOT"/*.whl)
shopt -u nullglob
test "${#WHEELS[@]}" -gt 0
python3 -m pip install --disable-pip-version-check --no-index --no-deps --target "$DEPS_ROOT" "${WHEELS[@]}"

export PATH="${DEPS_ROOT}/bin:${PATH}"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_HOME="${CACHE_ROOT}/huggingface"
export MODELSCOPE_CACHE="${CACHE_ROOT}/modelscope"
export TOKENIZERS_PARALLELISM=false
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export NPROC_PER_NODE=4
export MASTER_PORT=29631

nvidia-smi --query-gpu=name,uuid,memory.total,driver_version --format=csv,noheader > "${OUTPUT_ROOT}/gpu-info.csv"
test "$(wc -l < "${OUTPUT_ROOT}/gpu-info.csv")" -eq 4
test "$(grep -c 'NVIDIA H200' "${OUTPUT_ROOT}/gpu-info.csv")" -eq 4

set +e
python3 -m swift.cli.main sft "$CONFIG_PATH"
TRAIN_EXIT=$?
set -e
export AUTODATA_EXPERIMENT_TRAIN_EXIT="$TRAIN_EXIT"
unset NPROC_PER_NODE MASTER_PORT
python3 -m autodata_stage4b.worker validate-train "$AUTODATA_EXPERIMENT_REQUEST"
