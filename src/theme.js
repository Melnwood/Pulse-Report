// Design tokens + shared styles for the JV Pulse Report app.
// Single source of truth for the responsive hook, status colors, and the
// reused style objects. Extracted from App.jsx (values unchanged) so screens
// stay consistent and we have one place to evolve the look.
import { useState, useEffect } from "react";

// ── Responsive hook ──────────────────────────────────────────────────────────
export function useIsMobile(breakpoint = 700) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= breakpoint : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

// ── Palette ───────────────────────────────────────────────────────────────────
// Warm neutrals with a faint orange bias (chosen, not inherited grey) plus one
// accent used for actions only. The design direction from the audit.
export const C = {
  paper:   "#FAF6F0",
  surface: "#FFFFFF",
  surface2:"#F5EFE6",
  ink:     "#2A211C",
  inkSoft: "#5C5049",
  muted:   "#8C7D70",
  line:    "#EDE3D6",
  line2:   "#E0D4C4",
  accent:  "#DC5A12",   // JV orange, deepened for legible UI
  accentInk:"#B84A0E",
  accentWash:"#FBEEE3",
  shadow:  "0 1px 2px rgba(58,38,22,.06), 0 6px 22px -8px rgba(58,38,22,.10)",
};

// ── Status colors (Concern / Watch / Healthy) ────────────────────────────────
export const STATUS_COLOR  = { Concern:"#BE3B2E", Watch:"#A96A12", Healthy:"#1F7A44", null:"#8C7D70" };
export const STATUS_BG     = { Concern:"#FBE9E6", Watch:"#FBF0DC", Healthy:"#E7F3EC", null:"#F5EFE6" };
export const STATUS_BORDER = { Concern:"#EEC7C1", Watch:"#EAD5AC", Healthy:"#BFE0CC", null:"#E0D4C4" };
export const sc  = s => STATUS_COLOR[s]  || STATUS_COLOR[null];
export const sb  = s => STATUS_BG[s]     || STATUS_BG[null];
export const sbd = s => STATUS_BORDER[s] || STATUS_BORDER[null];

// ── Shared style objects ─────────────────────────────────────────────────────
export const card = {
  background:"#FFFFFF", borderRadius:12, padding:24,
  border:`1px solid ${C.line}`,
  boxShadow: C.shadow,
};
// The default button is a quiet SECONDARY — white with a border. Primary actions
// override the background with the accent so the one real action stands out.
export const navBtn = {
  background:"#FFFFFF", border:`1px solid ${C.line2}`, borderRadius:8,
  color: C.ink, padding:"8px 16px", fontSize:13, fontWeight:600,
  cursor:"pointer",
};
export const primaryBtn = {
  background: C.accent, border:"1px solid transparent", borderRadius:8,
  color:"#fff", padding:"8px 16px", fontSize:13, fontWeight:600, cursor:"pointer",
};
export const ghostBtn = {
  background:"transparent", border:"1px solid transparent", borderRadius:8,
  color: C.inkSoft, padding:"8px 16px", fontSize:13, fontWeight:600, cursor:"pointer",
};
export const lbl = { display:"block", fontSize:11, fontWeight:700, color: C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 };
export const inp = { width:"100%", background:"#FFFFFF", border:`1px solid ${C.line2}`, borderRadius:8, padding:"10px 14px", color: C.ink, fontSize:14, boxSizing:"border-box" };
