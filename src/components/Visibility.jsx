// Per-note visibility UI. Every note carries its OWN visibility, defaulting to
// Private. Two levels:
//   Private = only the author + P&C leadership (Mel & Chris)
//   Shared  = the whole team + country leadership
// The stored value stays "Private"/"Public" (unchanged in Airtable); the UI just
// labels "Public" as "Shared" and spells out the audience so it's clear each note
// is an independent choice. There is no login, so this is a soft visibility signal.
export const VIS_SHARED = "Public";
export const visLabel = (v) => (v === VIS_SHARED ? "Shared" : "Private");
export const visAudience = (v) => (v === VIS_SHARED
  ? "the whole team & country leadership can see this note"
  : "only you & P&C leadership (Mel & Chris) can see this note");

// Segmented Private/Shared picker for the composer — sets the note being written.
export function VisibilityPicker({ value, onChange, isMobile }) {
  const shared = value === VIS_SHARED;
  const btn = (active, bg) => ({ fontSize:12, fontWeight:600,
    padding: isMobile ? "9px 14px" : "5px 12px", border:"none", cursor:"pointer",
    background: active ? bg : "transparent", color: active ? "#fff" : "#8A7A6B" });
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
      <span style={{ fontSize:12, color:"#7A6E62" }}>This note:</span>
      <div style={{ display:"inline-flex", border:"1px solid #E2D3C2", borderRadius:8, overflow:"hidden" }}>
        <button type="button" onClick={() => onChange("Private")} style={btn(!shared, "#5A4A3B")}>🔒 Private</button>
        <button type="button" onClick={() => onChange(VIS_SHARED)} style={{ ...btn(shared, "#2E7D32"), borderLeft:"1px solid #E2D3C2" }}>👁 Shared</button>
      </div>
      <span style={{ fontSize:11, color:"#9C8F82" }}>{visAudience(value)}</span>
    </div>
  );
}

// Clickable chip on a posted note — shows its current level, one tap to flip.
export function VisibilityChip({ visibility, onClick }) {
  const shared = visibility === VIS_SHARED;
  return (
    <button onClick={onClick} title={`${visAudience(visibility)} — click to change`}
      style={{ marginLeft:"auto", fontSize:10, fontWeight:700, cursor:"pointer",
        display:"inline-flex", alignItems:"center", gap:5, whiteSpace:"nowrap",
        color: shared ? "#2E7D32" : "#8A7A6B",
        background: shared ? "#E8F5E9" : "#F3ECE3",
        border:"1px solid " + (shared ? "#A5D6A7" : "#E2D3C2"), borderRadius:5, padding:"2px 8px" }}>
      {shared ? "👁 Shared" : "🔒 Private"}<span style={{ fontSize:8, fontWeight:600, opacity:.65 }}>▾ change</span>
    </button>
  );
}
