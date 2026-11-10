"""Initial quota changes preserve provisioned workspaces and user overrides."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "sandbox_quotas", Path(__file__).resolve().parents[1] / "sandbox-quotas.py"
)
quotas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quotas)


class DefaultsTest(unittest.TestCase):
    @patch.dict("os.environ", {"SANDBOX_TOTAL_DISK_MIB": "4096"})
    def test_existing_users_are_frozen_without_touching_images(self):
        with tempfile.TemporaryDirectory() as root:
            policy = quotas.Quotas(root)
            policy.save("override", {**quotas.DEFAULT, "disk_mib": 512, "cpus": 2})
            image = Path(root) / "existing.img"
            image.touch()
            new = {**quotas.DEFAULT, "disk_mib": 2048, "pids": 128}
            self.assertEqual(policy.save_defaults(new)["quota"], new)
            self.assertEqual(policy.get("new"), new)
            self.assertEqual(policy.get("existing"), quotas.DEFAULT)
            self.assertEqual(policy.get("override")["cpus"], 2)
            self.assertEqual(image.stat().st_size, 0)
            policy.check_budget("new", new, policy.load())
            with self.assertRaisesRegex(ValueError, "磁盘预算"):
                policy.check_budget("new", {**new, "disk_mib": 4096}, policy.load())
            with self.assertRaisesRegex(ValueError, "不能超过"):
                policy.save_defaults({**new, "disk_mib": 8192})
            self.assertEqual(quotas.Quotas(root).get("new"), new)


if __name__ == "__main__":
    unittest.main()
