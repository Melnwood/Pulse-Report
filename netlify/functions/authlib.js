// Shared auth helpers for the serverless functions: password hashing (PBKDF2,
// built into Node — no dependency) and signed session tokens (HMAC-SHA256 JWTs,
// also built-in). Used by auth.js (login) and airtable.js (verify + scope).
const crypto = require("crypto");

const ITER = 120000, KEYLEN = 32, DIGEST = "sha256";

// Hash a password with a per-user salt. Returns { salt, hash } (both hex).
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, ITER, KEYLEN, DIGEST).toString("hex");
  return { salt, hash };
}

// Constant-time verify.
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.pbkdf2Sync(String(password), salt, ITER, KEYLEN, DIGEST).toString("hex");
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64urlJSON = (obj) => b64url(JSON.stringify(obj));

// Sign a session token. Default 12h expiry.
function signToken(payload, secret, ttlSec = 60 * 60 * 12) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const data = `${b64urlJSON(header)}.${b64urlJSON(body)}`;
  const sig = b64url(crypto.createHmac("sha256", secret).update(data).digest());
  return `${data}.${sig}`;
}

// Verify a token; returns the payload or null (bad signature / expired / malformed).
function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = b64url(crypto.createHmac("sha256", secret).update(data).digest());
  const a = Buffer.from(expected), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()); }
  catch { return null; }
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
