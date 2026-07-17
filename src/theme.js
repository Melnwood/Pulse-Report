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

// ── Status colors (Concern / Watch / Healthy) ────────────────────────────────
export const STATUS_COLOR  = { Concern:"#C0392B", Watch:"#D68910", Healthy:"#1E8449", null:"#9C8F82" };
export const STATUS_BG     = { Concern:"#FDF2F2", Watch:"#FFFBEB", Healthy:"#F0FDF4", null:"#FAFAF8" };
export const STATUS_BORDER = { Concern:"#FCA5A5", Watch:"#FCD34D", Healthy:"#86EFAC", null:"#E2E8F0" };
export const sc  = s => STATUS_COLOR[s]  || STATUS_COLOR[null];
export const sb  = s => STATUS_BG[s]     || STATUS_BG[null];
export const sbd = s => STATUS_BORDER[s] || STATUS_BORDER[null];

// ── Shared style objects ─────────────────────────────────────────────────────
export const card = {
  background:"#FFFFFF", borderRadius:12, padding:24,
  border:"1px solid #F5E4D5",
  boxShadow:"0 1px 4px rgba(124,111,224,0.07)",
};
export const navBtn = {
  background:"#FFEBDA", border:"none", borderRadius:8,
  color:"#1E1B3A", padding:"8px 16px", fontSize:13, fontWeight:600,
  cursor:"pointer",
};
export const lbl = { display:"block", fontSize:11, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:1, marginBottom:6 };
export const inp = { width:"100%", background:"#F8F7F4", border:"1px solid #F5E4D5", borderRadius:8, padding:"10px 14px", color:"#1E1B3A", fontSize:14, boxSizing:"border-box" };
