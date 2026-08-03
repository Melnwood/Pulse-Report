// Public endpoint for the in-app staff survey. The credentials are (1) the
// survey link's unguessable token, which must match an OPEN row in the Surveys
// table, and (2) their personal resume code, generated here when they start.
//
// Actions (POST JSON):
//   { action:"meta",   token }                      → { run, country, period, status }
//   { action:"start",  token }                      → { code }   (creates the response row)
//   { action:"resume", token, code }                → { code, answers, status }
//   { action:"save",   token, code, answers, status, language } → { ok:true }
//   { action:"checkin", token, email, done? }       → { ok:true }
//
// The check-in is the QuestionPro-style "sign in, stay anonymous" piece: the
// email lands in the separate Survey Checkins table (Started, then Finished on
// submit) and is NEVER written to a response row — there is no stored link
// between an email and a code or any answers.
//
// The Airtable token stays server-side, and this function can only touch the
// Surveys / Survey Responses / Survey Checkins tables — nothing else in the base.
const BASE_ID_FALLBACK = "appbGbWHVhneI7hQo";
const SURVEYS_TABLE = "Surveys";
const RESPONSES_TABLE = "Survey Responses";
const CHECKINS_TABLE = "Survey Checkins";

// Unambiguous alphabet (no 0/O, 1/I/L) so codes survive handwriting and phones.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const makeCode = () => {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
};
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{3})(.{3})$/, "$1-$2");

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  const fail = (code, error) => ({ statusCode: code, headers, body: JSON.stringify({ error }) });
  const ok = (data) => ({ statusCode: 200, headers, body: JSON.stringify(data) });

  if (event.httpMethod !== "POST") return fail(405, "Use POST.");
  const atToken = process.env.AIRTABLE_TOKEN;
  if (!atToken) return fail(500, "AIRTABLE_TOKEN env var is not set on this deploy.");
  const baseId = process.env.AIRTABLE_BASE_ID || BASE_ID_FALLBACK;

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return fail(400, "Body was not valid JSON: " + e.message); }
  const { action, token } = body;
  if (!token || String(token).length < 12) return fail(400, "Missing survey token.");

  const doFetch = (typeof fetch !== "undefined") ? fetch : (await import("node-fetch")).default;
  const AT = "https://api.airtable.com/v0";
  const authHeaders = { Authorization: `Bearer ${atToken}`, "Content-Type": "application/json" };
  const esc = (s) => String(s).replace(/'/g, "\\'");
  const list = async (table, formula) => {
    const qs = new URLSearchParams();
    qs.set("filterByFormula", formula);
    qs.set("pageSize", "100");
    const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(table)}?${qs}`, { headers: authHeaders });
    const text = await res.text();
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text).records || [];
  };
  const create = async (table, fields) => {
    const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(table)}`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ records: [{ fields }] }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text).records[0];
  };
  const update = async (table, id, fields) => {
    const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(table)}`, {
      method: "PATCH", headers: authHeaders, body: JSON.stringify({ records: [{ id, fields }] }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text).records[0];
  };

  try {
    // Every action begins by proving the token names a real survey.
    const surveys = await list(SURVEYS_TABLE, `{Token} = '${esc(token)}'`);
    const survey = surveys[0];
    if (!survey) return fail(404, "This survey link isn't valid.");
    const f = survey.fields || {};
    const run = f.Run || "";
    const status = (f.Status && f.Status.name) || f.Status || "Closed";

    if (action === "meta") {
      return ok({ run, country: f.Country || "", period: f.Period || "", status });
    }

    if (action === "start") {
      if (status !== "Open") return fail(409, "This survey is closed.");
      // Generate a code that's unused within this run (collisions are ~never,
      // but a survey is a bad place for "almost never").
      let code = makeCode();
      for (let i = 0; i < 5; i++) {
        const clash = await list(RESPONSES_TABLE, `AND({Run} = '${esc(run)}', {Code} = '${esc(code)}')`);
        if (!clash.length) break;
        code = makeCode();
      }
      const now = new Date().toISOString();
      await create(RESPONSES_TABLE, {
        "Code": code, "Run": run, "Answers": "{}",
        "Status": "In progress", "Started": now, "Updated": now,
      });
      return ok({ code });
    }

    if (action === "resume") {
      const code = normCode(body.code);
      if (!code) return fail(400, "Enter your code.");
      const rows = await list(RESPONSES_TABLE, `AND({Run} = '${esc(run)}', {Code} = '${esc(code)}')`);
      const row = rows[0];
      if (!row) return fail(404, "We couldn't find a survey with that code. Check the letters — or start a new one.");
      let answers = {};
      try { answers = JSON.parse(row.fields.Answers || "{}"); } catch {}
      const rStatus = (row.fields.Status && row.fields.Status.name) || row.fields.Status || "In progress";
      return ok({ code, answers, status: rStatus, language: row.fields.Language || "" });
    }

    if (action === "save") {
      if (status !== "Open") return fail(409, "This survey is closed — answers can no longer be changed.");
      const code = normCode(body.code);
      if (!code) return fail(400, "Missing code.");
      const rows = await list(RESPONSES_TABLE, `AND({Run} = '${esc(run)}', {Code} = '${esc(code)}')`);
      const row = rows[0];
      if (!row) return fail(404, "Unknown code for this survey.");
      const answersJSON = JSON.stringify(body.answers || {}).slice(0, 95000);
      const fields = { "Answers": answersJSON, "Updated": new Date().toISOString() };
      if (body.status === "Completed") fields["Status"] = "Completed";
      if (body.language !== undefined) fields["Language"] = String(body.language || "").slice(0, 40);
      await update(RESPONSES_TABLE, row.id, fields);
      return ok({ ok: true });
    }

    if (action === "checkin") {
      if (status !== "Open") return fail(409, "This survey is closed.");
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, "Please enter a real email address.");
      const rows = await list(CHECKINS_TABLE, `AND({Run} = '${esc(run)}', LOWER({Email}) = '${esc(email)}')`);
      const now = new Date().toISOString();
      const row = rows[0];
      if (!row) {
        await create(CHECKINS_TABLE, { "Email": email, "Run": run,
          "Status": body.done ? "Finished" : "Started", "Updated": now });
      } else {
        const cur = (row.fields.Status && row.fields.Status.name) || row.fields.Status || "";
        // Never step someone back from Finished.
        const next = body.done ? "Finished" : (cur === "Finished" ? "Finished" : "Started");
        await update(CHECKINS_TABLE, row.id, { "Status": next, "Updated": now });
      }
      return ok({ ok: true });
    }

    return fail(400, `Unknown action "${action}".`);
  } catch (e) {
    return fail(502, "Survey service error: " + e.message);
  }
};
