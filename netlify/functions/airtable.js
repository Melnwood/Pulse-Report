// Serverless proxy to the Airtable API. Keeps the Airtable Personal Access Token
// server-side so it never ships in the browser bundle. Reads the token from the
// AIRTABLE_TOKEN env var and the base id from AIRTABLE_BASE_ID.
//
// ── ACCESS CONTROL ──
// When AUTH_SECRET is set (i.e. login is switched on), every request must carry a
// valid session token (Authorization: Bearer …). The token says who you are —
// role (leader | country | director) and country. Non-leaders are scoped to their
// own country, enforced HERE on the server, so a director literally cannot pull or
// change another country's data even by calling this function directly:
//   • list  → results are filtered to the caller's country
//   • write → country role is read-only; director may only write within their country
// Leaders (and the unconfigured/auth-off state) are unrestricted.
const { verifyToken } = require("./authlib");

const BASE_ID_FALLBACK = "appbGbWHVhneI7hQo"; // JV Pulse Report base

const TABLES = {
  runs:        "tblYtu8IEYKLcBfOD",
  departments: "tblgk8lmwqZlUMkcz",
  selections:  "tbl199XH5ESEIPtTW",
  team:        "tblmucsQUIbfADmI1",
  deptNotes:     "Department Notes",
  questionNotes: "Question Notes",
};

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  const fail = (code, error) => ({ statusCode: code, headers, body: JSON.stringify({ error }) });

  if (event.httpMethod !== "POST") return fail(405, "Use POST.");

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return fail(500, "AIRTABLE_TOKEN env var is not set on this deploy.");
  const baseId = process.env.AIRTABLE_BASE_ID || BASE_ID_FALLBACK;
  const secret = process.env.AUTH_SECRET;

  // ── Identify the caller (only when auth is switched on) ──
  let user = null;
  if (secret) {
    const authz = event.headers.authorization || event.headers.Authorization || "";
    user = verifyToken(authz.replace(/^Bearer\s+/i, "").trim(), secret);
    if (!user) return fail(401, "Please sign in.");
  }
  const role = user && user.role;
  const scoped = !!user && role !== "leader";              // non-leaders are country-scoped
  const country = (user && user.country) || "";

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return fail(400, "Body was not valid JSON: " + e.message); }

  const { action, table, records, recordIds, filterByFormula, params } = body;
  const tableId = TABLES[table];
  if (action !== "meta" && !tableId) return fail(400, `Unknown table "${table}".`);

  const doFetch = (typeof fetch !== "undefined") ? fetch : (await import("node-fetch")).default;
  const AT = "https://api.airtable.com/v0";
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // ── Airtable helpers ──
  const listAll = async (tblId, formula, pageSize, sort) => {
    let all = [], offset = null;
    do {
      const qs = new URLSearchParams();
      if (formula) qs.set("filterByFormula", formula);
      if (pageSize) qs.set("pageSize", String(pageSize));
      if (sort) sort.forEach((s, i) => { qs.set(`sort[${i}][field]`, s.field); if (s.direction) qs.set(`sort[${i}][direction]`, s.direction); });
      if (offset) qs.set("offset", offset);
      const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(tblId)}?${qs.toString()}`, { headers: authHeaders });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(text), { statusCode: res.status, body: text });
      const data = JSON.parse(text);
      all = all.concat(data.records || []);
      offset = data.offset || null;
    } while (offset);
    return all;
  };
  const getRecord = async (tblId, id) => {
    const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(tblId)}/${id}`, { headers: authHeaders });
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  };

  // ── Country scoping helpers ──
  const startsWithCountry = (s) =>
    typeof s === "string" && s.toLowerCase().startsWith((country + " ").toLowerCase());
  let deptIdSet = null; // department record ids belonging to the caller's country
  const allowedDeptIds = async () => {
    if (deptIdSet) return deptIdSet;
    const recs = await listAll(TABLES.departments);
    deptIdSet = new Set(recs.filter(r => startsWithCountry(r.fields && r.fields["Department Key"])).map(r => r.id));
    return deptIdSet;
  };
  const linkId = (link) => Array.isArray(link) && link.length
    ? (typeof link[0] === "object" ? link[0].id : link[0]) : null;
  // Does a record (by its fields) belong to the caller's country?
  const recordInCountry = async (tbl, fields) => {
    fields = fields || {};
    if (tbl === "runs") return startsWithCountry(fields.Run) || String(fields.Country || "").toLowerCase() === country.toLowerCase();
    if (tbl === "departments") return startsWithCountry(fields["Department Key"]);
    if (tbl === "deptNotes" || tbl === "questionNotes") return startsWithCountry(fields.Run);
    if (tbl === "selections") { const set = await allowedDeptIds(); const id = linkId(fields.Department); return !!id && set.has(id); }
    return false; // unknown table → deny for non-leaders
  };

  try {
    // ── LIST ──
    if (action === "list") {
      let all = await listAll(tableId, filterByFormula, params && params.pageSize, params && params.sort);
      if (scoped) {
        const kept = [];
        for (const r of all) { if (await recordInCountry(table, r.fields)) kept.push(r); }
        all = kept;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ records: all }) };
    }

    // ── WRITES: create / update / delete ──
    if (action === "create" || action === "update" || action === "delete") {
      if (scoped) {
        if (role === "country") return fail(403, "Read-only access.");
        // director: every affected record must be within their country
        if (action === "create") {
          for (const rec of (records || [])) {
            if (!(await recordInCountry(table, rec.fields))) return fail(403, "Outside your country.");
          }
        } else if (action === "update") {
          for (const rec of (records || [])) {
            let ok = await recordInCountry(table, rec.fields);
            if (!ok) { const f = await getRecord(tableId, rec.id); ok = f && await recordInCountry(table, f.fields); }
            if (!ok) return fail(403, "Outside your country.");
          }
        } else if (action === "delete") {
          for (const id of (recordIds || [])) {
            const f = await getRecord(tableId, id);
            if (!f || !(await recordInCountry(table, f.fields))) return fail(403, "Outside your country.");
          }
        }
      }

      if (action === "create") {
        const created = [];
        for (let i = 0; i < records.length; i += 10) {
          const batch = records.slice(i, i + 10);
          const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(tableId)}`, {
            method: "POST", headers: authHeaders, body: JSON.stringify({ records: batch, typecast: true }),
          });
          const text = await res.text();
          if (!res.ok) return { statusCode: res.status, headers, body: text };
          created.push(...JSON.parse(text).records);
        }
        return { statusCode: 200, headers, body: JSON.stringify({ records: created }) };
      }
      if (action === "update") {
        const updated = [];
        for (let i = 0; i < records.length; i += 10) {
          const batch = records.slice(i, i + 10);
          const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(tableId)}`, {
            method: "PATCH", headers: authHeaders, body: JSON.stringify({ records: batch, typecast: true }),
          });
          const text = await res.text();
          if (!res.ok) return { statusCode: res.status, headers, body: text };
          updated.push(...JSON.parse(text).records);
        }
        return { statusCode: 200, headers, body: JSON.stringify({ records: updated }) };
      }
      // delete
      const deleted = [];
      for (let i = 0; i < recordIds.length; i += 10) {
        const batch = recordIds.slice(i, i + 10);
        const qs = batch.map(id => `records[]=${encodeURIComponent(id)}`).join("&");
        const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(tableId)}?${qs}`, { method: "DELETE", headers: authHeaders });
        const text = await res.text();
        if (!res.ok) return { statusCode: res.status, headers, body: text };
        deleted.push(...JSON.parse(text).records);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ records: deleted }) };
    }

    // ── META (connectivity check) ──
    if (action === "meta") {
      const res = await doFetch(`${AT}/meta/bases/${baseId}/tables`, { headers: authHeaders });
      const text = await res.text();
      return { statusCode: res.status, headers, body: text };
    }

    return fail(400, `Unknown action "${action}".`);
  } catch (err) {
    if (err.statusCode) return { statusCode: err.statusCode, headers, body: err.body || JSON.stringify({ error: err.message }) };
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Airtable proxy failed: " + err.message }) };
  }
};
