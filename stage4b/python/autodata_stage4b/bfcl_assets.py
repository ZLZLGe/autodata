"""Deterministically materialize the sealed Stage 4B B_search/B_dev fixtures.

Only case ids explicitly present in ``selection.json`` are decoded from the
upstream JSONL files.  The selection schema has no test split by construction.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any


CATEGORIES = (
    "simple_python",
    "multiple",
    "parallel",
    "parallel_multiple",
    "irrelevance",
)
SPLITS = ("search", "dev")
SOURCE_COMMIT = "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"
PARENT_SPLIT_MANIFEST_SHA256 = (
    "48c91d1d4191f2242ecea91b5e4094fc6cd13c7f1bf217761c33a03aadcf41fb"
)
SELECTION_VERSION = "dataharness-bfcl-small-loop-selection-1"
BUNDLE_VERSION = "dataharness-bfcl-case-bundle-1"
BUNDLE_MANIFEST_VERSION = "autodata-stage4b-bfcl-bundle-manifest-1"
SELECTION_ALGORITHM = (
    "take the five lowest SHA-256 ranks per split and category; rank input is "
    "UTF-8 decimal seed, NUL, split, NUL, category, NUL, case ID; ties use case ID"
)
SELECTION_SEED = 20260823
CASES_PER_CATEGORY = 5
SOURCE_FILES: dict[str, dict[str, str | None]] = {
    "simple_python": {
        "question": "bfcl_eval/data/BFCL_v4_simple_python.json",
        "question_sha256": "82dd63ba502eb2520c6b5d1d9a5c4b590e03ff261565175561f6228a367d1991",
        "possible_answer": "bfcl_eval/data/possible_answer/BFCL_v4_simple_python.json",
        "possible_answer_sha256": "90cd5bc653690ee8e459b5b3f3fc9458606f7f3fcbf795bb51b7dc581f8c86dc",
    },
    "multiple": {
        "question": "bfcl_eval/data/BFCL_v4_multiple.json",
        "question_sha256": "aef168155ebd74b7ac2401198b201343bc7d16d7a3d7e0d4e6d8ee82c6969b2a",
        "possible_answer": "bfcl_eval/data/possible_answer/BFCL_v4_multiple.json",
        "possible_answer_sha256": "244e00ce9395df948bcafc7bee64e8f9c87ef70887587d83cae45b13699f3047",
    },
    "parallel": {
        "question": "bfcl_eval/data/BFCL_v4_parallel.json",
        "question_sha256": "19f51a82eff42e5d62541aa500115a056eb78f437c2ba1f10415fd7c8e5dda84",
        "possible_answer": "bfcl_eval/data/possible_answer/BFCL_v4_parallel.json",
        "possible_answer_sha256": "8a6aa19c1adddc6a5a2f7e40f9dbf30cc7e95815e7b830c90589ab318229e0f0",
    },
    "parallel_multiple": {
        "question": "bfcl_eval/data/BFCL_v4_parallel_multiple.json",
        "question_sha256": "8863ea8433239f55c5f016154cf0830853c89f693c6ea270396a2fa121960579",
        "possible_answer": "bfcl_eval/data/possible_answer/BFCL_v4_parallel_multiple.json",
        "possible_answer_sha256": "5ebf24f458c1f16300c05505d83d6f0a1b68b79be273a033febd0d4f840507e3",
    },
    "irrelevance": {
        "question": "bfcl_eval/data/BFCL_v4_irrelevance.json",
        "question_sha256": "2b6ed4c2e992cdcf5f1678a701851f944bef7550ee026ed1ddb89efed5be01a6",
        "possible_answer": None,
        "possible_answer_sha256": None,
    },
}

_ID_PATTERN = re.compile(r'"id"\s*:\s*"([^"\\]+)"')


class DuplicateKeyError(ValueError):
    """Raised when a JSON object has an ambiguous duplicate key."""


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _json_object(text: str, label: str) -> dict[str, Any]:
    value = json.loads(text, object_pairs_hook=_pairs)
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain a JSON object")
    return value


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_path(root: Path, relative: str, expected_sha256: str) -> Path:
    path = (root.resolve() / relative).resolve()
    if not path.is_relative_to(root.resolve()) or path.is_symlink() or not path.is_file():
        raise ValueError(f"invalid BFCL source file: {relative}")
    observed = _sha256_file(path)
    if observed != expected_sha256:
        raise ValueError(f"BFCL source hash mismatch for {relative}: {observed}")
    return path


def load_selection(path: Path) -> dict[str, dict[str, list[str]]]:
    """Load the approved two-split selection and reject every extra field."""

    selection = _json_object(path.read_text(encoding="utf-8"), str(path))
    if set(selection) != {"manifest_version", "parent_split_manifest", "selection", "splits"}:
        raise ValueError("selection manifest fields are not frozen")
    if selection.get("manifest_version") != SELECTION_VERSION:
        raise ValueError("unsupported selection manifest version")
    if selection.get("parent_split_manifest") != "bfcl-v4-offline-derived.json":
        raise ValueError("unexpected parent split manifest")
    rule = selection.get("selection")
    if not isinstance(rule, dict) or rule != {
        "algorithm": SELECTION_ALGORITHM,
        "seed": SELECTION_SEED,
        "cases_per_category": CASES_PER_CATEGORY,
    }:
        raise ValueError("selection rule is not frozen")
    splits = selection.get("splits")
    if not isinstance(splits, dict) or set(splits) != set(SPLITS):
        raise ValueError("selection manifest must contain only search and dev")

    result: dict[str, dict[str, list[str]]] = {}
    all_ids: set[str] = set()
    for split in SPLITS:
        categories = splits.get(split)
        if not isinstance(categories, dict) or tuple(categories) != CATEGORIES:
            raise ValueError(f"{split} categories or order are not frozen")
        result[split] = {}
        for category in CATEGORIES:
            ids = categories.get(category)
            if not isinstance(ids, list) or len(ids) != CASES_PER_CATEGORY:
                raise ValueError(f"{split}/{category} must contain exactly five ids")
            if not all(
                isinstance(case_id, str)
                and re.fullmatch(rf"{re.escape(category)}_[0-9]+", case_id)
                for case_id in ids
            ):
                raise ValueError(f"{split}/{category} contains an invalid id")
            if len(ids) != len(set(ids)) or all_ids.intersection(ids):
                raise ValueError("selection manifest contains duplicate case ids")
            all_ids.update(ids)
            result[split][category] = list(ids)
    return result


def _load_selected_jsonl(path: Path, selected_ids: set[str]) -> dict[str, dict[str, Any]]:
    """Decode selected records only; all non-selected source rows stay opaque."""

    found: dict[str, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, 1):
            match = _ID_PATTERN.search(raw)
            if match is None or match.group(1) not in selected_ids:
                continue
            value = _json_object(raw, f"{path}:{line_number}")
            case_id = value.get("id")
            if case_id != match.group(1) or case_id in found:
                raise ValueError(f"invalid or duplicate selected id in {path}:{line_number}")
            found[case_id] = value
    missing = sorted(selected_ids - found.keys())
    if missing:
        raise ValueError(f"selected BFCL ids missing from {path}: {', '.join(missing)}")
    return found


def _single_turn_messages(question: Any, case_id: str) -> list[dict[str, Any]]:
    if not isinstance(question, list) or len(question) != 1 or not isinstance(question[0], list):
        raise ValueError(f"{case_id}: expected exactly one BFCL turn")
    messages = question[0]
    if not messages or not all(isinstance(message, Mapping) for message in messages):
        raise ValueError(f"{case_id}: messages must be a non-empty object array")
    normalized = [copy.deepcopy(dict(message)) for message in messages]
    if normalized[-1].get("role") != "user":
        raise ValueError(f"{case_id}: single-turn question must end with user")
    return normalized


def build_assets(source_root: Path, selection_path: Path) -> tuple[dict[str, bytes], dict[str, Any]]:
    """Return deterministic search/dev bundle bytes and their manifest."""

    selection = load_selection(selection_path)
    rows: dict[str, list[dict[str, Any]]] = {split: [] for split in SPLITS}
    source_manifest: dict[str, dict[str, str | None]] = {}
    for category in CATEGORIES:
        source = SOURCE_FILES[category]
        question_relative = source["question"]
        question_sha256 = source["question_sha256"]
        assert isinstance(question_relative, str) and isinstance(question_sha256, str)
        wanted = {case_id for split in SPLITS for case_id in selection[split][category]}
        questions = _load_selected_jsonl(
            _source_path(source_root, question_relative, question_sha256), wanted
        )

        answers: dict[str, dict[str, Any]] = {}
        answer_relative = source["possible_answer"]
        answer_sha256 = source["possible_answer_sha256"]
        if category != "irrelevance":
            assert isinstance(answer_relative, str) and isinstance(answer_sha256, str)
            answers = _load_selected_jsonl(
                _source_path(source_root, answer_relative, answer_sha256), wanted
            )
        elif answer_relative is not None or answer_sha256 is not None:
            raise ValueError("irrelevance must not have a possible-answer source")

        source_manifest[category] = dict(source)
        for split in SPLITS:
            for case_id in selection[split][category]:
                question = questions[case_id]
                functions = question.get("function")
                if not isinstance(functions, list) or not functions:
                    raise ValueError(f"{case_id}: function must be a non-empty array")
                ground_truth: Any = None
                if category != "irrelevance":
                    answer = answers[case_id]
                    ground_truth = answer.get("ground_truth")
                    if not isinstance(ground_truth, list):
                        raise ValueError(f"{case_id}: selected answer has no ground_truth array")
                rows[split].append({
                    "bundle_version": BUNDLE_VERSION,
                    "id": case_id,
                    "split": split,
                    "category": category,
                    "messages": _single_turn_messages(question.get("question"), case_id),
                    "functions": copy.deepcopy(functions),
                    "ground_truth": copy.deepcopy(ground_truth),
                })

    contents = {
        f"{split}.jsonl": "".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
            for row in rows[split]
        ).encode("utf-8")
        for split in SPLITS
    }
    manifest = {
        "manifest_version": BUNDLE_MANIFEST_VERSION,
        "bfcl": {
            "source_commit": SOURCE_COMMIT,
            "source_files": source_manifest,
            "parent_split_manifest_sha256": PARENT_SPLIT_MANIFEST_SHA256,
        },
        "selection": {
            "path": "selection.json",
            "sha256": _sha256_file(selection_path),
            "algorithm": SELECTION_ALGORITHM,
            "seed": SELECTION_SEED,
            "cases_per_category": CASES_PER_CATEGORY,
        },
        "bundles": {
            split: {
                "path": f"{split}.jsonl",
                "records": len(rows[split]),
                "category_counts": {
                    category: sum(row["category"] == category for row in rows[split])
                    for category in CATEGORIES
                },
                "bytes": len(contents[f"{split}.jsonl"]),
                "sha256": _sha256_bytes(contents[f"{split}.jsonl"]),
            }
            for split in SPLITS
        },
    }
    return contents, manifest


def _manifest_bytes(manifest: Mapping[str, Any]) -> bytes:
    return (json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def write_or_check_assets(
    source_root: Path,
    selection_path: Path,
    output_directory: Path,
    *,
    check: bool,
) -> None:
    contents, manifest = build_assets(source_root, selection_path)
    expected = {**contents, "manifest.json": _manifest_bytes(manifest)}
    if check:
        for name, value in expected.items():
            path = output_directory / name
            if not path.is_file() or path.read_bytes() != value:
                raise ValueError(f"checked-in Stage 4B BFCL asset differs from regeneration: {path}")
        return
    output_directory.mkdir(parents=True, exist_ok=True)
    for name, value in expected.items():
        path = output_directory / name
        if path.exists():
            raise FileExistsError(f"refusing to overwrite {path}")
        path.write_bytes(value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    write_or_check_assets(
        args.source_root,
        args.selection,
        args.output_dir,
        check=args.check,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
