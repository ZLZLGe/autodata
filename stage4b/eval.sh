#!/bin/bash
set -euo pipefail

: "${AUTODATA_EXPERIMENT_REQUEST:?AUTODATA_EXPERIMENT_REQUEST is required}"
SCRIPT_ROOT="$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)"
TEMP_ROOT="$(mktemp -d /tmp/autodata-stage4b-eval.XXXXXX)"
VLLM_ENV="${TEMP_ROOT}/vllm"
DEPS_ROOT="${TEMP_ROOT}/bfcl"
CACHE_ROOT="${TEMP_ROOT}/cache"
SERVER_PID=""

finish() {
  exit_code=$?
  trap - EXIT INT TERM
  if test -n "$SERVER_PID" && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  case "$TEMP_ROOT" in
    /tmp/autodata-stage4b-eval.*) rm -rf -- "$TEMP_ROOT" ;;
    *) printf 'refusing to remove unexpected temp path: %s\n' "$TEMP_ROOT" >&2 ;;
  esac
  exit "$exit_code"
}
trap finish EXIT INT TERM

mkdir -p "$VLLM_ENV" "$DEPS_ROOT" "$CACHE_ROOT"
export PYTHONNOUSERSITE=1
export PYTHONPATH="${SCRIPT_ROOT}/python:${DEPS_ROOT}"
python3 -m autodata_stage4b.worker prepare-eval "$AUTODATA_EXPERIMENT_REQUEST"
mapfile -t CONTRACT_VALUES < <(python3 - "$SCRIPT_ROOT/experiment-contract.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    contract = json.load(handle)
execution = contract["execution"]
evaluation = contract["evaluation"]
server = evaluation["server"]
values = (
    execution["vllm_wheelhouse"]["path"],
    execution["bfcl_wheelhouse"]["path"],
    contract["model"]["id"],
    server["dtype"],
    server["tensor_parallel_size"],
    server["max_model_len"],
    server["gpu_memory_utilization"],
    server["generation_config"],
    server["enable_auto_tool_choice"],
    evaluation["tool_call_parser"],
    evaluation["vllm_version"],
)
for value in values:
    if isinstance(value, bool):
        print("true" if value else "false")
    else:
        print(value)
PY
)
test "${#CONTRACT_VALUES[@]}" -eq 11
VLLM_WHEEL_ROOT="${CONTRACT_VALUES[0]}"
BFCL_WHEEL_ROOT="${CONTRACT_VALUES[1]}"
SERVED_MODEL_NAME="${CONTRACT_VALUES[2]}"
SERVER_DTYPE="${CONTRACT_VALUES[3]}"
TENSOR_PARALLEL_SIZE="${CONTRACT_VALUES[4]}"
MAX_MODEL_LEN="${CONTRACT_VALUES[5]}"
GPU_MEMORY_UTILIZATION="${CONTRACT_VALUES[6]}"
GENERATION_CONFIG="${CONTRACT_VALUES[7]}"
ENABLE_AUTO_TOOL_CHOICE="${CONTRACT_VALUES[8]}"
TOOL_CALL_PARSER="${CONTRACT_VALUES[9]}"
VLLM_VERSION="${CONTRACT_VALUES[10]}"
OUTPUT_ROOT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["output"]["root"])' "$AUTODATA_EXPERIMENT_REQUEST")"
CHECKPOINT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["checkpoint_path"])' "$AUTODATA_EXPERIMENT_REQUEST")"
RUN_LOG="${OUTPUT_ROOT}/run.log"
SERVER_LOG="${OUTPUT_ROOT}/vllm-server.log"
exec > >(tee "$RUN_LOG") 2>&1

test -d "$VLLM_WHEEL_ROOT"
test -d "$BFCL_WHEEL_ROOT"
shopt -s nullglob
VLLM_WHEELS=("$VLLM_WHEEL_ROOT"/*.whl)
BFCL_WHEELS=("$BFCL_WHEEL_ROOT"/*.whl)
shopt -u nullglob
test "${#VLLM_WHEELS[@]}" -gt 0
test "${#BFCL_WHEELS[@]}" -gt 0
python3 -m pip install --disable-pip-version-check --no-index --no-deps --target "$VLLM_ENV" "${VLLM_WHEELS[@]}"
python3 -m pip install --disable-pip-version-check --no-index --no-deps --target "$DEPS_ROOT" "${BFCL_WHEELS[@]}"

export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_HOME="${CACHE_ROOT}/huggingface"
export VLLM_CACHE_ROOT="${CACHE_ROOT}/vllm"
export TOKENIZERS_PARALLELISM=false
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

nvidia-smi --query-gpu=name,uuid,memory.total,driver_version --format=csv,noheader > "${OUTPUT_ROOT}/gpu-info.csv"
test "$(wc -l < "${OUTPUT_ROOT}/gpu-info.csv")" -eq 1
test "$(grep -c 'NVIDIA H200' "${OUTPUT_ROOT}/gpu-info.csv")" -eq 1

AUTO_TOOL_CHOICE_ARGS=()
case "$ENABLE_AUTO_TOOL_CHOICE" in
  true) AUTO_TOOL_CHOICE_ARGS=(--enable-auto-tool-choice) ;;
  false) ;;
  *) printf 'invalid enable_auto_tool_choice value: %s\n' "$ENABLE_AUTO_TOOL_CHOICE" >&2; exit 1 ;;
esac

PYTHONPATH="${VLLM_ENV}:${SCRIPT_ROOT}/python" python3 -m vllm.entrypoints.cli.main serve "$CHECKPOINT" \
  --host 127.0.0.1 \
  --port 8000 \
  --served-model-name "$SERVED_MODEL_NAME" \
  --dtype "$SERVER_DTYPE" \
  --tensor-parallel-size "$TENSOR_PARALLEL_SIZE" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  --generation-config "$GENERATION_CONFIG" \
  "${AUTO_TOOL_CHOICE_ARGS[@]}" \
  --tool-call-parser "$TOOL_CALL_PARSER" \
  > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

ready=false
for _attempt in $(seq 1 360); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    tail -200 "$SERVER_LOG" >&2 || true
    exit 1
  fi
  if PYTHONPATH="$VLLM_ENV" python3 - "$VLLM_VERSION" <<'PY'
import json
import sys
import urllib.request
with urllib.request.urlopen("http://127.0.0.1:8000/version", timeout=2) as response:
    value = json.loads(response.read().decode("utf-8"))
if value.get("version") != sys.argv[1]:
    raise SystemExit(1)
PY
  then
    ready=true
    break
  fi
  sleep 5
done
test "$ready" = true

python3 -m autodata_stage4b.worker evaluate "$AUTODATA_EXPERIMENT_REQUEST"
