// Client helpers for the Anthropic proxy (netlify/functions/claude.js). Keeps
// the prompt-building in one place. The proxy holds the API key server-side.
const MODEL = "claude-sonnet-4-6";

// Low-level call: send a single user prompt, return the assistant's text.
export async function callClaude(prompt, maxTokens = 1200) {
  const res = await fetch("/.netlify/functions/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Function returned HTTP ${res.status}: ${raw.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`Response was not JSON: ${raw.slice(0, 300)}`); }
  if (data.error) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error).slice(0, 300));
  const text = data.content?.find(b => b.type === "text")?.text;
  if (!text) throw new Error(`Unexpected response shape: ${JSON.stringify(data).slice(0, 300)}`);
  return text.trim();
}

// Summarize a department's follow-up notes + staff open responses into a concise
// digest. Callers pass ONLY the material the current viewer is allowed to see
// (visibility is applied before this is called — e.g. public-only for country
// leaders), so nothing private leaks into an AI summary.
export async function summarizeDeptNotes({ country, year, deptLabel, deptNotes = [], questionNotes = [], openResponses = [] }) {
  const clip = (s, n = 600) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const dn = deptNotes.map(n => `- (${n.author || "?"}) ${clip(n.body || n.title)}`).filter(l => l.length > 6);
  const qn = questionNotes.map(n => `- [${clip(n.question, 90)}] (${n.author || "?"}) ${clip(n.body || n.title)}`).filter(l => l.length > 6);
  const or = openResponses.map(r => `- ${clip(r.translation || r.text)}`).filter(l => l.length > 4).slice(0, 60);

  if (dn.length + qn.length + or.length === 0) {
    return { empty: true, text: "There aren't any notes or open responses yet to summarize for this department." };
  }

  const prompt =
`You are helping the People & Culture team at Josiah Venture (a Christian missions organisation) review staff-care survey follow-up for the "${deptLabel}" department (${country} ${year}).

Summarize the material below — the directors' notes and the staff's own open-ended responses — into a concise, practical digest. Use these sections, each with short bullet points (omit a section if there's nothing for it):

**Themes** — the recurring topics across the notes and responses.
**Concerns** — specific issues that need attention.
**In motion** — actions the director is already taking.
**Suggested focus** — 1–3 places to put energy next.

Be specific and pastoral in tone; quote sparingly. Keep the whole thing tight (roughly 150–220 words). Do not invent anything not supported by the input.

${dn.length ? `DEPARTMENT NOTES:\n${dn.join("\n")}\n` : ""}${qn.length ? `\nQUESTION NOTES:\n${qn.join("\n")}\n` : ""}${or.length ? `\nSTAFF OPEN RESPONSES:\n${or.join("\n")}\n` : ""}`;

  const text = await callClaude(prompt, 1200);
  return { empty: false, text };
}
