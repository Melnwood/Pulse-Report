import { useState } from "react";

// A collapsible section — the building block of the nested review. Shows a
// title, an optional status dot, and a count so you know what's inside before
// opening it. Progressive disclosure keeps the whole department on one screen.
export default function Disclosure({ title, count, dot, defaultOpen, flush, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  // The body is always in the DOM (hidden with display:none when closed) rather
  // than conditionally rendered, so print styles can force every section open —
  // the Report page prints to PDF and must never drop collapsed content. See the
  // `@media print { .pulse-disc-body ... }` rule in ReportView.
  return (
    <div className="pulse-disc" style={{ borderTop:"1px solid #ECE2D2" }}>
      <button className="pulse-disc-head" onClick={() => setOpen(o => !o)}
        style={{ width:"100%", display:"flex", alignItems:"center", gap:9, padding:"11px 14px",
          background: open ? "#FDFBF7" : "transparent", border:"none", cursor:"pointer",
          textAlign:"left", fontFamily:"inherit" }}>
        <svg className="pulse-disc-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#A89C8D"
          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink:0, transition:"transform .15s", transform: open ? "rotate(90deg)" : "none" }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
        {dot && <span style={{ width:8, height:8, borderRadius:"50%", background:dot, flexShrink:0 }} />}
        <span style={{ fontSize:13, fontWeight:700, color:"#2C2621" }}>{title}</span>
        {count != null && <span style={{ marginLeft:"auto", fontSize:11, color:"#7A6F63",
          fontVariantNumeric:"tabular-nums" }}>{count}</span>}
      </button>
      <div className="pulse-disc-body" style={{ display: open ? "block" : "none",
        padding: flush ? "0 0 10px" : "2px 14px 14px" }}>{children}</div>
    </div>
  );
}
