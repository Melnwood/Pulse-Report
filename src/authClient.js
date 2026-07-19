// Client side of auth: talk to the /.netlify/functions/auth endpoint, keep the
// session token + current user in localStorage, and expose helpers the app uses
// to gate itself. The server is the source of truth — these are conveniences.
const TOKEN_KEY = "pulse:token";
const USER_KEY = "pulse:user";

async function post(payload) {
  const res = await fetch("/.netlify/functions/auth", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// Is login switched on yet? Fails OPEN (returns disabled) so a network hiccup or
// unconfigured deploy never locks anyone out.
export async function authStatus() {
  try {
    const { ok, data } = await post({ action: "status" });
    return { enabled: !!(ok && data.enabled) };
  } catch { return { enabled: false }; }
}

// Returns the signed-in user, OR { needsPassword:true, email } when the account
// exists but hasn't set a password yet (the caller shows the create-password step).
export async function login(email, password) {
  const { ok, data } = await post({ action: "login", email, password });
  if (data && data.needsPassword) return { needsPassword: true, email: data.email || email };
  if (!ok || !data.token) throw new Error(data.error || "Login failed. Please try again.");
  try {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  } catch {}
  return data.user;
}

// First-time setup: the person chooses their own password. Signs them in on success.
export async function setPassword(email, password) {
  const { ok, data } = await post({ action: "setPassword", email, password });
  if (!ok || !data.token) throw new Error(data.error || "Couldn't set your password.");
  try {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  } catch {}
  return data.user;
}

// ── Leader-only user management (server verifies the caller is a leader) ──
async function authed(payload) {
  const token = getToken();
  const res = await fetch("/.netlify/functions/auth", {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}
export async function listUsers() { return (await authed({ action: "listUsers" })).users || []; }
export async function saveUser(user) { return (await authed({ action: "saveUser", user })).user; }
export async function deleteUser(id) { return authed({ action: "deleteUser", id }); }
export async function resetPassword(id) { return authed({ action: "resetPassword", id }); }

export function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function getUser() { try { const u = localStorage.getItem(USER_KEY); return u ? JSON.parse(u) : null; } catch { return null; } }
export function logout() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch {} }

// True if we hold a token that hasn't expired. (Signature is still verified
// server-side on every request — this just avoids showing a stale session.)
export function tokenValid() {
  const t = getToken();
  if (!t) return false;
  try {
    const payload = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return !payload.exp || payload.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
