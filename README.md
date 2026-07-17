# JV Pulse Report Platform

Staff care survey reporting tool for Josiah Venture.

## Setup

### 1. Clone and install
```bash
git clone https://github.com/Melnwood/pulse-report-app
cd pulse-report-app
npm install
```

### 2. Set your API keys
API keys are read server-side by the Netlify Functions and must **never** be
put in `REACT_APP_*` variables (those are bundled into the public client JS).

In Netlify dashboard → Site settings → Environment variables:
```
ANTHROPIC_KEY = sk-ant-...
AIRTABLE_TOKEN = pat...
```

For local development, create `.env` with the same (non-prefixed) names:
```
ANTHROPIC_KEY=your-key-here
AIRTABLE_TOKEN=your-token-here
```

### 3. Deploy
Push to `main` on GitHub. Netlify auto-deploys on every push.

For local dev (runs the Netlify Functions and loads env vars):
```bash
netlify dev
```

## How it works

1. **Upload** — Drop in SurveyPro export (.xlsx or .csv). Enter country + year.
2. **Director Review** — AI generates draft content per department. Directors approve/rewrite items inline. All selections are saved in browser storage.
3. **Report** — Click "Generate Report" → Print → Save as PDF.
4. **Dashboard** — P&C view shows all countries. Country view shows trends over time.

## Scoring Rules

- **DIST scale**: pos=(A+SA)/n, neg=(SD+D)/n → Healthy if pos≥75% AND neg≤15%; Watch if pos≥50% AND neg≤30%; else Concern
- **MEAN scale**: Healthy ≥3.50, Watch 2.50–3.49, Concern <2.50
- **Burden questions**: responses inverted (6 − raw) before scoring
- **Dept override**: 3+ Concern questions → dept = Concern regardless of avg

## File structure
```
src/
  App.jsx       — full application
netlify/
  functions/
    claude.js   — Anthropic API proxy (reads ANTHROPIC_KEY), model claude-sonnet-4-6
    airtable.js — Airtable proxy (reads AIRTABLE_TOKEN)
public/
  index.html
  favicon.svg   — pulse waveform icon
  manifest.json
netlify.toml    — build config
package.json
```
