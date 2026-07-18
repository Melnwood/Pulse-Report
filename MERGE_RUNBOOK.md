# Merge runbook — Pulse Report roadmap (6 PRs)

Six feature branches implement Steps 0–5 of the roadmap in `CLAUDE.md`. They are
**stacked** (each was cut from the one before it), so they must be merged
**bottom-up, one at a time**.

**Merge order (never skip ahead):**

1. `warm-human-reskin` — Warm & Human palette + Fraunces (Step 0)
2. `unique-respondents` — respondent double-count fixes (Step 1)
3. `measures-tracking` — Measures table + behaviour-change tracking (Step 2)
4. `question-workspace` — question-first director workspace (Step 3)
5. `notes-digest` — AI-summarized notes digest (Step 4)
6. `over-time-trends` — visual over-time trends (Step 5)

Merging in this order means each PR's diff **shrinks to just its own changes**
the moment its parent lands in `main`.

## Use "Create a merge commit" (not squash)

Because the branches are stacked, **squash-merging can inject avoidable
conflicts** into the branches above. Use a plain merge commit for all six.

One-time check: repo → **Settings → General → Pull Requests** → ensure
**"Allow merge commits"** is enabled.

## For each branch, in order

1. **Open the PR:** `https://github.com/Melnwood/Pulse-Report/pull/new/<branch-name>`
   (e.g. `.../pull/new/warm-human-reskin`).
2. Confirm the header reads **`base: main ← compare: <branch-name>`**. Add a
   title, click **Create pull request**.
3. **Wait for the Netlify check** to go green, then open the
   `deploy-preview-<n>--jv-pulse-report.netlify.app` link Netlify posts on the
   PR. Eyeball it.
4. **Merge pull request → change the dropdown to "Create a merge commit" →
   Confirm merge.**
5. **Delete branch** (safe — the commits are now in `main`).
6. **Only now** move to the next branch and repeat. Its PR auto-recomputes
   against the new `main` and shows a clean, smaller diff.

## What to check after each merge

Netlify auto-deploys `main` on every merge, so the **live site**
(jv-pulse-report.netlify.app) updates after each one. Hard-refresh
(Cmd-Shift-R) to bust cache.

- **After #1 (`warm-human-reskin`):** the whole site shows the warm cream/amber
  palette and Fraunces headings.
- **After #2 (`unique-respondents`):** open a country report → the header reads
  the real respondent count, not `0`.
- **After #3 (`measures-tracking`):** Director Review → **Notes** tab → any
  question shows a **Track change** control. *(The `Measures` Airtable table
  already exists, so this works immediately.)*
- **After #4 (`question-workspace`):** a **Question workspace** card appears on
  the landing page.
- **After #5 (`notes-digest`):** the Notes tab shows a **Notes digest** with a
  **Summarize** button. *(Uses the `ANTHROPIC_KEY` already set in Netlify.)*
- **After #6 (`over-time-trends`):** Country dashboard → pick a country → the
  **Over time** trend panel.

## Troubleshooting

- **A PR shows more than its own changes** → a branch *below* it isn't merged
  yet. Stop, merge the lower one first; the diff corrects itself.
- **GitHub reports a conflict** → only expected if a branch was merged out of
  order or with squash. Note which branch and re-cut/rebase it onto the updated
  `main`.

## Note on the live Airtable

The `Measures` table (Step 2) was created in the production base **ahead of its
code**. It's empty and additive — harmless while unmerged — and starts being
used once `measures-tracking` lands.
