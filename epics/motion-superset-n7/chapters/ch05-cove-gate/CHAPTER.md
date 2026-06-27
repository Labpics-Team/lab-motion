---
id: ch05-cove-gate
epic: motion-superset-n7
title: "Isolated verification-cove gate over the three hardened artifacts"
user_story: "technical enabler"
enabler_for: "Epic completion — the N7 source of truth is not authorized for downstream use until an isolated CoVe gate returns PASS."
status: draft
priority: 3
depends_on: [ch04-lock-superset]
refine_after: [t02-trace-and-nodescope-audit, t03-citation-density-pass]
parallel_group: wave-5
agent_profile:
  category: deep
  skills: [verification-cove]
---

# Isolated verification-cove gate

## User Story
Technical enabler for epic completion. An agent that did NOT write the artifacts independently fact-checks every atomic claim against the v1.0.0 source and live competitor docs, and returns PASS/FAIL. No self-grading.

## Purpose
Regenerate `docs/research/VERIFICATION-COVE.md` over the HARDENED artifacts (the prior gate covered prior drafts and does not count). Chain-of-Verification, Factor+Revise, isolated. Verify: every required competitor column present and cited (>=2 sources/non-obvious claim); v1.0.0 HAS claims match src:line; zero-descope count check holds; golden thread resolves for sampled rows; scope ids are in canonical s03..s13. Any discrepancy -> FAIL -> route back to the owning chapter to fix, then re-run. Only PASS authorizes epic completion.

## Tasks
| Task | Status | Agent | Depends On |
|------|--------|-------|------------|
| `tasks/t01-cove-gate.md` | placeholder | deep | t02-trace-and-nodescope-audit, t03-citation-density-pass |

## Exit Criteria
- [ ] Given the three hardened artifacts, When an isolated CoVe agent verifies them, Then VERIFICATION-COVE.md records per-claim independent evidence and verdict PASS with 0 unresolved discrepancies.
- [ ] Given a FAIL on any claim, When triaged, Then it is routed to the owning chapter, fixed, and re-gated (loop until PASS) — never waived.
- [ ] Given the no-runtime-code rule, When the gate runs, Then it confirms git diff touched only docs/research/* and epics/* (no src/, test/, package.json, build config).
