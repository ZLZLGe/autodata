from __future__ import annotations

import hashlib
import json
import copy
import shutil
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import autodata_stage4b.worker as worker


STAGE4B_ROOT = Path(__file__).resolve().parents[1]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")


class WorkerContractTest(unittest.TestCase):
    def _stage(self, temporary: str) -> Path:
        root = Path(temporary) / "run-one"
        (root / "bfcl").mkdir(parents=True)
        shutil.copy2(STAGE4B_ROOT / "experiment-contract.json", root / "experiment-contract.json")
        for name in worker.BFCL_HASHES:
            shutil.copy2(STAGE4B_ROOT / "bfcl" / name, root / "bfcl" / name)
        return root

    def _eval_request(self, root: Path) -> Path:
        checkpoint = root / "outputs" / "train" / "attempt-1" / "train" / "checkpoint-16"
        checkpoint.mkdir(parents=True)
        output = root / "outputs" / "eval" / "attempt-1"
        contract_path = root / "experiment-contract.json"
        contract_sha256 = hashlib.sha256(contract_path.read_bytes()).hexdigest()
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        request = {
            "schema_version": worker.EVAL_REQUEST_VERSION,
            "contract_id": worker.CONTRACT_ID,
            "contract_sha256": contract_sha256,
            "profile_id": "bfcl-v4",
            "run_id": root.name,
            "attempt": 1,
            "checkpoint_path": str(checkpoint),
            "output": {
                "root": str(output),
                "result_json": str(output / "result.json"),
                "predictions_jsonl": str(output / "predictions.jsonl"),
            },
            "model": contract["model"],
            "runtime": {
                "gpus": contract["evaluation"]["gpus"],
                "gpu_family": contract["evaluation"]["gpu_family"],
                "vllm_version": contract["evaluation"]["vllm_version"],
                "tool_call_parser": contract["evaluation"]["tool_call_parser"],
            },
            "benchmark": {
                "id": contract["profile"]["benchmark"],
                "metric": contract["profile"]["metric"],
                "categories": contract["evaluation"]["categories"],
                "case_ids": contract["evaluation"]["case_ids"],
                "macro": contract["evaluation"]["macro"],
            },
        }
        path = root / "attempts" / "eval" / "0001" / "request.json"
        write_json(path, request)
        return path

    def test_checked_contract_and_assets_match_worker_constants(self) -> None:
        contract = json.loads((STAGE4B_ROOT / "experiment-contract.json").read_text(encoding="utf-8"))
        self.assertEqual(contract, worker._expected_contract())
        rows = worker._validate_bfcl_assets(STAGE4B_ROOT)
        self.assertEqual(len(rows), 50)
        self.assertEqual([row["id"] for row in rows[:25]], list(worker.CASE_IDS["B_search"]))
        self.assertEqual([row["id"] for row in rows[25:]], list(worker.CASE_IDS["B_dev"]))
        self.assertEqual(worker._case_category("parallel_multiple_177"), "parallel_multiple")

    def test_candidate_contract_preserves_h0_protocol_and_source_pool(self) -> None:
        contract = copy.deepcopy(worker._expected_contract())
        contract["contract_id"] = worker.CANDIDATE_CONTRACT_ID
        contract["subject"] = {
            "candidate_id": "candidate-one",
            "generation": 1,
            "plugin_id": "bfcl-v4-strategy",
            "strategy_version": "1",
            "host_source_sha256": "a" * 64,
        }
        contract["data"]["harness_id"] = "bfcl-v4-strategy-h1"
        contract["data"]["logical_training_units"] = 2
        contract["data"]["logical_view_jsonl_sha256"] = "b" * 64
        contract["data"]["run_summary_json_sha256"] = "c" * 64
        worker._validate_contract(contract)

        contract["data"]["canonical_jsonl_sha256"] = "d" * 64
        with self.assertRaisesRegex(ValueError, "source pool"):
            worker._validate_contract(contract)

    def test_candidate_logical_view_can_filter_and_reorder_with_frozen_provenance(self) -> None:
        contract = copy.deepcopy(worker._expected_contract())
        contract["contract_id"] = worker.CANDIDATE_CONTRACT_ID
        contract["subject"] = {
            "candidate_id": "candidate-one",
            "generation": 1,
            "plugin_id": "bfcl-v4-strategy",
            "strategy_version": "1",
            "host_source_sha256": "a" * 64,
        }
        contract["data"]["canonical_records"] = 3
        contract["data"]["logical_training_units"] = 2
        source = worker._expected_source(contract)
        canonical = [
            {
                "schema_version": worker.CANONICAL_VERSION,
                "source": {**source, "record_id": f"record-{index}", "record_index": index, "record_line": index + 1},
                "messages": [
                    {"role": "user", "content": f"question {index}"},
                    {"role": "assistant", "content": f"answer {index}"},
                ],
                "tools": [],
            }
            for index in range(3)
        ]
        logical = [
            {
                "schema_version": worker.LOGICAL_VERSION,
                "id": f"record-{record_index}:assistant:1",
                "source": canonical[record_index]["source"],
                "assistant_message_index": 1,
                "messages": [
                    canonical[record_index]["messages"][0],
                    {**canonical[record_index]["messages"][1], "loss": True},
                ],
                "tools": [],
                "selection_rank": rank,
                "plugin_provenance": [{
                    "plugin_id": "bfcl-v4-strategy",
                    "plugin_version": "1",
                    "note": f"rank-{rank}",
                }],
            }
            for rank, record_index in enumerate((2, 0))
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            canonical_path = root / "canonical.jsonl"
            logical_path = root / "logical-view.jsonl"
            summary_path = root / "run-summary.json"
            canonical_path.write_text(
                "".join(json.dumps(row) + "\n" for row in canonical), encoding="utf-8"
            )
            logical_path.write_text(
                "".join(json.dumps(row) + "\n" for row in logical), encoding="utf-8"
            )
            summary = {
                "summary_version": worker.RUN_SUMMARY_VERSION,
                "harness_id": contract["data"]["harness_id"],
                "generation": 1,
                "seed": contract["data"]["seed"],
                "canonical_schema_version": worker.CANONICAL_VERSION,
                "logical_view_schema_version": worker.LOGICAL_VERSION,
                "source": source,
                "plugins": [{"id": "bfcl-v4-strategy", "version": "1"}],
                "counts": {
                    "source_records_read": 3,
                    "selected_source_records": 2,
                    "quarantined_source_records": 0,
                    "duplicate_source_records": 0,
                    "canonical_records": 3,
                    "logical_training_units": 2,
                    "validation_warnings": 0,
                },
                "validation_warning_counts": {},
            }
            write_json(summary_path, summary)
            contract["data"].update({
                "canonical_jsonl_sha256": hashlib.sha256(canonical_path.read_bytes()).hexdigest(),
                "logical_view_jsonl_sha256": hashlib.sha256(logical_path.read_bytes()).hexdigest(),
                "run_summary_json_sha256": hashlib.sha256(summary_path.read_bytes()).hexdigest(),
            })
            request = {"input": {
                "canonical_jsonl": str(canonical_path),
                "logical_view_jsonl": str(logical_path),
                "run_summary_json": str(summary_path),
            }}
            rows = worker._validate_materialized_data(request, root, contract)
            self.assertEqual([row["id"] for row in rows], ["record-2:assistant:1", "record-0:assistant:1"])

            summary["counts"]["selected_source_records"] = 3
            write_json(summary_path, summary)
            contract["data"]["run_summary_json_sha256"] = hashlib.sha256(summary_path.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, "record counts"):
                worker._validate_materialized_data(request, root, contract)

    def test_eval_request_uses_raw_contract_hash_and_rejects_extras(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = self._stage(temporary)
            request_path = self._eval_request(root)
            request, observed_root, rows = worker._validate_eval_request(request_path)
            self.assertEqual(observed_root, root)
            self.assertEqual(request["attempt"], 1)
            self.assertEqual(len(rows), 50)

            value = json.loads(request_path.read_text(encoding="utf-8"))
            value["unsupported"] = True
            write_json(request_path, value)
            with self.assertRaisesRegex(ValueError, "unsupported"):
                worker._validate_eval_request(request_path)

    def test_eval_request_rejects_semantically_equal_contract_with_new_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = self._stage(temporary)
            request_path = self._eval_request(root)
            contract_path = root / "experiment-contract.json"
            contract_path.write_bytes(contract_path.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "exact staged bytes"):
                worker._validate_eval_request(request_path)

    def test_prepare_train_config_enables_frozen_padding_free_recipe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request_path = root / "attempts" / "train" / "0001" / "request.json"
            request_path.parent.mkdir(parents=True)
            output = root / "output"
            request = {
                "output": {"root": str(output)},
                "model": {"path": worker.MODEL_PATH},
                "recipe": worker._expected_contract()["training"],
            }
            rows = [{"id": "one", "messages": [{"role": "assistant", "loss": True}], "tools": []}]
            with (
                patch.object(worker, "_validate_train_request", return_value=(request, root, rows)),
                patch.object(worker, "_verify_wheelhouse", return_value=()),
            ):
                self.assertEqual(worker.prepare_train(request_path), 0)
            config = json.loads((request_path.parent / "train-config.json").read_text(encoding="utf-8"))
            self.assertIs(config["padding_free"], True)
            self.assertIs(config["packing"], True)
            self.assertEqual(config["max_steps"], 16)
            self.assertEqual(config["save_steps"], 16)

    def test_wheelhouse_manifest_and_exact_wheel_set_are_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wheel = root / "example_pkg-1.0-py3-none-any.whl"
            wheel.write_bytes(b"frozen wheel bytes")
            wheel_sha256 = hashlib.sha256(wheel.read_bytes()).hexdigest()
            manifest = root / "wheelhouse.sha256"
            manifest.write_text(f"{wheel_sha256}  {wheel.name}\n", encoding="utf-8")
            spec = {
                "path": str(root),
                "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
            }

            self.assertEqual(worker._verify_wheelhouse(spec, "fixture"), (wheel,))

            wheel.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "wheel SHA-256 mismatch"):
                worker._verify_wheelhouse(spec, "fixture")

            wheel.write_bytes(b"frozen wheel bytes")
            manifest.write_bytes(manifest.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "manifest SHA-256 mismatch"):
                worker._verify_wheelhouse(spec, "fixture")

    def test_incorrect_predictions_still_complete_all_fifty_cases(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            output.mkdir()
            (output / "gpu-info.csv").write_text("NVIDIA H200, gpu, 1, driver\n", encoding="utf-8")
            checkpoint = root / "checkpoint"
            checkpoint.mkdir()
            for index in range(1, 5):
                (checkpoint / f"model-{index:05d}-of-00004.safetensors").touch()
            request = {
                "contract_id": worker.CONTRACT_ID,
                "contract_sha256": "a" * 64,
                "profile_id": "bfcl-v4",
                "run_id": "run-one",
                "attempt": 1,
                "checkpoint_path": str(checkpoint),
                "output": {
                    "root": str(output),
                    "result_json": str(output / "result.json"),
                    "predictions_jsonl": str(output / "predictions.jsonl"),
                },
            }
            rows = []
            for split in worker.SPLITS:
                for case_id in worker.CASE_IDS[split]:
                    category = worker._case_category(case_id)
                    rows.append({
                        "id": case_id,
                        "result_split": split,
                        "category": category,
                        "messages": [{"role": "user", "content": "test"}],
                        "functions": [{
                            "name": "tool",
                            "description": "test",
                            "parameters": {"type": "dict", "properties": {}},
                        }],
                        "ground_truth": None if category == "irrelevance" else [],
                    })

            def fake_http(method: str, _url: str, _payload: object = None) -> dict[str, object]:
                if method == "GET":
                    return {"version": worker.VLLM_VERSION}
                return {"choices": [{"message": {"tool_calls": []}}]}

            checker = lambda *_args: {"valid": False}
            language = types.SimpleNamespace(PYTHON="python")
            request_path = root / "request.json"
            with (
                patch.object(worker, "_validate_eval_request", return_value=(request, root, rows)),
                patch.object(worker, "_http", side_effect=fake_http),
                patch.object(worker, "_checker", return_value=(checker, language)),
                patch.object(worker.importlib.metadata, "version", return_value="2026.3.23"),
            ):
                self.assertEqual(worker.evaluate(request_path), 0)

            result = json.loads((output / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "completed")
            self.assertIsNone(result["failure"])
            self.assertEqual(len(result["cases"]), 50)
            self.assertEqual(result["macro_scores"], {"B_search": 0.2, "B_dev": 0.2})
            predictions = (output / "predictions.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(predictions), 50)


if __name__ == "__main__":
    unittest.main()
