"""Strict worker for frozen Stage 4B H0 and first-candidate H1 experiments.

The host owns experiment state and materializes an immutable staging tree.  This
module validates that tree against the checked-in contract, runs the fixed
training/evaluation commands, and emits the corresponding versioned result.
"""

from __future__ import annotations

import argparse
import copy
import gc
import hashlib
import importlib.metadata
import json
import math
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from autodata_stage4a.worker import (
    LOGICAL_FIELDS,
    SOURCE_FIELDS,
    _checker,
    _exact,
    _http,
    _integer,
    _logical_rows,
    _object,
    _pairs,
    _read_json,
    _request_root,
    _response_calls,
    _tensor_digest,
    _text,
    _tools,
    _under,
    _write_new_json,
)


CONTRACT_VERSION = "autodata-experiment-contract-1"
TRAIN_REQUEST_VERSION = "autodata-experiment-train-request-1"
TRAIN_RESULT_VERSION = "autodata-experiment-train-result-1"
EVAL_REQUEST_VERSION = "autodata-experiment-eval-request-1"
EVAL_RESULT_VERSION = "autodata-experiment-eval-result-1"
PREDICTION_VERSION = "autodata-experiment-prediction-1"
CONTRACT_ID = "stage4b-h0-baseline-1"
CANDIDATE_CONTRACT_ID = "stage4c-candidate-1"
CANONICAL_VERSION = "dataharness-canonical-tool-trajectory-3"
LOGICAL_VERSION = "dataharness-logical-training-unit-4"
RUN_SUMMARY_VERSION = "autodata-run-summary-1"
BFCL_BUNDLE_VERSION = "dataharness-bfcl-case-bundle-1"

MODEL_ID = "Qwen/Qwen3.5-9B"
MODEL_REVISION = "c202236235762e1c871ad0ccb60c8ee5ba337b9a"
MODEL_PATH = (
    "/mnt/shared-storage-gpfs2/gpfs2-shared-public/huggingface/hub/"
    "models--Qwen--Qwen3.5-9B/snapshots/" + MODEL_REVISION
)
EXPECTED_PARAMETERS = 9_409_813_744
VLLM_VERSION = "0.19.1"
TOOL_CALL_PARSER = "qwen3_coder"
SELECTED_PARAMETER = "model.language_model.layers.0.mlp.down_proj.weight"

DATASET_ID = "nex-agi/agent-sft"
DATASET_SUBSET = "tool_calling"
DATASET_REVISION = "d8d4de5643f9fe9d3fc3f89b3d55b8709ddc35c9"
ADAPTER_ID = "openai-tool-trajectory"
ADAPTER_VERSION = "2"
PLUGIN_ID = "toolcall-h0"
PLUGIN_VERSION = "3"
CANONICAL_RECORDS = 100
LOGICAL_TRAINING_UNITS = 236
HISTORICAL_TRAINING_TOKENS = 508_114

CATEGORIES = (
    "simple_python",
    "multiple",
    "parallel",
    "parallel_multiple",
    "irrelevance",
)
SPLITS = ("B_search", "B_dev")
CASE_IDS: dict[str, tuple[str, ...]] = {
    "B_search": (
        "simple_python_116", "simple_python_108", "simple_python_217",
        "simple_python_206", "simple_python_324",
        "multiple_132", "multiple_59", "multiple_169", "multiple_122",
        "multiple_107",
        "parallel_115", "parallel_161", "parallel_2", "parallel_41",
        "parallel_44",
        "parallel_multiple_177", "parallel_multiple_90", "parallel_multiple_68",
        "parallel_multiple_35", "parallel_multiple_185",
        "irrelevance_194", "irrelevance_68", "irrelevance_152",
        "irrelevance_45", "irrelevance_169",
    ),
    "B_dev": (
        "simple_python_304", "simple_python_195", "simple_python_53",
        "simple_python_35", "simple_python_159",
        "multiple_46", "multiple_35", "multiple_163", "multiple_183",
        "multiple_21",
        "parallel_86", "parallel_122", "parallel_59", "parallel_111",
        "parallel_28",
        "parallel_multiple_0", "parallel_multiple_163", "parallel_multiple_171",
        "parallel_multiple_188", "parallel_multiple_45",
        "irrelevance_188", "irrelevance_8", "irrelevance_236",
        "irrelevance_239", "irrelevance_184",
    ),
}
DATA_HASHES = {
    "canonical_jsonl": "c5c57f65bb58ddecf4d83d576a0fc7341153933bab2ce9b9596b20f9496a9db4",
    "logical_view_jsonl": "984a2fd580c28d2b4f5a4256e33997b221d309bb7b0c6d4fedb424a47a1fafc6",
    "run_summary_json": "8b845ffead9b96d42e9767406a2fe1519232280f4a79d8259be2276713cb2096",
}
BFCL_HASHES = {
    "selection.json": "899f2170343b2ebbeaa15263c73f45fe7a57ac74c04d0eed8864b034dbcec450",
    "search.jsonl": "a355b2e1137f7203e420bf80b75e822f3fc8747a2c89cbc1d1aa129b5c633d12",
    "dev.jsonl": "ae88ed88291b26e2aee549ac634662bc05e2848182df81ba8bd8b62732e2679e",
    "manifest.json": "3a6417f5675c0a9b98022289d4243dd39470e8e49ee2faf85e6fe0981cedca29",
}
CANONICAL_FIELDS = {"schema_version", "source", "messages", "tools"}
SUMMARY_FIELDS = {
    "summary_version", "harness_id", "generation", "seed",
    "canonical_schema_version", "logical_view_schema_version", "source",
    "plugins", "counts", "validation_warning_counts",
}
COUNT_FIELDS = {
    "source_records_read", "selected_source_records", "quarantined_source_records",
    "duplicate_source_records", "canonical_records", "logical_training_units",
    "validation_warnings",
}
BFCL_CASE_FIELDS = {
    "bundle_version", "id", "split", "category", "messages", "functions",
    "ground_truth",
}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_wheelhouse(value: Any, label: str) -> tuple[Path, ...]:
    """Verify the pinned manifest bytes, exact wheel set, and every wheel digest."""

    wheelhouse = _object(value, label)
    _exact(wheelhouse, {"path", "manifest_sha256"}, label)
    root = Path(_text(wheelhouse.get("path"), f"{label}.path"))
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError(f"{label} must be an absolute regular directory")
    manifest = root / "wheelhouse.sha256"
    if manifest.is_symlink() or not manifest.is_file():
        raise ValueError(f"{label} manifest must be a regular file")
    observed_manifest = _sha256_file(manifest)
    expected_manifest = _text(wheelhouse.get("manifest_sha256"), f"{label}.manifest_sha256")
    if observed_manifest != expected_manifest:
        raise ValueError(
            f"{label} manifest SHA-256 mismatch: observed={observed_manifest}"
        )

    expected_wheels: dict[str, str] = {}
    for line_number, line in enumerate(manifest.read_text(encoding="utf-8").splitlines(), 1):
        match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9_.+-]*\.whl)", line)
        if match is None:
            raise ValueError(f"{label} manifest line {line_number} is not canonical")
        digest, name = match.groups()
        if name in expected_wheels:
            raise ValueError(f"{label} manifest contains duplicate wheel {name}")
        expected_wheels[name] = digest
    if not expected_wheels or list(expected_wheels) != sorted(expected_wheels):
        raise ValueError(f"{label} manifest must contain a non-empty sorted wheel list")

    wheel_paths: dict[str, Path] = {}
    for path in root.glob("*.whl"):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"{label} contains a non-regular wheel: {path.name}")
        wheel_paths[path.name] = path
    if set(wheel_paths) != set(expected_wheels):
        raise ValueError(f"{label} manifest does not describe the exact wheel set")
    for name, expected in expected_wheels.items():
        observed = _sha256_file(wheel_paths[name])
        if observed != expected:
            raise ValueError(f"{label} wheel SHA-256 mismatch for {name}: observed={observed}")
    return tuple(wheel_paths[name] for name in expected_wheels)


def _expected_contract() -> dict[str, Any]:
    return {
        "schema_version": CONTRACT_VERSION,
        "contract_id": CONTRACT_ID,
        "profile": {
            "id": "bfcl-v4",
            "benchmark": "bfcl-v4",
            "metric": "equal_category_accuracy",
        },
        "data": {
            "dataset_id": DATASET_ID,
            "dataset_subset": DATASET_SUBSET,
            "dataset_revision": DATASET_REVISION,
            "harness_id": PLUGIN_ID,
            "seed": 42,
            "canonical_records": CANONICAL_RECORDS,
            "logical_training_units": LOGICAL_TRAINING_UNITS,
            "historical_training_tokens": HISTORICAL_TRAINING_TOKENS,
            "canonical_jsonl_sha256": DATA_HASHES["canonical_jsonl"],
            "logical_view_jsonl_sha256": DATA_HASHES["logical_view_jsonl"],
            "run_summary_json_sha256": DATA_HASHES["run_summary_json"],
        },
        "model": {
            "id": MODEL_ID,
            "revision": MODEL_REVISION,
            "path": MODEL_PATH,
            "thinking": False,
            "expected_parameters": EXPECTED_PARAMETERS,
        },
        "execution": {
            "container_image": "registry.h.pjlab.org.cn/ailab/pytorch2.7.0-cuda12.8-cudnn9:v5",
            "rjob_backoff_limit": 1,
            "training_wheelhouse": {
                "path": "/mnt/shared-storage-user/gezhilong/dataharness/dependencies/ms-swift-4.5.2-py311-torch2.7-cu128-v3/wheelhouse",
                "manifest_sha256": "e046861cb51416e092fcb9960f4a496624ee227843fe9eef0c7551beaf0cc8b2",
            },
            "vllm_wheelhouse": {
                "path": "/mnt/shared-storage-user/gezhilong/autodata/dependencies/vllm-0.19.1-transformers-5.15.1-py311-cu128/wheelhouse",
                "manifest_sha256": "55b2bfbd4b489dd2e7b7f2e799a0de77aa7c2955f6fdab0b637cdc7213525cd1",
            },
            "bfcl_wheelhouse": {
                "path": "/mnt/shared-storage-user/gezhilong/dataharness/dependencies/bfcl-eval-2026.3.23-py311/wheelhouse",
                "manifest_sha256": "7507a94e76979398fbc137aea24252a5a3362a478bdfecb8ed1ed18c02a720b6",
            },
        },
        "training": {
            "gpus": 4,
            "gpu_family": "H200",
            "max_steps": 16,
            "max_length": 8192,
            "per_device_train_batch_size": 1,
            "gradient_accumulation_steps": 4,
            "tuner_type": "full",
            "precision": "bf16",
            "optimizer": "adafactor",
            "deepspeed": "zero3",
            "packing": True,
            "padding_free": True,
            "gradient_checkpointing": True,
            "use_hf": True,
            "check_model": False,
            "template": "qwen3_5",
            "template_backend": "swift",
            "enable_thinking": False,
            "add_non_thinking_prefix": True,
            "loss_scale": "default",
            "is_binary_loss_scale": True,
            "truncation_strategy": "delete",
            "split_dataset_ratio": 0,
            "dataset_num_proc": 4,
            "load_from_cache_file": False,
            "strict": True,
            "freeze_llm": False,
            "freeze_vit": False,
            "freeze_aligner": False,
            "torch_dtype": "bfloat16",
            "bf16": True,
            "attention_implementation": "flash_attn",
            "packing_length": 8192,
            "packing_num_proc": 1,
            "packing_strategy": "sequential",
            "learning_rate": 1e-5,
            "lr_scheduler_type": "cosine",
            "warmup_ratio": 0.05,
            "weight_decay": 0.1,
            "vit_gradient_checkpointing": True,
            "save_strategy": "steps",
            "save_steps": 16,
            "save_total_limit": 1,
            "save_only_model": False,
            "logging_strategy": "steps",
            "logging_steps": 1,
            "logging_first_step": True,
            "report_to": ["none"],
            "dataloader_num_workers": 0,
            "seed": 42,
            "data_seed": 42,
            "add_version": False,
        },
        "evaluation": {
            "gpus": 1,
            "gpu_family": "H200",
            "vllm_version": VLLM_VERSION,
            "tool_call_parser": TOOL_CALL_PARSER,
            "bfcl_version": "2026.3.23",
            "server": {
                "dtype": "bfloat16",
                "tensor_parallel_size": 1,
                "max_model_len": 8192,
                "gpu_memory_utilization": 0.9,
                "generation_config": "vllm",
                "enable_auto_tool_choice": True,
            },
            "generation": {
                "tool_choice": "auto",
                "parallel_tool_calls": True,
                "temperature": 0,
                "top_p": 1,
                "max_tokens": 2048,
                "seed": 42,
                "n": 1,
                "stream": False,
                "include_reasoning": False,
                "enable_thinking": False,
            },
            "checker": {
                "language": "python",
                "model_config": "qwen3-8b-FC",
                "underscore_to_dot": True,
            },
            "categories": list(CATEGORIES),
            "cases_per_category_per_split": 5,
            "case_ids": {split: list(CASE_IDS[split]) for split in SPLITS},
            "macro": "equal_category_accuracy",
        },
        "retry": {
            "scientific_retries": 0,
            "infrastructure_retries_per_stage": 1,
        },
    }


def _load_contract(root: Path) -> tuple[dict[str, Any], str]:
    path = root / "experiment-contract.json"
    if path.is_symlink() or not path.is_file():
        raise ValueError("the staged experiment contract must be a regular file")
    raw_sha256 = _sha256_file(path)
    contract = _read_json(path)
    _validate_contract(contract)
    return contract, raw_sha256


def _validate_contract(contract: dict[str, Any]) -> None:
    """Accept the byte-compatible H0 contract or a strictly derived H1 contract."""

    expected = _expected_contract()
    if "subject" not in contract:
        if contract != expected:
            raise ValueError("the staged experiment contract is not the frozen Stage 4B contract")
        return

    _exact(contract, set(expected) | {"subject"}, "candidate experiment contract")
    if contract.get("schema_version") != CONTRACT_VERSION:
        raise ValueError("unsupported candidate experiment contract schema")
    if contract.get("contract_id") != CANDIDATE_CONTRACT_ID:
        raise ValueError("candidate experiment contract id is not frozen")
    for field in ("profile", "model", "execution", "training", "evaluation", "retry"):
        if contract.get(field) != expected[field]:
            raise ValueError(f"candidate experiment {field} differs from the frozen H0 protocol")

    subject = _object(contract.get("subject"), "candidate experiment subject")
    _exact(subject, {
        "candidate_id", "generation", "plugin_id", "strategy_version",
        "host_source_sha256",
    }, "candidate experiment subject")
    for field in ("candidate_id", "plugin_id"):
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", _text(subject.get(field), field)):
            raise ValueError(f"candidate experiment subject {field} is invalid")
    if subject["candidate_id"] == "h0" or _integer(subject.get("generation"), "generation", 1) != 1:
        raise ValueError("candidate experiment subject must identify H1")
    strategy_version = _text(subject.get("strategy_version"), "strategy_version")
    if len(strategy_version) > 128:
        raise ValueError("candidate strategy_version is too long")
    if not re.fullmatch(r"[a-f0-9]{64}", _text(subject.get("host_source_sha256"), "host_source_sha256")):
        raise ValueError("candidate host source hash is invalid")

    data = _object(contract.get("data"), "candidate experiment data")
    _exact(data, set(expected["data"]), "candidate experiment data")
    for field in (
        "dataset_id", "dataset_subset", "dataset_revision", "seed",
        "canonical_records", "historical_training_tokens", "canonical_jsonl_sha256",
    ):
        if data.get(field) != expected["data"][field]:
            raise ValueError(f"candidate experiment data.{field} differs from the frozen H0 source pool")
    _text(data.get("harness_id"), "candidate experiment data.harness_id")
    _integer(data.get("logical_training_units"), "logical_training_units", 1)
    for field in ("logical_view_jsonl_sha256", "run_summary_json_sha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", _text(data.get(field), field)):
            raise ValueError(f"candidate experiment data.{field} is invalid")


def _common_request(
    path: Path,
    expected_version: str,
    stage: str,
    fields: set[str],
) -> tuple[dict[str, Any], Path, dict[str, Any]]:
    request = _read_json(path)
    root = _request_root(path)
    if path.resolve(strict=True).parents[1].name != stage:
        raise ValueError(f"request path is not in the {stage} attempt directory")
    _exact(request, fields, f"{stage} request")
    if request.get("schema_version") != expected_version:
        raise ValueError(f"unsupported {stage} request schema")
    contract, contract_sha256 = _load_contract(root)
    if request.get("contract_id") != contract["contract_id"]:
        raise ValueError("request contract id is not frozen")
    if request.get("contract_sha256") != contract_sha256:
        raise ValueError("request contract SHA-256 does not match the exact staged bytes")
    profile_id = _text(request.get("profile_id"), "profile_id")
    run_id = _text(request.get("run_id"), "run_id")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", profile_id):
        raise ValueError("invalid profile_id")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", run_id) or root.name != run_id:
        raise ValueError("invalid run_id or staging directory")
    _integer(request.get("attempt"), "attempt", 1)
    if request.get("model") != contract["model"]:
        raise ValueError("request model differs from the experiment contract")
    return request, root, contract


def _input_path(root: Path, value: Any, name: str) -> Path:
    path = _under(root, value, f"training request.input.{name}")
    expected = root / {
        "canonical_jsonl": "canonical.jsonl",
        "logical_view_jsonl": "logical-view.jsonl",
        "run_summary_json": "run-summary.json",
    }[name]
    if path != expected or path.is_symlink() or not path.is_file():
        raise ValueError(f"training request.input.{name} is not the staged immutable input")
    return path


def _jsonl_objects(path: Path, label: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, 1):
            if not raw.strip():
                raise ValueError(f"{label} line {line_number} is blank")
            rows.append(_object(
                json.loads(raw, object_pairs_hook=_pairs),
                f"{label} line {line_number}",
            ))
    return rows


def _expected_source(contract: Mapping[str, Any] | None = None) -> dict[str, str]:
    data = _expected_contract()["data"] if contract is None else contract["data"]
    return {
        "adapter_id": ADAPTER_ID,
        "adapter_version": ADAPTER_VERSION,
        "dataset_id": data["dataset_id"],
        "dataset_revision": data["dataset_revision"],
    }


def _validate_canonical_rows(
    path: Path,
    contract: Mapping[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    contract = _expected_contract() if contract is None else contract
    expected_count = contract["data"]["canonical_records"]
    rows = _jsonl_objects(path, "canonical input")
    if len(rows) != expected_count:
        raise ValueError(f"canonical input must contain exactly {expected_count} records")
    positions: dict[str, int] = {}
    expected_source = _expected_source(contract)
    for position, row in enumerate(rows):
        _exact(row, CANONICAL_FIELDS, f"canonical input row {position + 1}")
        if row.get("schema_version") != CANONICAL_VERSION:
            raise ValueError("canonical input has an unsupported schema")
        source = _object(row.get("source"), "canonical source")
        _exact(source, SOURCE_FIELDS, "canonical source")
        if any(source.get(key) != value for key, value in expected_source.items()):
            raise ValueError("canonical input source provenance is not frozen")
        record_id = _text(source.get("record_id"), "canonical source.record_id")
        record_index = _integer(source.get("record_index"), "canonical source.record_index")
        if _integer(source.get("record_line"), "canonical source.record_line", 1) != record_index + 1:
            raise ValueError("canonical source line/index mismatch")
        if record_id in positions:
            raise ValueError("canonical input contains a duplicate record id")
        if record_index != position:
            raise ValueError("canonical input record index does not match frozen source order")
        positions[record_id] = position
        messages = row.get("messages")
        tools = row.get("tools")
        if not isinstance(messages, list) or not messages or not isinstance(tools, list):
            raise ValueError("canonical messages/tools are invalid")
        for message in messages:
            message_object = _object(message, "canonical message")
            if message_object.get("role") not in {"system", "developer", "user", "assistant", "tool"}:
                raise ValueError("canonical input contains an unsupported message role")
            if "loss" in message_object or "loss_scale" in message_object:
                raise ValueError("canonical input contains worker-only loss metadata")
    return rows, positions


def _without_loss(message: Mapping[str, Any]) -> dict[str, Any]:
    return {key: copy.deepcopy(value) for key, value in message.items() if key != "loss"}


def _validate_logical_rows(
    path: Path,
    canonical_rows: list[dict[str, Any]],
    canonical_positions: Mapping[str, int],
    contract: Mapping[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    contract = _expected_contract() if contract is None else contract
    expected_count = contract["data"]["logical_training_units"]
    subject = contract.get("subject")
    training_rows = _logical_rows(path)
    raw_rows = _jsonl_objects(path, "logical input")
    if len(raw_rows) != expected_count or len(training_rows) != expected_count:
        raise ValueError(f"logical input must contain exactly {expected_count} units")
    expected_source = _expected_source(contract)
    rank_by_record: dict[str, int] = {}
    selected_record_ids: set[str] = set()
    last_assistant_by_rank: dict[int, int] = {}
    assistant_indices_by_record: dict[str, list[int]] = {}
    previous_rank = -1
    for position, row in enumerate(raw_rows):
        _exact(row, LOGICAL_FIELDS, f"logical input row {position + 1}")
        source = _object(row.get("source"), "logical source")
        if any(source.get(key) != value for key, value in expected_source.items()):
            raise ValueError("logical input source provenance is not frozen")
        record_id = _text(source.get("record_id"), "logical source.record_id")
        selected_record_ids.add(record_id)
        selection_rank = _integer(row.get("selection_rank"), "selection_rank")
        canonical_position = canonical_positions.get(record_id)
        if canonical_position is None:
            raise ValueError("logical input refers to an unknown canonical record")
        canonical = canonical_rows[canonical_position]
        if subject is None:
            if selection_rank != canonical["source"]["record_index"]:
                raise ValueError("logical selection rank does not match source record index")
        else:
            known_rank = rank_by_record.get(record_id)
            if known_rank is None:
                if selection_rank != previous_rank + 1:
                    raise ValueError("candidate logical selection ranks are not contiguous and ordered")
                rank_by_record[record_id] = selection_rank
                previous_rank = selection_rank
            elif known_rank != selection_rank or selection_rank != previous_rank:
                raise ValueError("candidate logical units for a selected record are not contiguous")
        if source != canonical["source"] or row.get("tools") != canonical["tools"]:
            raise ValueError("logical source/tools do not match the canonical record")
        provenance = row.get("plugin_provenance")
        if subject is None:
            if provenance != [{"plugin_id": PLUGIN_ID, "plugin_version": PLUGIN_VERSION}]:
                raise ValueError("logical plugin provenance is not the frozen H0 provenance")
        else:
            if not isinstance(provenance, list) or len(provenance) != 1:
                raise ValueError("candidate logical provenance must contain exactly one strategy")
            entry = _object(provenance[0], "candidate logical provenance")
            if set(entry) not in (
                {"plugin_id", "plugin_version"},
                {"plugin_id", "plugin_version", "note"},
            ):
                raise ValueError("candidate logical provenance fields are invalid")
            if (
                entry.get("plugin_id") != subject["plugin_id"]
                or entry.get("plugin_version") != subject["strategy_version"]
            ):
                raise ValueError("candidate logical provenance does not match the contract subject")
            if "note" in entry:
                _text(entry.get("note"), "candidate logical provenance.note")
        assistant_index = _integer(row.get("assistant_message_index"), "assistant_message_index")
        if assistant_index <= last_assistant_by_rank.get(selection_rank, -1):
            raise ValueError("logical assistant targets are not in canonical message order")
        last_assistant_by_rank[selection_rank] = assistant_index
        assistant_indices_by_record.setdefault(record_id, []).append(assistant_index)
        messages = row.get("messages")
        assert isinstance(messages, list)
        stripped = [_without_loss(_object(message, "logical message")) for message in messages]
        if stripped != canonical["messages"][:assistant_index + 1]:
            raise ValueError("logical messages are not the canonical assistant prefix")
        if (
            assistant_index >= len(canonical["messages"])
            or canonical["messages"][assistant_index].get("role") != "assistant"
            or row.get("id") != f"{record_id}:assistant:{assistant_index}"
        ):
            raise ValueError("logical target identity is not canonical")
    for record_id in rank_by_record:
        canonical = canonical_rows[canonical_positions[record_id]]
        expected_indices = [
            index for index, message in enumerate(canonical["messages"])
            if message.get("role") == "assistant"
            and (
                message.get("content") not in (None, "")
                or bool(message.get("tool_calls"))
            )
        ]
        if assistant_indices_by_record.get(record_id) != expected_indices:
            raise ValueError("logical input does not contain every canonical assistant target")
    return training_rows, len(selected_record_ids)


def _validate_summary(
    path: Path,
    selected_source_records: int,
    contract: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    contract = _expected_contract() if contract is None else contract
    subject = contract.get("subject")
    summary = _read_json(path)
    _exact(summary, SUMMARY_FIELDS, "run summary")
    expected_source = _expected_source(contract)
    expected_plugins = (
        [{"id": PLUGIN_ID, "version": PLUGIN_VERSION}]
        if subject is None
        else [{"id": subject["plugin_id"], "version": subject["strategy_version"]}]
    )
    if (
        summary.get("summary_version") != RUN_SUMMARY_VERSION
        or summary.get("harness_id") != contract["data"]["harness_id"]
        or summary.get("generation") != (0 if subject is None else subject["generation"])
        or summary.get("seed") != contract["data"]["seed"]
        or summary.get("canonical_schema_version") != CANONICAL_VERSION
        or summary.get("logical_view_schema_version") != LOGICAL_VERSION
        or summary.get("source") != expected_source
        or summary.get("plugins") != expected_plugins
    ):
        raise ValueError("run summary provenance does not match the frozen experiment contract")
    counts = _object(summary.get("counts"), "run summary.counts")
    _exact(counts, COUNT_FIELDS, "run summary.counts")
    for name, value in counts.items():
        _integer(value, f"run summary.counts.{name}")
    canonical_records = contract["data"]["canonical_records"]
    if not 1 <= selected_source_records <= canonical_records:
        raise ValueError("logical input has an invalid selected source record count")
    if subject is None and selected_source_records != canonical_records:
        raise ValueError("H0 logical input must retain every frozen canonical record")
    if counts != {
        "source_records_read": canonical_records,
        "selected_source_records": selected_source_records,
        "quarantined_source_records": 0,
        "duplicate_source_records": 0,
        "canonical_records": canonical_records,
        "logical_training_units": contract["data"]["logical_training_units"],
        "validation_warnings": 0,
    }:
        raise ValueError("run summary record counts do not match the frozen data")
    warning_counts = _object(summary.get("validation_warning_counts"), "validation warning counts")
    if any(not isinstance(name, str) or not name for name in warning_counts):
        raise ValueError("run summary has an invalid validation warning name")
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in warning_counts.values()):
        raise ValueError("run summary has an invalid validation warning count")
    if warning_counts:
        raise ValueError("the frozen run summary must not contain validation warnings")
    return summary


def _validate_materialized_data(
    request: Mapping[str, Any],
    root: Path,
    contract: Mapping[str, Any],
) -> list[dict[str, Any]]:
    inputs = _object(request.get("input"), "training request.input")
    data_hashes = {
        "canonical_jsonl": contract["data"]["canonical_jsonl_sha256"],
        "logical_view_jsonl": contract["data"]["logical_view_jsonl_sha256"],
        "run_summary_json": contract["data"]["run_summary_json_sha256"],
    }
    _exact(inputs, set(data_hashes), "training request.input")
    paths = {name: _input_path(root, inputs[name], name) for name in data_hashes}
    for name, expected in data_hashes.items():
        observed = _sha256_file(paths[name])
        if observed != expected:
            raise ValueError(f"{name} SHA-256 mismatch: {observed}")
    canonical_rows, canonical_positions = _validate_canonical_rows(paths["canonical_jsonl"], contract)
    logical_rows, selected_source_records = _validate_logical_rows(
        paths["logical_view_jsonl"], canonical_rows, canonical_positions, contract
    )
    summary = _validate_summary(paths["run_summary_json"], selected_source_records, contract)
    if summary["counts"]["canonical_records"] != len(canonical_rows):
        raise ValueError("run summary canonical count mismatch")
    if summary["counts"]["logical_training_units"] != len(logical_rows):
        raise ValueError("run summary logical count mismatch")
    return logical_rows


def _validate_train_request(path: Path) -> tuple[dict[str, Any], Path, list[dict[str, Any]]]:
    request, root, contract = _common_request(
        path,
        TRAIN_REQUEST_VERSION,
        "train",
        {
            "schema_version", "contract_id", "contract_sha256", "profile_id",
            "run_id", "attempt", "input", "output", "model", "recipe",
        },
    )
    if request.get("recipe") != contract["training"]:
        raise ValueError("training recipe differs from the experiment contract")
    output = _object(request.get("output"), "training request.output")
    _exact(output, {"root", "result_json", "checkpoint_dir"}, "training request.output")
    output_root = _under(root, output.get("root"), "training request.output.root")
    expected_root = root / "outputs" / "train" / f"attempt-{request['attempt']}"
    if output_root != expected_root:
        raise ValueError("unexpected training output root")
    if _under(root, output.get("result_json"), "training request.output.result_json") != output_root / "result.json":
        raise ValueError("unexpected training result path")
    expected_checkpoint = output_root / "train" / "checkpoint-16"
    if _under(root, output.get("checkpoint_dir"), "training request.output.checkpoint_dir") != expected_checkpoint:
        raise ValueError("unexpected training checkpoint path")
    logical_rows = _validate_materialized_data(request, root, contract)
    return request, root, logical_rows


def _asset_path(root: Path, name: str) -> Path:
    path = root / "bfcl" / name
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"missing regular BFCL asset: {name}")
    observed = _sha256_file(path)
    if observed != BFCL_HASHES[name]:
        raise ValueError(f"BFCL asset SHA-256 mismatch for {name}: {observed}")
    return path


def _case_category(case_id: str) -> str:
    matches = [category for category in CATEGORIES if case_id.startswith(f"{category}_")]
    if not matches:
        raise ValueError(f"cannot infer category for {case_id}")
    return max(matches, key=len)


def _validate_bfcl_assets(root: Path) -> list[dict[str, Any]]:
    paths = {name: _asset_path(root, name) for name in BFCL_HASHES}
    manifest = _read_json(paths["manifest.json"])
    if set(manifest) != {"manifest_version", "bfcl", "selection", "bundles"}:
        raise ValueError("BFCL manifest fields are not frozen")
    selection = _object(manifest.get("selection"), "BFCL manifest.selection")
    if selection.get("sha256") != BFCL_HASHES["selection.json"]:
        raise ValueError("BFCL manifest selection hash is inconsistent")
    bundles = _object(manifest.get("bundles"), "BFCL manifest.bundles")
    if set(bundles) != {"search", "dev"}:
        raise ValueError("BFCL manifest must contain only search and dev")

    result: list[dict[str, Any]] = []
    for split, filename in (("B_search", "search.jsonl"), ("B_dev", "dev.jsonl")):
        metadata = _object(bundles.get(filename.removesuffix(".jsonl")), "BFCL bundle metadata")
        if (
            metadata.get("path") != filename
            or metadata.get("records") != len(CASE_IDS[split])
            or metadata.get("sha256") != BFCL_HASHES[filename]
            or metadata.get("bytes") != paths[filename].stat().st_size
            or metadata.get("category_counts") != {category: 5 for category in CATEGORIES}
        ):
            raise ValueError(f"BFCL manifest metadata for {split} is inconsistent")
        rows = _jsonl_objects(paths[filename], f"BFCL {split}")
        if [row.get("id") for row in rows] != list(CASE_IDS[split]):
            raise ValueError(f"BFCL {split} case order differs from the contract")
        for row in rows:
            _exact(row, BFCL_CASE_FIELDS, f"BFCL case {row.get('id')}")
            case_id = _text(row.get("id"), "BFCL case id")
            category = _case_category(case_id)
            if (
                row.get("bundle_version") != BFCL_BUNDLE_VERSION
                or row.get("split") != split.removeprefix("B_")
                or row.get("category") != category
            ):
                raise ValueError(f"BFCL case identity is inconsistent for {case_id}")
            if not isinstance(row.get("messages"), list) or not row["messages"]:
                raise ValueError(f"BFCL case {case_id} has invalid messages")
            if not isinstance(row.get("functions"), list) or not row["functions"]:
                raise ValueError(f"BFCL case {case_id} has invalid functions")
            if category == "irrelevance":
                if row.get("ground_truth") is not None:
                    raise ValueError(f"irrelevance case {case_id} must have null ground truth")
            elif not isinstance(row.get("ground_truth"), list):
                raise ValueError(f"BFCL case {case_id} has invalid ground truth")
            result.append({**row, "result_split": split})
    return result


def _validate_eval_request(path: Path) -> tuple[dict[str, Any], Path, list[dict[str, Any]]]:
    request, root, contract = _common_request(
        path,
        EVAL_REQUEST_VERSION,
        "eval",
        {
            "schema_version", "contract_id", "contract_sha256", "profile_id",
            "run_id", "attempt", "checkpoint_path", "output", "model",
            "runtime", "benchmark",
        },
    )
    checkpoint = _under(root, request.get("checkpoint_path"), "evaluation request.checkpoint_path")
    if checkpoint.is_symlink() or not checkpoint.is_dir():
        raise ValueError("evaluation checkpoint is missing")
    if not re.fullmatch(
        r"outputs/train/attempt-[1-9][0-9]*/train/checkpoint-16",
        checkpoint.relative_to(root).as_posix(),
    ):
        raise ValueError("evaluation checkpoint does not use the frozen training layout")
    output = _object(request.get("output"), "evaluation request.output")
    _exact(output, {"root", "result_json", "predictions_jsonl"}, "evaluation request.output")
    output_root = _under(root, output.get("root"), "evaluation request.output.root")
    expected_root = root / "outputs" / "eval" / f"attempt-{request['attempt']}"
    if output_root != expected_root:
        raise ValueError("unexpected evaluation output root")
    if _under(root, output.get("result_json"), "evaluation request.output.result_json") != output_root / "result.json":
        raise ValueError("unexpected evaluation result path")
    if _under(root, output.get("predictions_jsonl"), "evaluation request.output.predictions_jsonl") != output_root / "predictions.jsonl":
        raise ValueError("unexpected predictions path")
    expected_runtime = {
        "gpus": contract["evaluation"]["gpus"],
        "gpu_family": contract["evaluation"]["gpu_family"],
        "vllm_version": contract["evaluation"]["vllm_version"],
        "tool_call_parser": contract["evaluation"]["tool_call_parser"],
    }
    expected_benchmark = {
        "id": contract["profile"]["benchmark"],
        "metric": contract["profile"]["metric"],
        "categories": contract["evaluation"]["categories"],
        "case_ids": contract["evaluation"]["case_ids"],
        "macro": contract["evaluation"]["macro"],
    }
    if request.get("runtime") != expected_runtime or request.get("benchmark") != expected_benchmark:
        raise ValueError("evaluation request differs from the frozen experiment contract")
    return request, root, _validate_bfcl_assets(root)


def prepare_train(request_path: Path) -> int:
    request, _, rows = _validate_train_request(request_path)
    _verify_wheelhouse(
        _expected_contract()["execution"]["training_wheelhouse"],
        "training wheelhouse",
    )
    output = Path(request["output"]["root"])
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    dataset = request_path.parent / "messages-v2.jsonl"
    with dataset.open("x", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    recipe = request["recipe"]
    config = {
        "model": request["model"]["path"],
        "use_hf": recipe["use_hf"],
        "check_model": recipe["check_model"],
        "template": recipe["template"],
        "template_backend": recipe["template_backend"],
        "enable_thinking": recipe["enable_thinking"],
        "add_non_thinking_prefix": recipe["add_non_thinking_prefix"],
        "loss_scale": recipe["loss_scale"],
        "is_binary_loss_scale": recipe["is_binary_loss_scale"],
        "max_length": recipe["max_length"],
        "truncation_strategy": recipe["truncation_strategy"],
        "dataset": [str(dataset)],
        "split_dataset_ratio": recipe["split_dataset_ratio"],
        "dataset_num_proc": recipe["dataset_num_proc"],
        "load_from_cache_file": recipe["load_from_cache_file"],
        "strict": recipe["strict"],
        "tuner_type": recipe["tuner_type"],
        "freeze_llm": recipe["freeze_llm"],
        "freeze_vit": recipe["freeze_vit"],
        "freeze_aligner": recipe["freeze_aligner"],
        "torch_dtype": recipe["torch_dtype"],
        "bf16": recipe["bf16"],
        "attn_impl": recipe["attention_implementation"],
        "packing": recipe["packing"],
        "padding_free": recipe["padding_free"],
        "packing_length": recipe["packing_length"],
        "packing_num_proc": recipe["packing_num_proc"],
        "packing_strategy": recipe["packing_strategy"],
        "per_device_train_batch_size": recipe["per_device_train_batch_size"],
        "gradient_accumulation_steps": recipe["gradient_accumulation_steps"],
        "gradient_checkpointing": recipe["gradient_checkpointing"],
        "vit_gradient_checkpointing": recipe["vit_gradient_checkpointing"],
        "learning_rate": recipe["learning_rate"],
        "lr_scheduler_type": recipe["lr_scheduler_type"],
        "warmup_ratio": recipe["warmup_ratio"],
        "weight_decay": recipe["weight_decay"],
        "optim": recipe["optimizer"],
        "deepspeed": recipe["deepspeed"],
        "max_steps": recipe["max_steps"],
        "save_strategy": recipe["save_strategy"],
        "save_steps": recipe["save_steps"],
        "save_total_limit": recipe["save_total_limit"],
        "save_only_model": recipe["save_only_model"],
        "logging_strategy": recipe["logging_strategy"],
        "logging_steps": recipe["logging_steps"],
        "logging_first_step": recipe["logging_first_step"],
        "report_to": recipe["report_to"],
        "dataloader_num_workers": recipe["dataloader_num_workers"],
        "seed": recipe["seed"],
        "data_seed": recipe["data_seed"],
        "output_dir": str(output / "train"),
        "add_version": recipe["add_version"],
    }
    _write_new_json(request_path.parent / "train-config.json", config)
    return 0


def validate_train(request_path: Path) -> int:
    request, _, _ = _validate_train_request(request_path)
    checkpoint = Path(request["output"]["checkpoint_dir"])
    result_path = Path(request["output"]["result_json"])
    checks: dict[str, Any] = {
        "gpu_count": 0,
        "gpu_family": "unknown",
        "model_revision": MODEL_REVISION,
        "trainable_parameters": 0,
        "total_parameters": 0,
        "global_step": 0,
        "finite_metrics": False,
        "huggingface_weight_shards": 0,
        "zero_optimizer_shards": 0,
        "zero_model_state_shards": 0,
        "fresh_process_reload": False,
        "weights_changed": False,
    }
    failure: str | None = None
    try:
        if os.environ.get("AUTODATA_EXPERIMENT_TRAIN_EXIT", "0") != "0":
            raise RuntimeError("ms-swift training command failed")
        output_root = Path(request["output"]["root"])
        gpu_lines = [
            line for line in (output_root / "gpu-info.csv").read_text(encoding="utf-8").splitlines()
            if line
        ]
        checks["gpu_count"] = len(gpu_lines)
        checks["gpu_family"] = (
            "NVIDIA H200"
            if len(gpu_lines) == 4 and all("NVIDIA H200" in line for line in gpu_lines)
            else "unexpected"
        )
        trainer_state = _read_json(checkpoint / "trainer_state.json")
        checks["global_step"] = trainer_state.get("global_step", 0)
        step_logs = [
            entry for entry in trainer_state.get("log_history", [])
            if isinstance(entry, dict) and "loss" in entry
        ]
        checks["finite_metrics"] = len(step_logs) >= 16 and all(
            isinstance(entry.get(field), (int, float))
            and not isinstance(entry.get(field), bool)
            and math.isfinite(entry[field])
            for entry in step_logs
            for field in ("loss", "grad_norm", "learning_rate")
        )
        checks["huggingface_weight_shards"] = len(list(checkpoint.glob("model-*-of-*.safetensors")))
        checks["zero_optimizer_shards"] = len(list(checkpoint.rglob("*optim_states.pt")))
        checks["zero_model_state_shards"] = len(list(checkpoint.rglob("*model_states.pt")))

        import torch
        from transformers import Qwen3_5ForConditionalGeneration

        base = Qwen3_5ForConditionalGeneration.from_pretrained(
            MODEL_PATH,
            local_files_only=True,
            dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
        )
        base_parameters = dict(base.named_parameters())
        base_names = tuple(base_parameters)
        base_count = sum(parameter.numel() for parameter in base_parameters.values())
        base_selected = base_parameters[SELECTED_PARAMETER].detach().cpu().clone()
        del base_parameters, base
        gc.collect()
        trained = Qwen3_5ForConditionalGeneration.from_pretrained(
            checkpoint,
            local_files_only=True,
            dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
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
            "gpu_count": 4,
            "gpu_family": "NVIDIA H200",
            "model_revision": MODEL_REVISION,
            "trainable_parameters": EXPECTED_PARAMETERS,
            "total_parameters": EXPECTED_PARAMETERS,
            "global_step": 16,
            "finite_metrics": True,
            "huggingface_weight_shards": 4,
            "zero_optimizer_shards": 4,
            "zero_model_state_shards": 4,
            "fresh_process_reload": True,
            "weights_changed": True,
        }
        if checks != required:
            raise RuntimeError(f"training checks failed: observed={checks!r}")
    except Exception as exc:  # Emit a strict diagnostic result whenever possible.
        failure = f"{type(exc).__name__}: {exc}"
    result = {
        "schema_version": TRAIN_RESULT_VERSION,
        "contract_id": request["contract_id"],
        "contract_sha256": request["contract_sha256"],
        "profile_id": request["profile_id"],
        "run_id": request["run_id"],
        "attempt": request["attempt"],
        "status": "passed" if failure is None else "failed",
        "checkpoint_path": str(checkpoint),
        "checks": checks,
        "failure": failure,
    }
    _write_new_json(result_path, result)
    return 0 if failure is None else 1


def prepare_eval(request_path: Path) -> int:
    request, _, _ = _validate_eval_request(request_path)
    execution = _expected_contract()["execution"]
    _verify_wheelhouse(execution["vllm_wheelhouse"], "vLLM wheelhouse")
    _verify_wheelhouse(execution["bfcl_wheelhouse"], "BFCL wheelhouse")
    Path(request["output"]["root"]).mkdir(parents=True, exist_ok=False, mode=0o700)
    return 0


def _case_failure(exc: Exception) -> str:
    message = str(exc).strip()
    return type(exc).__name__ if not message else f"{type(exc).__name__}: {message}"


def _score_cases(cases: list[dict[str, Any]]) -> tuple[dict[str, dict[str, float]], dict[str, float]]:
    category_scores: dict[str, dict[str, float]] = {}
    macro_scores: dict[str, float] = {}
    for split in SPLITS:
        category_scores[split] = {}
        for category in CATEGORIES:
            selected = [case for case in cases if case["split"] == split and case["category"] == category]
            if len(selected) != 5:
                raise ValueError(f"{split}/{category} does not contain exactly five results")
            category_scores[split][category] = sum(case["passed"] for case in selected) / len(selected)
        macro_scores[split] = sum(category_scores[split].values()) / len(CATEGORIES)
    return category_scores, macro_scores


def _fill_failed_cases(
    cases: list[dict[str, Any]],
    predictions: list[dict[str, Any]],
    failure: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    case_by_id = {case["case_id"]: case for case in cases}
    prediction_by_id = {prediction["case_id"]: prediction for prediction in predictions}
    completed_cases: list[dict[str, Any]] = []
    completed_predictions: list[dict[str, Any]] = []
    for split in SPLITS:
        for case_id in CASE_IDS[split]:
            category = _case_category(case_id)
            case = case_by_id.get(case_id, {
                "case_id": case_id,
                "split": split,
                "category": category,
                "passed": False,
                "failure_summary": failure,
            })
            completed_cases.append(case)
            completed_predictions.append(prediction_by_id.get(case_id, {
                "schema_version": PREDICTION_VERSION,
                "case_id": case_id,
                "split": split,
                "category": category,
                "tool_calls": [],
                "passed": False,
                "failure_summary": failure,
            }))
    return completed_cases, completed_predictions


def _write_predictions(path: Path, predictions: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("x", encoding="utf-8") as handle:
        for prediction in predictions:
            handle.write(json.dumps(
                prediction,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ) + "\n")


def evaluate(request_path: Path) -> int:
    request, _, rows = _validate_eval_request(request_path)
    evaluation = _expected_contract()["evaluation"]
    result_path = Path(request["output"]["result_json"])
    predictions_path = Path(request["output"]["predictions_jsonl"])
    checks: dict[str, Any] = {
        "gpu_count": 0,
        "gpu_family": "unknown",
        "model_revision": MODEL_REVISION,
        "vllm_version": "unknown",
        "tool_call_parser": TOOL_CALL_PARSER,
        "loaded_weight_shards": 0,
    }
    case_results: list[dict[str, Any]] = []
    predictions: list[dict[str, Any]] = []
    failure: str | None = None
    try:
        output_root = Path(request["output"]["root"])
        gpu_lines = [
            line for line in (output_root / "gpu-info.csv").read_text(encoding="utf-8").splitlines()
            if line
        ]
        checks["gpu_count"] = len(gpu_lines)
        checks["gpu_family"] = (
            "NVIDIA H200"
            if len(gpu_lines) == 1 and "NVIDIA H200" in gpu_lines[0]
            else "unexpected"
        )
        checks["vllm_version"] = _http("GET", "http://127.0.0.1:8000/version").get("version")
        checkpoint = Path(request["checkpoint_path"])
        checks["loaded_weight_shards"] = len(list(checkpoint.glob("model-*-of-*.safetensors")))
        if importlib.metadata.version("bfcl-eval") != evaluation["bfcl_version"]:
            raise ValueError("unexpected bfcl-eval version")
        expected_checks = {
            "gpu_count": 1,
            "gpu_family": "NVIDIA H200",
            "model_revision": MODEL_REVISION,
            "vllm_version": VLLM_VERSION,
            "tool_call_parser": TOOL_CALL_PARSER,
            "loaded_weight_shards": 4,
        }
        if checks != expected_checks:
            raise RuntimeError(f"evaluation execution checks failed: observed={checks!r}")

        ast_checker, language = _checker()
        for case in rows:
            split = case["result_split"]
            category = case["category"]
            generation = evaluation["generation"]
            body = {
                "model": MODEL_ID,
                "messages": case["messages"],
                "tools": _tools(case["functions"]),
                "tool_choice": generation["tool_choice"],
                "parallel_tool_calls": generation["parallel_tool_calls"],
                "temperature": generation["temperature"],
                "top_p": generation["top_p"],
                "max_tokens": generation["max_tokens"],
                "seed": generation["seed"],
                "n": generation["n"],
                "stream": generation["stream"],
                "include_reasoning": generation["include_reasoning"],
                "chat_template_kwargs": {"enable_thinking": generation["enable_thinking"]},
                "request_id": f"{request['run_id']}-{case['id']}",
            }
            response = _http("POST", "http://127.0.0.1:8000/v1/chat/completions", body)
            calls: list[dict[str, str]] = []
            passed = False
            failure_summary: str | None = None
            try:
                calls = _response_calls(response)
                if category == "irrelevance":
                    passed = not calls
                else:
                    decoded = [
                        {name: json.loads(arguments)}
                        for call in calls
                        for name, arguments in call.items()
                    ]
                    outcome = _object(ast_checker(
                        case["functions"],
                        decoded,
                        case["ground_truth"],
                        language.PYTHON,
                        category,
                        evaluation["checker"]["model_config"],
                    ), "BFCL checker result")
                    passed = bool(outcome.get("valid"))
                if not passed:
                    failure_summary = "BFCL checker rejected prediction"
            except Exception as exc:  # Malformed model output is an incorrect case, not infra failure.
                failure_summary = _case_failure(exc)
            case_result = {
                "case_id": case["id"],
                "split": split,
                "category": category,
                "passed": passed,
                "failure_summary": failure_summary,
            }
            case_results.append(case_result)
            predictions.append({
                "schema_version": PREDICTION_VERSION,
                "case_id": case["id"],
                "split": split,
                "category": category,
                "tool_calls": calls,
                "passed": passed,
                "failure_summary": failure_summary,
            })
        if len(case_results) != 50:
            raise RuntimeError("evaluation did not complete the exact frozen 50-case set")
    except Exception as exc:  # Preserve a parseable diagnostic result; the Host will not retry it automatically.
        failure = _case_failure(exc)
        case_results, predictions = _fill_failed_cases(case_results, predictions, failure)

    category_scores, macro_scores = _score_cases(case_results)
    _write_predictions(predictions_path, predictions)
    result = {
        "schema_version": EVAL_RESULT_VERSION,
        "contract_id": request["contract_id"],
        "contract_sha256": request["contract_sha256"],
        "profile_id": request["profile_id"],
        "run_id": request["run_id"],
        "attempt": request["attempt"],
        "status": "completed" if failure is None else "failed",
        "checks": checks,
        "cases": case_results,
        "category_scores": category_scores,
        "macro_scores": macro_scores,
        "predictions_path": str(predictions_path),
        "failure": failure,
    }
    _write_new_json(result_path, result)
    return 0 if failure is None else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "operation",
        choices=("prepare-train", "validate-train", "prepare-eval", "evaluate"),
    )
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
