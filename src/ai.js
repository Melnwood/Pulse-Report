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

// ─── TRANSLATION ─────────────────────────────────────────────────────────────
// The language each JV country works in — used for the report's language flip
// and for turning leader-written notes into English for P&C and the directors.
// Countries not listed (or English-speaking) simply don't get the flip button.
const LANG_BY_COUNTRY = {
  poland: "Polish", czech: "Czech", czechia: "Czech", "czech republic": "Czech",
  slovakia: "Slovak", hungary: "Hungarian", slovenia: "Slovene",
  croatia: "Croatian", serbia: "Serbian", bulgaria: "Bulgarian",
  romania: "Romanian", moldova: "Romanian", ukraine: "Ukrainian",
  estonia: "Estonian", latvia: "Latvian", lithuania: "Lithuanian",
  albania: "Albanian", "north macedonia": "Macedonian", macedonia: "Macedonian",
  germany: "German", austria: "German", spain: "Spanish", portugal: "Portuguese",
};
export function languageForCountry(country) {
  return LANG_BY_COUNTRY[String(country || "").trim().toLowerCase()] || null;
}

// The flip button shows the language in its own tongue — that's the reader it's for.
const NATIVE_LABEL = {
  Polish: "Po polsku", Czech: "Česky", Slovak: "Po slovensky", Hungarian: "Magyarul",
  Slovene: "Slovensko", Croatian: "Hrvatski", Serbian: "Srpski", Bulgarian: "Български",
  Romanian: "Română", Ukrainian: "Українською", Estonian: "Eesti keeles",
  Latvian: "Latviski", Lithuanian: "Lietuviškai", Albanian: "Shqip",
  Macedonian: "Македонски", German: "Deutsch", Spanish: "Español", Portuguese: "Português",
};
export function nativeLanguageLabel(language) { return NATIVE_LABEL[language] || language; }

// Translate a batch of report/UI strings into `language`. Returns an array the
// same length and order as the input; any string the model misses falls back to
// the English original. Callers chunk to ~35 strings per call.
export async function translateBatch(strings, language) {
  const prompt =
`Translate each string in the JSON array below from English into ${language}. They are labels and content from a staff-care survey report for Josiah Venture, a Christian missions organisation — use a warm, natural, professional tone in ${language}. Keep any leading/trailing symbols (✓, +, ↓, parentheses, ellipses) in place. Do NOT translate proper nouns like "Josiah Venture", "JV Kids", or people's names.

Return ONLY a JSON array of exactly ${strings.length} translated strings in the same order — no prose, no code fences.

${JSON.stringify(strings)}`;
  const raw = await callClaude(prompt, 3500);
  const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const arr = JSON.parse(jsonText.slice(jsonText.indexOf("["), jsonText.lastIndexOf("]") + 1));
  if (!Array.isArray(arr)) throw new Error("Translation response was not an array");
  return strings.map((s, i) => (typeof arr[i] === "string" && arr[i].trim()) ? arr[i].trim() : s);
}

// Translate one leader-written text into English. Returns null on any failure —
// callers treat the translation as best-effort and never block a save on it.
export async function translateToEnglish(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const prompt =
`Translate the following into natural English. It was written by a ministry country leader about their team — keep the tone, meaning, and any names exactly as they are. Return ONLY the translation, no commentary.

${t.slice(0, 2400)}`;
  try { return await callClaude(prompt, 800); } catch { return null; }
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
export async function synthesizeLeadership({ countries = [], lowestQuestions = [], recurring = [], scope = null, notes = [], openResponses = [] }) {
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
  // Keep the prompt lean — an oversized prompt + big completion is what pushed
  // the Netlify function past its timeout (504). Cap both count and length.
  const noteLines = notes
    .map(n => `- ${n.country} · ${n.deptLabel}${n.question ? ` [${clip(n.question, 60)}]` : ""} (${n.author || "?"}): ${clip(n.body, 160)}`)
    .filter(l => l.length > 20).slice(0, 25);
  const respLines = openResponses
    .map(r => `- ${r.country} · ${r.deptLabel}: ${clip(r.text, 160)}`)
    .filter(l => l.length > 12).slice(0, 35);

  const prompt =
`You are the strategic advisor to the People & Culture leaders (Mel & Chris) at Josiah Venture, a Christian youth-missions organisation working across several countries. They oversee staff care org-wide. Below is the current pulse rollup ${scope ? `for ${scope} (a single country)` : "across every country's latest survey"}. Your job is NOT to restate the numbers — it's to help them decide where to put their attention ${where} and WHAT to do.
${scope ? "" : `
THIS BRIEF IS ORG-WIDE. Every priority must be a PATTERN or THREAD that runs across multiple countries or the whole organisation — never one country's issue. Do NOT title or frame any priority around a single country (nothing like "X is broken in Poland"); if something matters in only one country, leave it for that country's own brief. Countries may appear only as short supporting evidence inside an insight ("lowest in Poland and Hungary"). Set "country" to "Org-wide" on every priority.
`}

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

Give 3–4 priorities, most important first. Prefer synthesis over enumeration: if the same issue recurs across countries, make that ONE priority and name the pattern. Only use deptKey values that appear in the DEPARTMENTS list below. Be specific to THIS data; do not invent anything.

BE BRIEF. Each "insight" is at most 2 short sentences (~40 words); each "nextStep" is ONE sentence. Your whole reply is cut off past ~700 words, so a long answer arrives broken — keep the entire JSON comfortably under that.

Ground the story in what people actually said: where the DIRECTORS' NOTES or STAFF OPEN RESPONSES sharpen or explain a score, weave that in — name the human reality behind the number, and quote a short phrase sparingly (a few words). If a director is already acting on something, say so in the next step. Never invent quotes or attribute anything not in the material below.

COUNTRIES (flagged counts):
${countryLines.join("\n")}

DEPARTMENTS at Concern/Watch (country | deptKey | deptLabel | avg | status):
${flagged.join("\n")}

LOWEST-SCORING QUESTIONS (the specific pain points):
${lowLines.join("\n") || "- (none)"}

RECURRING ACROSS TEAMS (same question low in multiple places):
${recLines.join("\n") || "- (none)"}

DIRECTORS' NOTES (what directors have written; may be empty):
${noteLines.join("\n") || "- (none yet)"}

STAFF OPEN RESPONSES (in staff's own words, translated; may be empty):
${respLines.join("\n") || "- (none)"}`;

  // 1024 max_tokens: enough for 3–4 JSON priorities, small enough to finish
  // inside the function timeout.
  const raw = await callClaude(prompt, 1024);
  const parsed = parseBriefJSON(raw);
  if (!parsed || (!parsed.headline && !(parsed.priorities || []).length)) {
    // Never show raw JSON to the reader — a garbled answer gets a plain retry note.
    return { empty: false, headline: "", priorities: [],
      text: "The AI's answer came back garbled this time. Press Synthesize again — a fresh run usually comes out clean." };
  }
  return { empty: false, headline: parsed.headline || "", priorities: Array.isArray(parsed.priorities) ? parsed.priorities : [] };
}

// Parse the brief's JSON, surviving a truncated reply. If the answer was cut
// off by the token cap mid-way, salvage the headline and every COMPLETE
// priority object rather than dumping raw JSON at the reader.
function parseBriefJSON(raw) {
  const jsonText = String(raw || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = jsonText.indexOf("{");
  if (start < 0) return null;
  const body = jsonText.slice(start);
  try { return JSON.parse(body.slice(0, body.lastIndexOf("}") + 1)); } catch {}
  // Truncated: pull the headline, then walk the priorities array and keep each
  // fully-closed { … } object (string-aware, so braces inside quotes don't count).
  let headline = "";
  const hm = body.match(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (hm) { try { headline = JSON.parse(`"${hm[1]}"`); } catch { headline = hm[1]; } }
  const priorities = [];
  const arrStart = body.indexOf("[");
  if (arrStart >= 0) {
    let depth = 0, objStart = -1, inStr = false, esc = false;
    for (let i = arrStart + 1; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") { if (depth === 0) objStart = i; depth++; }
      else if (c === "}") {
        depth--;
        if (depth === 0 && objStart >= 0) {
          try { priorities.push(JSON.parse(body.slice(objStart, i + 1))); } catch {}
          objStart = -1;
        }
      } else if (c === "]" && depth === 0) break;
    }
  }
  return (headline || priorities.length) ? { headline, priorities } : null;
}
