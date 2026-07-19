import { useState } from "react";
import { login, setPassword as setPasswordApi } from "../authClient";
import { FONT_DISPLAY } from "../theme";

// The login screen shown when auth is switched on and there's no valid session.
// Two steps: sign in, or — for a brand-new account with no password yet — create
// your own password. A person a leader just added lands in "create" automatically.
export default function Login({ onLogin }) {
  const [step, setStep] = useState("signin");   // "signin" | "create"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  const goCreate = (msg) => { setStep("create"); setPassword(""); setConfirm(""); setErr(""); setNotice(msg || ""); setBusy(false); };

  const submitSignin = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) { setErr("Enter your email and password."); return; }
    setBusy(true); setErr("");
    try {
      const res = await login(email.trim(), password);
      if (res && res.needsPassword) { goCreate("This is your first sign-in — choose a password to finish setting up your account."); return; }
      onLogin(res);
    } catch (e2) {
      setErr(e2.message || "Login failed.");
      setBusy(false);
    }
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!email.trim()) { setErr("Enter your email."); return; }
    if (password.length < 6) { setErr("Use a password of at least 6 characters."); return; }
    if (password !== confirm) { setErr("Those two passwords don't match."); return; }
    setBusy(true); setErr("");
    try {
      const user = await setPasswordApi(email.trim(), password);
      onLogin(user);
    } catch (e2) {
      setErr(e2.message || "Couldn't set your password.");
      setBusy(false);
    }
  };

  const linkBtn = { background: "none", border: "none", padding: 0, cursor: "pointer", color: "#B96524", fontWeight: 600, fontSize: 12.5 };

  return (
    <div style={{ minHeight: "100vh", background: "#F6F1E8", fontFamily: "'Inter',system-ui,sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <form onSubmit={step === "create" ? submitCreate : submitSignin} style={{ width: "100%", maxWidth: 380, background: "#FFFFFF",
        border: "1px solid #ECE2D2", borderRadius: 16, boxShadow: "0 1px 2px rgba(58,38,22,.06), 0 10px 30px -10px rgba(58,38,22,.14)",
        padding: 28 }}>
        <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11, letterSpacing: 2,
          textTransform: "uppercase", color: "#B96524", fontWeight: 600, marginBottom: 6 }}>Josiah Venture</div>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 600, color: "#2C2621", marginBottom: 4, letterSpacing: -.3 }}>Pulse Report</div>
        <div style={{ fontSize: 13.5, color: "#7A6F63", marginBottom: 22 }}>
          {step === "create" ? "Create your password to finish setting up." : "Sign in to continue."}
        </div>

        {notice && <div style={{ marginBottom: 16, fontSize: 12.5, color: "#5C9A6D", background: "#E9F1E9",
          border: "1px solid #CDE3CD", borderRadius: 8, padding: "8px 12px", lineHeight: 1.45 }}>{notice}</div>}

        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#7A6F63",
          textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Email</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username"
          style={inp} placeholder="you@josiahventure.com" />

        {step === "create" ? (
          <>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#7A6F63",
              textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 6px" }}>New password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password"
              style={inp} placeholder="at least 6 characters" />
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#7A6F63",
              textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 6px" }}>Confirm password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password"
              style={inp} placeholder="type it again" />
          </>
        ) : (
          <>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#7A6F63",
              textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 6px" }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"
              style={inp} placeholder="••••••••" />
          </>
        )}

        {err && <div style={{ marginTop: 14, fontSize: 13, color: "#BE6650", background: "#F6E5DE",
          border: "1px solid #E4C4BA", borderRadius: 8, padding: "8px 12px" }}>{err}</div>}

        <button type="submit" disabled={busy} style={{ marginTop: 20, width: "100%", padding: "11px 0",
          background: busy ? "#ECE2D2" : "#E0863C", color: busy ? "#7A6F63" : "#fff", border: "none",
          borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: busy ? "wait" : "pointer" }}>
          {busy ? (step === "create" ? "Setting up…" : "Signing in…") : (step === "create" ? "Set password & sign in" : "Sign in")}
        </button>

        <div style={{ marginTop: 16, fontSize: 12.5, color: "#A89C8D", textAlign: "center" }}>
          {step === "create" ? (
            <button type="button" onClick={() => { setStep("signin"); setErr(""); setNotice(""); }} style={linkBtn}>← Back to sign in</button>
          ) : (
            <>First time signing in? <button type="button" onClick={() => goCreate("")} style={linkBtn}>Create your password</button></>
          )}
        </div>
      </form>
    </div>
  );
}

const inp = { width: "100%", boxSizing: "border-box", background: "#FFFFFF", border: "1px solid #E2D3C2",
  borderRadius: 8, padding: "10px 14px", color: "#2C2621", fontSize: 14, fontFamily: "inherit" };
