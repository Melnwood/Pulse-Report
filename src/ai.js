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

// Synthesize an org-wide leadership brief from the quantitative rollup: what's
// the story, and — for each priority — the next step / conversation to have.
// Returns { empty } or { headline, priorities:[{title, insight, nextStep,
// country, deptKey, deptLabel, status}] }. deptKey lets the UI make each
// priority click straight into that department's detail (null = systemic).
export async function synthesizeLeadership({ countries = [], lowestQuestions = [], recurring = [], scope = null }) {
  const clip = (s, n = 140) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const flagged = countries.flatMap(c =>
    (c.depts || []).map(d => `${c.country} | ${d.deptKey} | ${d.deptLabel} | ${d.avg} | ${d.status}`));
  const where = scope ? `in ${scope}` : "across the org";
  if (flagged.length === 0) {
    return { empty: true, text: `Nothing is at Concern or Watch ${where} right now — no brief to synthesize.` };
  }
  const countryLines = countries.map(c => `- ${c.country}: ${c.concern} Concern, ${c.watch} Watch`);
  const lowLines = lowestQuestions.slice(0, 12).map(q => `- ${q.country} · ${q.deptLabel} · ${q.score} (${q.status}): ${clip(q.en)}`);
  const recLines = recurring.slice(0, 8).map(e => `- (${e.count} places) ${clip(e.en)} — ${(e.where || []).join("; ")}`);

  const prompt =
`You are the strategic advisor to the People & Culture leaders (Mel & Chris) at Josiah Venture, a Christian youth-missions organisation working across several countries. They oversee staff care org-wide. Below is the current pulse rollup ${scope ? `for ${scope} (a single country)` : "across every country's latest survey"}. Your job is NOT to restate the numbers — it's to help them decide where to put their attention ${where} and WHAT to do.

Produce a short leadership brief as JSON only (no prose outside the JSON, no code fences), in exactly this shape:
{
  "headline": "1–2 sentences: the honest state of things across the org right now",
  "priorities": [
    {
      "title": "a short, specific label (max ~8 words)",
      "insight": "1–2 sentences: what's actually going on and why it matters — connect the dots (a pattern across teams/countries, a cluster, a root cause), don't just repeat a score",
      "nextStep": "1 concrete next move for Mel & Chris — a conversation to have, a director to support, a question to ask. Pastoral and practical.",
      "country": "the country this points to, or \\"Org-wide\\" if systemic",
      "deptKey": "the EXACT dept key from the DEPARTMENTS list if this is about one department, else null",
      "deptLabel": "the department name, or null",
      "status": "Concern | Watch | null"
    }
  ]
}

Give 3–5 priorities, most important first. Prefer synthesis over enumeration: if the same issue recurs across countries, make that ONE priority and name the pattern. Only use deptKey values that appear in the DEPARTMENTS list below. Be specific to THIS data; do not invent anything.

COUNTRIES (flagged counts):
${countryLines.join("\n")}

DEPARTMENTS at Concern/Watch (country | deptKey | deptLabel | avg | status):
${flagged.join("\n")}

LOWEST-SCORING QUESTIONS (the specific pain points):
${lowLines.join("\n") || "- (none)"}

RECURRING ACROSS TEAMS (same question low in multiple places):
${recLines.join("\n") || "- (none)"}`;

  const raw = await callClaude(prompt, 1600);
  let parsed;
  try {
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    parsed = JSON.parse(jsonText.slice(jsonText.indexOf("{"), jsonText.lastIndexOf("}") + 1));
  } catch {
    // Fall back to showing the raw text rather than failing outright.
    return { empty: false, headline: "", priorities: [], text: raw };
  }
  return { empty: false, headline: parsed.headline || "", priorities: Array.isArray(parsed.priorities) ? parsed.priorities : [] };
}
