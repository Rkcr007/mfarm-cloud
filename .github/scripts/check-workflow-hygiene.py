#!/usr/bin/env python3
"""
Three hygiene rules for action.yml, .github/workflows/*.yml and the snippets in docs/ci.md.

Each is here because it was violated at least once, and each was previously "enforced" by a
reviewer noticing -- which is not enforcement.

  1. ACTION PINS. Every third-party `uses:` is a full 40-hex commit SHA. A tag is a mutable
     pointer its owner can re-point at any commit, so `@v5` is unaudited code execution with this
     job's secrets. docs/ci.md is checked too: the snippet we hand customers ends up in their
     repos, and a page that calls mutable tags a security hole while using one is worse than
     saying nothing.

  2. SHELL SYNTAX. Every `run:` block parses under `bash -n`. That catches an unterminated
     heredoc or quote at review time rather than in a customer's job.

  3. NPM PINS. action.yml installs no floating dist-tag, and asks for no unscoped `mfarm`. That
     process holds MFARM_API_KEY and builds MFARM_WEBDRIVER_URL from it, so `@latest` means an
     unreviewed publish executes with the customer's credential on their next CI run, and an
     unscoped name is one this project does not own.

Run: python3 .github/scripts/check-workflow-hygiene.py
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r"^[0-9a-f]{40}$")

# `./` is this repo's own action; `docker://` is not a git ref. Everything else needs a SHA.
LOCAL_PREFIXES = ("./", "docker://")

# The one documented exception, and the only one: `mfarm/mfarm-cloud@v1` in the customer snippets
# is OUR action. docs/ci.md says out loud that this tag is mutable too and tells a reader with a
# stricter threat model to pin it. Handing a stranger a 40-hex SHA as their first impression of the
# product is a worse trade than that paragraph.
OWN_ACTION_PREFIX = "mfarm/mfarm-cloud@"

problems = []


def check_uses(where, uses):
    if uses.startswith(LOCAL_PREFIXES):
        return
    if uses.startswith(OWN_ACTION_PREFIX) and where.startswith("docs/"):
        return
    if "@" not in uses:
        problems.append(f"{where}: `uses: {uses}` has no ref at all")
        return
    repo, ref = uses.rsplit("@", 1)
    if not SHA.match(ref):
        problems.append(
            f"{where}: `uses: {repo}@{ref}` is a mutable ref. Pin the 40-hex commit SHA and "
            f"leave the version in a trailing comment.")


def walk_steps(where, node):
    """Recurse the parsed YAML looking for anything with a `uses:` or a `run:`."""
    if isinstance(node, dict):
        if isinstance(node.get("uses"), str):
            check_uses(where, node["uses"])
        if isinstance(node.get("run"), str):
            check_shell(f"{where} step {node.get('name', node.get('id', '?'))!r}", node["run"])
        for v in node.values():
            walk_steps(where, v)
    elif isinstance(node, list):
        for v in node:
            walk_steps(where, v)


def check_shell(where, script):
    # Only `shell: bash` (and the default, which is bash on Linux) is used in this repo.
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(script)
        path = f.name
    p = subprocess.run(["bash", "-n", path], capture_output=True, text=True)
    if p.returncode != 0:
        problems.append(f"{where}: `run:` block is not valid bash:\n    "
                        + p.stderr.replace(path, "<run block>").strip())
    Path(path).unlink()


def check_npm_pins(text):
    for m in re.finditer(r"npx[^\n]*", text):
        line = m.group(0)
        if re.search(r"@latest\b|@next\b|@beta\b", line):
            problems.append(f"action.yml: floating npm dist-tag in `{line.strip()}`. "
                            f"Pin an exact version.")
        # An unscoped `mfarm` is a package name this project does not own. The lookbehind is what
        # lets `@mfarm/cli@0.1.0` through while catching `"mfarm@0.1.0"` -- in the scoped form the
        # character after `mfarm` is `/`, so the literal `mfarm@` never appears.
        if re.search(r"(?<![@/\w-])mfarm@", line):
            problems.append(f"action.yml: installs unscoped `mfarm` in `{line.strip()}`. "
                            f"The package in this repo is `@mfarm/cli`.")


def main():
    files = sorted((ROOT / ".github" / "workflows").glob("*.y*ml")) + [ROOT / "action.yml"]
    for f in files:
        rel = f.relative_to(ROOT)
        try:
            doc = yaml.safe_load(f.read_text())
        except yaml.YAMLError as e:
            problems.append(f"{rel}: does not parse: {e}")
            continue
        walk_steps(str(rel), doc)
        print(f"checked {rel}")

    check_npm_pins((ROOT / "action.yml").read_text())

    # The customer-facing snippets. Parsed as YAML where they are YAML, so a `uses:` in a fenced
    # block is held to exactly the same standard as one in a workflow.
    doc = ROOT / "docs" / "ci.md"
    for i, block in enumerate(re.findall(r"```yaml\n(.*?)```", doc.read_text(), re.S)):
        try:
            parsed = yaml.safe_load(block)
        except yaml.YAMLError as e:
            problems.append(f"docs/ci.md yaml block {i + 1}: does not parse: {e}")
            continue
        walk_steps(f"docs/ci.md yaml block {i + 1}",
                   parsed if not isinstance(parsed, list) else {"steps": parsed})
    print("checked docs/ci.md")

    if problems:
        print()
        for p in problems:
            print(f"::error title=Workflow hygiene::{p}")
        print(f"\n{len(problems)} problem(s).")
        return 1
    print("\nall clean: pins are SHAs, every run: block parses, no floating npm tags.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
