import { useState } from "react";
import { saveMeasure } from "../airtable";
import { C, sc, FONT_DISPLAY } from "../theme";

const DEFAULT_TARGET = 3.5;
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const fmtDate = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}); } catch { return iso; } };

// Behavioural-change tracking for one survey question, threaded across runs.
// Directors set a target + the behaviour they want to change, then log
// interventions (what they did) and checks (follow-up readings). View-only for
// country leaders. `measure` is the loaded record (or null if none yet).
export default function MeasurePanel({ country, deptKey, question, currentScore, author, canEdit, measure, onSaved }) {
  const [open, setOpen] = useState(false);
  const [m, setM] = useState(measure);            // local working copy
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // draft rows for the two logs
  const [iv, setIv] = useState({ date: today(), action: "" });
  const [ck, setCk] = useState({ date: today(), value: "", source: "Observation" });

  const baseline = m?.baseline ?? num(currentScore);
  const target = m?.target ?? DEFAULT_TARGET;
  const checks = m?.checks || [];
  const latest = checks.length ? num(checks[checks.length - 1].value) : baseline;
  const span = (target != null && baseline != null) ? (target - baseline) : null;
  const pct = (span && span !== 0 && latest != null)
    ? Math.max(0, Math.min(100, ((latest - baseline) / span) * 100)) : 0;

  const persist = async (patch) => {
    setBusy(true); setErr("");
    try {
      const base = m || { country, deptKey, question, baseline, target: DEFAULT_TARGET, behavior: "",
        interventions: [], checks: [], status: "Open", author };
      const saved = await saveMeasure({ ...base, ...patch });
      setM(saved); onSaved?.(saved);
      return saved;
    } catch (e) { setErr("Couldn't save: " + e.message); }
    finally { setBusy(false); }
  };

  const start = () => persist({});                                   // create with baseline+default target
  const addIntervention = async () => {
    if (!iv.action.trim()) return;
    await persist({ interventions: [...(m?.interventions || []), { date: iv.date, action: iv.action.trim() }] });
    setIv({ date: today(), action: "" });
  };
  const addCheck = async () => {
    if (num(ck.value) == null) return;
    await persist({ checks: [...(m?.checks || []), { date: ck.date, value: num(ck.value), source: ck.source }] });
    setCk({ date: today(), value: "", source: "Observation" });
  };

  const chipBg = m ? (m.status === "Achieved" ? "#E9F1E9" : m.status === "Paused" ? C.surface2 : "#FBEFE4") : "transparent";
  const chipCol = m ? (m.status === "Achieved" ? "#5C9A6D" : m.status === "Paused" ? C.muted : C.accentInk) : C.muted;

  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 600,
          color: m ? C.accentInk : C.muted, background: m ? "#FBEFE4" : C.surface2,
          border: `0.5px solid ${m ? "#E0A56F" : C.line2}`, borderRadius: 5, padding: "3px 9px", cursor: "pointer" }}>
        <span style={{ fontSize: 12 }}>◑</span>
        {m ? `Tracking · ${latest ?? "–"}→${target}` : "Track change"}
      </button>

      {open && (
        <div style={{ marginTop: 8, background: C.surface2, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12 }}>
          {!m ? (
            <div>
              <div style={{ fontSize: 12.5, color: C.inkSoft, lineHeight: 1.5, marginBottom: 10 }}>
                Track behaviour change on this question. We’ll set the baseline to the current score
                ({baseline ?? "–"}) and a target of {DEFAULT_TARGET}.
              </div>
              {canEdit ? (
                <button onClick={start} disabled={busy}
                  style={{ background: C.accent, color: "#fff", border: "none", borderRadius: 8,
                    padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: busy ? "wait" : "pointer" }}>
                  {busy ? "Starting…" : "Start tracking"}
                </button>
              ) : <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>No measure set yet.</div>}
              {err && <div style={{ color: "#BE6650", fontSize: 12, marginTop: 8 }}>{err}</div>}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Progress */}
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 600, color: sc(latest >= target ? "Healthy" : latest > baseline ? "Watch" : "Concern") }}>
                    {latest ?? "–"}
                  </span>
                  <span style={{ fontSize: 11, color: C.muted }}>now · baseline {baseline ?? "–"} · target {target}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: chipCol,
                    background: chipBg, borderRadius: 5, padding: "2px 8px" }}>{m.status}</span>
                </div>
                <div style={{ height: 7, background: "#EBDECB", borderRadius: 5, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: C.accent, borderRadius: 5, transition: "width .3s" }} />
                </div>
              </div>

              {/* Behaviour + target + status (editable) */}
              {canEdit ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <textarea value={m.behavior || ""} onChange={e => setM({ ...m, behavior: e.target.value })}
                    onBlur={() => persist({ behavior: m.behavior })} rows={2}
                    placeholder="The behaviour you’re working to change…"
                    style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: 8, border: `1px solid ${C.line2}`,
                      borderRadius: 8, resize: "vertical", fontFamily: "inherit", background: "#fff" }} />
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ fontSize: 11, color: C.muted }}>Target
                      <input type="number" step="0.1" min="1" max="5" value={m.target ?? DEFAULT_TARGET}
                        onChange={e => setM({ ...m, target: num(e.target.value) })} onBlur={() => persist({ target: m.target })}
                        style={{ width: 60, marginLeft: 6, fontSize: 13, padding: "5px 8px", border: `1px solid ${C.line2}`, borderRadius: 7 }} />
                    </label>
                    <label style={{ fontSize: 11, color: C.muted }}>Status
                      <select value={m.status} onChange={e => persist({ status: e.target.value })}
                        style={{ marginLeft: 6, fontSize: 13, padding: "5px 8px", border: `1px solid ${C.line2}`, borderRadius: 7, background: "#fff" }}>
                        <option>Open</option><option>Achieved</option><option>Paused</option>
                      </select>
                    </label>
                  </div>
                </div>
              ) : (
                m.behavior && <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.5 }}>{m.behavior}</div>
              )}

              {/* Interventions log */}
              <Log title="What we’re doing" items={m.interventions} empty="No actions logged yet."
                render={(x) => <><b style={{ fontWeight: 650 }}>{fmtDate(x.date)}</b> — {x.action}</>} />
              {canEdit && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <input type="date" value={iv.date} onChange={e => setIv({ ...iv, date: e.target.value })}
                    style={{ fontSize: 12, padding: "5px 8px", border: `1px solid ${C.line2}`, borderRadius: 7 }} />
                  <input value={iv.action} onChange={e => setIv({ ...iv, action: e.target.value })} placeholder="What did you do?"
                    style={{ flex: 1, minWidth: 140, fontSize: 12, padding: "5px 8px", border: `1px solid ${C.line2}`, borderRadius: 7 }} />
                  <button onClick={addIntervention} disabled={busy || !iv.action.trim()}
                    style={{ fontSize: 12, fontWeight: 600, color: "#fff", background: (busy || !iv.action.trim()) ? "#ECD9C2" : C.accent,
                      border: "none", borderRadius: 7, padding: "5px 12px", cursor: "pointer" }}>Add</button>
                </div>
              )}

              {/* Checks log */}
              <Log title="Progress checks" items={m.checks} empty="No follow-up readings yet."
                render={(x) => <><b style={{ fontWeight: 650 }}>{fmtDate(x.date)}</b> — {x.value} <span style={{ color: C.muted }}>· {x.source}</span></>} />
              {canEdit && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <input type="date" value={ck.date} onChange={e => setCk({ ...ck, date: e.target.value })}
                    style={{ fontSize: 12, padding: "5px 8px", border: `1px solid ${C.line2}`, borderRadius: 7 }} />
                  <input type="number" step="0.1" min="1" max="5" value={ck.value} onChange={e => setCk({ ...ck, value: e.target.value })} placeholder="score"
                    style={{ width: 70, fontSize: 12, padding: "5px 8px", border: `1px solid ${C.line2}`, borderRadius: 7 }} />
                  <select value={ck.source} onChange={e => setCk({ ...ck, source: e.target.value })}
                    style={{ fontSize: 12, padding: "5px 8px", border: `1px solid ${C.line2}`, borderRadius: 7, background: "#fff" }}>
                    <option>Observation</option><option>Pulse survey</option><option>Conversation</option><option>Team check-in</option>
                  </select>
                  <button onClick={addCheck} disabled={busy || num(ck.value) == null}
                    style={{ fontSize: 12, fontWeight: 600, color: "#fff", background: (busy || num(ck.value) == null) ? "#ECD9C2" : C.accent,
                      border: "none", borderRadius: 7, padding: "5px 12px", cursor: "pointer" }}>Log</button>
                </div>
              )}
              {err && <div style={{ color: "#BE6650", fontSize: 12 }}>{err}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Log({ title, items, empty, render }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>{title}</div>
      {(items || []).length === 0
        ? <div style={{ fontSize: 12, color: C.faint, fontStyle: "italic" }}>{empty}</div>
        : (items || []).map((x, i) => (
          <div key={i} style={{ fontSize: 12.5, color: C.inkSoft, lineHeight: 1.55, padding: "2px 0" }}>{render(x)}</div>
        ))}
    </div>
  );
}
