#!/bin/bash
set -euo pipefail

: "${AUTODATA_STAGE4A_REQUEST:?AUTODATA_STAGE4A_REQUEST is required}"
SCRIPT_ROOT="$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)"
VLLM_WHEEL_ROOT="/mnt/shared-storage-user/gezhilong/autodata/dependencies/vllm-0.19.1-transformers-5.15.1-py311-cu128/wheelhouse"
BFCL_WHEEL_ROOT="/mnt/shared-storage-user/gezhilong/dataharness/dependencies/bfcl-eval-2026.3.23-py311/wheelhouse"
TEMP_ROOT="$(mktemp -d /tmp/autodata-stage4a-eval.XXXXXX)"
VLLM_ENV="${TEMP_ROOT}/vllm"
BFCL_ENV="${TEMP_ROOT}/bfcl"
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
    /tmp/autodata-stage4a-eval.*) rm -rf -- "$TEMP_ROOT" ;;
    *) printf 'refusing to remove unexpected temp path: %s\n' "$TEMP_ROOT" >&2 ;;
  esac
  exit "$exit_code"
}
trap finish EXIT INT TERM

mkdir -p "$VLLM_ENV" "$BFCL_ENV" "$CACHE_ROOT"
export PYTHONNOUSERSITE=1
export PYTHONPATH="${SCRIPT_ROOT}/python"
python3 -m autodata_stage4a.worker prepare-eval "$AUTODATA_STAGE4A_REQUEST"
OUTPUT_ROOT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["output"]["root"])' "$AUTODATA_STAGE4A_REQUEST")"
CHECKPOINT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["checkpoint_path"])' "$AUTODATA_STAGE4A_REQUEST")"
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
python3 -m pip install --disable-pip-version-check --no-index --no-deps --target "$BFCL_ENV" "${BFCL_WHEELS[@]}"

export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_HOME="${CACHE_ROOT}/huggingface"
export VLLM_CACHE_ROOT="${CACHE_ROOT}/vllm"
export TOKENIZERS_PARALLELISM=false
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

nvidia-smi --query-gpu=name,uuid,memory.total,driver_version --format=csv,noheader > "${OUTPUT_ROOT}/gpu-info.csv"
test "$(wc -l < "${OUTPUT_ROOT}/gpu-info.csv")" -eq 1
test "$(grep -c 'NVIDIA H200' "${OUTPUT_ROOT}/gpu-info.csv")" -eq 1

PYTHONPATH="$VLLM_ENV" python3 -m vllm.entrypoints.cli.main serve "$CHECKPOINT" \
  --host 127.0.0.1 \
  --port 8000 \
  --served-model-name Qwen/Qwen3.5-9B \
  --dtype bfloat16 \
  --tensor-parallel-size 1 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90 \
  --generation-config vllm \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

ready=false
for _attempt in $(seq 1 360); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    tail -200 "$SERVER_LOG" >&2 || true
    exit 1
  fi
  if PYTHONPATH="$VLLM_ENV" python3 - <<'PY'
import json
import urllib.request
with urllib.request.urlopen("http://127.0.0.1:8000/version", timeout=2) as response:
    value = json.loads(response.read().decode("utf-8"))
if value.get("version") != "0.19.1":
    raise SystemExit(1)
PY
  then
    ready=true
    break
  fi
  sleep 5
done
test "$ready" = true

PYTHONPATH="${BFCL_ENV}:${SCRIPT_ROOT}/python" python3 -m autodata_stage4a.worker evaluate "$AUTODATA_STAGE4A_REQUEST"
