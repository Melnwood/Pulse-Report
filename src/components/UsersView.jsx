import { useState, useEffect } from "react";
import { listUsers, saveUser, deleteUser } from "../authClient";
import { card, navBtn, lbl, inp } from "../theme";

const ROLES = [
  { value: "director", label: "Director — edits their department" },
  { value: "country",  label: "Country leader — views their country" },
  { value: "leader",   label: "P&C leader — full access" },
];
const blank = { id: null, name: "", email: "", role: "director", country: "", department: "", password: "", active: true };

// Leaders-only screen to add / edit / remove accounts.
export default function UsersView({ setView, me }) {
  const [users, setUsers] = useState(null);
  const [form, setForm] = useState(null);   // the user being added/edited, or null
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => { try { setUsers(await listUsers()); } catch (e) { setErr(e.message); setUsers([]); } };
  useEffect(() => { load(); }, []);

  const startAdd = () => { setErr(""); setForm({ ...blank }); };
  const startEdit = (u) => { setErr(""); setForm({ ...u, password: "" }); };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { await saveUser(form); setForm(null); await load(); }
    catch (e2) { setErr(e2.message); }
    setBusy(false);
  };
  const remove = async (u) => {
    if (!window.confirm(`Remove ${u.name}'s account? They will no longer be able to sign in.`)) return;
    try { await deleteUser(u.id); await load(); } catch (e) { setErr(e.message); }
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div style={{ minHeight: "100vh", background: "#FAF6F0", fontFamily: "'Inter',system-ui,sans-serif", padding: "28px 20px" }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
          <button onClick={() => setView("__back__")} style={{ ...navBtn }}>← Back</button>
          <span style={{ fontSize: 20, fontWeight: 750, color: "#2A211C" }}>People &amp; accounts</span>
          <button onClick={startAdd} style={{ ...navBtn, marginLeft: "auto", background: "#DC5A12", color: "#fff", border: "1px solid transparent" }}>+ Add person</button>
        </div>

        {err && <div style={{ marginBottom: 14, fontSize: 13, color: "#BE3B2E", background: "#FBE9E6", border: "1px solid #EEC7C1", borderRadius: 8, padding: "8px 12px" }}>{err}</div>}

        {form && (
          <form onSubmit={submit} style={{ ...card, marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#DC5A12", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 14 }}>
              {form.id ? "Edit person" : "Add person"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div><label style={lbl}>Name</label><input style={inp} value={form.name} onChange={e => set("name", e.target.value)} /></div>
              <div><label style={lbl}>Email</label><input style={inp} type="email" value={form.email} onChange={e => set("email", e.target.value)} /></div>
              <div><label style={lbl}>Role</label>
                <select style={inp} value={form.role} onChange={e => set("role", e.target.value)}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div><label style={lbl}>Country {form.role === "leader" && <span style={{ color: "#B7A896" }}>(leaders: leave blank)</span>}</label>
                <input style={inp} value={form.country} onChange={e => set("country", e.target.value)} placeholder="e.g. Hungary" disabled={form.role === "leader"} /></div>
              {form.role === "director" && (
                <div><label style={lbl}>Department</label><input style={inp} value={form.department} onChange={e => set("department", e.target.value)} placeholder="e.g. HR" /></div>
              )}
              <div><label style={lbl}>{form.id ? "New password (blank = keep)" : "Password"}</label>
                <input style={inp} type="password" value={form.password} onChange={e => set("password", e.target.value)} placeholder={form.id ? "leave blank to keep" : "set a password"} /></div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13, color: "#5C5049" }}>
              <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} /> Active (can sign in)
            </label>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button type="submit" disabled={busy} style={{ ...navBtn, background: busy ? "#E7DDD2" : "#DC5A12", color: busy ? "#9C8F82" : "#fff", border: "1px solid transparent" }}>
                {busy ? "Saving…" : "Save"}</button>
              <button type="button" onClick={() => setForm(null)} style={{ ...navBtn }}>Cancel</button>
            </div>
          </form>
        )}

        {users === null ? (
          <div style={{ color: "#8C7D70", fontSize: 14 }}>Loading…</div>
        ) : users.length === 0 ? (
          <div style={{ ...card, color: "#8C7D70", fontSize: 14 }}>No accounts yet. Add yourself and Chris as leaders first.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {users.map(u => (
              <div key={u.id} style={{ ...card, display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650, color: "#2A211C" }}>{u.name} {!u.active && <span style={{ fontSize: 11, color: "#BE3B2E" }}>· inactive</span>}</div>
                  <div style={{ fontSize: 12, color: "#8C7D70" }}>{u.email}</div>
                </div>
                <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, color: "#5C5049", background: "#F5EFE6", border: "1px solid #E0D4C4", borderRadius: 20, padding: "3px 10px" }}>
                  {u.role === "leader" ? "P&C leader" : u.role === "country" ? `${u.country || "?"} leader` : `${u.country || "?"} · ${u.department || "?"}`}
                </span>
                <button onClick={() => startEdit(u)} style={{ ...navBtn, fontSize: 12, padding: "6px 12px" }}>Edit</button>
                <button onClick={() => remove(u)} disabled={u.name === me} title={u.name === me ? "You can't remove yourself" : ""}
                  style={{ ...navBtn, fontSize: 12, padding: "6px 12px", color: u.name === me ? "#C9BCAF" : "#BE3B2E", borderColor: "#EEC7C1" }}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
