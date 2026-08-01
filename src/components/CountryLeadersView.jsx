import { useState, useEffect } from "react";
import { useIsMobile, navBtn, FONT_DISPLAY } from "../theme";
import { listUsers, saveUser } from "../authClient";

// People & Culture settings — the Country Leaders directory.
// One row per country with an editable Name + Email. Rows are backed by the
// Users table (role = country), so saving here also creates/updates that
// person's login account: they set their own password on first sign-in.
// Only P&C leadership reaches this screen (routed behind isAdmin).
export default function CountryLeadersView({ setView, countries = [], onChanged }) {
  const isMobile = useIsMobile();
  const [rows, setRows] = useState(null);      // [{country, id?, name, email, dirty, saving, err, savedAt}]
  const [loadErr, setLoadErr] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const users = await listUsers();
        if (!alive) return;
        const leaders = users.filter(u => u.role === "country");
        const byCountry = {};
        leaders.forEach(u => { byCountry[String(u.country || "").toLowerCase()] = u; });
        // Every country with a run gets a row, plus any country that already has
        // a leader account we didn't infer from runs.
        const names = [...new Set([
          ...countries,
          ...leaders.map(u => u.country).filter(Boolean),
        ])].sort();
        setRows(names.map(c => {
          const u = byCountry[c.toLowerCase()];
          return { country: c, id: u?.id || null, name: u?.name || "", email: u?.email || "",
            dirty: false, saving: false, err: null, savedAt: null };
        }));
      } catch (e) {
        if (alive) { setLoadErr(e.message); setRows([]); }
      }
    })();
    return () => { alive = false; };
  }, [countries.join("|")]); // eslint-disable-line

  const setRow = (i, patch) => setRows(prev => prev.map((r, ri) => ri === i ? { ...r, ...patch } : r));

  const save = async (i) => {
    const r = rows[i];
    if (!r.name.trim() || !r.email.trim()) { setRow(i, { err: "Name and email are both needed." }); return; }
    setRow(i, { saving: true, err: null });
    try {
      const saved = await saveUser({ id: r.id || undefined, name: r.name.trim(), email: r.email.trim(),
        role: "country", country: r.country, active: true });
      setRow(i, { saving: false, dirty: false, id: saved?.id || r.id, savedAt: new Date() });
      if (onChanged) onChanged();
    } catch (e) {
      setRow(i, { saving: false, err: e.message });
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#F6F1E8", fontFamily: "'Inter',system-ui,sans-serif", padding: isMobile ? "20px 14px" : "28px 20px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <button onClick={() => setView("__back__")} style={{ ...navBtn, background: "transparent", border: "1px solid #ECE2D2" }}>← Back</button>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 600, color: "#2C2621" }}>Country leaders</div>
        </div>
        <div style={{ fontSize: 13, color: "#7A6F63", lineHeight: 1.55, marginBottom: 18 }}>
          Who leads each country. The name personalizes that country's report ("David, here's your
          Poland report…") and attributes their shared notes; the email is their sign-in. Saving a
          new person creates their account — they choose a password the first time they sign in.
        </div>
        {loadErr && <div style={{ color: "#BE6650", fontSize: 13, marginBottom: 12 }}>Couldn't load the directory: {loadErr}</div>}
        {rows === null ? (
          <div style={{ color: "#7A6F63", fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 && !loadErr ? (
          <div style={{ color: "#7A6F63", fontSize: 13 }}>No countries yet — upload a survey run first.</div>
        ) : (
          <div style={{ background: "#FFFFFF", border: "1px solid #ECE2D2", borderRadius: 14, overflow: "hidden",
            boxShadow: "0 1px 2px rgba(58,38,22,.06), 0 6px 22px -8px rgba(58,38,22,.10)" }}>
            {!isMobile && (
              <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1.2fr 120px", gap: 10, padding: "10px 16px",
                background: "#FBEFE4", fontSize: 11, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: 1 }}>
                <span>Country</span><span>Name</span><span>Email</span><span></span>
              </div>
            )}
            {rows.map((r, i) => (
              <div key={r.country} style={{ display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "140px 1fr 1.2fr 120px",
                gap: 10, alignItems: "center", padding: "12px 16px", borderTop: "1px solid #FBEFE4" }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: "#2C2621" }}>{r.country}</div>
                <input value={r.name} placeholder="Full name"
                  onChange={e => setRow(i, { name: e.target.value, dirty: true })}
                  style={{ fontSize: 13, padding: "8px 10px", border: "1px solid #E2D3C2", borderRadius: 8, fontFamily: "inherit" }} />
                <input value={r.email} placeholder="email@josiahventure.com" type="email"
                  onChange={e => setRow(i, { email: e.target.value, dirty: true })}
                  style={{ fontSize: 13, padding: "8px 10px", border: "1px solid #E2D3C2", borderRadius: 8, fontFamily: "inherit" }} />
                <div style={{ textAlign: isMobile ? "left" : "right" }}>
                  {r.dirty || r.err ? (
                    <button onClick={() => save(i)} disabled={r.saving}
                      style={{ ...navBtn, background: r.saving ? "#ECE2D2" : "#E0863C", color: r.saving ? "#7A6F63" : "#fff" }}>
                      {r.saving ? "Saving…" : "Save"}
                    </button>
                  ) : r.savedAt ? (
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#5C9A6D" }}>✓ Saved</span>
                  ) : r.id ? (
                    <span style={{ fontSize: 11, color: "#A89C8D" }}>On file</span>
                  ) : (
                    <span style={{ fontSize: 11, color: "#A89C8D", fontStyle: "italic" }}>Not set</span>
                  )}
                </div>
                {r.err && <div style={{ gridColumn: "1 / -1", color: "#BE6650", fontSize: 12 }}>{r.err}</div>}
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 12, color: "#A89C8D", marginTop: 14, lineHeight: 1.5 }}>
          Need finer control (roles, directors, deactivating accounts)? Use <b>Manage people</b> in the Leadership section.
        </div>
      </div>
    </div>
  );
}
