# CLAUDE.md

Context for future Claude Code sessions working in this repo.

## What this is

JV Pulse Report Platform — a staff care survey reporting tool for Josiah Venture.

## Deployment

- **Live at:** https://jv-pulse-report.netlify.app (hosted on Netlify)
- **Auto-deploy:** Netlify builds and deploys automatically on every push to `main`.

## Architecture

- **Frontend:** Create React App. Main app code lives in `src/App.jsx`.
- **Backend:** Netlify Functions in `netlify/functions/`.
  - `claude.js` — calls the Anthropic API. Reads the `ANTHROPIC_KEY` env var.
  - `airtable.js` — calls Airtable. Reads the `AIRTABLE_TOKEN` env var.
- **AI model:** `claude-sonnet-4-6`.
- **Data:** Airtable base `appbGbWHVhneI7hQo` (6 tables).

## Secrets

API keys live **only** in Netlify environment variables. They must **never** be
placed in `REACT_APP_*` variables — anything prefixed `REACT_APP_` is bundled
into the client-side JS and would be publicly exposed. The serverless functions
read the raw env vars (`ANTHROPIC_KEY`, `AIRTABLE_TOKEN`) server-side instead.

## Local development

Use `netlify dev` for local testing (not `npm start`) so the Netlify Functions
and environment variables are available locally.

## Known issues

- `README.md` still incorrectly instructs setting `REACT_APP_ANTHROPIC_KEY`.
  This is wrong and insecure (see Secrets above) and should be fixed.
