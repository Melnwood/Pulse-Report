#!/usr/bin/env node
// One-off maintenance script: remove duplicate Selections rows in Airtable.
//
// Background: a bug in saveSelections (fixed in commit 507e8d1) meant a
// department's existing selection rows were never deleted before re-saving,
// so every autosave appended a fresh full copy. This collapses those
// duplicates back down to one row per unique item.
//
// It talks to the DEPLOYED Netlify function proxy (which holds AIRTABLE_TOKEN
// server-side) — so you don't need the Airtable token locally. It only uses
// the same list/delete actions the app already uses.
//
// Two rows are considered duplicates when they share the same department,
// section, order, text, and rewrite. For each such group we KEEP the oldest
// row (earliest createdTime) and delete the rest. Genuinely distinct items
// (different order or different text) are never touched.
//
// Usage:
//   node scripts/dedupe-selections.mjs                 # DRY RUN — reports only, deletes nothing
//   node scripts/dedupe-selections.mjs --apply         # actually delete the duplicates
//   PROXY=https://jv-pulse-report.netlify.app/.netlify/functions/airtable node scripts/dedupe-selections.mjs
//
// Recommended: run the dry run first, eyeball the summary, then re-run with --apply.

const PROXY = process.env.PROXY
  || "https://jv-pulse-report.netlify.app/.netlify/functions/airtable";
const APPLY = process.argv.includes("--apply");

async function call(payload) {
  const res = await fetch(PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Proxy ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON response: ${text.slice(0, 200)}`); }
}

// Stable key that identifies "the same item" so exact re-saves collapse.
function keyFor(r) {
  const f = r.fields || {};
  const linked = Array.isArray(f["Department"]) ? f["Department"] : [];
  const deptId = linked.map(l => (l && typeof l === "object" ? l.id : l)).filter(Boolean).sort().join(",");
  const section = f["Section"]?.name ?? f["Section"] ?? "";
  const order = f["Order"] ?? "";
  const text = (f["Text"] ?? "").trim();
  const rewrite = (f["Rewrite"] ?? "").trim();
  return [deptId, section, order, text, rewrite].join(" ¦ ");
}

function deptIdOf(r) {
  const linked = Array.isArray(r.fields?.["Department"]) ? r.fields["Department"] : [];
  const first = linked[0];
  return (first && typeof first === "object" ? first.id : first) || null;
}

async function main() {
  console.log(`Proxy: ${PROXY}`);
  console.log(`Mode:  ${APPLY ? "APPLY (will delete duplicates)" : "DRY RUN (no changes)"}\n`);

  // Map department record id -> readable name so the report is legible.
  const deptNames = new Map();
  try {
    const { records: depts } = await call({ action: "list", table: "departments" });
    for (const d of depts) deptNames.set(d.id, d.fields?.["Department Key"] || d.id);
  } catch { /* names are cosmetic — fall back to ids */ }
  const labelFor = (id) => deptNames.get(id) || id || "(no department)";

  const { records } = await call({ action: "list", table: "selections" });
  console.log(`Fetched ${records.length} selection rows.\n`);

  // Group by content key. Keep the oldest (earliest createdTime) in each group.
  const groups = new Map();
  for (const r of records) {
    const k = keyFor(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const toDelete = [];
  const perDept = new Map(); // dept label -> { dupes, kept }
  for (const [, rows] of groups) {
    if (rows.length <= 1) continue;
    rows.sort((a, b) => new Date(a.createdTime || 0) - new Date(b.createdTime || 0));
    const [keep, ...dupes] = rows;         // keep the oldest, delete the rest
    toDelete.push(...dupes);
    const label = labelFor(deptIdOf(keep));
    const acc = perDept.get(label) || { dupes: 0 };
    acc.dupes += dupes.length;
    perDept.set(label, acc);
  }

  const affectedDepts = [...perDept.entries()].sort((a, b) => b[1].dupes - a[1].dupes);
  if (!toDelete.length) {
    console.log("✓ No duplicates found. Nothing to do.");
    return;
  }

  console.log(`Found ${toDelete.length} duplicate rows across ${affectedDepts.length} departments:\n`);
  for (const [label, { dupes }] of affectedDepts) {
    console.log(`  ${String(dupes).padStart(4)} extra  ${label}`);
  }
  console.log(`\n  ${records.length} rows total → ${records.length - toDelete.length} after cleanup.\n`);

  if (!APPLY) {
    console.log("DRY RUN — nothing deleted. Re-run with --apply to delete these duplicates.");
    return;
  }

  // Delete in batches (the proxy chunks into 10s, but keep requests modest).
  const ids = toDelete.map(r => r.id);
  let done = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    await call({ action: "delete", table: "selections", recordIds: batch });
    done += batch.length;
    console.log(`  deleted ${done}/${ids.length}…`);
  }
  console.log(`\n✓ Done. Deleted ${ids.length} duplicate rows.`);
}

main().catch(e => { console.error("\n✗ Failed:", e.message); process.exit(1); });
