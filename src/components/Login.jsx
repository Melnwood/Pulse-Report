import { useState } from "react";
import { login } from "../authClient";

// The login screen shown when auth is switched on and there's no valid session.
export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) { setErr("Enter your email and password."); return; }
    setBusy(true); setErr("");
    try {
      const user = await login(email.trim(), password);
      onLogin(user);
    } catch (e2) {
      setErr(e2.message || "Login failed.");
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#FAF6F0", fontFamily: "'Inter',system-ui,sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 380, background: "#FFFFFF",
        border: "1px solid #EDE3D6", borderRadius: 16, boxShadow: "0 1px 2px rgba(58,38,22,.06), 0 10px 30px -10px rgba(58,38,22,.14)",
        padding: 28 }}>
        <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11, letterSpacing: 2,
          textTransform: "uppercase", color: "#B84A0E", fontWeight: 600, marginBottom: 6 }}>Josiah Venture</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#2A211C", marginBottom: 4 }}>Pulse Report</div>
        <div style={{ fontSize: 13.5, color: "#8C7D70", marginBottom: 22 }}>Sign in to continue.</div>

        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#8C7D70",
          textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Email</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username"
          style={inp} placeholder="you@josiahventure.com" />

        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#8C7D70",
          textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 6px" }}>Password</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"
          style={inp} placeholder="••••••••" />

        {err && <div style={{ marginTop: 14, fontSize: 13, color: "#BE3B2E", background: "#FBE9E6",
          border: "1px solid #EEC7C1", borderRadius: 8, padding: "8px 12px" }}>{err}</div>}

        <button type="submit" disabled={busy} style={{ marginTop: 20, width: "100%", padding: "11px 0",
          background: busy ? "#E7DDD2" : "#DC5A12", color: busy ? "#9C8F82" : "#fff", border: "none",
          borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: busy ? "wait" : "pointer" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div style={{ marginTop: 14, fontSize: 12, color: "#B7A896", textAlign: "center" }}>
          Trouble signing in? Contact Mel or Chris.
        </div>
      </form>
    </div>
  );
}

const inp = { width: "100%", boxSizing: "border-box", background: "#FFFFFF", border: "1px solid #E0D4C4",
  borderRadius: 8, padding: "10px 14px", color: "#2A211C", fontSize: 14, fontFamily: "inherit" };
