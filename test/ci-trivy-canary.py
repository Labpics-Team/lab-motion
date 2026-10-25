"""Test Trivy security scan of an actual examples/ path with a synthetic AWS key."""
import json
import secrets
import string
import sys
from pathlib import Path

if len(sys.argv) < 3:
    raise SystemExit("Usage: ci-trivy-canary.py seed FILE | verify REPORT FILE STATUS")

mode = sys.argv[1]
if mode == "seed" and len(sys.argv) == 3:
    # Build the test-only value at runtime; never store a recognizable key in Git.
    suffix = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(16))
    Path(sys.argv[2]).write_text(f"AWS_ACCESS_KEY_ID=AKIA{suffix}\n")
elif mode == "verify" and len(sys.argv) == 5:
    report, fixture, status = Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4])
    if status != 1:
        raise SystemExit(f"Trivy canary expected scanner exit 1, got {status}")
    try:
        results = json.loads(report.read_text()).get("Results", [])
    except (OSError, ValueError) as exc:
        raise SystemExit("Trivy canary missing a valid JSON report") from exc
    target = fixture.as_posix()
    observed = any(
        str(result.get("Target", "")).replace("\\", "/").endswith(target)
        and any(item.get("RuleID") == "aws-access-key-id" for item in result.get("Secrets") or [])
        for result in results
        if isinstance(result, dict)
    )
    if not observed:
        raise SystemExit("Trivy did not detect the generated AWS key in examples/")
    print("Trivy canary: actual examples/ secret detected; clean-tree scan passed")
else:
    raise SystemExit("Invalid Trivy canary invocation")
