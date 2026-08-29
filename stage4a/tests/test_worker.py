from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from autodata_stage4a.worker import (
    CASE_IDS,
    MODEL_ID,
    MODEL_PATH,
    MODEL_REVISION,
    TRAIN_REQUEST_VERSION,
    _response_calls,
    _validate_train_request,
)


class WorkerContractTest(unittest.TestCase):
    def _request(self, root: Path) -> Path:
        attempt = root / "attempts" / "train" / "0001"
        attempt.mkdir(parents=True)
        for name, text in {
            "canonical.jsonl": "{}\n",
            "logical-view.jsonl": "{}\n",
            "run-summary.json": "{}\n",
        }.items():
            (root / name).write_text(text, encoding="utf-8")
        request = {
            "schema_version": TRAIN_REQUEST_VERSION,
            "profile_id": "bfcl",
            "run_id": "stage-four-a",
            "attempt": 1,
            "input": {
                "canonical_jsonl": str(root / "canonical.jsonl"),
                "logical_view_jsonl": str(root / "logical-view.jsonl"),
                "run_summary_json": str(root / "run-summary.json"),
            },
            "output": {
                "root": str(root / "outputs" / "train" / "attempt-1"),
                "result_json": str(root / "outputs" / "train" / "attempt-1" / "result.json"),
                "checkpoint_dir": str(root / "outputs" / "train" / "attempt-1" / "train" / "checkpoint-2"),
            },
            "model": {"id": MODEL_ID, "revision": MODEL_REVISION, "path": MODEL_PATH},
            "recipe": {
                "gpus": 4, "gpu_family": "H200", "max_steps": 2, "tuner_type": "full",
                "precision": "bf16", "optimizer": "adafactor", "deepspeed": "zero3",
                "expected_parameters": 9_409_813_744,
            },
        }
        path = attempt / "request.json"
        path.write_text(json.dumps(request), encoding="utf-8")
        return path

    def test_strict_training_request_and_path_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "stage-four-a"
            path = self._request(root)
            request, observed_root = _validate_train_request(path)
            self.assertEqual(observed_root, root)
            self.assertEqual(request["recipe"]["max_steps"], 2)
            value = json.loads(path.read_text(encoding="utf-8"))
            value["extra"] = True
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unsupported"):
                _validate_train_request(path)

    def test_openai_response_preserves_parallel_call_order(self) -> None:
        response = {"choices": [{"message": {"tool_calls": [
            {"type": "function", "function": {"name": "one", "arguments": '{"b":2,"a":1}'}},
            {"type": "function", "function": {"name": "two", "arguments": {"x": 3}}},
        ]}}]}
        self.assertEqual(
            _response_calls(response),
            [{"one": '{"a":1,"b":2}'}, {"two": '{"x":3}'}],
        )
        self.assertEqual(len(CASE_IDS), 5)


if __name__ == "__main__":
    unittest.main()
