// One-off reskin: map the old "orange/navy" hardcoded hex values across App.jsx
// and src/components to the Warm & Human palette. Auditable + reversible (git).
// Runs a case-insensitive, exact-hex replacement. White (#FFFFFF/#FFF) untouched.
import { readFileSync, writeFileSync } from "fs";

// old (UPPERCASE) -> new
const MAP = {
  // ── Navy family (retired) → warm ink / deep accent / warm tints ──
  "#1E1B3A": "#2C2621", "#1B1533": "#2C2621", "#3B3882": "#B96524",
  "#1E3A8A": "#B96524", "#C8C4E8": "#F0DFCE", "#F1EFF9": "#FDFAF4",
  "#FAF9FE": "#FDFAF4", "#0F172A": "#F6F1E8",
  // ── Orange → soft amber accent ──
  "#DC5A12": "#E0863C", "#B84A0E": "#B96524", "#E8834A": "#E0863C",
  "#FFA766": "#E0A56F", "#FFD9BE": "#F5DCC4", "#FFF4EC": "#FBEFE4",
  "#FFEBDA": "#F7E7D5", "#FFF1E6": "#FBEFE4", "#FFF9F3": "#FDFAF4",
  "#FBF0E6": "#FDFAF4", "#F3E6D6": "#FDFAF4", "#FBEEE3": "#FBEFE4",
  // ── Page backgrounds (creams) → #F6F1E8 ──
  "#FAF6F0": "#F6F1E8", "#FBF7F2": "#F6F1E8", "#F8F7F4": "#F6F1E8",
  "#FAFAF8": "#F6F1E8", "#F7F2EA": "#F6F1E8", "#F8F8F8": "#F6F1E8",
  "#F9FAFB": "#F6F1E8", "#F3F4F6": "#F6F1E8",
  // ── Warm inset panels → #FDFAF4 ──
  "#F5EFE6": "#FDFAF4", "#F2E7DB": "#FDFAF4", "#F3EBE1": "#F4ECDD",
  "#EFF6FF": "#FDFAF4",
  // ── Text neutrals ──
  "#9C8F82": "#7A6F63", "#8C7D70": "#7A6F63", "#7A6E62": "#7A6F63",
  "#8A7A6B": "#7A6F63", "#8A7E71": "#7A6F63", "#6B7280": "#7A6F63",
  "#A99C8E": "#A89C8D", "#B7A896": "#A89C8D", "#B4A897": "#A89C8D",
  "#C9BCAF": "#A89C8D", "#9CA3AF": "#A89C8D",
  "#2A211C": "#2C2621", "#332E29": "#2C2621", "#374151": "#2C2621",
  "#5C5048": "#5A4A3B", "#5C5049": "#5A4A3B", "#4B5563": "#5A4A3B",
  // ── Lines / borders ──
  "#EDE3D6": "#ECE2D2", "#EFE3D6": "#ECE2D2", "#E7DDD2": "#ECE2D2",
  "#E7DBCB": "#ECE2D2", "#E8D9CA": "#ECE2D2", "#E5E7EB": "#ECE2D2",
  "#E0D4C4": "#E2D3C2",
  // ── Status: Concern (red → terracotta) ──
  "#BE3B2E": "#BE6650", "#C0392B": "#BE6650", "#B91C1C": "#BE6650",
  "#E24B4A": "#BE6650", "#991B1B": "#A34D3B", "#7B2D3E": "#A34D3B",
  "#E87F7F": "#D89080", "#FCA5A5": "#E2B3A8", "#F2C4CE": "#EBD0C8",
  "#FBE9E6": "#F6E5DE", "#FEF2F2": "#F6E5DE", "#FDF2F2": "#F6E5DE",
  "#EEC7C1": "#E4C4BA",
  // ── Status: Watch (amber) ──
  "#A96A12": "#C08636", "#B45309": "#C08636", "#D68910": "#C08636",
  "#854F0B": "#9A6B26", "#92400E": "#9A6B26", "#8A5A2B": "#9A6B26",
  "#FBF0DC": "#F7EEDC", "#FFFBEB": "#F7EEDC", "#FFF8E1": "#F7EEDC",
  "#FAEEDA": "#F7EEDC", "#F0DCC9": "#F7EEDC", "#FCD34D": "#E3B85C",
  "#EAD5AC": "#E2CDA0",
  // ── Status: Healthy (green → sage) ──
  "#1F7A44": "#5C9A6D", "#1E8449": "#5C9A6D", "#2E7D32": "#5C9A6D",
  "#639922": "#5C9A6D", "#166534": "#3E7A50", "#5DBB8A": "#7FB894",
  "#86EFAC": "#AFD8BB", "#A5D6A7": "#AFD8BB",
  "#E7F3EC": "#E9F1E9", "#F0FDF4": "#E9F1E9", "#F5FBF6": "#E9F1E9",
  "#E6F6EC": "#E9F1E9", "#E8F5E9": "#E9F1E9", "#BFE0CC": "#C3DCC8",
};

const files = process.argv.slice(2);
let grand = 0;
for (const file of files) {
  let src = readFileSync(file, "utf8");
  let n = 0;
  for (const [oldHex, newHex] of Object.entries(MAP)) {
    const re = new RegExp(oldHex.replace("#", "#"), "gi");
    src = src.replace(re, (m) => { if (m.toUpperCase() === oldHex) { n++; return newHex; } return m; });
  }
  writeFileSync(file, src);
  console.log(`${file}: ${n} replacements`);
  grand += n;
}
console.log(`TOTAL: ${grand}`);
