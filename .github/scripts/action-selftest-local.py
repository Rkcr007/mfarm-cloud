#!/usr/bin/env python3
"""
Run every scenario in ../workflows/action-test.yml on this machine.

The matrix, the stub CLI, the stub control plane and the assertion scripts are all READ OUT OF
action-test.yml rather than re-implemented here, so this harness and the workflow cannot drift: a
scenario added to the matrix runs here too, and an assertion changes in exactly one place.

What is emulated is the WORKFLOW layer -- job `env:`, matrix expansion, `${{ steps.act.outcome }}`
and `${{ steps.act.outputs.* }}`, `continue-on-error`, and GITHUB_ENV accumulating across steps.
The ACTION layer is emulated by run-action-locally.py, which is where the `bash -eo pipefail`
fidelity that actually matters lives.

Not emulated: `uses:` steps other than `uses: ./` (checkout and setup-node are no-ops locally),
and the runner's `::add-mask::` redaction -- deliberately, because the self-test's whole point is
to be able to SEE a leaked key.

Usage:
  action-selftest-local.py                 # every job, every scenario
  action-selftest-local.py -k capacity     # only scenarios whose label matches
  action-selftest-local.py -v              # print every step's output, pass or fail
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "action-test.yml"
HARNESS = HERE / "run-action-locally.py"

BASH_ARGV = ["bash", "--noprofile", "--norc", "-eo", "pipefail"]
EXPR = re.compile(r"\$\{\{\s*([^}]+?)\s*\}\}")


class Step:
    """Just enough of a CompletedProcess for the log formatter."""

    def __init__(self, rc, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


def resolve(text, ctx):
    def sub(m):
        ref = m.group(1).strip()
        if ref in ctx:
            return str(ctx[ref])
        # An unset `env.X` / `steps.x.outputs.y` is the empty string on the real runner.
        if ref.startswith(("env.", "steps.")):
            return ""
        raise SystemExit(f"harness cannot resolve expression: {ref}")

    return EXPR.sub(sub, str(text))


def read_kv(path):
    out = {}
    p = Path(path)
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                out[k] = v
    return out


def run_job(job, row, verbose):
    tmp = tempfile.mkdtemp(prefix="mfarm-selftest-")
    gh_env = Path(tmp) / "job_github_env"
    gh_env.touch()

    job_env = dict(os.environ)
    job_env.update({
        "RUNNER_TEMP": tmp,
        "GITHUB_ENV": str(gh_env),
        "GITHUB_WORKSPACE": str(ROOT),
        "CI": "true",
    })
    declared_env = {k: str(v) for k, v in (job.get("env") or {}).items()}
    job_env.update(declared_env)

    ctx = {f"matrix.{k}": v for k, v in (row or {}).items()}
    ctx.update({f"env.{k}": v for k, v in declared_env.items()})

    log = []
    ok = True

    for i, step in enumerate(job["steps"]):
        name = step.get("name", step.get("id", f"step-{i}"))

        if step.get("uses") == "./":
            inputs = []
            for k, v in (step.get("with") or {}).items():
                inputs += ["--input", f"{k}={resolve(v, ctx)}"]

            # Everything a previous step exported, plus the job's own env, reaches the action.
            envs = []
            for k, v in list(declared_env.items()) + list(read_kv(gh_env).items()):
                envs += ["--env", f"{k}={v}"]
            envs += ["--env", f"RUNNER_TEMP={tmp}"]

            p = subprocess.run(
                [sys.executable, str(HARNESS), "--json"] + inputs + envs,
                capture_output=True, text=True, cwd=str(ROOT), env=job_env,
            )
            if p.returncode != 0:
                log.append(("action harness crashed", p))
                return False, log
            result = json.loads(p.stdout)

            log.append((
                f"{name} -> outcome={result['outcome']}",
                Step(0 if result["outcome"] == "success" else 1,
                     "".join(t.get("stdout", "") for t in result["transcript"]),
                     "".join(t.get("stderr", "") for t in result["transcript"])),
            ))

            # The action's GITHUB_ENV writes become job environment, as on the real runner.
            job_env.update(result["github_env"])
            ctx.update({f"env.{k}": v for k, v in result["github_env"].items()})

            if "id" in step:
                ctx[f"steps.{step['id']}.outcome"] = result["outcome"]
                for k, v in result["outputs"].items():
                    ctx[f"steps.{step['id']}.outputs.{k}"] = v

            # ADR-0002 decision 4's CI-side echo: the action must not litter RUNNER_TEMP.
            if result["runner_temp_leftovers"]:
                log.append(("RUNNER_TEMP not cleaned", Step(
                    1, "", f"leftovers: {result['runner_temp_leftovers']}\n")))
                ok = False

            if result["outcome"] != "success" and not step.get("continue-on-error"):
                return False, log
            continue

        if "uses" in step:
            log.append((f"{name} (uses: not emulated)", Step(0)))
            continue

        env = dict(job_env)
        env.update(read_kv(gh_env))
        for k, v in (step.get("env") or {}).items():
            env[k] = resolve(v, ctx)

        script = Path(tmp) / f"step-{i}.sh"
        script.write_text(resolve(step["run"], ctx))
        p = subprocess.run(BASH_ARGV + [str(script)], env=env, cwd=str(ROOT),
                           capture_output=True, text=True)
        log.append((name, p))

        job_env.update(read_kv(gh_env))
        ctx.update({f"env.{k}": v for k, v in read_kv(gh_env).items()})

        if p.returncode != 0 and not step.get("continue-on-error"):
            return False, log

    return ok, log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", "--filter", default="")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    for tool in ("bash", "node", "jq"):
        if not shutil.which(tool):
            print(f"missing required tool: {tool}")
            return 2

    wf = yaml.safe_load(WORKFLOW.read_text())
    results = []

    for job_name, job in wf["jobs"].items():
        rows = ((job.get("strategy") or {}).get("matrix") or {}).get("include") or [None]
        for row in rows:
            row = {k: str(v) for k, v in row.items()} if row else None
            label = f"{job_name}: {row['name'] if row else job.get('name', job_name)}"
            if args.filter and args.filter not in label:
                continue
            ok, log = run_job(job, row, args.verbose)
            results.append((label, ok, log))

    for label, ok, log in results:
        print(f"\n{'PASS' if ok else 'FAIL'}  {label}")
        if args.verbose or not ok:
            for tag, p in log:
                print(f"      . {tag} (rc={p.returncode})")
                for stream in (p.stdout, p.stderr):
                    for line in (stream or "").splitlines():
                        print(f"        | {line}")

    failed = [l for l, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} scenarios passed")
    for l in failed:
        print(f"  FAILED: {l}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
