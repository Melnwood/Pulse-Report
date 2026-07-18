// Login endpoint. Verifies an email + password against the "Users" table in
// Airtable and returns a signed session token carrying the user's role, country
// and department. Also exposes a "status" action so the client can tell whether
// auth is switched on yet (it is only once AUTH_SECRET is set) — this keeps the
// app open until you deliberately configure it, so a half-built rollout can't
// lock anyone out.
const { verifyPassword, signToken, hashPassword, verifyToken } = require("./authlib");

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

    // Departments is a multi-select (array of dept codes); the old Department
    // text field is a fallback. Normalize either to a comma-joined string, which
    // is what the client and the airtable proxy both parse.
    const deptRaw = (f.Departments !== undefined && f.Departments !== null) ? f.Departments : f.Department;
    const department = Array.isArray(deptRaw) ? deptRaw.join(",") : (deptRaw || null);
    const user = {
      id: rec.id,
      email,
      name: f.Name || email,
      role: String(f.Role || "director").toLowerCase().trim(),   // leader | country | director
      country: f.Country || null,
      department,
    };
    const jwt = signToken(user, secret);
    return { statusCode: 200, headers, body: JSON.stringify({ enabled: true, token: jwt, user }) };
  }

  // ── Leader-only user management: listUsers / saveUser / deleteUser ──
  if (["listUsers", "saveUser", "deleteUser"].includes(body.action)) {
    if (!secret) return { statusCode: 400, headers, body: JSON.stringify({ error: "Login isn't configured yet." }) };
    const authz = event.headers.authorization || event.headers.Authorization || "";
    const requester = verifyToken(authz.replace(/^Bearer\s+/i, "").trim(), secret);
    if (!requester || requester.role !== "leader") {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Only P&C leaders can manage accounts." }) };
    }
    const token = process.env.AIRTABLE_TOKEN;
    if (!token) return { statusCode: 500, headers, body: JSON.stringify({ error: "AIRTABLE_TOKEN is not set." }) };
    const baseId = process.env.AIRTABLE_BASE_ID || BASE_ID_FALLBACK;
    const doFetch = (typeof fetch !== "undefined") ? fetch : (await import("node-fetch")).default;
    const AT = "https://api.airtable.com/v0";
    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const T = `${AT}/${baseId}/${encodeURIComponent(USERS_TABLE)}`;
    const deptToStr = (f) => {
      const d = (f.Departments !== undefined && f.Departments !== null) ? f.Departments : f.Department;
      return Array.isArray(d) ? d.join(",") : (d || "");
    };
    const sanitize = (r) => ({ id: r.id, email: r.fields.Email || "", name: r.fields.Name || "",
      role: String(r.fields.Role || "director").toLowerCase(), country: r.fields.Country || "",
      department: deptToStr(r.fields), active: r.fields.Active !== false });

    try {
      if (body.action === "listUsers") {
        const res = await doFetch(`${T}?pageSize=200`, { headers: authHeaders });
        const data = JSON.parse(await res.text());
        if (!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: "Could not list users." }) };
        const users = (data.records || []).map(sanitize).sort((a, b) => (a.country || "").localeCompare(b.country || "") || a.name.localeCompare(b.name));
        return { statusCode: 200, headers, body: JSON.stringify({ users }) };
      }

      if (body.action === "saveUser") {
        const u = body.user || {};
        const email = String(u.email || "").trim().toLowerCase();
        const role = String(u.role || "director").toLowerCase().trim();
        if (!email || !u.name) return { statusCode: 400, headers, body: JSON.stringify({ error: "Name and email are required." }) };
        if (!["leader", "country", "director"].includes(role)) return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid role." }) };
        // Departments is a multi-select: accept an array or a comma string from
        // the client and write an array of dept codes (empty for non-directors).
        const deptArr = role === "director"
          ? (Array.isArray(u.department) ? u.department : String(u.department || "").split(",").map(s => s.trim()).filter(Boolean))
          : [];
        const fields = {
          Email: email, Name: String(u.name).trim(), Role: role,
          Country: u.country || "", Departments: deptArr,
          Active: u.active !== false,
        };
        if (u.password) { const { salt, hash } = hashPassword(String(u.password)); fields.Salt = salt; fields.Hash = hash; }

        if (u.id) {
          const res = await doFetch(T, { method: "PATCH", headers: authHeaders, body: JSON.stringify({ records: [{ id: u.id, fields }], typecast: true }) });
          const text = await res.text();
          if (!res.ok) return { statusCode: res.status, headers, body: text };
          return { statusCode: 200, headers, body: JSON.stringify({ user: sanitize(JSON.parse(text).records[0]) }) };
        }
        // create — reject duplicate email, and require a password on new accounts
        if (!u.password) return { statusCode: 400, headers, body: JSON.stringify({ error: "Set a password for the new account." }) };
        const dupRes = await doFetch(`${T}?filterByFormula=${encodeURIComponent(`LOWER({Email})='${email.replace(/'/g, "\\'")}'`)}&pageSize=1`, { headers: authHeaders });
        const dup = JSON.parse(await dupRes.text());
        if (dup.records && dup.records.length) return { statusCode: 409, headers, body: JSON.stringify({ error: "That email already has an account." }) };
        const res = await doFetch(T, { method: "POST", headers: authHeaders, body: JSON.stringify({ records: [{ fields }], typecast: true }) });
        const text = await res.text();
        if (!res.ok) return { statusCode: res.status, headers, body: text };
        return { statusCode: 200, headers, body: JSON.stringify({ user: sanitize(JSON.parse(text).records[0]) }) };
      }

      // deleteUser
      if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing id." }) };
      if (body.id === requester.id) return { statusCode: 400, headers, body: JSON.stringify({ error: "You can't delete your own account." }) };
      const res = await doFetch(`${T}?records[]=${encodeURIComponent(body.id)}`, { method: "DELETE", headers: authHeaders });
      if (!res.ok) return { statusCode: res.status, headers, body: await res.text() };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "User management failed: " + e.message }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action "${body.action}".` }) };
};
