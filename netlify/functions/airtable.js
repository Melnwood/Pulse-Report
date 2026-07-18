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
  measures:      "Measures",
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
  const country = (user && user.country) || "";
  // A director owns one or more departments (by code) and works ACROSS every
  // country: they READ all data but may only WRITE within their departments.
  // A country leader is READ-ONLY within a single country. A leader (and the
  // auth-off state) is unrestricted.
  const deptSet = new Set(String((user && user.department) || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const readScoped   = role === "country";                 // only country leaders are read-filtered
  const writeBlocked = role === "country";                 // country leaders are read-only
  const writeByDept  = role === "director";                // directors write within their departments

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

  // ── Scoping helpers ──
  // Some tables are written by field ID (runs/departments/selections), others by
  // field name (notes/measures). Scoping reads must therefore accept either key.
  const FIELD = { deptCode: "fldcCWQxrxNd5gJSI", deptKey: "fldwrkz5V5OF3mZbT", selDept: "fldSOi2rf84bWvz1L" };
  const linkId = (link) => Array.isArray(link) && link.length
    ? (typeof link[0] === "object" ? link[0].id : link[0]) : null;
  const selectionDeptId = (fields) => linkId(fields.Department || fields[FIELD.selDept]);
  // A department record's dept code (e.g. "hr"), from whichever key is present.
  const codeOf = (fields) => {
    const dc = fields["Dept Code"] !== undefined ? fields["Dept Code"] : fields[FIELD.deptCode];
    const key = fields["Department Key"] !== undefined ? fields["Department Key"] : fields[FIELD.deptKey];
    const c = (dc && dc.name) || dc || String(key || "").split("·").pop().trim();
    return String(c || "").trim().toLowerCase();
  };

  // Country scoping — for the country-leader READ filter only.
  const startsWithCountry = (s) =>
    typeof s === "string" && s.toLowerCase().startsWith((country + " ").toLowerCase());
  let countryDeptIds = null;
  const allowedCountryDeptIds = async () => {
    if (countryDeptIds) return countryDeptIds;
    const recs = await listAll(TABLES.departments);
    countryDeptIds = new Set(recs.filter(r => startsWithCountry(r.fields && r.fields["Department Key"])).map(r => r.id));
    return countryDeptIds;
  };
  const recordInCountry = async (tbl, fields) => {
    fields = fields || {};
    if (tbl === "runs") return startsWithCountry(fields.Run) || String(fields.Country || "").toLowerCase() === country.toLowerCase();
    if (tbl === "departments") return startsWithCountry(fields["Department Key"]);
    if (tbl === "deptNotes" || tbl === "questionNotes") return startsWithCountry(fields.Run);
    if (tbl === "measures") return String(fields.Country || "").toLowerCase() === country.toLowerCase();
    if (tbl === "selections") { const set = await allowedCountryDeptIds(); const id = selectionDeptId(fields); return !!id && set.has(id); }
    return false;
  };

  // Department scoping — for director WRITES (any country, matched by dept code).
  let myDeptIds = null;
  const myDepartmentIds = async () => {
    if (myDeptIds) return myDeptIds;
    const recs = await listAll(TABLES.departments);
    myDeptIds = new Set(recs.filter(r => deptSet.has(codeOf(r.fields || {}))).map(r => r.id));
    return myDeptIds;
  };
  const recordInDept = async (tbl, fields) => {
    fields = fields || {};
    if (tbl === "runs") return true; // shared run metadata; directors work across all countries
    if (tbl === "departments") return deptSet.has(codeOf(fields));
    if (tbl === "deptNotes" || tbl === "questionNotes") return deptSet.has(String(fields.Department || "").trim().toLowerCase());
    if (tbl === "measures") return deptSet.has(String(fields.Department || "").trim().toLowerCase());
    if (tbl === "selections") { const set = await myDepartmentIds(); const id = selectionDeptId(fields); return !!id && set.has(id); }
    return false;
  };

  try {
    // ── LIST ──
    if (action === "list") {
      let all = await listAll(tableId, filterByFormula, params && params.pageSize, params && params.sort);
      // Country leaders see only their own country; directors and leaders read everything.
      if (readScoped) {
        const kept = [];
        for (const r of all) { if (await recordInCountry(table, r.fields)) kept.push(r); }
        all = kept;
      }
      // Notes carry a visibility. Non-leaders never receive someone else's PRIVATE
      // note — a country leader gets public notes only; a director also gets their
      // own. (Enforced here on the server, not just hidden in the client.)
      if ((table === "deptNotes" || table === "questionNotes") && role && role !== "leader") {
        const myName = String((user && user.name) || "");
        all = all.filter(r => {
          const f = r.fields || {};
          if ((f.Visibility || "Private") === "Public") return true;
          return role === "director" && myName !== "" && String(f.Author || "") === myName;
        });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ records: all }) };
    }

    // ── WRITES: create / update / delete ──
    if (action === "create" || action === "update" || action === "delete") {
      if (writeBlocked) return fail(403, "Read-only access.");
      if (writeByDept) {
        // director: every affected record must belong to one of their departments
        // (in any country). Updates/deletes fetch the record so the check uses
        // Airtable's name-keyed fields even when the write payload used field ids.
        if (action === "create") {
          for (const rec of (records || [])) {
            if (!(await recordInDept(table, rec.fields))) return fail(403, "Outside your department.");
          }
        } else if (action === "update") {
          for (const rec of (records || [])) {
            let ok = await recordInDept(table, rec.fields);
            if (!ok) { const f = await getRecord(tableId, rec.id); ok = f && await recordInDept(table, f.fields); }
            if (!ok) return fail(403, "Outside your department.");
          }
        } else if (action === "delete") {
          for (const id of (recordIds || [])) {
            const f = await getRecord(tableId, id);
            if (!f || !(await recordInDept(table, f.fields))) return fail(403, "Outside your department.");
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
