---
id: ch02-parallel-deep-dive
epic: motion-superset-n7
title: "Parallel deep dive — one subagent per competitor cluster, 10-step cap"
user_story: "technical enabler"
enabler_for: "feature-matrix.md (CH-03) — the per-competitor capability evidence with >=2 citations per non-obvious claim is gathered here."
status: draft
priority: 1
depends_on: [ch01-landscape-dimensions]
refine_after: [t01-roster-and-doc-urls, t02-lock-dimensions]
parallel_group: wave-2
agent_profile:
  category: deep
  skills: [research-swarm]
---

# Parallel deep dive — one subagent per competitor cluster

## User Story
Technical enabler for the feature matrix. This is research-swarm Phase 3: fan out N subagents (each capped at 10 steps), one reading each competitor's official docs across the 14 frozen dimensions, each producing a per-competitor capability sheet with >=2 citations per non-obvious capability.

## Purpose
Read the official public docs (Firecrawl/Context7 ONLY — never memory) of every competitor in the locked roster and extract, per dimension D1..D14, which capabilities that competitor documents, with citations. Priority is the four MISSING columns (Theatre.js, Rive, Lottie, native scroll-driven CSS) plus reinforcing the existing six to >=2 sources/claim. Each subagent writes ONE sheet to `chapters/ch02-parallel-deep-dive/sheets/<competitor>.md`; no subagent touches `docs/research/*`.

## Tasks
| Task | Status | Agent | Depends On |
|------|--------|-------|------------|
| `tasks/t01-gsap.md` | placeholder | deep | t01-roster-and-doc-urls, t02-lock-dimensions |
| `tasks/t02-motion.md` | placeholder | deep | t01-roster-and-doc-urls, t02-lock-dimensions |
| `tasks/t03-anime-reactspring.md` | placeholder | deep | t01-roster-and-doc-urls, t02-lock-dimensions |
| `tasks/t04-theatre-rive.md` | placeholder | deep | t01-roster-and-doc-urls, t02-lock-dimensions |
| `tasks/t05-lottie-native.md` | placeholder | deep | t01-roster-and-doc-urls, t02-lock-dimensions |

## Exit Criteria
- [ ] Given the locked roster + dimensions, When the deep dive completes, Then every competitor has a sheet under `sheets/` covering all 14 dimensions (capability present/absent/partial) with a citation per documented capability and >=2 sources per non-obvious claim.
- [ ] Given the four previously-missing competitors, When their sheets are produced, Then Theatre.js, Rive, Lottie, and native scroll-driven CSS each have a complete, cited sheet.
- [ ] Given the swarm rule, When subagents run, Then each used <=10 steps and wrote only its own sheet (no cross-write, no edits to docs/research/*).
