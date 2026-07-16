// Serverless proxy to the Airtable API. Keeps the Airtable Personal Access Token
// server-side so it never ships in the browser bundle. Reads the token from the
// AIRTABLE_TOKEN env var and the base id from AIRTABLE_BASE_ID.
//
// The app calls this function with a small JSON "action" describing what it wants;
// the function translates that into Airtable REST calls. This keeps all Airtable
// specifics (base id, table ids, token) on the server.

const BASE_ID_FALLBACK = "appbGbWHVhneI7hQo"; // JV Pulse Report base

// Table ids in the JV Pulse Report base
const TABLES = {
  runs:        "tblYtu8IEYKLcBfOD",
  departments: "tblgk8lmwqZlUMkcz",
  selections:  "tbl199XH5ESEIPtTW",
  team:        "tblmucsQUIbfADmI1",
  // Notes tables addressed by name (created by hand in the same base). The API
  // accepts a table name in place of an id, so long as the URL encodes it.
  deptNotes:     "Department Notes",
  questionNotes: "Question Notes",
};

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST." }) };
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "AIRTABLE_TOKEN env var is not set on this deploy." }) };
  }
  const baseId = process.env.AIRTABLE_BASE_ID || BASE_ID_FALLBACK;

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Body was not valid JSON: " + e.message }) }; }

  const { action, table, records, recordIds, filterByFormula, params } = body;
  const tableId = TABLES[table];
  if (action !== "meta" && !tableId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown table "${table}". Use one of: ${Object.keys(TABLES).join(", ")}` }) };
  }

  const doFetch = (typeof fetch !== "undefined") ? fetch : (await import("node-fetch")).default;
  const AT = "https://api.airtable.com/v0";
  const authHeaders = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    // ---- LIST (with optional filterByFormula + pagination) ----
    if (action === "list") {
      let all = [];
      let offset = null;
      do {
        const qs = new URLSearchParams();
        if (filterByFormula) qs.set("filterByFormula", filterByFormula);
        if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
        if (params?.sort) {
          params.sort.forEach((s, i) => {
            qs.set(`sort[${i}][field]`, s.field);
            if (s.direction) qs.set(`sort[${i}][direction]`, s.direction);
          });
        }
        if (offset) qs.set("offset", offset);
        const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(tableId)}?${qs.toString()}`, { headers: authHeaders });
        const text = await res.text();
        if (!res.ok) return { statusCode: res.status, headers, body: text };
        const data = JSON.parse(text);
        all = all.concat(data.records || []);
        offset = data.offset || null;
      } while (offset);
      return { statusCode: 200, headers, body: JSON.stringify({ records: all }) };
    }

    // ---- CREATE (batches of 10) ----
    if (action === "create") {
      const created = [];
      for (let i = 0; i < records.length; i += 10) {
        const batch = records.slice(i, i + 10);
        const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(tableId)}`, {
          method: "POST", headers: authHeaders,
          body: JSON.stringify({ records: batch, typecast: true }),
        });
        const text = await res.text();
        if (!res.ok) return { statusCode: res.status, headers, body: text };
        created.push(...JSON.parse(text).records);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ records: created }) };
    }

    // ---- UPDATE (batches of 10) ----
    if (action === "update") {
      const updated = [];
      for (let i = 0; i < records.length; i += 10) {
        const batch = records.slice(i, i + 10);
        const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(tableId)}`, {
          method: "PATCH", headers: authHeaders,
          body: JSON.stringify({ records: batch, typecast: true }),
        });
        const text = await res.text();
        if (!res.ok) return { statusCode: res.status, headers, body: text };
        updated.push(...JSON.parse(text).records);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ records: updated }) };
    }

    // ---- DELETE (batches of 10) ----
    if (action === "delete") {
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

    // ---- META (connectivity check) ----
    if (action === "meta") {
      const res = await doFetch(`${AT}/meta/bases/${baseId}/tables`, { headers: authHeaders });
      const text = await res.text();
      return { statusCode: res.status, headers, body: text };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action "${action}".` }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Airtable proxy failed: " + err.message }) };
  }
};
