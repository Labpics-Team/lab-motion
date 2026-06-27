---
id: t01-roster-and-doc-urls
chapter: ch01-landscape-dimensions
epic: motion-superset-n7
title: "Lock the competitor roster and confirm each official-docs entry URL"
status: ready
priority: 1
depends_on: []
blocks:
  - t01-gsap
  - t02-motion
  - t03-anime-reactspring
  - t04-theatre-rive
  - t05-lottie-native
agent_profile:
  category: deep
  skills: [research-swarm]
started: null
completed: null
---

# Lock the competitor roster and confirm each official-docs entry URL

## What
Produce `chapters/ch01-landscape-dimensions/roster.md` (working note). Enumerate the EXACT competitor set the exit-criteria demand and, for each, the canonical official documentation entry point, confirmed reachable via Firecrawl/Context7 (record HTTP status + retrieval date). Note `Motion` = the union of Framer Motion (`motion.dev`, React) and Motion One (`motion.dev`, vanilla/mini) — two columns or one clearly-split column. Explicitly flag the four columns absent from the current `feature-matrix.md` (Theatre.js, Rive, Lottie, native scroll-driven CSS) as MUST-ADD.

Required entries (confirm each URL, do not assume):
- GSAP — gsap.com/docs (+ the `gsap_llms_txt` Context7 source already cited)
- Framer Motion / Motion — motion.dev/docs
- Motion One / Motion mini — motion.dev (mini/vanilla docs)
- Anime.js v4 — animejs.com/documentation
- React Spring — react-spring docs (Context7 / react-spring.dev)
- Theatre.js — theatrejs.com/docs
- Rive — rive.app/docs (runtime/state-machine docs)
- Lottie — lottiefiles.com / airbnb.io/lottie docs
- native WAAPI — MDN Web Animations API
- native View Transitions — MDN / drafts.csswg.org View Transitions
- native scroll-driven CSS — MDN scroll-driven animations / ScrollTimeline

## Must NOT Do
- Do NOT write into `docs/research/*` — this is a working note only.
- Do NOT cite from memory — every URL must be retrieved (record status + date).
- Do NOT exceed 10 tool-steps. If a doc is unreachable, record the failure and the closest official mirror; do not substitute a blog/third-party.

## Verification
- [ ] `roster.md` lists all 11 required competitor entries with a reachable official URL each (HTTP 200 + date recorded).
- [ ] The four missing columns (Theatre.js, Rive, Lottie, native scroll-driven CSS) are explicitly flagged MUST-ADD.

## References
- `docs/research/feature-matrix.md` — current roster C1–C6 (to be extended).
- Exit-criteria competitor list in `EPIC.md`.
