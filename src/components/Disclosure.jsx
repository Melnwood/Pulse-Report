import { useState } from "react";

// A collapsible section — the building block of the nested review. Shows a
// title, an optional status dot, and a count so you know what's inside before
// opening it. Progressive disclosure keeps the whole department on one screen.
export default function Disclosure({ title, count, dot, defaultOpen, flush, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ borderTop:"1px solid #EDE3D6" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width:"100%", display:"flex", alignItems:"center", gap:9, padding:"11px 14px",
          background: open ? "#FDFBF7" : "transparent", border:"none", cursor:"pointer",
          textAlign:"left", fontFamily:"inherit" }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#B7A896"
          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink:0, transition:"transform .15s", transform: open ? "rotate(90deg)" : "none" }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
        {dot && <span style={{ width:8, height:8, borderRadius:"50%", background:dot, flexShrink:0 }} />}
        <span style={{ fontSize:13, fontWeight:700, color:"#2A211C" }}>{title}</span>
        {count != null && <span style={{ marginLeft:"auto", fontSize:11, color:"#8C7D70",
          fontVariantNumeric:"tabular-nums" }}>{count}</span>}
      </button>
      {open && <div style={{ padding: flush ? "0 0 10px" : "2px 14px 14px" }}>{children}</div>}
    </div>
  );
}
