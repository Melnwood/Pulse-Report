// Login endpoint. Verifies an email + password against the "Users" table in
// Airtable and returns a signed session token carrying the user's role, country
// and department. Also exposes a "status" action so the client can tell whether
// auth is switched on yet (it is only once AUTH_SECRET is set) — this keeps the
// app open until you deliberately configure it, so a half-built rollout can't
// lock anyone out.
const { verifyPassword, signToken } = require("./authlib");

const BASE_ID_FALLBACK = "appbGbWHVhneI7hQo";
const USERS_TABLE = "Users";

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST." }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Body was not valid JSON." }) }; }

  const secret = process.env.AUTH_SECRET;

  // status — is login required yet? (client asks on load)
  if (body.action === "status") {
    return { statusCode: 200, headers, body: JSON.stringify({ enabled: !!secret }) };
  }

  if (body.action === "login") {
    if (!secret) {
      // Auth not configured — logins are meaningless; tell the client it's off.
      return { statusCode: 200, headers, body: JSON.stringify({ enabled: false }) };
    }
    const token = process.env.AIRTABLE_TOKEN;
    if (!token) return { statusCode: 500, headers, body: JSON.stringify({ error: "AIRTABLE_TOKEN is not set." }) };
    const baseId = process.env.AIRTABLE_BASE_ID || BASE_ID_FALLBACK;

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Email and password are required." }) };
    }

    const doFetch = (typeof fetch !== "undefined") ? fetch : (await import("node-fetch")).default;
    const AT = "https://api.airtable.com/v0";
    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // Look up the user by email (case-insensitive).
    const safeEmail = email.replace(/'/g, "\\'");
    const qs = new URLSearchParams({ filterByFormula: `LOWER({Email})='${safeEmail}'`, pageSize: "1" });
    let rec, f;
    try {
      const res = await doFetch(`${AT}/${baseId}/${encodeURIComponent(USERS_TABLE)}?${qs.toString()}`, { headers: authHeaders });
      if (!res.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not reach the user directory." }) };
      const data = await res.json();
      rec = data.records && data.records[0];
      f = (rec && rec.fields) || {};
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "User lookup failed: " + e.message }) };
    }

    // Same generic message whether the email exists or the password is wrong.
    if (!rec || f.Active === false || !verifyPassword(password, f.Salt, f.Hash)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Wrong email or password." }) };
    }

    const user = {
      email,
      name: f.Name || email,
      role: String(f.Role || "director").toLowerCase().trim(),   // leader | country | director
      country: f.Country || null,
      department: f.Department || null,
    };
    const jwt = signToken(user, secret);
    return { statusCode: 200, headers, body: JSON.stringify({ enabled: true, token: jwt, user }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action "${body.action}".` }) };
};
