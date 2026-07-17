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
    sbOverrides: "fldrMavYHDwp3fcWv",
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
    [F.departments.sbOverrides]: dept.sbOverridesJSON || undefined,
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
  // 1. delete existing items for this department.
  //    NOTE: we match the Department link LOCALLY rather than with a
  //    filterByFormula. `ARRAYJOIN({Department})` yields the linked records'
  //    display names (e.g. "Hungary 2026 · Counseling"), NOT their record ids,
  //    so `FIND(deptRecordId, ARRAYJOIN({Department}))` never matched — the
  //    delete silently found nothing and every save appended a fresh full copy,
  //    duplicating every item. (loadRunSelections matches locally for the same
  //    reason.) List all selections and match the link by record id here.
  //    (Airtable REST returns fields keyed by NAME, so read {Department} by name,
  //    exactly like loadRunSelections does.)
  const all = await call({ action: "list", table: "selections" });
  const staleIds = all.records.filter(r => {
    const linked = r.fields["Department"];
    if (!Array.isArray(linked)) return false;
    return linked.some(l =>
      (l && typeof l === "object" ? l.id : l) === deptRecordId);
  }).map(r => r.id);
  if (staleIds.length) {
    await call({ action: "delete", table: "selections", recordIds: staleIds });
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


// Load ALL selections for a run (country+year) from Airtable, keyed by dept code
// (HR, LC1, JVK2, ...) in the app's selections shape. Returns {} if nothing found.
export async function loadRunSelections(country, year) {
  const runName = `${country} ${year}`;
  // 1. Get this run's departments and build BOTH a record-id map and a name map,
  //    so we can match selections no matter what the link field returns.
  const depts = await call({ action: "list", table: "departments",
    filterByFormula: `FIND(${q(runName)}, {Department Key}) = 1` });
  if (!depts.records.length) return {};

  const codeById = {};    // dept record id -> dept code
  const codeByName = {};  // dept full name ("Poland 2026 · HR") -> dept code
  for (const dRec of depts.records) {
    const key = dRec.fields["Department Key"] || "";
    const code = dRec.fields["Dept Code"]?.name || dRec.fields["Dept Code"] ||
                 key.split("·").pop().trim();
    if (code) { codeById[dRec.id] = code; codeByName[key] = code; }
  }

  // 2. Pull ALL selections (paginated) and match each to a department of THIS run.
  //    We don't filter server-side by name (ARRAYJOIN behavior is unreliable);
  //    instead we match the link locally against both id and name maps.
  const sels = await call({ action: "list", table: "selections" });

  const out = {};
  const ensure = (code) => (out[code] = out[code] || { strengths: [], growth: [], leadershipQs: [], quotes: [] });

  sels.records
    .map(r => ({ id: r.id, f: r.fields }))
    .sort((a, b) => (a.f["Order"] || 0) - (b.f["Order"] || 0))
    .forEach(({ id, f }) => {
      const linked = f["Department"];
      if (!Array.isArray(linked) || !linked.length) return;
      const item0 = linked[0];
      // link entry may be {id, name}, a bare id string, or a bare name string
      let code = null;
      if (item0 && typeof item0 === "object") {
        code = codeById[item0.id] || (item0.name ? codeByName[item0.name] : null);
      } else if (typeof item0 === "string") {
        code = codeById[item0] || codeByName[item0] || null;
      }
      if (!code) return;   // belongs to a different run
      const sectionKey = SECTION_KEY[f["Section"]?.name || f["Section"]] || null;
      if (!sectionKey) return;
      ensure(code)[sectionKey].push({
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

// Check whether a run exists in Airtable (any departments for it).
export async function runExistsInAirtable(country, year) {
  const runName = `${country} ${year}`;
  const depts = await call({ action: "list", table: "departments",
    filterByFormula: `FIND(${q(runName)}, {Department Key}) = 1`, params: { pageSize: 1 } });
  return depts.records.length > 0;
}


// Load all runs from Airtable for the home screen's Previous Runs list.
// Returns [{ id, country, year, status, overallAvg, respondents, depts:[...] }].
export async function loadAllRuns() {
  const runsRes = await call({ action: "list", table: "runs" });
  const deptsRes = await call({ action: "list", table: "departments" });

  // group departments by run name
  const deptsByRun = {};
  for (const d of deptsRes.records) {
    const key = d.fields["Department Key"] || "";
    const runName = key.includes("·") ? key.split("·")[0].trim() : "";
    if (!runName) continue;
    (deptsByRun[runName] = deptsByRun[runName] || []).push({
      key: d.fields["Dept Code"]?.name || d.fields["Dept Code"] || "",
      label: d.fields["Dept Name"] || "",
      avg: d.fields["Average"] ?? null,
      status: d.fields["Status"]?.name || d.fields["Status"] || null,
      n: d.fields["Respondents"] ?? null,
    });
  }

  const runs = [];
  for (const r of runsRes.records) {
    const country = r.fields["Country"];
    const year = r.fields["Year"];
    if (!country || !year) continue;   // skip empty placeholder rows
    const runName = `${country} ${year}`;
    runs.push({
      id: `${country}-${year}-airtable`,
      country, year,
      status: r.fields["Status"]?.name || r.fields["Status"] || "In Review",
      overallAvg: r.fields["Overall Average"] ?? null,
      respondents: r.fields["Respondents"] ?? null,
      depts: deptsByRun[runName] || [],
      fromAirtable: true,
    });
  }
  return runs;
}


// Reassemble a full surveyData object for a run from Airtable, so any device can
// open a run and see the complete review (scores, questions, heatmap, quotes).
export async function loadRunSurveyData(country, year) {
  const runName = `${country} ${year}`;
  const depts = await call({ action: "list", table: "departments",
    filterByFormula: `FIND(${q(runName)}, {Department Key}) = 1` });
  if (!depts.records.length) return null;

  // department code -> record id, for pulling that dept's quotes
  const recByCode = {};
  const dd = {};
  const sbOverrides = {};   // merged Survey Basics edits across all depts in this run
  for (const d of depts.records) {
    const key = d.fields["Department Key"] || "";
    const code = d.fields["Dept Code"]?.name || d.fields["Dept Code"] ||
                 key.split("·").pop().trim();
    if (!code) continue;
    recByCode[code] = d.id;
    let questions = [];
    try { questions = JSON.parse(d.fields["Survey Data JSON"] || "{}").questions || []; } catch {}
    dd[code] = {
      key: code,
      label: d.fields["Dept Name"] || code,
      group: (code === "JVK1" || code === "JVK2") ? "JVK" : (code === "LC1" || code === "LC2") ? "LC" : code,
      n: d.fields["Respondents"] ?? (questions[0]?.n ?? 0),
      avg: d.fields["Average"] ?? null,
      status: d.fields["Status"]?.name || d.fields["Status"] || null,
      questions,
      openResponses: [],   // filled from Selections (quotes) below
      openQLabel: d.fields["Open Question"] || "",
    };
    // Merge this department's shared Survey Basics edits (if any) into the run-wide map.
    try {
      const ov = JSON.parse(d.fields["SB Overrides"] || "{}");
      if (ov && typeof ov === "object") Object.assign(sbOverrides, ov);
    } catch {}
  }

  // Pull all quote selections and attach as openResponses per dept — matched
  // locally by department id/name (robust to link-field format).
  try {
    const sels = await call({ action: "list", table: "selections" });
    const codeById = {}, codeByName = {};
    Object.entries(recByCode).forEach(([code, id]) => { codeById[id] = code; });
    for (const d of depts.records) {
      const key = d.fields["Department Key"] || "";
      const code = d.fields["Dept Code"]?.name || d.fields["Dept Code"] || key.split("·").pop().trim();
      if (code) codeByName[key] = code;
    }
    sels.records.forEach(r => {
      if ((r.fields["Section"]?.name || r.fields["Section"]) !== "Quote") return;
      const linked = r.fields["Department"];
      if (!Array.isArray(linked) || !linked.length) return;
      const item0 = linked[0];
      let code = null;
      if (item0 && typeof item0 === "object") code = codeById[item0.id] || (item0.name ? codeByName[item0.name] : null);
      else if (typeof item0 === "string") code = codeById[item0] || codeByName[item0] || null;
      if (!code || !dd[code]) return;
      dd[code].openResponses.push({
        text: r.fields["Text"] || "",
        translation: r.fields["Translation"] || null,
        isOriginalLang: !!r.fields["Is Original Language"],
      });
    });
  } catch (e) { /* quotes optional — leave empty if unavailable */ }

  return { depts: dd, merged: {}, raw: [], sbOverrides };
}


// ─── NOTES ────────────────────────────────────────────────────────────────────
// Department-level meeting notes and question-level notes, stored in the
// "Department Notes" and "Question Notes" tables (addressed by name via the proxy).
// Fields are referenced by name to match the hand-created tables:
//   Note, Body, Run, Department, [Question], Author, Created, Visibility

// Add a department meeting note. Returns the created record id.
export async function addDepartmentNote({ country, year, deptKey, author, title, body, visibility }) {
  const run = `${country} ${year}`;
  const fields = {
    "Name": (title || body || "").slice(0, 120),
    "Body": body || "",
    "Run": run,
    "Department": deptKey,
    "Author": author || "Unknown",
    "Created": new Date().toISOString(),
    "Visibility": visibility === "Public" ? "Public" : "Private",
  };
  const res = await call({ action: "create", table: "deptNotes", records: [{ fields }] });
  return res.records?.[0]?.id || null;
}

// Load all department meeting notes for a run+department, newest first.
// Visibility filtering (private vs public) is applied by the caller, which knows
// the current user and whether they're P&C leadership.
export async function loadDepartmentNotes(country, year, deptKey) {
  const run = `${country} ${year}`;
  const res = await call({ action: "list", table: "deptNotes",
    filterByFormula: `AND({Run} = ${q(run)}, {Department} = ${q(deptKey)})` });
  return (res.records || [])
    .map(r => ({
      id: r.id,
      title: r.fields["Name"] || "",
      body: r.fields["Body"] || "",
      author: r.fields["Author"] || "",
      created: r.fields["Created"] || null,
      visibility: r.fields["Visibility"] || "Private",
    }))
    .sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
}

// Flip a note between Private and Public.
export async function setDepartmentNoteVisibility(noteId, visibility) {
  await call({ action: "update", table: "deptNotes",
    records: [{ id: noteId, fields: { "Visibility": visibility === "Public" ? "Public" : "Private" } }] });
}

// Add a question-level note. Returns the created record id.
export async function addQuestionNote({ country, year, deptKey, question, author, title, body, visibility }) {
  const run = `${country} ${year}`;
  const fields = {
    "Name": (title || body || "").slice(0, 120),
    "Body": body || "",
    "Run": run,
    "Department": deptKey,
    "Question": question || "",
    "Author": author || "Unknown",
    "Created": new Date().toISOString(),
    "Visibility": visibility === "Public" ? "Public" : "Private",
  };
  const res = await call({ action: "create", table: "questionNotes", records: [{ fields }] });
  return res.records?.[0]?.id || null;
}

// Load question notes. Pass a question to get that one question's full history
// across ALL runs (the thread), or omit it to get every question note for a run+dept.
export async function loadQuestionNotes(country, year, deptKey, question) {
  let formula;
  if (question) {
    // history of THIS question across every survey (run), for this department
    formula = `AND({Department} = ${q(deptKey)}, {Question} = ${q(question)})`;
  } else {
    const run = `${country} ${year}`;
    formula = `AND({Run} = ${q(run)}, {Department} = ${q(deptKey)})`;
  }
  const res = await call({ action: "list", table: "questionNotes", filterByFormula: formula });
  return (res.records || [])
    .map(r => ({
      id: r.id,
      title: r.fields["Name"] || "",
      body: r.fields["Body"] || "",
      run: r.fields["Run"] || "",
      question: r.fields["Question"] || "",
      author: r.fields["Author"] || "",
      created: r.fields["Created"] || null,
      visibility: r.fields["Visibility"] || "Private",
    }))
    .sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
}

export async function setQuestionNoteVisibility(noteId, visibility) {
  await call({ action: "update", table: "questionNotes",
    records: [{ id: noteId, fields: { "Visibility": visibility === "Public" ? "Public" : "Private" } }] });
}

export { F as AIRTABLE_FIELDS };
