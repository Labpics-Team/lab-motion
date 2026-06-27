---
id: t01-cove-gate
chapter: ch05-cove-gate
epic: motion-superset-n7
title: "Run isolated CoVe gate; regenerate VERIFICATION-COVE.md; loop to PASS"
status: placeholder
priority: 1
depends_on: [t02-trace-and-nodescope-audit, t03-citation-density-pass]
blocks: []
agent_profile:
  category: deep
  skills: [verification-cove]
started: null
completed: null
refine_after: [t02-trace-and-nodescope-audit, t03-citation-density-pass]
---

# Isolated CoVe gate

Run by an agent that did NOT author the artifacts. Chain-of-Verification over `feature-matrix.md`, `gap-matrix.md`, `superset.md`. Plan verification questions, answer each against independent evidence (re-scrape competitor docs via Firecrawl/Context7; re-read src for HAS claims), cross-check, revise. Confirm: required competitor columns + >=2 citations/non-obvious claim; HAS == src:line; zero-descope count equality; golden thread resolves; s03..s13 ids; git diff confined to docs/research/* + epics/*. Write verdict + per-claim evidence table to `docs/research/VERIFICATION-COVE.md`. On any FAIL, route to the owning chapter, fix, re-run — loop until PASS.

Will be refined after the trace/no-descope audit and citation pass complete.
