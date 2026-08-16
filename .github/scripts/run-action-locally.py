#!/usr/bin/env python3
"""
Execute the composite steps of ../../action.yml on this machine, the way the GitHub runner does.

WHY THIS EXISTS
---------------
`action-test.yml` can only be run by GitHub, which means a bug in the action's shell is only
discoverable by pushing. The bug this harness was written to catch (F1) was exactly that shape:
the runner invokes every `shell: bash` step as

    bash --noprofile --norc -eo pipefail {0}

so `-e` is on before the script's own `set` line runs, and a bare non-zero command aborts the step
and discards its outputs. Reading the YAML cannot show you that. Running it can.

WHAT IS FAITHFULLY EMULATED
---------------------------
  * the `-eo pipefail` bash invocation, byte for byte
  * GITHUB_OUTPUT / GITHUB_ENV as append-only files, with GITHUB_ENV visible to later steps
  * a failed step aborting the composite and SKIPPING every remaining step (the F1 blast radius)
  * `${{ inputs.* }}` and `${{ steps.<id>.outputs.* }}` resolved into a step's `env:` block
  * `working-directory`, RUNNER_TEMP

WHAT IS NOT
-----------
  * `uses:` steps are skipped (setup-node is a no-op here; the local node is used instead)
  * the runner's own `::add-mask::` redaction is not applied to this process's output -- which is
    deliberate, because the self-test's whole point is to SEE a leaked key if one occurs
  * whether GitHub publishes composite `outputs:` after the action has failed the job is a
    property of the real runner and is NOT decided here; the harness records what the step wrote.

Usage:  run-action-locally.py --input k=v [--input ...] [--env K=V ...] [--json]
Prints a JSON object with the recorded outputs, env and the composite's overall outcome.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
ACTION = ROOT / "action.yml"

# The exact argv the GitHub Actions runner uses for `shell: bash`.
# Source: the runner's ScriptHandlerHelpers -- "bash --noprofile --norc -e -o pipefail {0}".
BASH_ARGV = ["bash", "--noprofile", "--norc", "-eo", "pipefail"]

EXPR = re.compile(r"\$\{\{\s*([^}]+?)\s*\}\}")


def resolve(text, inputs, step_outputs):
    """Resolve the `${{ }}` subset action.yml actually uses: inputs.* and steps.<id>.outputs.*."""

    def sub(m):
        ref = m.group(1)
        if ref.startswith("inputs."):
            return inputs.get(ref[len("inputs."):], "")
        if ref.startswith("steps."):
            _, step_id, kind, name = ref.split(".", 3)
            if kind != "outputs":
                raise SystemExit(f"harness cannot resolve: {ref}")
            return step_outputs.get(step_id, {}).get(name, "")
        raise SystemExit(f"harness cannot resolve: {ref}")

    return EXPR.sub(sub, str(text))


def read_kv(path):
    """Parse the GITHUB_OUTPUT / GITHUB_ENV `key=value` file format (no heredoc form is used)."""
    out = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k] = v
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", action="append", default=[], metavar="K=V")
    ap.add_argument("--env", action="append", default=[], metavar="K=V")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--workdir", default=str(ROOT))
    args = ap.parse_args()

    action = yaml.safe_load(ACTION.read_text())

    # Declared defaults first, caller overrides second -- the runner's own precedence.
    inputs = {}
    for name, spec in (action.get("inputs") or {}).items():
        inputs[name] = str(spec.get("default", ""))
    for pair in args.input:
        k, v = pair.split("=", 1)
        inputs[k] = v

    tmp = Path(tempfile.mkdtemp(prefix="mfarm-action-harness-"))
    gh_out = tmp / "github_output"
    gh_env = tmp / "github_env"
    gh_out.touch()
    gh_env.touch()
    runner_temp = tmp / "runner_temp"
    runner_temp.mkdir()

    base = dict(os.environ)
    base.update({
        "GITHUB_OUTPUT": str(gh_out),
        "GITHUB_ENV": str(gh_env),
        "RUNNER_TEMP": str(runner_temp),
        "CI": "true",
    })
    for pair in args.env:
        k, v = pair.split("=", 1)
        base[k] = v

    # A caller may hand us the job's own RUNNER_TEMP so that a stub built by an earlier workflow
    # step is visible here. In that case the directory is not ours and is not empty, so the
    # "did the action clean up after itself" check has to be a before/after diff rather than a
    # listing -- otherwise a deleted `rm -f` is a mutant that survives.
    runner_temp = Path(base["RUNNER_TEMP"])
    before = set(p.name for p in runner_temp.iterdir())

    step_outputs = {}
    outcome = "success"
    failed_at = None
    skipped = []
    transcript = []

    for step in action["runs"]["steps"]:
        name = step.get("name", step.get("id", "<unnamed>"))

        if outcome != "success":
            skipped.append(name)
            continue

        if "uses" in step:
            transcript.append({"step": name, "note": "uses: step not emulated", "rc": 0})
            continue

        if step.get("shell") != "bash":
            raise SystemExit(f"harness only handles shell: bash, got {step.get('shell')!r}")

        env = dict(base)
        # GITHUB_ENV written by an earlier step is visible to every later step.
        env.update(read_kv(gh_env))
        for k, v in (step.get("env") or {}).items():
            env[k] = resolve(v, inputs, step_outputs)

        script = tmp / f"step-{len(transcript)}.sh"
        script.write_text(step["run"])

        cwd = resolve(step.get("working-directory", args.workdir), inputs, step_outputs)
        cwd = str((Path(args.workdir) / cwd).resolve())

        proc = subprocess.run(
            BASH_ARGV + [str(script)],
            env=env, cwd=cwd, capture_output=True, text=True,
        )
        transcript.append({
            "step": name, "rc": proc.returncode,
            "stdout": proc.stdout, "stderr": proc.stderr,
        })

        if "id" in step:
            step_outputs[step["id"]] = read_kv(gh_out)

        if proc.returncode != 0:
            outcome = "failure"
            failed_at = name

    # Composite `outputs:` are evaluated by the runner from the recorded step outputs.
    declared = {}
    for name, spec in (action.get("outputs") or {}).items():
        declared[name] = resolve(spec["value"], inputs, step_outputs)

    result = {
        "outcome": outcome,
        "failed_at": failed_at,
        "skipped_steps": skipped,
        "outputs": declared,
        "github_env": read_kv(gh_env),
        # Only the action's own scratch files. The stub CLI and the stub control plane also write
        # into RUNNER_TEMP and are the test's business to clean up, not the action's.
        "runner_temp_leftovers": sorted(
            n for n in set(p.name for p in runner_temp.iterdir()) - before
            if n.startswith("mfarm-child-")),
        "transcript": transcript,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for t in transcript:
            print(f"--- {t['step']} (rc={t['rc']})")
            for stream in ("stdout", "stderr"):
                if t.get(stream):
                    sys.stdout.write(t[stream])
        print(json.dumps({k: v for k, v in result.items() if k != "transcript"}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
