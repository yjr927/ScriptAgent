import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from script_agent.pipeline import prepare_script
from script_agent import web


class WebHelpersTests(unittest.TestCase):
    def test_safe_filename_removes_path_components(self):
        self.assertEqual("剧本-final.docx", web._safe_filename("../../剧本 final.docx"))

    def test_run_summary_does_not_expose_source_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runs_root = root / "runs"
            run_dir = runs_root / "run-0001"
            script = root / "sample.txt"
            script.write_text("第一场 客厅 日\n甲：你好。\n", encoding="utf-8")
            prepare_script(script, run_dir)
            with patch.object(web, "RUNS_ROOT", runs_root):
                summary = web._run_summary(web._resolve_run("run-0001"))
            self.assertEqual("sample.txt", summary["source_name"])
            self.assertNotIn("source_path", summary)

    def test_resolve_run_rejects_traversal(self):
        with self.assertRaises(ValueError):
            web._resolve_run("../outside")


if __name__ == "__main__":
    unittest.main()
