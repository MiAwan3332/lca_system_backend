import unittest
import sys
sys.dont_write_bytecode = True
from checkSourceIntegrity import findings


class SourceIntegrityTests(unittest.TestCase):
    def test_clean_source(self):
        self.assertEqual(findings("export const value = 1;"), [])

    def test_each_conflict_marker(self):
        for marker in ("<<<<<<< HEAD", "=======", ">>>>>>> topic"):
            with self.subTest(marker=marker):
                self.assertIn("unresolved merge conflict", findings("// header\n" + marker + "\n"))

    def test_injection_after_hidden_whitespace(self):
        source = "};" + " " * 3000 + "global.o='5-1684-du';"
        self.assertIn("known injected executable block", findings(source))

    def test_other_known_signatures(self):
        for signature in ("_$_9ff7", "_$jsoPow"):
            self.assertIn("known injected executable block", findings(signature))


if __name__ == "__main__":
    unittest.main()
