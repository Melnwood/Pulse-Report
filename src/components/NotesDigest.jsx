import { useState } from "react";
import { loadDepartmentNotes, loadQuestionNotes } from "../airtable";
import { summarizeDeptNotes } from "../ai";
import { C, FONT_DISPLAY } from "../theme";
import { IconSparkle } from "./Icons";

// AI digest of a department's follow-up. Lazily loads the department + question
// notes on demand, applies visibility (only what this viewer may see — so a
// country leader's digest is built from public notes only), adds the staff open
// responses, and asks the model for a concise, practical summary.
export default function NotesDigest({ country, year, deptKey, deptLabel, me, isPCLead, openResponses = [] }) {
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState(null);
  const [err, setErr] = useState("");
  const [when, setWhen] = useState("");

  const canSee = (n) => n.visibility === "Public" || isPCLead || (me && n.author === me);

  const run = async () => {
    setBusy(true); setErr(""); setDigest(null);
    try {
      const [deptNotes, questionNotes] = await Promise.all([
        loadDepartmentNotes(country, year, deptKey).catch(() => []),
        loadQuestionNotes(country, year, deptKey).catch(() => []),
      ]);
      const res = await summarizeDeptNotes({
        country, year, deptLabel,
        deptNotes: deptNotes.filter(canSee),
        questionNotes: questionNotes.filter(canSee),
        openResponses,
      });
      setDigest(res.text);
      setWhen(new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    } catch (e) { setErr(e.message || "Couldn't build the digest."); }
    setBusy(false);
  };

  return (
    <div style={{ ...cardLite, marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 600, color: C.ink }}>Notes digest</span>
        <span style={{ fontSize: 12, color: C.muted }}>AI summary of the notes & responses you can see</span>
        <button onClick={run} disabled={busy}
          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6,
            background: busy ? C.line : C.accent, color: busy ? C.muted : "#fff", border: "none", borderRadius: 8,
            padding: "7px 13px", fontSize: 13, fontWeight: 600, cursor: busy ? "wait" : "pointer" }}>
          <IconSparkle size={14} /> {busy ? "Summarizing…" : digest ? "Refresh" : "Summarize"}
        </button>
      </div>
      {err && <div style={{ color: "#BE6650", fontSize: 12.5, marginTop: 10 }}>{err}</div>}
      {digest && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
          <Markdownish text={digest} />
          {when && <div style={{ fontSize: 11, color: C.faint, marginTop: 10 }}>Generated {when} · from the material visible to you</div>}
        </div>
      )}
    </div>
  );
}

const cardLite = {
  background: C.surface2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16,
};

// Tiny renderer for the model's light markdown: **bold** headers and "- " bullets.
function Markdownish({ text }) {
  const lines = String(text || "").split("\n");
  const out = [];
  let bullets = [];
  const flush = (key) => { if (bullets.length) { out.push(<ul key={"u" + key} style={{ margin: "2px 0 10px", paddingLeft: 18 }}>{bullets}</ul>); bullets = []; } };
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (!t) { flush(i); return; }
    if (/^[-*]\s+/.test(t)) {
      bullets.push(<li key={i} style={{ fontSize: 13, color: C.inkSoft, lineHeight: 1.55, marginBottom: 3 }}>{inline(t.replace(/^[-*]\s+/, ""))}</li>);
      return;
    }
    flush(i);
    const heading = /^\*\*(.+?)\*\*:?\s*$/.exec(t);
    if (heading) {
      out.push(<div key={i} style={{ fontSize: 11, fontWeight: 700, color: C.accentInk, textTransform: "uppercase", letterSpacing: 1, margin: "10px 0 4px" }}>{heading[1]}</div>);
    } else {
      out.push(<div key={i} style={{ fontSize: 13, color: C.inkSoft, lineHeight: 1.55, marginBottom: 6 }}>{inline(t)}</div>);
    }
  });
  flush("end");
  return <div>{out}</div>;
}

// Bold inline **spans**.
function inline(s) {
  const parts = String(s).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(p);
    return m ? <b key={i} style={{ color: C.ink }}>{m[1]}</b> : <span key={i}>{p}</span>;
  });
}
