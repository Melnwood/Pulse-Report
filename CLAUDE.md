# CLAUDE.md

Context for future Claude Code sessions working in this repo.

## What this is

JV Pulse Report Platform — a staff-care survey reporting tool for Josiah Venture.

## Deployment

- **Live at:** https://jv-pulse-report.netlify.app (Netlify)
- **Auto-deploy:** Netlify builds and deploys on every push to `main`.

## Architecture

- **Frontend:** Create React App. Main code in `src/App.jsx`.
- **Backend:** Netlify Functions in `netlify/functions/`.
  - `claude.js` — Anthropic API. Reads `ANTHROPIC_KEY`.
  - `airtable.js` — Airtable. Reads `AIRTABLE_TOKEN`.
- **AI model:** `claude-sonnet-4-6`.
- **Data:** Airtable base `appbGbWHVhneI7hQo` (Runs, Departments, Selections, Team, Department Notes, Question Notes).

## Secrets

API keys live ONLY in Netlify env vars (`ANTHROPIC_KEY`, `AIRTABLE_TOKEN`), read server-side by the functions. Never `REACT_APP_*` (that ships them to the browser).

## Local development

Use `netlify dev` (not `npm start`) so functions and env vars load locally.

---

## Design system — Warm & Human (app-wide)

The whole app uses the Warm & Human palette; the old orange/navy is retired. Centralize these as one shared theme (the app currently uses scattered inline styles — pull them into a theme object / CSS variables):

- bg `#F6F1E8` · card `#FFFFFF` · warm panel `#FDFAF4`
- text `#2C2621` · soft `#7A6F63` · faint `#A89C8D` · lines `#ECE2D2`
- accent `#E0863C` · deep `#B96524`
- Healthy `#5C9A6D` / bg `#E9F1E9` · Watch `#C08636` / bg `#F7EEDC` · Concern `#BE6650` / bg `#F6E5DE`
- Type: Fraunces (headings & scores), Inter (body/UI); rounded cards 14-16px, gentle warm shadows.

## Keep exactly — reskin only, do NOT rebuild

- Pulse Report — `ReportView` / `DeptReportPage` (summary + per-dept drill-down).
- Private/Public notes at every level — `NoteThread` / `DeptNotesTab` / `components/Visibility`.
- Heatmap — in `ReviewView`.
- Finish/reopen lock — `toggleDeptFinished` / `reviewDone` / `canEditDept`.
- Survey upload -> scoring -> status pipeline.

## Zones

- 1 Leadership (Mel & Chris): Leaders' dashboard [new]; Finalize/lock control [new, drives the existing lock].
- 2 Directors (dept across countries): Director's dashboard [new]; Every-question workspace + notes [new]; Behavioural-change tracking [new]; Question-first cross-country workspace [new]; Director Review = `ReviewView` [keep]; Summarized notes digest [new].
- 3 Country leaders: Country dashboard + shared public notes [new]; Pulse Report = `ReportView` [keep]; Over-time trends [new — complete the `ComingSoonSection` stub].
- 4 Foundations [keep]: notes, heatmap, scoring pipeline. Plus Warm & Human design system [new].

## Roadmap — build order

0. Warm & Human design system + reskin existing screens (structure untouched). Branch + Netlify preview.
1. Unique respondents — never sum per-department `n`s (double-counts a staff member); use the run's unique count.
2. Behavioural-change tracking — new Airtable `Measures` table keyed by dept+question: `baseline`, `target` (default 3.50), `behavior` (text), `interventions[]` {date,action}, `checks[]` {date,value,source}; threaded across runs.
3. Question-first workspace — new view; reuses Question Notes; writes to `Measures`.
4. AI-summarized notes digest — via `claude.js`; input = Department + Question notes + open-text; respects visibility (public-only for country leaders).
5. Over-time trends — complete the country trends stub; anchors on 2026.

## Known issues

- None. (README previously said `REACT_APP_ANTHROPIC_KEY` — corrected to server-side vars.)
