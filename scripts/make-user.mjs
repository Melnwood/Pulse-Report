#!/usr/bin/env node
// Generates the Salt + Hash for a new user's password, so you can add them to
// the "Users" table in Airtable. Run:
//
//   node scripts/make-user.mjs "somePassword"
//
// Then create a row in the Users table with:
//   Email, Name, Role (leader|country|director), Country, Department (directors),
//   Active (checkbox, on), and paste the Salt + Hash printed below.
//
// The plain password is never stored — only the salt + hash.
import crypto from "crypto";

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/make-user.mjs "<password>"');
  process.exit(1);
}
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");

console.log("\nPaste these into the user's Airtable row:\n");
console.log("Salt:", salt);
console.log("Hash:", hash);
console.log("\n(Do not store the plain password anywhere.)\n");
