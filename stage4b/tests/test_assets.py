from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from autodata_stage4b.bfcl_assets import (
    CATEGORIES,
    SPLITS,
    _manifest_bytes,
    load_selection,
)


STAGE4B_ROOT = Path(__file__).resolve().parents[1]
BFCL_ROOT = STAGE4B_ROOT / "bfcl"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class BfclAssetTest(unittest.TestCase):
    def test_checked_bundle_is_exactly_two_disjoint_balanced_splits(self) -> None:
        selection = load_selection(BFCL_ROOT / "selection.json")
        self.assertEqual(tuple(selection), SPLITS)
        all_ids: list[str] = []
        for split in SPLITS:
            self.assertEqual(tuple(selection[split]), CATEGORIES)
            for category in CATEGORIES:
                self.assertEqual(len(selection[split][category]), 5)
                all_ids.extend(selection[split][category])
        self.assertEqual(len(all_ids), 50)
        self.assertEqual(len(set(all_ids)), 50)
        self.assertNotIn("test", selection)

    def test_manifest_binds_checked_jsonl_bytes(self) -> None:
        manifest_path = BFCL_ROOT / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest_path.read_bytes(), _manifest_bytes(manifest))
        self.assertEqual(manifest["selection"]["sha256"], sha256(BFCL_ROOT / "selection.json"))
        self.assertEqual(set(manifest["bundles"]), {"search", "dev"})
        for split in SPLITS:
            metadata = manifest["bundles"][split]
            path = BFCL_ROOT / metadata["path"]
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(metadata["sha256"], sha256(path))
            self.assertEqual(metadata["bytes"], path.stat().st_size)
            self.assertEqual(metadata["records"], 25)
            self.assertEqual(metadata["category_counts"], {category: 5 for category in CATEGORIES})
            self.assertEqual([row["split"] for row in rows], [split] * 25)

    def test_selection_rejects_duplicate_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "selection.json"
            path.write_text('{"manifest_version":"one","manifest_version":"two"}\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
                load_selection(path)


if __name__ == "__main__":
    unittest.main()
