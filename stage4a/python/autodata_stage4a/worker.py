"""Strict Stage 4A worker.

The TypeScript Core owns canonicalization, selection, ordering, and run state.
This module consumes one immutable logical view, invokes the frozen training or
evaluation stack, and writes exactly one versioned result. It is not a second
controller, CAS, canonicalizer, or protocol-lock implementation.
"""

from __future__ import annotations

import argparse
import copy
import gc
import importlib
import importlib.metadata
import json
import math
import os
import re
import sys
import types
import urllib.error
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any


TRAIN_REQUEST_VERSION = "autodata-stage4a-train-request-1"
TRAIN_RESULT_VERSION = "autodata-stage4a-train-result-1"
EVAL_REQUEST_VERSION = "autodata-stage4a-eval-request-1"
EVAL_RESULT_VERSION = "autodata-stage4a-eval-result-1"
LOGICAL_VERSION = "dataharness-logical-training-unit-4"
RUN_SUMMARY_VERSION = "autodata-run-summary-1"
MODEL_ID = "Qwen/Qwen3.5-9B"
MODEL_REVISION = "c202236235762e1c871ad0ccb60c8ee5ba337b9a"
MODEL_PATH = (
    "/mnt/shared-storage-gpfs2/gpfs2-shared-public/huggingface/hub/"
    "models--Qwen--Qwen3.5-9B/snapshots/" + MODEL_REVISION
)
EXPECTED_PARAMETERS = 9_409_813_744
VLLM_VERSION = "0.19.1"
TOOL_CALL_PARSER = "qwen3_coder"
CASE_IDS = (
    "simple_python_116",
    "multiple_132",
    "parallel_115",
    "parallel_multiple_177",
    "irrelevance_194",
)
LOGICAL_FIELDS = {
    "schema_version", "id", "source", "assistant_message_index", "messages",
    "tools", "selection_rank", "plugin_provenance",
}
SOURCE_FIELDS = {
    "adapter_id", "adapter_version", "dataset_id", "dataset_revision",
    "record_id", "record_index", "record_line",
}
SELECTED_PARAMETER = "model.language_model.layers.0.mlp.down_proj.weight"


class DuplicateKeyError(ValueError):
    """Raised when JSON contains an ambiguous duplicate object key."""


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_json(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"JSON input must be a regular non-symlink file: {path}")
    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_pairs)
    if not isinstance(value, dict):
        raise ValueError(f"JSON input must contain an object: {path}")
    return value


def _write_new_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, sort_keys=True, allow_nan=False)
        handle.write("\n")


def _exact(value: Mapping[str, Any], fields: set[str], label: str) -> None:
    missing = sorted(fields - value.keys())
    extra = sorted(value.keys() - fields)
    if missing:
        raise ValueError(f"{label} missing fields: {', '.join(missing)}")
    if extra:
        raise ValueError(f"{label} has unsupported fields: {', '.join(extra)}")


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _integer(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def _under(root: Path, value: Any, label: str) -> Path:
    path = Path(_text(value, label))
    if not path.is_absolute():
        raise ValueError(f"{label} must be absolute")
    resolved_root = root.resolve(strict=True)
    resolved = path.resolve(strict=False)
    if not resolved.is_relative_to(resolved_root):
        raise ValueError(f"{label} escapes the staging directory")
    cursor = resolved_root
    for part in resolved.relative_to(resolved_root).parts:
        cursor /= part
        if cursor.exists() and cursor.is_symlink():
            raise ValueError(f"{label} traverses a symbolic link")
    return resolved


def _request_root(path: Path) -> Path:
    resolved = path.resolve(strict=True)
    # <run>/attempts/<stage>/<number>/request.json
    if len(resolved.parents) < 4 or resolved.parent.name.isdigit() is False:
        raise ValueError("request path does not use the staged attempt layout")
    root = resolved.parents[3]
    if root.name == "" or root.is_symlink() or not root.is_dir():
        raise ValueError("invalid staging root")
    return root


def _common_request(path: Path, expected_version: str, stage: str) -> tuple[dict[str, Any], Path]:
    request = _read_json(path)
    root = _request_root(path)
    if request.get("schema_version") != expected_version:
        raise ValueError(f"unsupported {stage} request schema")
    profile_id = _text(request.get("profile_id"), "profile_id")
    run_id = _text(request.get("run_id"), "run_id")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", profile_id):
        raise ValueError("invalid profile_id")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", run_id) or root.name != run_id:
        raise ValueError("invalid run_id or staging directory")
    _integer(request.get("attempt"), "attempt", 1)
    return request, root


def _validate_train_request(path: Path) -> tuple[dict[str, Any], Path]:
    request, root = _common_request(path, TRAIN_REQUEST_VERSION, "training")
    _exact(request, {"schema_version", "profile_id", "run_id", "attempt", "input", "output", "model", "recipe"}, "training request")
    inputs = _object(request["input"], "training request.input")
    _exact(inputs, {"canonical_jsonl", "logical_view_jsonl", "run_summary_json"}, "training request.input")
    for key in inputs:
        candidate = _under(root, inputs[key], f"training request.input.{key}")
        if candidate.is_symlink() or not candidate.is_file():
            raise ValueError(f"training input is missing: {candidate}")
    output = _object(request["output"], "training request.output")
    _exact(output, {"root", "result_json", "checkpoint_dir"}, "training request.output")
    output_root = _under(root, output["root"], "training request.output.root")
    if output_root != root / "outputs" / "train" / f"attempt-{request['attempt']}":
        raise ValueError("unexpected training output root")
    if _under(root, output["result_json"], "training request.output.result_json") != output_root / "result.json":
        raise ValueError("unexpected training result path")
    if _under(root, output["checkpoint_dir"], "training request.output.checkpoint_dir") != output_root / "train" / "checkpoint-2":
        raise ValueError("unexpected training checkpoint path")
    model = _object(request["model"], "training request.model")
    _exact(model, {"id", "revision", "path"}, "training request.model")
    if model != {"id": MODEL_ID, "revision": MODEL_REVISION, "path": MODEL_PATH}:
        raise ValueError("training model is not frozen Qwen3.5-9B revision")
    recipe = _object(request["recipe"], "training request.recipe")
    expected_recipe = {
        "gpus": 4, "gpu_family": "H200", "max_steps": 2, "tuner_type": "full",
        "precision": "bf16", "optimizer": "adafactor", "deepspeed": "zero3",
        "expected_parameters": EXPECTED_PARAMETERS,
    }
    if recipe != expected_recipe:
        raise ValueError("training recipe is not the frozen Stage 4A recipe")
    return request, root


def _validate_eval_request(path: Path) -> tuple[dict[str, Any], Path]:
    request, root = _common_request(path, EVAL_REQUEST_VERSION, "evaluation")
    _exact(request, {"schema_version", "profile_id", "run_id", "attempt", "checkpoint_path", "output", "runtime", "case_ids"}, "evaluation request")
    checkpoint = _under(root, request["checkpoint_path"], "evaluation request.checkpoint_path")
    if checkpoint.is_symlink() or not checkpoint.is_dir():
        raise ValueError("evaluation checkpoint is missing")
    output = _object(request["output"], "evaluation request.output")
    _exact(output, {"root", "result_json"}, "evaluation request.output")
    output_root = _under(root, output["root"], "evaluation request.output.root")
    if output_root != root / "outputs" / "eval" / f"attempt-{request['attempt']}":
        raise ValueError("unexpected evaluation output root")
    if _under(root, output["result_json"], "evaluation request.output.result_json") != output_root / "result.json":
        raise ValueError("unexpected evaluation result path")
    runtime = _object(request["runtime"], "evaluation request.runtime")
    expected_runtime = {
        "gpus": 1, "gpu_family": "H200", "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION, "vllm_version": VLLM_VERSION,
        "tool_call_parser": TOOL_CALL_PARSER,
    }
    if runtime != expected_runtime or request["case_ids"] != list(CASE_IDS):
        raise ValueError("evaluation protocol is not the frozen Stage 4A protocol")
    return request, root


def _logical_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, 1):
            if not raw.strip():
                raise ValueError(f"logical view line {line_number} is blank")
            value = json.loads(raw, object_pairs_hook=_pairs)
            row = _object(value, f"logical view line {line_number}")
            _exact(row, LOGICAL_FIELDS, f"logical view line {line_number}")
            if row["schema_version"] != LOGICAL_VERSION:
                raise ValueError("unsupported logical-view schema")
            source = _object(row["source"], f"logical view line {line_number}.source")
            _exact(source, SOURCE_FIELDS, f"logical view line {line_number}.source")
            record_id = _text(source["record_id"], "source.record_id")
            record_index = _integer(source["record_index"], "source.record_index")
            if _integer(source["record_line"], "source.record_line", 1) != record_index + 1:
                raise ValueError("source line/index mismatch")
            assistant_index = _integer(row["assistant_message_index"], "assistant_message_index")
            unit_id = _text(row["id"], "logical unit id")
            if unit_id != f"{record_id}:assistant:{assistant_index}" or unit_id in seen:
                raise ValueError("logical unit id is inconsistent or duplicated")
            seen.add(unit_id)
            messages = row["messages"]
            tools = row["tools"]
            if not isinstance(messages, list) or not messages or not isinstance(tools, list):
                raise ValueError("logical messages/tools are invalid")
            if assistant_index != len(messages) - 1:
                raise ValueError("logical unit is not an assistant-target prefix")
            for index, message_value in enumerate(messages):
                message = _object(message_value, f"messages[{index}]")
                role = message.get("role")
                if role not in {"system", "developer", "user", "assistant", "tool"}:
                    raise ValueError("unsupported message role")
                if role == "assistant":
                    if message.get("loss") is not (index == assistant_index):
                        raise ValueError("logical view does not use assistant-only loss")
                elif "loss" in message:
                    raise ValueError("non-assistant message must not carry loss")
                if "loss_scale" in message:
                    raise ValueError("message-level loss_scale is forbidden")
            if messages[-1].get("role") != "assistant":
                raise ValueError("logical target must be assistant")
            rows.append({
                "id": unit_id,
                "messages": copy.deepcopy(messages),
                "tools": copy.deepcopy(tools),
            })
    if not rows:
        raise ValueError("logical view is empty")
    return rows


def prepare_train(request_path: Path) -> int:
    request, root = _validate_train_request(request_path)
    summary = _read_json(_under(root, request["input"]["run_summary_json"], "run summary"))
    if summary.get("summary_version") != RUN_SUMMARY_VERSION:
        raise ValueError("unsupported run summary")
    rows = _logical_rows(_under(root, request["input"]["logical_view_jsonl"], "logical view"))
    if summary.get("counts", {}).get("logical_training_units") != len(rows):
        raise ValueError("run summary logical count mismatch")
    output = Path(request["output"]["root"])
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    dataset = request_path.parent / "messages-v2.jsonl"
    with dataset.open("x", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    config = {
        "model": MODEL_PATH, "use_hf": True, "check_model": False,
        "template": "qwen3_5", "template_backend": "swift", "enable_thinking": False,
        "add_non_thinking_prefix": True, "loss_scale": "default", "is_binary_loss_scale": True,
        "max_length": 8192, "truncation_strategy": "raise", "dataset": [str(dataset)],
        "split_dataset_ratio": 0, "dataset_num_proc": 4, "load_from_cache_file": False,
        "strict": True, "tuner_type": "full", "freeze_llm": False, "freeze_vit": False,
        "freeze_aligner": False, "torch_dtype": "bfloat16", "bf16": True,
        "attn_impl": "flash_attn", "packing": True, "packing_length": 8192,
        "packing_num_proc": 1, "packing_strategy": "sequential",
        "per_device_train_batch_size": 1, "gradient_accumulation_steps": 4,
        "gradient_checkpointing": True, "vit_gradient_checkpointing": True,
        "learning_rate": 1e-5, "lr_scheduler_type": "cosine", "warmup_ratio": 0.05,
        "weight_decay": 0.1, "optim": "adafactor", "deepspeed": "zero3", "max_steps": 2,
        "save_strategy": "steps", "save_steps": 2, "save_total_limit": 1,
        "save_only_model": False, "logging_strategy": "steps", "logging_steps": 1,
        "logging_first_step": True, "report_to": ["none"], "dataloader_num_workers": 0,
        "seed": 42, "data_seed": 42, "output_dir": str(output / "train"), "add_version": False,
    }
    _write_new_json(request_path.parent / "train-config.json", config)
    return 0


def _tensor_digest(tensor: Any) -> str:
    import hashlib
    import torch
    raw = tensor.detach().cpu().contiguous().view(-1).view(torch.uint8).numpy().tobytes()
    return hashlib.sha256(raw).hexdigest()


def validate_train(request_path: Path) -> int:
    request, _ = _validate_train_request(request_path)
    checkpoint = Path(request["output"]["checkpoint_dir"])
    result_path = Path(request["output"]["result_json"])
    checks: dict[str, Any] = {
        "gpu_count": 0, "gpu_family": "unknown", "model_revision": MODEL_REVISION,
        "trainable_parameters": 0, "total_parameters": 0, "global_step": 0,
        "finite_metrics": False, "huggingface_weight_shards": 0,
        "zero_optimizer_shards": 0, "zero_model_state_shards": 0,
        "fresh_process_reload": False, "weights_changed": False,
    }
    failure: str | None = None
    try:
        if os.environ.get("AUTODATA_STAGE4A_TRAIN_EXIT", "0") != "0":
            raise RuntimeError("ms-swift training command failed")
        gpu_lines = [line for line in (Path(request["output"]["root"]) / "gpu-info.csv").read_text(encoding="utf-8").splitlines() if line]
        checks["gpu_count"] = len(gpu_lines)
        checks["gpu_family"] = "NVIDIA H200" if gpu_lines and all("NVIDIA H200" in line for line in gpu_lines) else "unexpected"
        trainer_state = _read_json(checkpoint / "trainer_state.json")
        checks["global_step"] = trainer_state.get("global_step", 0)
        step_logs = [entry for entry in trainer_state.get("log_history", []) if isinstance(entry, dict) and "loss" in entry]
        checks["finite_metrics"] = len(step_logs) >= 2 and all(
            isinstance(entry.get(field), (int, float)) and math.isfinite(entry[field])
            for entry in step_logs for field in ("loss", "grad_norm", "learning_rate")
        )
        checks["huggingface_weight_shards"] = len(list(checkpoint.glob("model-*-of-*.safetensors")))
        checks["zero_optimizer_shards"] = len(list(checkpoint.rglob("*optim_states.pt")))
        checks["zero_model_state_shards"] = len(list(checkpoint.rglob("*model_states.pt")))

        import torch
        from transformers import Qwen3_5ForConditionalGeneration
        base = Qwen3_5ForConditionalGeneration.from_pretrained(
            MODEL_PATH, local_files_only=True, dtype=torch.bfloat16, low_cpu_mem_usage=True
        )
        base_parameters = dict(base.named_parameters())
        base_names = tuple(base_parameters)
        base_count = sum(parameter.numel() for parameter in base_parameters.values())
        base_selected = base_parameters[SELECTED_PARAMETER].detach().cpu().clone()
        del base_parameters, base
        gc.collect()
        trained = Qwen3_5ForConditionalGeneration.from_pretrained(
            checkpoint, local_files_only=True, dtype=torch.bfloat16, low_cpu_mem_usage=True
        )
        trained_parameters = dict(trained.named_parameters())
        trained_count = sum(parameter.numel() for parameter in trained_parameters.values())
        trained_selected = trained_parameters[SELECTED_PARAMETER].detach().cpu().clone()
        checks["trainable_parameters"] = sum(
            parameter.numel() for parameter in trained_parameters.values() if parameter.requires_grad
        )
        checks["total_parameters"] = trained_count
        checks["fresh_process_reload"] = base_names == tuple(trained_parameters) and base_count == trained_count
        checks["weights_changed"] = _tensor_digest(base_selected) != _tensor_digest(trained_selected)
        required = {
            "gpu_count": 4, "gpu_family": "NVIDIA H200", "model_revision": MODEL_REVISION,
            "trainable_parameters": EXPECTED_PARAMETERS, "total_parameters": EXPECTED_PARAMETERS,
            "global_step": 2, "finite_metrics": True, "huggingface_weight_shards": 4,
            "zero_optimizer_shards": 4, "zero_model_state_shards": 4,
            "fresh_process_reload": True, "weights_changed": True,
        }
        if checks != required:
            raise RuntimeError(f"training checks failed: observed={checks!r}")
    except Exception as exc:  # result is still emitted for diagnosis
        failure = f"{type(exc).__name__}: {exc}"
    result = {
        "schema_version": TRAIN_RESULT_VERSION,
        "profile_id": request["profile_id"], "run_id": request["run_id"],
        "attempt": request["attempt"], "status": "passed" if failure is None else "failed",
        "checkpoint_path": str(checkpoint), "checks": checks, "failure": failure,
    }
    _write_new_json(result_path, result)
    return 0 if failure is None else 1


_GORILLA_TYPES = {
    "integer": "integer", "number": "number", "float": "number", "string": "string",
    "boolean": "boolean", "bool": "boolean", "array": "array", "list": "array",
    "dict": "object", "object": "object", "tuple": "array", "any": "string",
    "byte": "integer", "short": "integer", "long": "integer", "double": "number",
    "char": "string", "ArrayList": "array", "Array": "array", "HashMap": "object",
    "Hashtable": "object", "Queue": "array", "Stack": "array", "Any": "string",
    "String": "string", "Bigint": "integer",
}


def _cast_properties(properties: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(properties))
    for name, raw in result.items():
        value = _object(raw, f"property {name}")
        raw_type = value.get("type", "string")
        if not isinstance(raw_type, str):
            raise ValueError("BFCL property type must be a string")
        if raw_type == "float":
            value["format"] = "float"
            value["description"] = _text(value.get("description"), "float description") + " This is a float type value."
        value["type"] = _GORILLA_TYPES.get(raw_type, "string")
        if value["type"] == "object" and isinstance(value.get("properties"), Mapping):
            value["properties"] = _cast_properties(value["properties"])
        if value["type"] == "array" and isinstance(value.get("items"), dict):
            item_type = value["items"].get("type")
            if not isinstance(item_type, str) or item_type not in _GORILLA_TYPES:
                raise ValueError("unsupported BFCL array item type")
            value["items"]["type"] = _GORILLA_TYPES[item_type]
    return result


def _tools(functions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for function_value in functions:
        function = copy.deepcopy(function_value)
        function["name"] = _text(function.get("name"), "function name").replace(".", "_")
        parameters = _object(function.get("parameters"), "function parameters")
        parameters["type"] = "object"
        parameters["properties"] = _cast_properties(_object(parameters.get("properties"), "function properties"))
        tools.append({"type": "function", "function": function})
    return tools


def _http(method: str, url: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            value = json.loads(response.read().decode("utf-8"), object_pairs_hook=_pairs)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"vLLM HTTP {exc.code}: {exc.read().decode(errors='replace')}") from exc
    return _object(value, "vLLM response")


def _response_calls(response: Mapping[str, Any]) -> list[dict[str, str]]:
    choices = response.get("choices")
    if not isinstance(choices, list) or len(choices) != 1:
        raise ValueError("vLLM response must contain one choice")
    message = _object(_object(choices[0], "choice").get("message"), "choice.message")
    calls = message.get("tool_calls") or []
    if not isinstance(calls, list):
        raise ValueError("tool_calls must be an array")
    result: list[dict[str, str]] = []
    for call in calls:
        function = _object(_object(call, "tool call").get("function"), "tool call.function")
        arguments = function.get("arguments")
        parsed = json.loads(arguments, object_pairs_hook=_pairs) if isinstance(arguments, str) else arguments
        parsed_object = _object(parsed, "tool call arguments")
        result.append({_text(function.get("name"), "tool call name"): json.dumps(parsed_object, sort_keys=True, separators=(",", ":"), allow_nan=False)})
    return result


def _checker() -> tuple[Any, Any]:
    from bfcl_eval.constants.enums import Language
    registry_name = "bfcl_eval.constants.model_config"
    module_name = "bfcl_eval.eval_checker.ast_eval.ast_checker"
    previous = sys.modules.get(registry_name)
    stub = types.ModuleType(registry_name)
    stub.MODEL_CONFIG_MAPPING = {"qwen3-8b-FC": types.SimpleNamespace(underscore_to_dot=True)}
    sys.modules[registry_name] = stub
    try:
        module = importlib.import_module(module_name)
    finally:
        if previous is None:
            sys.modules.pop(registry_name, None)
        else:
            sys.modules[registry_name] = previous
    return module.ast_checker, Language


def prepare_eval(request_path: Path) -> int:
    request, _ = _validate_eval_request(request_path)
    Path(request["output"]["root"]).mkdir(parents=True, exist_ok=False, mode=0o700)
    return 0


def evaluate(request_path: Path) -> int:
    request, root = _validate_eval_request(request_path)
    result_path = Path(request["output"]["result_json"])
    checks: dict[str, Any] = {
        "gpu_count": 0, "gpu_family": "unknown", "model_revision": MODEL_REVISION,
        "vllm_version": "unknown", "tool_call_parser": TOOL_CALL_PARSER,
        "loaded_weight_shards": 0,
    }
    case_results: list[dict[str, Any]] = []
    failure: str | None = None
    try:
        output_root = Path(request["output"]["root"])
        gpu_lines = [line for line in (output_root / "gpu-info.csv").read_text(encoding="utf-8").splitlines() if line]
        checks["gpu_count"] = len(gpu_lines)
        checks["gpu_family"] = "NVIDIA H200" if len(gpu_lines) == 1 and "NVIDIA H200" in gpu_lines[0] else "unexpected"
        version = _http("GET", "http://127.0.0.1:8000/version").get("version")
        checks["vllm_version"] = version
        checkpoint = Path(request["checkpoint_path"])
        checks["loaded_weight_shards"] = len(list(checkpoint.glob("model-*-of-*.safetensors")))
        if importlib.metadata.version("bfcl-eval") != "2026.3.23":
            raise ValueError("unexpected bfcl-eval version")
        ast_checker, language = _checker()
        rows: list[dict[str, Any]] = []
        with (root / "bfcl" / "search.jsonl").open(encoding="utf-8") as handle:
            for line in handle:
                rows.append(_object(json.loads(line, object_pairs_hook=_pairs), "BFCL case"))
        if [row.get("id") for row in rows] != list(CASE_IDS):
            raise ValueError("BFCL case bundle does not match frozen order")
        for case in rows:
            body = {
                "model": MODEL_ID, "messages": case["messages"], "tools": _tools(case["functions"]),
                "tool_choice": "auto", "parallel_tool_calls": True, "temperature": 0.0,
                "top_p": 1.0, "max_tokens": 2048, "seed": 42, "n": 1, "stream": False,
                "include_reasoning": False, "chat_template_kwargs": {"enable_thinking": False},
                "request_id": f"{request['run_id']}-{case['id']}",
            }
            response = _http("POST", "http://127.0.0.1:8000/v1/chat/completions", body)
            calls = _response_calls(response)
            if case["category"] == "irrelevance":
                passed = not calls
            else:
                decoded = [{name: json.loads(arguments)} for call in calls for name, arguments in call.items()]
                outcome = ast_checker(
                    case["functions"], decoded, case["ground_truth"], language.PYTHON,
                    case["category"], "qwen3-8b-FC",
                )
                passed = bool(outcome.get("valid"))
            case_results.append({"case_id": case["id"], "passed": passed})
        expected_checks = {
            "gpu_count": 1, "gpu_family": "NVIDIA H200", "model_revision": MODEL_REVISION,
            "vllm_version": VLLM_VERSION, "tool_call_parser": TOOL_CALL_PARSER,
            "loaded_weight_shards": 4,
        }
        if checks != expected_checks or not all(case["passed"] for case in case_results):
            raise RuntimeError("evaluation checks or one frozen BFCL case failed")
    except Exception as exc:  # preserve a strict failure result when possible
        failure = f"{type(exc).__name__}: {exc}"
        known = {entry["case_id"]: entry for entry in case_results}
        case_results = [known.get(case_id, {"case_id": case_id, "passed": False}) for case_id in CASE_IDS]
    result = {
        "schema_version": EVAL_RESULT_VERSION,
        "profile_id": request["profile_id"], "run_id": request["run_id"],
        "attempt": request["attempt"], "status": "passed" if failure is None else "failed",
        "checks": checks, "cases": case_results, "failure": failure,
    }
    _write_new_json(result_path, result)
    return 0 if failure is None else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("prepare-train", "validate-train", "prepare-eval", "evaluate"))
    parser.add_argument("request", type=Path)
    args = parser.parse_args(argv)
    if args.operation == "prepare-train":
        return prepare_train(args.request)
    if args.operation == "validate-train":
        return validate_train(args.request)
    if args.operation == "prepare-eval":
        return prepare_eval(args.request)
    return evaluate(args.request)


if __name__ == "__main__":
    raise SystemExit(main())
