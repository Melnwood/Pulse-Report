import { useState, useEffect } from "react";
import { loadAllHelpVideos, saveHelpVideo, deleteHelpVideo } from "../airtable";
import { card, navBtn, lbl, inp, C } from "../theme";

// Where a video shows. Value must match the Section choices in the Help Videos
// table and the section keys the app renders against.
const SECTIONS = [
  { value: "How to use the app", label: "How to use the app — directors' How-to panel" },
  { value: "Overview",           label: "How scoring works — top (Overview)" },
  { value: "Two ways to measure",label: "How scoring works — under “Two ways to measure”" },
  { value: "Why it matters",     label: "How scoring works — under “Why it matters”" },
  { value: "Department status",  label: "How scoring works — under “Three things… status”" },
  { value: "Status thresholds",  label: "How scoring works — under “Status thresholds”" },
];
const sectionLabel = (v) => (SECTIONS.find(s => s.value === v)?.label) || v || "—";
const blank = { id: null, title: "", url: "", fileUrl: "", section: "How to use the app", description: "", order: "", active: true };

// Leaders-only screen to add / edit / remove instructional videos.
export default function VideosView({ setView }) {
  const [videos, setVideos] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => { try { setVideos(await loadAllHelpVideos()); } catch (e) { setErr(e.message); setVideos([]); } };
  useEffect(() => { load(); }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) { setErr("Give the video a title."); return; }
    if (!form.url.trim() && !form.fileUrl) { setErr("Paste a video link, or upload a file to this video's “Video File” column in Airtable."); return; }
    setBusy(true); setErr("");
    try { await saveHelpVideo(form); setForm(null); await load(); }
    catch (e2) { setErr(e2.message); }
    setBusy(false);
  };
  const remove = async (v) => {
    if (!window.confirm(`Remove "${v.title}"? This deletes the video from the app.`)) return;
    try { await deleteHelpVideo(v.id); await load(); } catch (e) { setErr(e.message); }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.paper, fontFamily: "'Inter',system-ui,sans-serif", padding: "28px 20px" }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
          <button onClick={() => setView("__back__")} style={{ ...navBtn }}>← Back</button>
          <span style={{ fontSize: 20, fontWeight: 750, color: C.ink }}>Help videos</span>
          <button onClick={() => { setErr(""); setForm({ ...blank }); }}
            style={{ ...navBtn, marginLeft: "auto", background: C.accent, color: "#fff", border: "1px solid transparent" }}>+ Add video</button>
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 18, lineHeight: 1.55 }}>
          Two ways to add a video: <b>paste a link</b> (YouTube unlisted / Vimeo / Loom) below, or <b>upload the file</b> — great for a phone recording — into the <b>“Video File”</b> column of the Help Videos table in Airtable. Either way, pick where it shows. <span style={{ color: C.faint }}>For phone videos, record in “Most Compatible” (H.264) so they play in every browser.</span>
        </div>

        {err && <div style={{ marginBottom: 14, fontSize: 13, color: "#BE6650", background: "#F6E5DE", border: "1px solid #E4C4BA", borderRadius: 8, padding: "8px 12px" }}>{err}</div>}

        {form && (
          <form onSubmit={submit} style={{ ...card, marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.accent, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 14 }}>
              {form.id ? "Edit video" : "Add video"}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div><label style={lbl}>Title</label><input style={inp} value={form.title} onChange={e => set("title", e.target.value)} placeholder="e.g. How to read your report" /></div>
              <div>
                <label style={lbl}>Video link (YouTube / Vimeo / Loom){form.fileUrl ? " — optional, a file is uploaded" : ""}</label>
                <input style={inp} value={form.url} onChange={e => set("url", e.target.value)} placeholder="https://youtu.be/…  (or leave blank and upload a file in Airtable)" />
                {form.fileUrl && !form.url && <div style={{ fontSize: 12, color: "#5C9A6D", marginTop: 4 }}>▶ An uploaded video file is attached in Airtable — it'll play in the app.</div>}
              </div>
              <div><label style={lbl}>Where it shows</label>
                <select style={inp} value={form.section} onChange={e => set("section", e.target.value)}>
                  {SECTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 12 }}>
                <div><label style={lbl}>Description (optional)</label><input style={inp} value={form.description} onChange={e => set("description", e.target.value)} placeholder="One line shown under the title" /></div>
                <div><label style={lbl}>Order</label><input style={inp} type="number" value={form.order} onChange={e => set("order", e.target.value)} placeholder="1" /></div>
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13, color: C.inkSoft }}>
              <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} /> Active (visible in the app)
            </label>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button type="submit" disabled={busy} style={{ ...navBtn, background: busy ? C.line : C.accent, color: busy ? C.muted : "#fff", border: "1px solid transparent" }}>{busy ? "Saving…" : "Save"}</button>
              <button type="button" onClick={() => setForm(null)} style={{ ...navBtn }}>Cancel</button>
            </div>
          </form>
        )}

        {videos === null ? (
          <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
        ) : videos.length === 0 ? (
          <div style={{ ...card, color: C.muted, fontSize: 14 }}>No videos yet. Click “+ Add video” to add your first one.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {videos.map(v => (
              <div key={v.id} style={{ ...card, display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 650, color: C.ink }}>{v.title || "(untitled)"} {!v.active && <span style={{ fontSize: 11, color: "#BE6650" }}>· hidden</span>}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{sectionLabel(v.section)}</div>
                </div>
                <button onClick={() => { setErr(""); setForm({ ...v, order: v.order ?? "" }); }} style={{ ...navBtn, fontSize: 12, padding: "6px 12px" }}>Edit</button>
                <button onClick={() => remove(v)} style={{ ...navBtn, fontSize: 12, padding: "6px 12px", color: "#BE6650", borderColor: "#E4C4BA" }}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
