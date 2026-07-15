# JV Pulse Report Platform

Staff care survey reporting tool for Josiah Venture.

## Setup

### 1. Clone and install
```bash
git clone https://github.com/Melnwood/pulse-report-app
cd pulse-report-app
npm install
```

### 2. Set your API key
In Netlify dashboard → Site settings → Environment variables:
```
REACT_APP_ANTHROPIC_KEY = sk-ant-...
```

For local development, create `.env`:
```
REACT_APP_ANTHROPIC_KEY=sk-ant-...
```

### 3. Deploy
Push to GitHub. Netlify auto-deploys on every push.

For local dev:
```bash
npm start
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
public/
  index.html
  favicon.svg   — pulse waveform icon
  manifest.json
netlify.toml    — build config
package.json
```
