"""Check tracked source as data before running builds or dependency scripts."""
import re
import subprocess
import sys
from pathlib import Path


def findings(source):
    problems = []
    if re.search(r"(?m)^(?:<{7} |={7}$|>{7} )", source):
        problems.append("unresolved merge conflict")
    if "global.o=" in source or "_$_9ff7" in source or "_$jsoPow" in source:
        problems.append("known injected executable block")
    return problems


def main():
    root = Path(__file__).resolve().parents[1]
    paths = subprocess.check_output(
        ["git", "ls-files", "-z", "--", "*.js", "*.mjs", "*.cjs"], cwd=root
    ).decode().split("\0")
    failures = []
    checked = 0
    for name in filter(None, paths):
        path = root / name
        if not path.is_file():
            continue
        checked += 1
        for problem in findings(path.read_text(encoding="utf-8", errors="replace")):
            failures.append(f"{name}: {problem}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"Source integrity: {checked} tracked JavaScript files checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
