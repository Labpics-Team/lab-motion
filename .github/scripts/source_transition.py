"""Resolve the exact Git transition being verified, not the PR display diff.

Canonical source: Labpics-Team/.github, ci/source_transition.py.
Product copies at .github/scripts/source_transition.py are byte projections.
No API, remote fetch, mutable branch lookup, path filtering or CI policy.
"""
from dataclasses import dataclass
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


SHA = re.compile(r"[0-9a-f]{40}")


@dataclass(frozen=True)
class Transition:
    kind: str
    before: str
    after: str
    before_tree: str
    after_tree: str
    source_head: str = ""

    def outputs(self):
        return {"available": "true", **vars(self)}


def _sha(value):
    return isinstance(value, str) and SHA.fullmatch(value) is not None and value != "0" * 40


def _git(root, *args):
    env = os.environ.copy()
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"):
        env.pop(key, None)
    env.update(GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    return subprocess.check_output(
        ["git", "--no-replace-objects", "-C", str(root), *args],
        env=env, stderr=subprocess.PIPE, timeout=30,
    )


def _checked(root, sha):
    if not _sha(sha):
        raise ValueError("missing checked commit")
    top, checked = _git(root, "rev-parse", "--show-toplevel", "HEAD^{commit}").splitlines()
    if Path(os.fsdecode(top)).resolve() != Path(root).resolve() or checked.decode("ascii") != sha:
        raise ValueError("checkout does not bind the execution commit")


def _commit(root, sha):
    if not _sha(sha):
        raise ValueError("missing commit")
    # Inspect the raw object, not a shallow/grafted presentation of its parents.
    # A tag is not a commit identity, even if it peels to one.
    if _git(root, "cat-file", "-t", sha).strip() != b"commit":
        raise ValueError("not a commit")
    header = _git(root, "cat-file", "commit", sha).split(b"\n\n", 1)[0].splitlines()
    trees = [line[5:].decode("ascii") for line in header if line.startswith(b"tree ")]
    parents = [line[7:].decode("ascii") for line in header if line.startswith(b"parent ")]
    if len(trees) != 1 or not all(_sha(value) for value in trees + parents):
        raise ValueError("invalid commit object")
    if _git(root, "cat-file", "-t", trees[0]).strip() != b"tree":
        raise ValueError("missing tree")
    return trees[0], parents


def _pull(root, checked, source_head):
    # Historical pull_request.base.sha is deliberately not an argument.
    if not _sha(source_head):
        raise ValueError("missing author commit")
    after_tree, parents = _commit(root, checked)
    if len(parents) != 2 or parents[1] != source_head:
        raise ValueError("not the native merge of the event's source head")
    before = parents[0]
    before_tree, _ = _commit(root, before)
    return Transition("pull_request", before, checked, before_tree, after_tree, source_head)


def _advance(root, kind, checked, before, event_head):
    if not _sha(before) or event_head != checked:
        raise ValueError("event does not bind the transition")
    after_tree, _ = _commit(root, checked)
    before_tree, _ = _commit(root, before)
    # A missing history or a non-fast-forward event cannot justify skipping.
    _git(root, "merge-base", "--is-ancestor", before, checked)
    return Transition(kind, before, checked, before_tree, after_tree)


def resolve(root, kind, checked, event):
    """Return a proven transition, or None. Unknown is not an empty diff."""
    try:
        if not isinstance(event, dict):
            return None
        _checked(root, checked)
        if kind == "pull_request":
            return _pull(root, checked, event["pull_request"]["head"]["sha"])
        if kind == "merge_group":
            group = event["merge_group"]
            return _advance(root, kind, checked, group["base_sha"], group["head_sha"])
        if kind == "push":
            return _advance(root, kind, checked, event["before"], event["after"])
    except (OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError):
        return None
    return None


def from_github(root, environ=None):
    env = os.environ if environ is None else environ
    try:
        event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
        repository = env["GITHUB_REPOSITORY"]
        if not isinstance(repository, str) or not repository or event["repository"]["full_name"] != repository:
            return None
        kind = env["GITHUB_EVENT_NAME"]
        if kind == "pull_request":
            pull = event["pull_request"]
            if pull["base"]["repo"]["full_name"] != repository:
                return None
            if type(event["number"]) is not int or env["GITHUB_REF"] != f"refs/pull/{event['number']}/merge":
                return None
        return resolve(root, kind, env["GITHUB_SHA"], event)
    except (OSError, KeyError, TypeError, ValueError):
        return None


def changed_paths(root, transition):
    """Complete NUL-delimited Git paths, including both ends of renames."""
    if not isinstance(transition, Transition):
        raise ValueError("a proven transition is required")
    paths = _git(root, "diff-tree", "-r", "--no-commit-id", "--no-renames",
                 "--no-ext-diff", "--ignore-submodules=none", "--name-only", "-z",
                 transition.before_tree, transition.after_tree, "--")
    if paths and not paths.endswith(b"\0"):
        raise ValueError("incomplete Git path stream")
    return tuple(paths[:-1].split(b"\0")) if paths else ()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--root", default=os.environ.get("GITHUB_WORKSPACE") or ".")
    parser.add_argument("--format", choices=("github", "json", "range"), default="json")
    parser.add_argument("--required", action="store_true")
    args = parser.parse_args(argv)
    result = from_github(args.root)
    outputs = result.outputs() if result else {"available": "false"}
    if args.format == "github":
        for key, value in outputs.items():
            print(f"{key}={value}")
    elif args.format == "range":
        if result:
            print(result.before, result.after)
    else:
        print(json.dumps(outputs, separators=(",", ":")))
    if not result and args.required:
        print("The checked Git transition could not be established.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
