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

// ── Palette — "Warm & Human" ──────────────────────────────────────────────────
// Warm cream grounds, a soft amber accent used for actions, and muted earth
// neutrals. The old orange/navy identity is retired. Fraunces carries display
// type (headings & scores); Inter carries body/UI. Keep this the single source
// of truth — screens should reference these tokens, not raw hex.
export const FONT_DISPLAY = "'Fraunces', Georgia, 'Times New Roman', serif";
export const FONT_BODY    = "'Inter', system-ui, sans-serif";

export const C = {
  paper:   "#F6F1E8",   // page background
  surface: "#FFFFFF",   // cards
  surface2:"#FDFAF4",   // warm inset panel
  ink:     "#2C2621",   // primary text / headings
  inkSoft: "#5A4A3B",   // secondary text
  muted:   "#7A6F63",   // soft labels
  faint:   "#A89C8D",   // faint captions
  line:    "#ECE2D2",   // hairlines
  line2:   "#E2D3C2",   // stronger borders
  accent:  "#E0863C",   // amber — actions only
  accentInk:"#B96524",  // deep amber — accent text / hover
  accentWash:"#FBEFE4", // faint accent tint
  shadow:  "0 1px 2px rgba(58,38,22,.05), 0 6px 22px -10px rgba(58,38,22,.12)",
};

// ── Status colors (Concern / Watch / Healthy) — sage / amber / terracotta ─────
export const STATUS_COLOR  = { Concern:"#BE6650", Watch:"#C08636", Healthy:"#5C9A6D", null:"#7A6F63" };
export const STATUS_BG     = { Concern:"#F6E5DE", Watch:"#F7EEDC", Healthy:"#E9F1E9", null:"#FDFAF4" };
export const STATUS_BORDER = { Concern:"#E4C4BA", Watch:"#E2CDA0", Healthy:"#C3DCC8", null:"#E2D3C2" };
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
