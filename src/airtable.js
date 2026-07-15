// Client-side Airtable sync layer. Talks to the /.netlify/functions/airtable proxy
// (which holds the token server-side). Maps between the app's data shapes and the
// Airtable records in the JV Pulse Report base.
//
// Field ids for the JV Pulse Report base (stable — from base creation):
const F = {
  runs: {
    run: "fldMPrlvLKeQw7ioa", country: "fldMIgXKTpziwXaWz", year: "fldCm5PXsFZbvaHkM",
    status: "fldqHUkBPPFWMjjBU", overallAvg: "fldMzeJ7WPqyVrjHR", respondents: "fldI5KTdxOUAYbFwi",
    created: "fld6tycDgC89DnfEd", notes: "fldHNaBQNPLKg4Qi0",
  },
  departments: {
    key: "fldwrkz5V5OF3mZbT", name: "fldTtBNqo2xQQ3ouz", code: "fldcCWQxrxNd5gJSI",
    average: "fld2T9dJ5YF4dbd51", status: "fldRFtULXR26afEno", respondents: "fldejOT4HCHvWA7cB",
    openQuestion: "fldCHcHldlZeE1Krj", reviewStatus: "fldtb8tiiIkb3S7pw",
    surveyData: "fld3Wh12t2T8jvGXU", run: "fldqIzzYgH4rFEgFX",
  },
  selections: {
    item: "fldJisxHvmDIK4yGC", section: "fldGViHWpebqdgjDx", text: "fldD4bJvQ3FavY575",
    rewrite: "fldgGljxIPzzhwygy", translation: "fldBXTBZLxEzXhJI5",
    isOriginalLang: "fldKQeRF7g4mp9o5c", include: "fldguoZpHN9B3JvNd",
    order: "fldfcc9pRw7aKrql5", department: "fldSOi2rf84bWvz1L",
  },
};

const SECTION_LABEL = { strengths: "Strength", growth: "Growth", leadershipQs: "Leadership Q", quotes: "Quote" };
const SECTION_KEY   = { "Strength": "strengths", "Growth": "growth", "Leadership Q": "leadershipQs", "Quote": "quotes" };

async function call(payload) {
  const res = await fetch("/.netlify/functions/airtable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Airtable returned non-JSON: ${text.slice(0, 200)}`); }
}

// Connectivity check — returns true if the token + base are reachable.
export async function airtablePing() {
  try { await call({ action: "meta" }); return true; }
  catch { return false; }
}

// Escape a value for use inside an Airtable filterByFormula string literal.
const q = (s) => `'${String(s).replace(/'/g, "\\'")}'`;

// ---- RUNS ----
export async function upsertRun({ country, year, status, overallAvg, respondents, notes }) {
  const runName = `${country} ${year}`;
  const existing = await call({ action: "list", table: "runs",
    filterByFormula: `{Run} = ${q(runName)}` });
  const fields = {
    [F.runs.run]: runName, [F.runs.country]: country, [F.runs.year]: Number(year),
    [F.runs.status]: status || "Draft",
    [F.runs.overallAvg]: overallAvg != null ? Number(overallAvg) : undefined,
    [F.runs.respondents]: respondents != null ? Number(respondents) : undefined,
    [F.runs.notes]: notes || undefined,
  };
  if (existing.records.length) {
    const id = existing.records[0].id;
    await call({ action: "update", table: "runs", records: [{ id, fields }] });
    return id;
  }
  fields[F.runs.created] = new Date().toISOString().slice(0, 10);
  const created = await call({ action: "create", table: "runs", records: [{ fields }] });
  return created.records[0].id;
}

// ---- DEPARTMENTS ----
// Upsert one department row for a run. Returns the Airtable record id.
export async function upsertDepartment(runId, runName, dept) {
  const key = `${runName} · ${dept.key}`;
  const existing = await call({ action: "list", table: "departments",
    filterByFormula: `{Department Key} = ${q(key)}` });
  const fields = {
    [F.departments.key]: key,
    [F.departments.name]: dept.label,
    [F.departments.code]: dept.key,
    [F.departments.average]: dept.avg != null ? Number(dept.avg) : undefined,
    [F.departments.status]: dept.status || undefined,
    [F.departments.respondents]: dept.n != null ? Number(dept.n) : undefined,
    [F.departments.openQuestion]: dept.openQLabel || undefined,
    [F.departments.surveyData]: dept.surveyDataJSON || undefined,
    [F.departments.run]: [runId],
  };
  if (existing.records.length) {
    const id = existing.records[0].id;
    await call({ action: "update", table: "departments", records: [{ id, fields }] });
    return id;
  }
  const created = await call({ action: "create", table: "departments", records: [{ fields }] });
  return created.records[0].id;
}

// ---- SELECTIONS ----
// Load all selection items for a department record id, grouped by section.
export async function loadSelections(deptRecordId) {
  const res = await call({ action: "list", table: "selections",
    filterByFormula: `FIND(${q(deptRecordId)}, ARRAYJOIN({Department}))` });
  const out = { strengths: [], growth: [], leadershipQs: [], quotes: [] };
  res.records
    .map(r => ({ id: r.id, f: r.fields }))
    .sort((a, b) => (a.f["Order"] || 0) - (b.f["Order"] || 0))
    .forEach(({ id, f }) => {
      const sectionKey = SECTION_KEY[f["Section"]?.name || f["Section"]] || null;
      if (!sectionKey) return;
      out[sectionKey].push({
        _recordId: id,
        text: f["Text"] || "",
        rewrite: f["Rewrite"] || "",
        translation: f["Translation"] || null,
        isOriginalLang: !!f["Is Original Language"],
        include: !!f["Include"],
        isRefined: !!(f["Rewrite"] && f["Rewrite"].trim()),
      });
    });
  return out;
}

// Save a department's selections: replace all its items with the current set.
// Simple + reliable: delete existing rows for this dept, then create fresh ones.
export async function saveSelections(deptRecordId, selections) {
  // 1. delete existing items for this department
  const existing = await call({ action: "list", table: "selections",
    filterByFormula: `FIND(${q(deptRecordId)}, ARRAYJOIN({Department}))` });
  if (existing.records.length) {
    await call({ action: "delete", table: "selections",
      recordIds: existing.records.map(r => r.id) });
  }
  // 2. create rows for every item, section by section
  const rows = [];
  for (const [sectionKey, label] of Object.entries(SECTION_LABEL)) {
    (selections[sectionKey] || []).forEach((it, idx) => {
      const text = it.text || "";
      rows.push({ fields: {
        [F.selections.item]: (it.rewrite?.trim() || text).slice(0, 60),
        [F.selections.section]: label,
        [F.selections.text]: text,
        [F.selections.rewrite]: it.rewrite || undefined,
        [F.selections.translation]: it.translation || undefined,
        [F.selections.isOriginalLang]: !!it.isOriginalLang,
        [F.selections.include]: !!it.include,
        [F.selections.order]: idx,
        [F.selections.department]: [deptRecordId],
      }});
    });
  }
  if (rows.length) await call({ action: "create", table: "selections", records: rows });
  return rows.length;
}

export { F as AIRTABLE_FIELDS };
