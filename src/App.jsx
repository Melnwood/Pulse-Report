import { useState, useEffect, useCallback, useRef } from "react";
import { useIsMobile, sc, sb, sbd, card, navBtn, lbl, inp, C, FONT_DISPLAY } from "./theme";
import Disclosure from "./components/Disclosure";
import { VisibilityPicker, VisibilityChip } from "./components/Visibility";
import { IconHelp, IconUpload } from "./components/Icons";
import Login from "./components/Login";
import UsersView from "./components/UsersView";
import VideosView from "./components/VideosView";
import { authStatus, tokenValid, getUser, logout } from "./authClient";
import SURVEY_BASICS from "./surveyBasics.json";
import { airtablePing, upsertRun, upsertDepartment, loadSelections, saveSelections as atSaveSelections, loadRunSelections, loadAllRuns, loadRunSurveyData, setDepartmentReviewStatus, addDepartmentNote, loadDepartmentNotes, setDepartmentNoteVisibility, deleteDepartmentNote, addQuestionNote, loadQuestionNotes, setQuestionNoteVisibility, deleteQuestionNote, loadMeasures, loadSurveyBasicsMaster, saveSurveyBasicsMaster, loadHelpVideos } from "./airtable";
import { synthesizeLeadership } from "./ai";
import MeasurePanel from "./components/MeasurePanel";
import NotesDigest from "./components/NotesDigest";
import CountryTrends from "./components/CountryTrends";

// Map app department keys (HR, LD, LC1/LC2, JVK1/JVK2, ...) to surveyBasics.json keys
// (which are lowercase and un-split: hr, ld, lc, jvk, ...).
const SB_KEY = {
  HR:"hr", LD:"ld", LC1:"lc", LC2:"lc", MPD:"mpd", Counseling:"counseling",
  Women:"women", Singles:"singles", Marriages:"marriages", JVK1:"jvk", JVK2:"jvk",
};
const getSurveyBasics = (deptKey) => SURVEY_BASICS[SB_KEY[deptKey] || String(deptKey||"").toLowerCase()] || [];

// Normalize question text for matching: unify apostrophes/quotes, collapse spaces,
// strip punctuation. Makes Survey Basics matching robust to curly-vs-straight quotes
// and tiny wording differences that were hiding the Survey Basics + Edit button.
const normQ = (s) => String(s || "")
  .toLowerCase()
  .replace(/[\u2018\u2019\u201B\u2032]/g, "'")   // curly/uncommon apostrophes -> '
  .replace(/[\u201C\u201D]/g, '"')
  .replace(/[^a-z0-9 ]/g, " ")                      // drop punctuation
  .replace(/\s+/g, " ")
  .trim();

// Friendly "Jul 19, 2026" label for today — shown in note composers so the
// author knows the date is stamped automatically.
const todayLabel = () => {
  try { return new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return ""; }
};

// Find the Survey Basics entry for a question, tolerant of small text differences.
const findSurveyBasics = (deptKey, qText) => {
  const list = getSurveyBasics(deptKey);
  const nq = normQ(qText);
  if (!nq) return null;
  // 1. exact normalized match — check the question AND any aliases (app-worded variants)
  let m = list.find(sb => normQ(sb.question) === nq ||
    (sb.aliases || []).some(a => normQ(a) === nq));
  if (m) return m;
  // 2. strong prefix overlap (first ~35 normalized chars)
  const head = nq.slice(0, 35);
  m = list.find(sb => { const sbn = normQ(sb.question); return sbn.startsWith(head) || head.startsWith(sbn.slice(0,35)); });
  if (m) return m;
  // 3. token-overlap fallback: >=70% of the shorter question's words shared
  const words = new Set(nq.split(" ").filter(w => w.length > 2));
  let best = null, bestScore = 0;
  for (const sb of list) {
    const sw = new Set(normQ(sb.question).split(" ").filter(w => w.length > 2));
    const shared = [...words].filter(w => sw.has(w)).length;
    const denom = Math.min(words.size, sw.size) || 1;
    const score = shared / denom;
    if (score > bestScore) { bestScore = score; best = sb; }
  }
  return bestScore >= 0.7 ? best : null;
};

// ─── AIRTABLE CONFIG ─────────────────────────────────────────────────────────
const AT_BASE = "appPulseReportBase"; // replace with real base ID

// ─── SURVEY STRUCTURE ────────────────────────────────────────────────────────
// Col indices from QuestionPro Raw Data sheet
// Routing columns are resolved from the header row at parse time (positions vary
// by country export), so we match on the header TEXT rather than a fixed index.
// Fallback indices match the observed Poland layout if a header isn't found.
const ROUTING_HEADERS = {
  marital: [/marital status/i, /stan cywilny/i],
  kids:    [/children living in your household/i, /mieszkaj.* dzieci/i],
  culture: [/serving cross-?culturally/i, /środowisku międzykulturowym/i],
};
const ROUTING_FALLBACK = { marital: 19, kids: 20, culture: 21 };

// Resolve routing column indices from a header row (array of header strings).
function resolveRouting(headerRow) {
  const find = (patterns, fallback) => {
    for (let i = 0; i < headerRow.length; i++) {
      const h = String(headerRow[i] || "");
      if (patterns.some(p => p.test(h))) return i;
    }
    return fallback;
  };
  return {
    marital: find(ROUTING_HEADERS.marital, ROUTING_FALLBACK.marital),
    kids:    find(ROUTING_HEADERS.kids,    ROUTING_FALLBACK.kids),
    culture: find(ROUTING_HEADERS.culture, ROUTING_FALLBACK.culture),
  };
}

const DEPARTMENTS = [
  {
    key: "HR", label: "Human Resources",
    cols: [23,24,25,26,27,28,29,30,31], openQ: 32,
    route: () => true, // everyone
    questions: [
      { col:23, en:"I have a clear and up-to-date Position Focus with regular opportunities to work within my gifting, experience, and calling.", burden:false, scale:"mean" },
      { col:24, en:"I have a working knowledge of JV policies and procedures.", burden:false, scale:"dist" },
      { col:25, en:"I often feel unsure about my place within the organization.", burden:true,  scale:"dist" },
      { col:26, en:"I often feel confused or overwhelmed by complicated HR requirements.", burden:true,  scale:"dist" },
      { col:27, en:"HR processes and systems are clear and efficient, making it easy to get what I need.", burden:false, scale:"dist" },
      { col:28, en:"I am able to utilize HR information, tools, and the support I need to do my job effectively.", burden:false, scale:"dist" },
      { col:29, en:"The compensation and benefits I receive are appropriate for the cost of living and demands of my role.", burden:false, scale:"dist" },
      { col:30, en:"I believe that HR policies and decisions are applied fairly across the organization.", burden:false, scale:"dist" },
      { col:31, en:"I feel noticed and cared for by my team when I have needs.", burden:false, scale:"mean" },
    ],
    openQLabel: "What would make HR support more helpful to you?",
  },
  {
    key: "LD", label: "Learning & Development",
    cols: [33,34,35,36,37,38,39,40,41], openQ: 42,
    route: () => true,
    questions: [
      { col:33, en:"The equipping resources available enable me to be developed in my role.", burden:false, scale:"dist" },
      { col:34, en:"I am continually learning how Christ's strategy shapes how I lead, train, and disciple others in ministry.", burden:false, scale:"mean" },
      { col:35, en:"My uplink rhythms (meetings, guidance, support) help me thrive in ministry.", burden:false, scale:"mean" },
      { col:36, en:"I frequently feel unsure about how to move forward in my development.", burden:true,  scale:"dist" },
      { col:37, en:"I receive helpful feedback and encouragement that supports my learning and development.", burden:false, scale:"dist" },
      { col:38, en:"I am experiencing personal growth in this season.", burden:false, scale:"mean" },
      { col:39, en:"I am experiencing professional growth in this season.", burden:false, scale:"mean" },
      { col:40, en:"I often struggle to apply Christ's strategy to daily ministry.", burden:true,  scale:"dist" },
      { col:41, en:"I am growing in healthy rhythms that help me serve others from a place of wholeness.", burden:false, scale:"mean" },
    ],
    openQLabel: "What training or development would be most useful to you right now?",
  },
  {
    key: "LC1", label: "Language & Culture (1st Culture)", group: "LC",
    cols: [43,44,45,46], openQ: 47,
    // 1st culture = culture code 2 (confirmed across PL/HU/RO). Require they answered
    // at least one L&C question so we don't include people who skipped the section.
    route: (r, routing) => routing && parseFloat(r[routing.culture]) === 2 &&
      [43,44,45,46,48,49,50,51,52,53,54,55].some(c => !isNaN(parseFloat(r[c]))),
    questions: [
      { col:43, en:"I can switch to English and still communicate effectively in team contexts.", burden:false, scale:"dist" },
      { col:44, en:"I am aware of cultural differences on my team and intentionally try to understand them.", burden:false, scale:"mean" },
      { col:45, en:"Improving my language skills matters to me as part of an international team.", burden:false, scale:"mean" },
      { col:46, en:"I regularly show patience and support to team members experiencing culture shock.", burden:false, scale:"mean" },
    ],
    openQLabel: "What would most help you work more effectively in a multicultural team?",
  },
  {
    key: "LC2", label: "Language & Culture (2nd Culture)", group: "LC",
    cols: [48,49,50,51,52,53,54,55], openQ: 56,
    // 2nd culture = culture code 1.
    route: (r, routing) => routing && parseFloat(r[routing.culture]) === 1 &&
      [43,44,45,46,48,49,50,51,52,53,54,55].some(c => !isNaN(parseFloat(r[c]))),
    questions: [
      { col:48, en:"I clearly understand the expectations for my progress in language and culture learning.", burden:false, scale:"dist" },
      { col:49, en:"My team helps me with my language and cultural adaptation needs.", burden:false, scale:"dist" },
      { col:50, en:"I receive regular accountability and helpful feedback on my progress in language learning.", burden:false, scale:"dist" },
      { col:51, en:"I know who to turn to for help with language learning challenges.", burden:false, scale:"dist" },
      { col:52, en:"I am growing in my ability to live and function daily in another culture and language.", burden:false, scale:"mean" },
      { col:53, en:"I feel increasingly capable in ministry because of my language and cultural skills.", burden:false, scale:"mean" },
      { col:54, en:"I regularly feel discouraged about my pace of language learning.", burden:true,  scale:"dist" },
      { col:55, en:"I often struggle to balance ministry demands with language and culture growth.", burden:true,  scale:"dist" },
    ],
    openQLabel: "What would most help you in your language and cultural growth?",
  },
  {
    key: "MPD", label: "Ministry Partner Development",
    cols: [57,58,59,60,61,62,63,64,65], openQ: 66,
    route: () => true,
    questions: [
      { col:57, en:"I have the practical MPD tools and guidance I need to raise and maintain support for long-term ministry.", burden:false, scale:"dist" },
      { col:58, en:"I am confident when sharing my ministry vision and financial needs with potential supporters.", burden:false, scale:"mean" },
      { col:59, en:"I know who to turn to for encouragement or accountability in my MPD journey.", burden:false, scale:"dist" },
      { col:60, en:"Financial pressure sometimes distracts me from focusing on ministry.", burden:true,  scale:"dist" },
      { col:61, en:"I regularly communicate with my partners to let them know how their giving and praying is making an impact.", burden:false, scale:"mean" },
      { col:62, en:"I receive valid and regular financial reports about my support team, and I routinely track changes to my finances.", burden:false, scale:"mean" },
      { col:63, en:"I often feel alone in carrying the responsibility of MPD.", burden:true,  scale:"dist" },
      { col:64, en:"I feel supported by my uplink or ministry team in building and maintaining my support team.", burden:false, scale:"dist" },
      { col:65, en:"I am effective when sharing my ministry vision and financial needs with potential supporters.", burden:false, scale:"mean" },
    ],
    openQLabel: "What is one thing that would strengthen your MPD journey right now?",
  },
  {
    key: "Counseling", label: "Counseling",
    cols: [67,68,69,70,71,72,73,74,75], openQ: 76,
    route: () => true,
    questions: [
      { col:67, en:"I know who to contact for personal or family care, especially in times of crisis.", burden:false, scale:"dist" },
      { col:68, en:"I understand JV's process for getting counseling help.", burden:false, scale:"dist" },
      { col:69, en:"I feel encouraged to pursue counseling when needed.", burden:false, scale:"dist" },
      { col:70, en:"I have safe and trusted people I can talk to about seeking help.", burden:false, scale:"mean" },
      { col:71, en:"Counseling is viewed in our organization as a healthy and constructive step.", burden:false, scale:"mean" },
      { col:72, en:"I feel more equipped to navigate challenges because of counseling I have received.", burden:false, scale:"mean" },
      { col:73, en:"I see counseling as a proactive tool for growth, not just crisis.", burden:false, scale:"mean" },
      { col:74, en:"Practical barriers (time, cost, access) keep me from seeking counseling.", burden:true,  scale:"dist" },
      { col:75, en:"I know someone on staff who has benefitted from counseling.", burden:false, scale:"dist" },
    ],
    openQLabel: "What would make counseling more accessible or effective for you?",
  },
  {
    key: "Women", label: "JV Women",
    cols: [77,78,79,80,81,82,83], openQ: 84,
    route: (r) => [77,78,79,80,81,82,83].some(c => !isNaN(parseFloat(r[c]))),
    questions: [
      { col:77, en:"I sometimes feel isolated in ministry and lack women I can turn to.", burden:true,  scale:"dist" },
      { col:78, en:"I have clarity and alignment with my spouse, team, and leadership about my ministry role and responsibilities.", burden:false, scale:"dist" },
      { col:79, en:"I often feel disconnected from my team and uninformed about its activities and decisions.", burden:true,  scale:"dist" },
      { col:80, en:"I feel my voice is valued in team and organizational settings.", burden:false, scale:"dist" },
      { col:81, en:"I find it difficult to see how my gifts and role fit my ministry context.", burden:true,  scale:"dist" },
      { col:82, en:"My organization provides clear guidance about women's roles and leadership opportunities.", burden:false, scale:"dist" },
      { col:83, en:"JV gatherings (conferences, retreats) provide a safe and nurturing environment for women.", burden:false, scale:"mean" },
    ],
    openQLabel: "What support or opportunities would most help women flourish in JV?",
  },
  {
    key: "Singles", label: "Singles",
    cols: [85,86,87,88,89,90,91,92,93], openQ: 95,
    route: (r) => [85,86,87,88,89,90,91,92,93].some(c => !isNaN(parseFloat(r[c]))),
    questions: [
      { col:85, en:"I have access to resources that address the unique needs of single missionaries.", burden:false, scale:"dist" },
      { col:86, en:"I have a clear understanding of what is expected of me in ministry, team, and community life as a single staff member.", burden:false, scale:"dist" },
      { col:87, en:"My practical needs as a single (housing, financial, social) are adequately acknowledged and supported in my context.", burden:false, scale:"dist" },
      { col:88, en:"I feel relationally connected to my team and community as a single.", burden:false, scale:"mean" },
      { col:89, en:"I have safe people I can turn to for support, encouragement, and prayer.", burden:false, scale:"mean" },
      { col:90, en:"I feel that my singleness is respected and valued by JV leadership.", burden:false, scale:"dist" },
      { col:91, en:"I'm learning to navigate singleness, finding increasing peace and purpose.", burden:false, scale:"mean" },
      { col:92, en:"I see my gifts and opportunities as a single person being used effectively in ministry.", burden:false, scale:"mean" },
      { col:93, en:"I sometimes feel the weight of carrying ministry responsibilities on my own.", burden:true,  scale:"dist" },
    ],
    openQLabel: "What would most strengthen JV's support for singles in your context?",
  },
  {
    key: "Marriages", label: "Marriages",
    cols: [96,97,98,99,100,101], openQ: 102,
    route: (r) => [96,97,98,99,100,101].some(c => !isNaN(parseFloat(r[c]))),
    questions: [
      { col:96,  en:"I know where to go for help if our marriage faces challenges.", burden:false, scale:"dist" },
      { col:97,  en:"I feel supported and encouraged by JV and my team culture to prioritize my marriage.", burden:false, scale:"dist" },
      { col:98,  en:"I have couples or mentors I can turn to for support.", burden:false, scale:"dist" },
      { col:99,  en:"My team culture values and respects the importance of nurturing marriages in ministry.", burden:false, scale:"mean" },
      { col:100, en:"In our marriage, we are learning together how to navigate ministry pressure in healthy ways.", burden:false, scale:"mean" },
      { col:101, en:"I often feel that ministry demands drain me so much that I have little left for my spouse.", burden:true,  scale:"dist" },
    ],
    openQLabel: "What would most strengthen marriages in your ministry context?",
  },
  {
    key: "JVK2", label: "JVK — 2nd Culture Parents", group: "JVK",
    cols: [103,104,105,106,107], openQ: 117,
    // 2nd-culture parents answer cols 103-107 (exclusive to this group).
    // 2nd culture parents = culture code 1, who answered any JVK question (cols 103-116).
    route: (r, routing) => routing && parseFloat(r[routing.culture]) === 1 &&
      [103,104,105,106,107,108,109,110,111,112,113,114,115,116].some(c => !isNaN(parseFloat(r[c]))),
    questions: [
      { col:103, en:"I'm aware of available resources to support my children in cross-cultural life.", burden:false, scale:"dist" },
      { col:104, en:"I clearly understand JV's approach to caring for kids.", burden:false, scale:"dist" },
      { col:105, en:"I have someone to turn to for help when my kids face challenges.", burden:false, scale:"dist" },
      { col:106, en:"I feel my children are cared for and supported by JV.", burden:false, scale:"mean" },
      { col:107, en:"My children have 1–2 adults outside our family they can talk to if needed.", burden:false, scale:"mean" },
    ],
    openQLabel: "What would most strengthen JV's care for kids?",
  },
  {
    key: "JVK1", label: "JVK — 1st Culture Parents", group: "JVK",
    cols: [108,109,110,111,112,113,114,115,116], openQ: 117,
    // 1st-culture parents are identified by cols 108-111 (exclusive to this group;
    // cols 112-116 are shared with 2nd-culture parents, so we don't route on those).
    // 1st culture parents = culture code 2, who answered any JVK question.
    route: (r, routing) => routing && parseFloat(r[routing.culture]) === 2 &&
      [103,104,105,106,107,108,109,110,111,112,113,114,115,116].some(c => !isNaN(parseFloat(r[c]))),
    questions: [
      { col:108, en:"I clearly understand JV's approach to caring for kids.", burden:false, scale:"dist" },
      { col:109, en:"I have someone to turn to for help when my kids face challenges.", burden:false, scale:"dist" },
      { col:110, en:"I feel my children are cared for and supported by JV.", burden:false, scale:"mean" },
      { col:111, en:"My children have 1–2 adults outside our family they can talk to if needed.", burden:false, scale:"mean" },
      { col:112, en:"JV provides opportunities for my kids to connect with other kids who share similar experiences.", burden:false, scale:"dist" },
      { col:113, en:"My children are growing in resilience through our family's ministry context.", burden:false, scale:"mean" },
      { col:114, en:"I see my children thriving in at least some areas of life.", burden:false, scale:"mean" },
      { col:115, en:"My children often feel isolated or disconnected.", burden:true,  scale:"dist" },
      { col:116, en:"I regularly feel my children's needs are overlooked in ministry life.", burden:true,  scale:"dist" },
    ],
    openQLabel: "What would most strengthen JV's care for kids?",
  },
];

// ─── SCORING ENGINE ───────────────────────────────────────────────────────────
function computeScore(vals, burden) {
  const nums = vals.filter(v => v >= 1 && v <= 5);
  if (!nums.length) return null;
  const inv = burden ? nums.map(v => 6 - v) : nums;
  return inv.reduce((a,b) => a+b, 0) / inv.length;
}

function distStatus(vals, burden) {
  const nums = vals.filter(v => v >= 1 && v <= 5);
  if (nums.length < 3) return null;
  const inv = burden ? nums.map(v => 6 - v) : nums;
  const n = inv.length;
  const pos = inv.filter(v => v >= 4).length / n;
  const neg = inv.filter(v => v <= 2).length / n;
  if (pos >= 0.75 && neg <= 0.15) return "Healthy";
  if (pos >= 0.50 && neg <= 0.30 && neg < pos) return "Watch";
  return "Concern";
}

function meanStatus(score) {
  if (score === null) return null;
  if (score >= 3.50) return "Healthy";
  if (score >= 2.50) return "Watch";
  return "Concern";
}

function getStatus(vals, q) {
  const score = computeScore(vals, q.burden);
  if (score === null) return { score: null, status: null };
  if (q.scale === "dist" && vals.filter(v=>v>=1&&v<=5).length >= 5) {
    return { score, status: distStatus(vals, q.burden) };
  }
  return { score, status: meanStatus(score) };
}

function deptStatus(questions) {
  // A department is Concern if its average is below 2.50, OR if it has 4+ individual
  // Concern-level questions (matches the director's report: 3 concern Qs stays Watch,
  // 4+ tips the whole department to Concern). Otherwise status follows the average.
  const statuses = questions.map(q => q.status).filter(Boolean);
  const concerns = statuses.filter(s => s === "Concern").length;
  if (concerns >= 4) return "Concern";
  const scores = questions.map(q=>q.score).filter(Boolean);
  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : null;
  if (!avg) return null;
  if (avg >= 3.50) return "Healthy";
  if (avg >= 2.50) return "Watch";
  return "Concern";
}

// ─── PARSE SURVEY FILE ────────────────────────────────────────────────────────
async function parseSurveyFile(file) {
  const { read, utils } = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb  = read(buf);
  const ws  = wb.Sheets["Raw Data"] || wb.Sheets[wb.SheetNames[0]];
  const raw = utils.sheet_to_json(ws, { header:1, defval:null });

  const headerRow = raw[0] || [];
  const routing = resolveRouting(headerRow);   // resolves marital/kids/culture column indices from headers

  const dataRows = raw.slice(2).filter(r => r[1] === "Completed" || r[1] === "Complete");

  const results = {};

  // A respondent "answered" a set of columns if at least one has a numeric value.
  const answered = (r, cols) => cols.some(c => {
    const v = parseFloat(r[c]); return !isNaN(v);
  });

  for (const dept of DEPARTMENTS) {
    // Route by ANSWER PRESENCE (most robust — a person is in a department iff they
    // answered its questions), with the resolved culture column disambiguating the
    // 1st/2nd culture split for grouped departments.
    const eligible = dataRows.filter(r => {
      try {
        if (dept.route) return dept.route(r, routing);   // custom route wins if defined
        return answered(r, dept.cols);
      } catch { return answered(r, dept.cols); }
    });

    const qResults = dept.questions.map(q => {
      const vals = eligible.map(r => {
        const v = parseFloat(r[q.col]);
        return isNaN(v) ? null : v;
      }).filter(v => v !== null);
      const { score, status } = getStatus(vals, q);
      const counts = [1,2,3,4,5].map(n => vals.filter(v=>v===n).length);
      return { ...q, vals, counts, score: score ? +score.toFixed(2) : null, status, n: vals.length };
    });

    // Collect open responses with language detection
    // Store as {text, isOriginalLang} — isOriginalLang=true means non-English (needs translation shown)
    const openResponses = eligible
      .map(r => {
        const raw = (r[dept.openQ] || "").toString().trim();
        if (!raw || raw === ".") return null;
        // Use the shared diacritic-based detector (defined below) so Polish/Romanian/etc. flag correctly
        const isOriginalLang = looksNonEnglish(raw);
        return { text: raw, isOriginalLang };
      })
      .filter(Boolean);

    const avg = qResults.filter(q=>q.score).reduce((a,b,_,arr)=>a+b.score/arr.length,0);

    results[dept.key] = {
      key: dept.key, label: dept.label, group: dept.group || dept.key,
      n: eligible.length,
      avg: +avg.toFixed(2),
      status: deptStatus(qResults),
      questions: qResults,
      openResponses,
      openQLabel: dept.openQLabel,
    };
  }

  // Merge LC and JVK groups for display
  const merged = {};
  for (const [k,v] of Object.entries(results)) {
    if (!merged[v.group]) merged[v.group] = { ...v, subgroups: [] };
    merged[v.group].subgroups.push(v);
  }

  return { depts: results, merged, raw: dataRows };
}


// ─── PARSE COMPLETED DIRECTOR REVIEW (Excel) ──────────────────────────────────
// Reads a completed director-review workbook (one sheet per department) and maps
// each sheet's edits/includes/rewrites into the app's `selections` shape:
//   { deptKey: { strengths:[{text,include,rewrite,...}], growth:[...], leadershipQs:[...], quotes:[...] } }
//
// The director review Excel uses these section markers in column A and this layout:
//   SECTION 1 — QUESTION SCORES : per-question interpretation (E) + rewrite (G) + score note (H)
//   SECTION 2 — STRENGTHS       : statement (B), include Yes (F), rewrite (G)
//   SECTION 3 — GROWTH AREAS     : statement (B), include Yes (F), rewrite (G)
//   SECTION 4 — LEADERSHIP Qs    : question (B), include Yes (F)
//   SECTION 5 — STAFF VOICE      : quote (B), tag (D), include Yes (F)
//
// Sheet names look like "Poland Human Resources" — we match by the department label.

// Map an Excel sheet name (e.g. "Poland Human Resources") to an app dept key.
function matchDeptKeyFromSheet(sheetName, departments) {
  const clean = sheetName.replace(/^\s*\w+\s+/, "").trim().toLowerCase(); // drop leading country word
  // Grouped departments come as one combined tab in the director Excel.
  if (/jvk|josiah venture kid/.test(clean)) return { group: "JVK" };
  if (/language\s*&?\s*culture|language and culture/.test(clean)) return { group: "LC" };
  // Try exact label match first, then contains
  for (const d of departments) {
    const lbl = d.label.toLowerCase();
    if (clean === lbl) return { key: d.key };
  }
  for (const d of departments) {
    const lbl = d.label.toLowerCase();
    const lblCore = lbl.split("(")[0].split("—")[0].trim();
    const cleanCore = clean.split("(")[0].split("—")[0].trim();
    if (cleanCore && (lblCore.startsWith(cleanCore) || cleanCore.startsWith(lblCore))) return { key: d.key };
  }
  return null;
}

const isPlaceholder = (t) => {
  if (!t) return true;
  const s = String(t).trim();
  return !s ||
    s.includes("Type full replacement") ||
    s.includes("Note here if not") ||
    s.includes("Add your own") ||
    s.includes("do not change") ||
    s.includes("must not be changed") ||
    s.includes("Quote text must not");
};

const cell = (row, i) => {
  const v = row?.[i];
  return v === null || v === undefined ? "" : String(v).trim();
};
const isYes = (v) => String(v || "").trim().toLowerCase() === "yes";

// For grouped departments (JVK, L&C) the director's single Excel tab mixes both
// cultures; the culture is embedded in each statement's wording. Classify by cue.
// Returns "1st", "2nd", or "both".
function classifyCulture(text) {
  const t = String(text || "").toLowerCase();
  const has1 = /\b(first culture|1st culture)\b/.test(t);
  const has2 = /\b(second culture|2nd culture)\b/.test(t);
  const allP = /\ball (families|parents|staff|the)\b/.test(t);
  if (allP) return "both";
  if (has1 && has2) return "both";
  if (has1) return "1st";
  if (has2) return "2nd";
  return "both"; // no marker → applies to both cultures
}

// Which app sub-keys a grouped sheet fans out to.
const GROUP_SPLIT = {
  JVK: { first: "JVK1", second: "JVK2" },
  LC:  { first: "LC1",  second: "LC2"  },
};

// Route a list of items to {firstKey:[], secondKey:[]} by culture cue.
// "both" items are copied into each side.
function splitByCulture(items, firstKey, secondKey) {
  const out = { [firstKey]: [], [secondKey]: [] };
  for (const it of items) {
    const c = classifyCulture(it.rewrite?.trim() || it.text);
    if (c === "1st") out[firstKey].push(it);
    else if (c === "2nd") out[secondKey].push(it);
    else { out[firstKey].push({ ...it }); out[secondKey].push({ ...it }); }
  }
  return out;
}

async function parseDirectorReview(file, departments) {
  const { read, utils } = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb  = read(buf);

  const result = {};       // deptKey -> selections object
  const report = [];       // human-readable summary of what was imported
  const allInterpretations = []; // { deptKeys:[...], question, text } — Section 1 rewrites

  for (const sheetName of wb.SheetNames) {
    if (/summary/i.test(sheetName)) continue;
    const match = matchDeptKeyFromSheet(sheetName, departments);
    if (!match) { report.push(`⚠ Skipped sheet "${sheetName}" — no matching department`); continue; }

    const rows = utils.sheet_to_json(wb.Sheets[sheetName], { header:1, defval:null });

    // Find section boundaries by scanning column A
    let sec = null;
    const strengths = [], growth = [], leadershipQs = [], quotes = [];
    const interpretations = [];   // Section 1: director's reworded question interpretations
    let edits = 0, includes = 0;

    for (let r = 0; r < rows.length; r++) {
      const a = cell(rows[r], 0);
      if (/SECTION 1/i.test(a)) { sec = "questions"; continue; }
      if (/SECTION 2/i.test(a)) { sec = "strengths"; continue; }
      if (/SECTION 3/i.test(a)) { sec = "growth"; continue; }
      if (/SECTION 4/i.test(a)) { sec = "leadershipQs"; continue; }
      if (/SECTION 5/i.test(a)) { sec = "quotes"; continue; }
      if (/^Section$/i.test(a) || !a) continue; // header row or blank

      const B = cell(rows[r], 1), D = cell(rows[r], 3),
            E = cell(rows[r], 4), F = cell(rows[r], 5), G = cell(rows[r], 6);

      if (sec === "questions" && (/^Q$/i.test(a) || /^Burden/i.test(a))) {
        // Section 1 row: B = question text, G = director's interpretation rewrite.
        // Only capture when they actually typed a replacement (not the placeholder).
        if (B && !isPlaceholder(G)) {
          interpretations.push({ question: B, text: G });
          edits++;
        }
      }
      else if (sec === "strengths" && /^Strength/i.test(a)) {
        const rewrite = !isPlaceholder(G) ? G : "";
        if (rewrite) edits++;
        if (isYes(F)) includes++;
        strengths.push({ text: B, include: isYes(F), rewrite, isRefined:false });
      }
      else if (sec === "growth" && /^Growth/i.test(a)) {
        const rewrite = !isPlaceholder(G) ? G : "";
        if (rewrite) edits++;
        if (isYes(F)) includes++;
        growth.push({ text: B, include: isYes(F), rewrite, isRefined:false });
      }
      else if (sec === "leadershipQs" && /^Leader/i.test(a)) {
        if (isPlaceholder(B)) continue;
        if (isYes(F)) includes++;
        leadershipQs.push({ text: B, include: isYes(F), rewrite:"", isRefined:false });
      }
      else if (sec === "leadershipQs" && /^Write-in/i.test(a)) {
        if (isPlaceholder(B)) continue;               // skip empty write-in prompts
        if (isYes(F)) includes++;
        leadershipQs.push({ text: B, include: isYes(F), rewrite:"", isRefined:false });
      }
      else if (sec === "quotes" && /^Quote/i.test(a)) {
        // Quote text may carry an inline "Translation:" line — split it so the app shows both.
        let original = B, translation = null, isOriginalLang = false;
        const tIdx = B.search(/\n+\s*Translation:/i);
        if (tIdx !== -1) {
          original = B.slice(0, tIdx).trim().replace(/^"|"$/g, "");
          translation = B.slice(tIdx).replace(/^\s*\n+\s*Translation:\s*/i, "").trim().replace(/^"|"$/g, "");
          isOriginalLang = true;
        } else {
          original = B.replace(/^"|"$/g, "");
        }
        if (isYes(F)) includes++;
        quotes.push({ text: original, translation, isOriginalLang, include: isYes(F), rewrite:"", isRefined:false });
      }
    }

    if (match.group) {
      // Grouped dept (JVK / L&C): fan out to 1st / 2nd culture sub-keys by cue.
      const { first, second } = GROUP_SPLIT[match.group];
      const s = splitByCulture(strengths, first, second);
      const g = splitByCulture(growth, first, second);
      const l = splitByCulture(leadershipQs, first, second);
      const q = splitByCulture(quotes, first, second);
      result[first]  = { strengths: s[first],  growth: g[first],  leadershipQs: l[first],  quotes: q[first]  };
      result[second] = { strengths: s[second], growth: g[second], leadershipQs: l[second], quotes: q[second] };
      interpretations.forEach(it => allInterpretations.push({ deptKeys:[first, second], question: it.question, text: it.text }));
      report.push(`✓ ${sheetName} → split ${first} / ${second}: ${strengths.length} strengths, ${growth.length} growth, ${leadershipQs.length} leadership Qs, ${quotes.length} quotes routed by culture · ${includes} included, ${edits} rewritten`);
    } else {
      result[match.key] = { strengths, growth, leadershipQs, quotes };
      interpretations.forEach(it => allInterpretations.push({ deptKeys:[match.key], question: it.question, text: it.text }));
      report.push(`✓ ${sheetName} → ${match.key}: ${strengths.length} strengths, ${growth.length} growth, ${leadershipQs.length} leadership Qs, ${quotes.length} quotes · ${includes} included, ${edits} rewritten`);
    }
  }

  return { selections: result, report, interpretations: allInterpretations };
}

// ─── CONTENT GENERATION ──────────────────────────────────────────────────────
// Strengths and growth come from Survey Basics (approved source of truth).
// Leadership questions and quote selection use AI since they require reading open responses.
// Translate any non-English quotes that are missing a translation.
// Works on the app's quote-item shape {text, translation, isOriginalLang, ...}.
// Returns the same array with translations filled where possible. Resilient:
// if the API is unavailable it returns the quotes unchanged.
async function translateMissingQuotes(quotes) {
  // Find quotes that look non-English AND have no translation yet
  const needing = [];
  quotes.forEach((q, i) => {
    const text = (q.text || q.original || "").trim();
    const hasTrans = q.translation && String(q.translation).trim();
    const nonEng = q.isOriginalLang || looksNonEnglish(text);
    if (text && nonEng && !hasTrans) needing.push({ i, text });
  });
  if (!needing.length) return quotes;

  const prompt = `Translate each of the following survey responses into natural English. ` +
    `They may be in Polish, Romanian, Hungarian, Czech, or another language. ` +
    `Return ONLY a JSON array of objects, no markdown, in the same order:\n` +
    `[{"i": <the number>, "translation": "<English translation>"}]\n\n` +
    needing.map(n => `${n.i}. "${n.text}"`).join("\n");

  const res = await fetch("/.netlify/functions/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  // Read the raw response so we can report exactly what went wrong.
  const rawBody = await res.text();
  if (!res.ok) {
    // Surface the real HTTP error (e.g. 500 API key not configured, 404 function missing)
    throw new Error(`Function returned HTTP ${res.status}: ${rawBody.slice(0, 300)}`);
  }

  let data;
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`Function response was not JSON: ${rawBody.slice(0, 300)}`); }

  if (data.error) {
    throw new Error(`API error: ${typeof data.error === "string" ? data.error : JSON.stringify(data.error).slice(0,300)}`);
  }

  const text = data.content?.find(b => b.type === "text")?.text;
  if (!text) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(data).slice(0, 300)}`);
  }

  let arr;
  try { arr = JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch { throw new Error(`Translation JSON parse failed. Model returned: ${text.slice(0, 300)}`); }

  const byIdx = {};
  for (const item of arr) if (item && typeof item.i === "number") byIdx[item.i] = item.translation;

  return quotes.map((q, i) => {
    if (byIdx[i]) return { ...q, translation: byIdx[i], isOriginalLang: true };
    return q;
  });
}

async function generateDeptContent(dept) {
  const deptSBList = getSurveyBasics(dept.key);

  // Helper: pick the right Survey Basics interpretation level for a question
  const getSBText = (qText, status) => {
    const m = findSurveyBasics(dept.key, qText);
    if (!m) return '';
    return status === 'Healthy' ? m.high : status === 'Watch' ? m.mid : m.low;
  };

  // Build strengths from Healthy questions and growth from Concern/Watch questions
  // using the correct level of Survey Basics interpretation
  const strengths = dept.questions
    .filter(q => q.status === 'Healthy')
    .map(q => getSBText(q.en, 'Healthy'))
    .filter(Boolean);
  const growth = dept.questions
    .filter(q => q.status === 'Concern' || q.status === 'Watch')
    .sort((a,b) => a.score - b.score)
    .slice(0, 4)
    .map(q => getSBText(q.en, q.status))
    .filter(Boolean);

  // Leadership questions: build a deterministic fallback from the department's
  // weakest questions so there are ALWAYS options — the AI (if reachable) can
  // replace these with sharper ones, but we never show an empty section.
  const weakQs = dept.questions
    .filter(q => q.status === 'Concern' || q.status === 'Watch')
    .sort((a,b) => a.score - b.score)
    .slice(0, 4);
  let leadershipQs = weakQs.map(q =>
    `Looking at "${q.en.replace(/\.$/, '')}" — what do you think is driving this, and what would help your team here?`
  );
  // Always include solid generic prompts as backup options so the section is never empty
  leadershipQs.push(
    `What is one change that would most improve staff experience in ${dept.label} this year?`,
    `Where do you see the biggest gap between what staff need and what they currently receive?`
  );
  // Fallback: first 6 responses as bilingual objects
  let quotes = dept.openResponses.slice(0, 6).map(r =>
    typeof r === 'string'
      ? { original: r, translation: null, isOriginalLang: false }
      : { original: r.text, translation: null, isOriginalLang: r.isOriginalLang }
  );

  if (dept.openResponses.length > 0) {
    try {
      const prompt = `You are helping prepare a JV (Josiah Venture) People & Culture Pulse Report for the ${dept.label} department. This report goes to the department's leader.

Department overall status: ${dept.status} (average score: ${dept.avg} out of 5, n=${dept.n} respondents).
Scoring: Healthy >= 3.50, Watch 2.50-3.49, Concern < 2.50. Lower scores mean staff are struggling more in that area.

Concern-level questions (the most serious):
${dept.questions.filter(q=>q.status==='Concern').map(q=>`- ${q.score?.toFixed(2)} "${q.en}"`).join('\n')||'None'}

Watch-level questions (mixed / emerging):
${dept.questions.filter(q=>q.status==='Watch').map(q=>`- ${q.score?.toFixed(2)} "${q.en}"`).join('\n')||'None'}

What staff said in their own words (verbatim — some in the local language, some in English):
${dept.openResponses.map((r,i)=>`${i+1}. [${r.isOriginalLang?'NON-ENGLISH':'ENGLISH'}] "${r.text}"`).join('\n')}

Write exactly TWO leadership questions for this department's leader. These are the most important part of the report. Their purpose is NOT to hand the leader a conclusion, but to help the leader personally reflect and figure out how to GO LEARN what is really happening with their team.

Guidelines for the two questions:
- Ground them in this department's actual weakest areas and what staff wrote above — not generic management advice.
- Calibrate the tone to the overall status. For a Concern department, the questions should help the leader confront a real, significant gap honestly. For Watch, help them investigate something mixed or emerging before it worsens. For Healthy, help them protect and build on a strength while staying curious about blind spots.
- Each question should prompt the leader to think about HOW they will find this information out about their team — what conversations to have, what to observe, who to ask — rather than assuming they already know the answer.
- Make them open, non-defensive, and genuinely thought-provoking. Avoid yes/no questions. Avoid jargon.
- Write them so a busy ministry leader would pause and actually think.

Return ONLY valid JSON (no markdown):
{
  "leadershipQs": ["first thoughtful question", "second thoughtful question"],
  "quotes": [
    {
      "original": "the verbatim response exactly as written",
      "translation": "English translation if the response is non-English, otherwise null",
      "isOriginalLang": true or false
    }
  ]
}
For quotes: select 4-6 of the most representative responses. For non-English responses, provide an accurate English translation. For English responses, set translation to null.`;

      const res = await fetch("/.netlify/functions/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 3000,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json();
      const text = data.content?.find(b => b.type === "text")?.text || "{}";
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (parsed.leadershipQs?.length) leadershipQs = parsed.leadershipQs;
      if (parsed.quotes?.length) {
        // Normalise — handle both old string format and new object format
        quotes = parsed.quotes.map(q =>
          typeof q === 'string'
            ? { original: q, translation: null, isOriginalLang: false }
            : q
        );
      }
    } catch(e) {
      console.warn("AI generation failed for", dept.key, e.message);
    }
  }

  return { strengths, growth, leadershipQs, quotes };
}

// Detect if text is likely non-English (simple heuristic — works for Polish, Romanian, Hungarian)
function looksNonEnglish(text) {
  if (!text || text.length < 5) return false;
  // Detect diacritics / language-specific letters (Polish, Romanian, Hungarian, Czech, etc.)
  // Polish text is mostly ASCII with only a few accented chars, so an ASCII-ratio test fails —
  // detecting the presence of these characters is far more reliable.
  const diacritics = text.match(/[ąćęłńóśźżäöüßàâçéèêëîïôûùÿœáíúőűăîșțčřšžě]/gi);
  if (diacritics && diacritics.length >= 2) return true;
  const letters = text.replace(/[^a-zA-ZÀ-ɏ]/g, '');
  const ascii   = text.replace(/[^a-zA-Z]/g, '');
  return letters.length > 8 && (ascii.length / letters.length) < 0.92;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  // ── AUTH GATE ──
  // "checking" while we ask the server if login is on; "open" if it's off (app
  // works as before); "needLogin" / "authed" once it's on. Fails OPEN so an
  // unconfigured deploy or a hiccup never locks anyone out.
  const [authGate, setAuthGate] = useState("checking");
  const [authUser, setAuthUser] = useState(() => getUser());
  useEffect(() => {
    let alive = true;
    (async () => {
      const { enabled } = await authStatus();
      if (!alive) return;
      if (!enabled) setAuthGate("open");
      else setAuthGate(tokenValid() ? "authed" : "needLogin");
    })();
    return () => { alive = false; };
  }, []);
  const signOut = () => { logout(); setAuthUser(null); setAuthGate("needLogin"); };

  // When to loud than silent: a data call whose token was rejected (401) fires a
  // "pulse:unauthorized" event. Return to login (soft, no reload). If it happens
  // right after a successful sign-in, the session is being rejected on arrival —
  // a server-side sign-in-key mismatch, not an expiry — so say so instead of
  // silently bouncing (which would look like a flashing loop).
  const [authNotice, setAuthNotice] = useState("");
  const loginAtRef = useRef(0);
  useEffect(() => {
    const onUnauthorized = () => {
      logout();
      setAuthUser(null);
      if (Date.now() - loginAtRef.current < 8000) {
        setAuthNotice("You signed in, but the app couldn't load your data — the session was rejected. This is a site setup issue (the sign-in key), not your password. Please tell Mel or Chris.");
      }
      setAuthGate("needLogin");
    };
    window.addEventListener("pulse:unauthorized", onUnauthorized);
    return () => window.removeEventListener("pulse:unauthorized", onUnauthorized);
  }, []);

  const [view, setViewRaw]        = useState("sections");   // sections | home | review | report | dashboard | country | leadership | users
  // Navigation history so every "← Back" retraces the layers you came through,
  // no matter which path you took to get here. setView() records the jump; goBack
  // pops it. Same-view navigations aren't recorded (avoids dead back steps).
  const [navHistory, setNavHistory] = useState([]);
  const goBack = () => {
    setNavHistory(h => {
      if (!h.length) { setViewRaw("sections"); return h; }
      setViewRaw(h[h.length - 1]);
      return h.slice(0, -1);
    });
  };
  // Any component can trigger a real "back" by calling setView("__back__") — no
  // new prop needed. Other values push the current view onto the history stack.
  const setView = (next) => {
    if (next === "__back__") { goBack(); return; }
    setNavHistory(h => (next !== view ? [...h, view] : h));
    setViewRaw(next);
  };
  const [openToDept, setOpenToDept] = useState(null);   // deptKey to jump to when the review opens (from the P&C home)
  // Admin mode (Mel & Chris only) — shared across screens, remembered per device.
  const [isAdmin, setIsAdmin] = useState(() => {
    try { return localStorage.getItem("pulse:admin") === "1"; } catch { return false; }
  });
  const toggleAdmin = () => {
    setIsAdmin(prev => {
      if (!prev) {
        const ok = window.confirm("Turn on admin tools? (Survey upload, Import, Generate Report, and AI tools.) These are for the People & Culture admins — Mel & Chris.");
        if (!ok) return prev;
      }
      const next = !prev;
      try { localStorage.setItem("pulse:admin", next ? "1" : "0"); } catch {}
      return next;
    });
  };
  // Simple identity: who is using the app on this device. Notes are attributed to
  // this name, and the private/public model uses it. Remembered per device.
  const [me, setMe] = useState(() => {
    try { return localStorage.getItem("pulse:me") || ""; } catch { return ""; }
  });
  const saveMe = (name) => {
    const n = (name || "").trim();
    setMe(n);
    try { localStorage.setItem("pulse:me", n); } catch {}
  };
  // P&C leadership (Mel & Chris) see every note regardless of private/public.
  const isPCLead = isAdmin;   // admins are Mel & Chris — the P&C leadership

  // ── Role wiring ── When login is on, the account's role decides access (the
  // manual lock only applies in the auth-off state). Leader = full admin;
  // country/director = not. Identity for notes comes from the account.
  const authed = !!authUser && authGate === "authed";
  const authRole = authUser && authUser.role;

  // ── Preview-as ── A leader (Mel & Chris) can look at the app exactly as a
  // country leader or a P&C director sees it, without logging out. previewAs is
  // null normally, or { role, country?, department?, label }. Only a real leader
  // may preview; everyone else ignores it. The whole UI below renders against
  // the *view* identity (viewRole / viewUser), so gating, cards, locks and
  // headers all follow. NOTE: this reshapes what a leader SEES; the server still
  // holds the leader's real token, so this is a visual walkthrough, not a
  // sandbox — edit controls are hidden in the previewed roles anyway.
  const [previewAs, setPreviewAs] = useState(null);
  const canPreview = authed && authRole === "leader";
  const preview = canPreview ? previewAs : null;
  const viewRole = preview ? preview.role : authRole;
  const viewUser = preview
    ? { ...authUser, role: preview.role, country: preview.country || "", department: preview.department || "" }
    : authUser;
  const exitPreview = () => { setPreviewAs(null); setView("leadership"); };

  const effIsAdmin  = authed ? viewRole === "leader" : isAdmin;
  const effIsPCLead = authed ? viewRole === "leader" : isPCLead;
  const effMe       = authed ? (authUser.name || me) : me;
  // P&C directors are international: they own one or more departments (comma-
  // separated codes) and work ACROSS every country. authDepts is that set.
  const authDepts   = authed && viewRole === "director"
    ? String(viewUser.department || "").split(",").map(s => s.trim()).filter(Boolean)
    : [];
  // A director may edit only their own department(s), in any country; leaders
  // (and the auth-off state) edit any; a country leader edits none. The server
  // enforces this regardless — this is the in-app guardrail.
  const canEditDept = (deptKey) => {
    if (!authed) return true;
    if (viewRole === "leader") return true;
    if (viewRole === "director") return authDepts.includes(deptKey);
    return false; // country (view-only)
  };

  const [country, setCountry]     = useState("");
  const [year, setYear]           = useState(new Date().getFullYear().toString());
  const [surveyData, setSurveyData] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState({});
  const [selections, setSelections] = useState({});    // { deptKey: { strengths:[{text,include,rewrite}], ... } }
  const [saved, setSaved]         = useState(false);
  // Autosync status: "idle" | "saving" | "saved" | "error". Shown as a quiet indicator.
  const [syncStatus, setSyncStatus] = useState("idle");
  const syncTimer = useRef(null);
  const lastSyncedRef = useRef("");   // JSON of last-synced selections, to skip no-op saves
  const skipNextSyncRef = useRef(true); // don't autosync the very first load of a run
  const syncInFlightRef = useRef(false); // guard so overlapping saves can't race/duplicate
  const [dashCountry, setDashCountry] = useState("all");
  const [allRuns, setAllRuns]     = useState([]);       // from storage
  const [runsLoading, setRunsLoading] = useState(true);
  const fileRef = useRef();

  // Load historical runs: local first (instant), then the SHARED list from Airtable
  // so any device — phone, Chris's laptop — sees every uploaded run, not just what's
  // in this browser's storage.
  useEffect(() => {
    (async () => {
      // 1. local copy first, so the list isn't empty while Airtable loads
      try {
        const _v = localStorage.getItem("pulse:runs");
        if (_v) {
          const loaded = JSON.parse(_v).map((run, i) => ({ ...run, id: run.id || `${run.country}-${run.year}-${i}` }));
          setAllRuns(loaded);
        }
      } catch {}
      // 2. shared list from Airtable — merge by country+year (Airtable wins)
      setRunsLoading(true);
      try {
        const shared = await loadAllRuns();
        if (shared && shared.length) {
          setAllRuns(prev => {
            const byKey = {};
            (prev || []).forEach(r => { byKey[`${r.country}-${r.year}`] = r; });
            shared.forEach(r => { byKey[`${r.country}-${r.year}`] = { ...(byKey[`${r.country}-${r.year}`]||{}), ...r }; });
            return Object.values(byKey);
          });
        }
      } catch (e) {
        console.warn("Airtable run list load failed, using local only:", e.message);
      }
      setRunsLoading(false);
    })();
  }, []);

  // Load refinements (cross-country learned rewrites) on startup
  const [refinements, setRefinements] = useState(() => {
    try { const r = localStorage.getItem("pulse:refinements"); return r ? JSON.parse(r) : {}; }
    catch { return {}; }
  });

  const saveRefinement = (deptKey, section, idx, text) => {
    const key = `${deptKey}:${section}:${idx}`;
    const updated = { ...refinements, [key]: { text, savedAt: new Date().toISOString() } };
    setRefinements(updated);
    try { localStorage.setItem("pulse:refinements", JSON.stringify(updated)); } catch(e) {}
  };

  // Survey Basics interpretation overrides — a director's reworded interpretation for
  // a specific question. Keyed country:year:deptKey:normalizedQuestion. Persisted.
  const [sbOverrides, setSbOverrides] = useState(() => {
    try { const r = localStorage.getItem("pulse:sbOverrides"); return r ? JSON.parse(r) : {}; }
    catch { return {}; }
  });
  const saveSbOverride = (deptKey, qText, text) => {
    const key = `${country}:${year}:${deptKey}:${normQ(qText)}`;
    const updated = { ...sbOverrides };
    if (text && text.trim()) updated[key] = text.trim();
    else delete updated[key];   // empty clears the override
    setSbOverrides(updated);
    try { localStorage.setItem("pulse:sbOverrides", JSON.stringify(updated)); } catch(e) {}
    // Share the edit: push THIS department's overrides to its Airtable record (debounced),
    // so the "(edited)" marker shows for everyone reviewing this run — not just this device.
    syncSbOverridesForDept(deptKey, updated);
  };

  // Debounced per-department push of Survey Basics overrides to Airtable.
  const sbSyncTimers = useRef({});
  const syncSbOverridesForDept = (deptKey, allOverrides) => {
    if (!country || !year || !surveyData?.depts?.[deptKey]) return;
    const prefix = `${country}:${year}:${deptKey}:`;
    // slice out just this department's edits
    const slice = {};
    Object.entries(allOverrides).forEach(([k, v]) => { if (k.startsWith(prefix)) slice[k] = v; });
    if (sbSyncTimers.current[deptKey]) clearTimeout(sbSyncTimers.current[deptKey]);
    sbSyncTimers.current[deptKey] = setTimeout(async () => {
      try {
        const runName = `${country} ${year}`;
        const d = surveyData.depts[deptKey];
        const runId = await upsertRun({ country, year, status: "In Review",
          // Only send a count when we actually have the raw rows (a fresh upload).
          // A reloaded run has raw=[] → length 0; sending 0 would clobber the
          // stored unique count, so pass null to leave the run's value intact.
          overallAvg: null, respondents: surveyData?.raw?.length || null });
        await upsertDepartment(runId, runName, {
          key: deptKey, label: d.label, avg: d.avg, status: d.status, n: d.n,
          openQLabel: d.openQLabel,
          surveyDataJSON: JSON.stringify({ questions: d.questions || [] }).slice(0, 95000),
          sbOverridesJSON: JSON.stringify(slice),
        });
      } catch (e) { console.warn("SB override sync failed:", e.message); }
    }, 1200);
  };

  // MASTER Survey Basics interpretations — the shared default each report uses for
  // a question + score band. Editing a Survey Basics line writes here, so the edit
  // becomes the default in every report going forward. Keyed sbKey:normQuestion:level
  // (e.g. "hr:...:low"). Persisted to Airtable (shared) with a localStorage cache.
  const [sbMaster, setSbMaster] = useState(() => {
    try { const r = localStorage.getItem("pulse:sbMaster"); return r ? JSON.parse(r) : {}; }
    catch { return {}; }
  });
  // Pull the shared masters from Airtable on load and cache them.
  useEffect(() => {
    loadSurveyBasicsMaster().then(m => {
      if (m && Object.keys(m).length) {
        setSbMaster(m);
        try { localStorage.setItem("pulse:sbMaster", JSON.stringify(m)); } catch {}
      }
    }).catch(e => console.warn("Survey Basics master load failed:", e.message));
  }, []);
  // Save an edited interpretation as the master default (empty text restores the
  // built-in default). Updates the cache immediately, then persists to Airtable.
  const saveSbMaster = (sbKey, qText, level, text) => {
    const key = `${sbKey}:${normQ(qText)}:${level}`;
    const clean = (text || "").trim();
    const updated = { ...sbMaster };
    if (clean) updated[key] = clean; else delete updated[key];
    setSbMaster(updated);
    try { localStorage.setItem("pulse:sbMaster", JSON.stringify(updated)); } catch(e) {}
    saveSurveyBasicsMaster({ key, sbKey, question: qText, level, text: clean, author: effMe })
      .catch(e => console.warn("Survey Basics master save failed:", e.message));
  };

  // Loading indicator while pulling the shared version from Airtable.
  const [cloudLoading, setCloudLoading] = useState(false);

  // When a run opens (country+year set), load the SHARED version from Airtable
  // (source of truth). Fall back to the local copy if Airtable is empty/unreachable,
  // so the app still works offline or before the first push.
  useEffect(() => {
    if (!country || !year) return;
    let cancelled = false;
    skipNextSyncRef.current = true;   // loading a run is not an edit — don't autosync it back
    // start from local immediately so nothing flashes empty
    try {
      const raw = localStorage.getItem(`pulse:sel:${country}:${year}`);
      if (raw) setSelections(JSON.parse(raw));
    } catch(e) {}
    // then pull the shared version and use it if present
    (async () => {
      setCloudLoading(true);
      try {
        const shared = await loadRunSelections(country, year);
        if (!cancelled && shared && Object.keys(shared).length) {
          setSelections(shared);
          try { localStorage.setItem(`pulse:sel:${country}:${year}`, JSON.stringify(shared)); } catch {}
        }
      } catch (e) {
        // Airtable unreachable — keep the local copy already loaded above.
        console.warn("Airtable load failed, using local copy:", e.message);
      }
      if (!cancelled) setCloudLoading(false);
    })();
    return () => { cancelled = true; };
  }, [country, year]);

  // ── AUTOSYNC ──────────────────────────────────────────────────────────────
  // Whenever the review selections change (a director edits an include, rewrite,
  // translation, etc.), save automatically: to localStorage immediately, and to
  // Airtable after a short debounce. No manual push button, so nothing to forget
  // or double-press. Each department's save deletes its existing selection rows
  // before recreating them (see saveSelections), so re-saving replaces rather
  // than appends — no duplicate items accumulate.
  useEffect(() => {
    if (!country || !year) return;
    const snapshot = JSON.stringify(selections || {});
    // skip empty, unchanged, or the initial load of a run
    if (!selections || !Object.keys(selections).length) return;
    if (skipNextSyncRef.current) { skipNextSyncRef.current = false; lastSyncedRef.current = snapshot; return; }
    if (snapshot === lastSyncedRef.current) return;

    // local save is instant
    try { localStorage.setItem(`pulse:sel:${country}:${year}`, JSON.stringify(selections)); } catch {}

    // debounce the Airtable save so rapid edits collapse into one write
    if (syncTimer.current) clearTimeout(syncTimer.current);
    setSyncStatus("saving");
    syncTimer.current = setTimeout(async () => {
      if (syncInFlightRef.current) {
        // a save is already running — reschedule this one shortly after
        if (syncTimer.current) clearTimeout(syncTimer.current);
        syncTimer.current = setTimeout(() => setSelections(s => ({ ...s })), 800);
        return;
      }
      syncInFlightRef.current = true;
      try {
        const runName = `${country} ${year}`;
        // ensure the run exists, then save each department's selections
        const runId = await upsertRun({
          country, year, status: "In Review",
          overallAvg: surveyData?.depts
            ? (() => { const d = Object.values(surveyData.depts).filter(x=>x.avg); return d.length ? d.reduce((a,x)=>a+parseFloat(x.avg||0),0)/d.length : null; })()
            : null,
          // See note above: 0 (reloaded run) → null so we never overwrite the
          // stored unique respondent count with a double-counted/empty value.
          respondents: surveyData?.raw?.length || null,
        });
        for (const [deptKey, sel] of Object.entries(selections)) {
          const d = surveyData?.depts?.[deptKey];
          if (!d) continue;
          const deptRecId = await upsertDepartment(runId, runName, {
            key: deptKey, label: d.label, avg: d.avg, status: d.status, n: d.n,
            openQLabel: d.openQLabel,
            surveyDataJSON: JSON.stringify({ questions: d.questions || [] }).slice(0, 95000),
          });
          await atSaveSelections(deptRecId, sel);
        }
        lastSyncedRef.current = snapshot;
        setSyncStatus("saved");
        setTimeout(() => setSyncStatus(s => s === "saved" ? "idle" : s), 2500);
      } catch (e) {
        console.warn("Autosync failed:", e.message);
        setSyncStatus("error");
      } finally {
        syncInFlightRef.current = false;
      }
    }, 1500);

    return () => { if (syncTimer.current) clearTimeout(syncTimer.current); };
  }, [selections, country, year, surveyData]);

  const saveRun = async (data) => {
    const run = {
      id: `${country}-${year}-${Date.now()}`,
      country, year,
      // Run-level unique respondents = number of survey rows (one per person).
      // Never derive this by summing per-department n's — staff who serve on
      // more than one team answer for each, so a sum double-counts them.
      respondents: data?.raw?.length || null,
      depts: Object.values(data.depts).map(d => ({
        key: d.key, label: d.label, group: d.group,
        avg: d.avg, status: d.status, n: d.n,
      })),
      savedAt: new Date().toISOString(),
    };
    const runs = [...allRuns.filter(r => !(r.country===country && r.year===year)), run];
    setAllRuns(runs);
    try { localStorage.setItem("pulse:runs", JSON.stringify(runs)); } catch(e) {}
    try { localStorage.setItem(`pulse:data:${country}:${year}`, JSON.stringify(data)); } catch(e) {}
  };

  const handleFile = async (file) => {
    if (!country || !year) { alert("Enter country and year first."); return; }
    setGenerating(true);
    setGenProgress({ step: "Parsing survey file…" });
    try {
      const data = await parseSurveyFile(file);
      setSurveyData(data);
      setGenProgress({ step: "Generating draft content with AI…" });

      // Generate AI content for each dept
      const sels = {};
      const depts = Object.values(data.depts).filter(d => d.n > 0);
      // Read current refinements from localStorage
      let currentRefinements = {};
      try { const r = localStorage.getItem("pulse:refinements"); currentRefinements = r ? JSON.parse(r) : {}; } catch {}

      for (let i=0; i<depts.length; i++) {
        const d = depts[i];
        setGenProgress({ step: `Generating content for ${d.label} (${i+1}/${depts.length})…` });
        const gen = await generateDeptContent(d, country);

        const applyRefinements = (section, items) =>
          items.map((t, idx) => {
            const key = `${d.key}:${section}:${idx}`;
            const refined = currentRefinements[key];
            // quotes are objects — AI gen uses {original}, import uses {text}; accept both
            const isObj = section === 'quotes' && typeof t === 'object' && t !== null;
            const textVal = isObj ? (t.original ?? t.text ?? '') : t;
            return {
              text: textVal,
              translation: isObj ? (t.translation ?? null) : null,
              isOriginalLang: isObj ? !!t.isOriginalLang : false,
              include: true,
              rewrite: refined ? refined.text : "",
              isRefined: !!refined,
            };
          });

        sels[d.key] = {
          strengths:    applyRefinements("strengths",    gen.strengths    || []),
          growth:       applyRefinements("growth",       gen.growth       || []),
          leadershipQs: applyRefinements("leadershipQs", gen.leadershipQs || []),
          quotes:       applyRefinements("quotes",       gen.quotes       || []),
        };
      }
      setSelections(sels);
      await saveRun(data);
      setView("review");
    } catch(e) {
      alert("Error parsing file: " + e.message);
    } finally {
      setGenerating(false);
      setGenProgress({});
    }
  };

  // Persist selections whenever they change
  useEffect(() => {
    if (country && year && Object.keys(selections).length > 0) {
      try { localStorage.setItem(`pulse:sel:${country}:${year}`, JSON.stringify(selections)); } catch(e) {}
    }
  }, [selections, country, year]);

  const saveSelections = async () => {
    try { localStorage.setItem(`pulse:sel:${country}:${year}`, JSON.stringify(selections)); } catch(e) {}
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggleItem = (deptKey, section, idx) => {
    setSelections(prev => {
      const d = { ...prev[deptKey] };
      d[section] = d[section].map((item,i) => i===idx ? { ...item, include:!item.include } : item);
      return { ...prev, [deptKey]: d };
    });
  };

  const setRewrite = (deptKey, section, idx, val) => {
    setSelections(prev => {
      const d = { ...prev[deptKey] };
      d[section] = d[section].map((item,i) => i===idx ? { ...item, rewrite:val } : item);
      return { ...prev, [deptKey]: d };
    });
  };

  // Add a blank, included item to a section so a director can write one in when
  // none were generated (e.g. JVK 1st-culture strengths). Autosync persists it.
  const addItem = (deptKey, section) => {
    setSelections(prev => {
      const d = { ...(prev[deptKey] || {}) };
      const list = Array.isArray(d[section]) ? d[section] : [];
      d[section] = [...list, { text: "", rewrite: "", include: true, isRefined: false }];
      return { ...prev, [deptKey]: d };
    });
  };

  const getApproved = (deptKey, section) =>
    (selections[deptKey]?.[section] || [])
      .filter(i => i.include)
      .map(i => {
        const text = i.rewrite.trim() || i.text;
        // For quotes, preserve translation metadata so display can show both languages
        if (section === 'quotes') {
          return { text, translation: i.translation || null, isOriginalLang: !!i.isOriginalLang };
        }
        return text;
      });

  // Mark a department's review finished / reopen it. Updates the in-memory
  // surveyData (so the checklist reflects it instantly), the local cache, and
  // the shared Airtable "Review Status" field so Mel & Chris see it anywhere.
  const toggleDeptFinished = (deptKey) => {
    if (!surveyData?.depts?.[deptKey]) return;
    const next = !surveyData.depts[deptKey].reviewDone;
    setSurveyData(prev => {
      if (!prev?.depts?.[deptKey]) return prev;
      const updated = { ...prev, depts: { ...prev.depts,
        [deptKey]: { ...prev.depts[deptKey], reviewDone: next } } };
      try { localStorage.setItem(`pulse:data:${country}:${year}`, JSON.stringify(updated)); } catch {}
      return updated;
    });
    // Mirror into the run list so the leaders' dashboard reflects it live.
    setAllRuns(prev => prev.map(r =>
      (String(r.country) === String(country) && String(r.year) === String(year))
        ? { ...r, depts: (r.depts || []).map(d => d.key === deptKey ? { ...d, reviewDone: next } : d) }
        : r));
    setDepartmentReviewStatus(country, year, deptKey, next)
      .catch(e => console.warn("Review status sync failed:", e.message));
  };

  // Re-pull the shared run list (with each department's finished state) from
  // Airtable — used by the leaders' dashboard's Refresh button.
  const reloadRuns = async () => {
    try {
      const shared = await loadAllRuns();
      if (shared && shared.length) {
        setAllRuns(prev => {
          const byKey = {};
          (prev || []).forEach(r => { byKey[`${r.country}-${r.year}`] = r; });
          shared.forEach(r => { byKey[`${r.country}-${r.year}`] = { ...(byKey[`${r.country}-${r.year}`]||{}), ...r }; });
          return Object.values(byKey);
        });
      }
    } catch (e) { console.warn("Run reload failed:", e.message); }
  };

  // Open a run into the Director Review — used by the leaders' dashboard to
  // drill into a run for the full detail. Loads local cache first, then merges
  // the shared Airtable data (survey scores, selections, sb overrides).
  const openRunShared = async (run, targetView = "review") => {
    setCountry(run.country); setYear(run.year);
    setOpenToDept(null);
    let haveData = false;
    try {
      const _v = localStorage.getItem(`pulse:data:${run.country}:${run.year}`);
      if (_v) { setSurveyData(JSON.parse(_v)); haveData = true; }
      const _s = localStorage.getItem(`pulse:sel:${run.country}:${run.year}`);
      if (_s) setSelections(JSON.parse(_s));
    } catch {}
    setView(targetView);
    try {
      const sd = await loadRunSurveyData(run.country, run.year);
      if (sd?.sbOverrides && Object.keys(sd.sbOverrides).length) {
        setSbOverrides(prev => { const m = { ...prev, ...sd.sbOverrides };
          try { localStorage.setItem("pulse:sbOverrides", JSON.stringify(m)); } catch {} return m; });
      }
      if (sd && Object.keys(sd.depts).length) {
        setSurveyData(sd);
        try { localStorage.setItem(`pulse:data:${run.country}:${run.year}`, JSON.stringify(sd)); } catch {}
      }
      if (!haveData) {
        const shared = await loadRunSelections(run.country, run.year);
        if (shared && Object.keys(shared).length) {
          setSelections(shared);
          try { localStorage.setItem(`pulse:sel:${run.country}:${run.year}`, JSON.stringify(shared)); } catch {}
        }
      }
    } catch (e) { console.warn("Open run failed:", e.message); }
  };
  const openReport = (run) => openRunShared(run, "report");

  // Import a completed director-review Excel from the Leadership section. The
  // country is read from the file's sheet names, we open that country's latest
  // run, and the review applies the import (via pendingImport) once it's loaded.
  const [pendingImport, setPendingImport] = useState(null);
  const startDirectorReviewImport = async (file) => {
    if (!file) return;
    let detected = "";
    try {
      const { read } = await import("xlsx");
      const wb = read(await file.arrayBuffer());
      const summary = wb.SheetNames.find(n => /summary/i.test(n)) || wb.SheetNames[0] || "";
      detected = summary.replace(/\s*summary\s*/i, "").trim();
    } catch (e) { window.alert("Couldn't read that file: " + e.message); return; }
    const run = [...allRuns]
      .filter(r => String(r.country || "").toLowerCase() === detected.toLowerCase())
      .sort((a, b) => Number(b.year) - Number(a.year))[0];
    if (!run) { window.alert(`No pulse run found for "${detected || "that file"}". Upload the survey for that country first, then import the director review.`); return; }
    setPendingImport(file);
    openRunShared(run, "review");
  };

  // ── AUTH GATE ── (only intercepts when login is switched on)
  if (authGate === "checking") return (
    <div style={{ minHeight:"100vh", background:"#F6F1E8", fontFamily:"'Inter',system-ui,sans-serif",
      display:"flex", alignItems:"center", justifyContent:"center", color:"#7A6F63", fontSize:14 }}>Loading…</div>
  );
  if (authGate === "needLogin") return (
    <Login sessionError={authNotice}
      onLogin={(u) => { loginAtRef.current = Date.now(); setAuthNotice(""); setAuthUser(u); setAuthGate("authed"); }} />
  );

  // ── VIEWS ──────────────────────────────────────────────────────────────────
  // Every view is wrapped so a previewing leader always has an "Exit preview"
  // bar, no matter how deep they've navigated into a role's screens. It's a
  // sticky bar at the very top (in normal flow, so it pushes content down and
  // can never be clipped or hidden behind the OS dock) that stays put as you
  // scroll.
  const wrap = (el) => preview ? (
    <div>
      <PreviewBanner preview={preview} onExit={exitPreview} />
      {el}
    </div>
  ) : el;

  if (view === "sections") return wrap(
    <SectionsView setView={setView} isPCLead={effIsPCLead} isAdmin={effIsAdmin} toggleAdmin={toggleAdmin}
      authUser={viewUser} onSignOut={signOut} authRole={viewRole} />
  );

  if (view === "users" && effIsAdmin) return wrap(
    <UsersView setView={setView} me={effMe} />
  );

  if (view === "videos" && effIsAdmin) return wrap(
    <VideosView setView={setView} />
  );

  if (view === "leadership") return wrap(
    <LeadershipView
      country={country} setCountry={setCountry} year={year} setYear={setYear}
      fileRef={fileRef} handleFile={handleFile}
      generating={generating} genProgress={genProgress}
      isAdmin={effIsAdmin} toggleAdmin={toggleAdmin} setView={setView}
      allRuns={allRuns} reloadRuns={reloadRuns} runsLoading={runsLoading} openRun={openRunShared}
      onImportDirectorReview={startDirectorReviewImport}
      canPreview={canPreview} setPreviewAs={setPreviewAs}
      authUser={authUser} onSignOut={signOut} />
  );

  if (view === "home") return wrap(
    <HomeView
      country={country} setCountry={setCountry}
      year={year} setYear={setYear}
      fileRef={fileRef} handleFile={handleFile}
      generating={generating} genProgress={genProgress}
      allRuns={allRuns} setAllRuns={setAllRuns} setView={setView}
      setSurveyData={setSurveyData} setSelections={setSelections}
      setSbOverrides={setSbOverrides}
      setOpenToDept={setOpenToDept}
      setCountry2={setCountry} setYear2={setYear}
      isAdmin={effIsAdmin} toggleAdmin={toggleAdmin}
      runsLoading={runsLoading}
      authUser={viewUser} onSignOut={signOut}
    />
  );

  if (view === "review") return wrap(
    <ReviewView
      country={country} year={year}
      surveyData={surveyData} selections={selections}
      toggleItem={toggleItem} setRewrite={setRewrite} addItem={addItem}
      saveSelections={saveSelections} saved={saved}
      saveRefinement={saveRefinement} refinements={refinements}
      setView={setView} setSelections={setSelections}
      isAdmin={effIsAdmin} toggleAdmin={toggleAdmin}
      pendingImport={pendingImport} clearPendingImport={() => setPendingImport(null)}
      sbOverrides={sbOverrides} saveSbOverride={saveSbOverride} setSbOverrides={setSbOverrides}
      sbMaster={sbMaster} saveSbMaster={saveSbMaster}
      cloudLoading={cloudLoading} syncStatus={syncStatus}
      me={effMe} saveMe={saveMe} isPCLead={effIsPCLead}
      openToDept={openToDept} setOpenToDept={setOpenToDept}
      toggleDeptFinished={toggleDeptFinished}
      canEditDept={canEditDept} authRole={viewRole} authUser={viewUser} onSignOut={signOut} authDepts={authDepts}
    />
  );

  if (view === "report") return wrap(
    <ReportView
      country={country} year={year}
      surveyData={surveyData} getApproved={getApproved}
      // Run-level unique respondent count (survives reload; raw rows don't).
      runRespondents={allRuns.find(r => r.country === country && String(r.year) === String(year))?.respondents ?? null}
      setView={setView}
      sbOverrides={sbOverrides} sbMaster={sbMaster}
    />
  );

  if (view === "workspace") return wrap(
    <WorkspaceView
      allRuns={allRuns} setView={setView}
      authRole={viewRole} authUser={viewUser} authDepts={authDepts}
      canEditDept={canEditDept} me={effMe} isPCLead={effIsPCLead}
      sbOverrides={sbOverrides} sbMaster={sbMaster}
    />
  );

  if (view === "dashboard") return wrap(
    <DashboardView
      allRuns={allRuns} dashCountry={dashCountry}
      setDashCountry={setDashCountry} setView={setView}
      country={country} year={year} surveyData={surveyData}
      refinements={refinements} setRefinements={setRefinements}
      openReport={openReport}
      lockCountry={viewRole === "country" ? (viewUser && viewUser.country) : null}
      isLeader={effIsAdmin}
      authUser={viewUser} onSignOut={signOut}
    />
  );
}

// ─── SECTIONS LANDING ─────────────────────────────────────────────────────────
// Top level of the app, organized by audience: Country dashboards (for each
// country), People & Culture (for directors — review + department pages + notes),
// and Leadership (for Mel & Chris — sees everything, overall dashboard).
function SectionsView({ setView, isPCLead, isAdmin, toggleAdmin, authUser, onSignOut, authRole }) {
  const isMobile = useIsMobile();
  const [showHowTo, setShowHowTo] = useState(false);
  const allCards = [
    { key: "country", title: "Country dashboards", to: "dashboard", roles: ["leader", "country"],
      blurb: "Each country's latest pulse report and how it's trending over time." },
    { key: "pc", title: "People & Culture", to: "home", roles: ["leader", "director"],
      blurb: "Your departments by country — the review, question-by-question notes, and behaviour tracking, all in one place." },
    { key: "leadership", title: "Leadership", to: "leadership", roles: ["leader"],
      blurb: "Everything across the org, with an overall dashboard. Mel & Chris." },
  ];
  // With login on, show only the sections this role can use; otherwise show all.
  const cards = authRole ? allCards.filter(c => c.roles.includes(authRole)) : allCards;
  return (
    <div style={{ minHeight:"100vh", background:"#F6F1E8", padding: isMobile ? "28px 16px" : "40px 24px" }}>
      <div style={{ maxWidth:900, margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"baseline", gap:12, marginBottom:4, flexWrap:"wrap" }}>
          <span style={{ fontFamily:FONT_DISPLAY, fontSize:26, fontWeight:600, color:"#2C2621", letterSpacing:-.2 }}>JV Pulse</span>
          <span style={{ fontSize:14, color:"#7A6F63" }}>People & Culture</span>
          <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:12 }}>
            <button onClick={() => setShowHowTo(true)} style={{ ...navBtn, fontSize:12, padding:"6px 12px", display:"inline-flex", alignItems:"center", gap:6 }}>
              <IconHelp/> How-to videos
            </button>
            {authUser && (
              <span style={{ fontSize:12, color:"#7A6F63" }}>
                {authUser.name} · <button onClick={onSignOut}
                  style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#B96524", fontWeight:600, fontSize:12 }}>Sign out</button>
              </span>
            )}
            {!authUser && (
              <button onClick={toggleAdmin} title="Admin tools for Mel & Chris"
                style={{ fontSize:12, color: isAdmin ? "#5C9A6D" : "#A89C8D",
                  background:"transparent", border:"none", cursor:"pointer" }}>
                {isAdmin ? "🔓 admin" : "🔒"}
              </button>
            )}
          </div>
        </div>
        <div style={{ fontSize:14, color:"#7A6F63", marginBottom:28 }}>Where would you like to go?</div>

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(240px, 1fr))", gap:16 }}>
          {cards.map(c => (
            <button key={c.key} onClick={() => setView(c.to)}
              style={{ textAlign:"left", background:"#fff", border:"1px solid #ECE2D2", borderRadius:14,
                padding:"22px 20px", cursor:"pointer", transition:"border-color .15s",
                display:"flex", flexDirection:"column", gap:8, minHeight:130 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#E0863C"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#ECE2D2"}>
              <span style={{ fontSize:17, fontWeight:700, color:"#2C2621" }}>{c.title}</span>
              <span style={{ fontSize:13, color:"#7A6F63", lineHeight:1.5 }}>{c.blurb}</span>
              <span style={{ marginTop:"auto", fontSize:13, fontWeight:600, color:"#E0863C" }}>Open →</span>
            </button>
          ))}
        </div>
      </div>
      {showHowTo && <HowToVideosPanel onClose={() => setShowHowTo(false)} />}
    </div>
  );
}


// ─── LEADERSHIP VIEW ──────────────────────────────────────────────────────────
// For Mel & Chris. Home of survey upload/processing (a leadership action), with the
// overall dashboard to be added here later.
// Leaders-only tool: step into the app as a country leader or a P&C director to
// see exactly what they see — no logging out, no second account. Starts closed;
// a mode is picked, then a country/department, then "Start preview". The exit is
// the fixed banner (PreviewBanner) that follows you across every screen.
function PreviewAsPanel({ allRuns, setPreviewAs, setView }) {
  const [mode, setMode] = useState(null);   // null | "country" | "director" — closed by default
  const [country, setCountry] = useState("");
  const [depts, setDepts] = useState([]);   // one or more department keys (directors can own several)
  const countries = [...new Set(allRuns.map(r => r.country).filter(Boolean))].sort();

  const pick = (m) => { setMode(prev => prev === m ? null : m); };
  const toggleDept = (key) => setDepts(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  const startCountry = () => {
    if (!country) return;
    setPreviewAs({ role: "country", country, label: `${country} country leader` });
    setView("sections");
  };
  const startDirector = () => {
    if (!depts.length) return;
    const names = depts.map(k => (DEPARTMENTS.find(x => x.key === k)?.label) || k);
    const label = names.length === 1 ? `${names[0]} director`
      : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]} director`;
    setPreviewAs({ role: "director", department: depts.join(","), label });
    setView("sections");
  };
  const modeBtn = (m, txt) => (
    <button onClick={() => pick(m)}
      style={{ ...navBtn, fontSize:13, padding:"9px 14px",
        background: mode === m ? "#FBEFE4" : undefined,
        borderColor: mode === m ? "#E0A56F" : undefined,
        color: mode === m ? "#B96524" : undefined, fontWeight:650 }}>
      👁 {txt}
    </button>
  );

  return (
    <div style={{ ...card, marginBottom:24, padding:"16px 18px" }}>
      <div style={{ fontSize:12, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5, marginBottom:4 }}>See what others see</div>
      <div style={{ fontSize:12.5, color:"#7A6F63", marginBottom:12, lineHeight:1.5 }}>
        Step into the app as one of your people to check their view. You stay signed in — a banner brings you back.
      </div>
      <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
        {modeBtn("country", "View as a country leader")}
        {modeBtn("director", "View as a P&C director")}
      </div>

      {mode === "country" && (
        <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap", marginTop:14 }}>
          <select value={country} onChange={e => setCountry(e.target.value)} style={{ ...inp, maxWidth:240 }}>
            <option value="">Choose a country…</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={startCountry} disabled={!country}
            style={{ ...navBtn, background: country ? "#E0863C" : "#ECE2D2", color: country ? "#fff" : "#A89C8D",
              border:"1px solid transparent", fontWeight:700 }}>Start preview →</button>
        </div>
      )}

      {mode === "director" && (
        <div style={{ marginTop:14 }}>
          <div style={{ fontSize:12, color:"#7A6F63", marginBottom:8 }}>
            Pick one or more departments (directors can cover several — e.g. Counseling &amp; Marriages):
          </div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 }}>
            {DEPARTMENTS.map(d => {
              const on = depts.includes(d.key);
              return (
                <button key={d.key} onClick={() => toggleDept(d.key)} style={{
                  fontSize:12.5, fontWeight:600, padding:"6px 12px", borderRadius:20, cursor:"pointer",
                  background: on ? "#2C2621" : "#FFFFFF", color: on ? "#fff" : "#5A4A3B",
                  border:`1px solid ${on ? "#2C2621" : "#E2D3C2"}` }}>
                  {on ? "✓ " : ""}{d.label}
                </button>
              );
            })}
          </div>
          <button onClick={startDirector} disabled={!depts.length}
            style={{ ...navBtn, background: depts.length ? "#E0863C" : "#ECE2D2", color: depts.length ? "#fff" : "#A89C8D",
              border:"1px solid transparent", fontWeight:700 }}>Start preview →</button>
        </div>
      )}
    </div>
  );
}

// Click-to-open department detail — a modal a leader can pop from any dashboard
// row to read the department's scores and its notes, and add notes/tracking,
// without leaving the page. Loads the run's survey data for the one department.
function DeptDetailModal({ country, year, deptKey, deptLabel, me, isPCLead, onClose }) {
  const [dept, setDept] = useState(undefined);   // undefined = loading, null = not found
  useEffect(() => {
    let alive = true;
    setDept(undefined);
    loadRunSurveyData(country, year)
      .then(sd => { if (alive) setDept((sd && sd.depts && sd.depts[deptKey]) || null); })
      .catch(() => { if (alive) setDept(null); });
    return () => { alive = false; };
  }, [country, year, deptKey]);

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, zIndex:1300, background:"rgba(44,38,33,0.45)",
      display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"20px 12px", overflowY:"auto" }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#F6F1E8", borderRadius:16, maxWidth:760, width:"100%",
        margin:"12px auto", boxShadow:"0 20px 60px rgba(0,0,0,0.3)", overflow:"hidden" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 18px", background:"#FBEFE4", borderBottom:"1px solid #ECE2D2", position:"sticky", top:0 }}>
          <span style={{ fontFamily:FONT_DISPLAY, fontSize:18, fontWeight:600, color:"#2C2621" }}>{deptLabel || deptKey}</span>
          <span style={{ fontSize:12, color:"#7A6F63" }}>{country} · {year}</span>
          <button onClick={onClose} title="Close"
            style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer", fontSize:20, color:"#7A6F63", lineHeight:1 }}>✕</button>
        </div>
        <div style={{ padding:18, maxHeight:"80vh", overflowY:"auto" }}>
          {dept === undefined ? (
            <div style={{ color:"#7A6F63", fontSize:13, fontStyle:"italic" }}>Loading the department…</div>
          ) : dept === null ? (
            <div style={{ color:"#7A6F63", fontSize:13 }}>Couldn't load this department's detail.</div>
          ) : (
            <DeptNotesTab dept={dept} country={country} year={year} me={me} saveMe={() => {}}
              isPCLead={isPCLead} canEdit={true} sbOverrides={{}} sbMaster={{}} />
          )}
        </div>
      </div>
    </div>
  );
}

// The leadership brief — an on-demand AI synthesis of the whole-org rollup:
// a headline plus a few prioritised "what's happening + next step" cards, each
// clickable into that department's detail. Button-triggered (no auto AI cost).
function LeadershipBriefPanel({ countriesData = [], issues = [], allCountries = [], onOpenDept }) {
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState(null);
  const [err, setErr] = useState("");
  const [scope, setScope] = useState("all");   // "all" or a country name

  // Build the rollup for the chosen scope. For a single country we compute that
  // country's own lowest questions and within-country recurrences, so a country
  // brief is as rich as the org one.
  const rollupFor = (sc) => {
    const inScope = (c) => sc === "all" || c === sc;
    const countries = countriesData.filter(c => inScope(c.country));
    const qs = issues.filter(q => inScope(q.country)).slice().sort((a, b) => (parseFloat(a.score) || 9) - (parseFloat(b.score) || 9));
    const lowestQuestions = qs.slice(0, 12);
    const g = {};
    qs.forEach(q => { const k = normQ(q.en); (g[k] = g[k] || { en: q.en, where: [] }).where.push(`${q.country} · ${q.deptLabel}`); });
    const recurring = Object.values(g).filter(e => e.where.length >= 2)
      .map(e => ({ en: e.en, count: e.where.length, where: e.where }))
      .sort((a, b) => b.count - a.count).slice(0, 8);
    return { countries, lowestQuestions, recurring, scope: sc === "all" ? null : sc };
  };

  // Gather the qualitative material — directors' notes and staff open responses —
  // for the in-scope flagged departments, so the brief reflects what people
  // actually said, not just the scores. Leaders see everything, so no visibility
  // filtering is needed here. Bounded to keep the fetch + prompt reasonable.
  const gatherQualitative = async (sc) => {
    const inScope = (c) => sc === "all" || c === sc;
    const depts = countriesData.filter(c => inScope(c.country))
      .flatMap(c => (c.depts || []).map(d => ({ country: c.country, year: c.year, deptKey: d.deptKey, deptLabel: d.deptLabel })))
      .filter(d => d.year)
      .slice(0, 16);
    const notes = [];
    await Promise.all(depts.map(async (d) => {
      try {
        const [dn, qn] = await Promise.all([
          loadDepartmentNotes(d.country, d.year, d.deptKey).catch(() => []),
          loadQuestionNotes(d.country, d.year, d.deptKey).catch(() => []),
        ]);
        dn.forEach(n => notes.push({ country: d.country, deptLabel: d.deptLabel, author: n.author, body: n.body || n.title }));
        qn.forEach(n => notes.push({ country: d.country, deptLabel: d.deptLabel, author: n.author, body: n.body || n.title, question: n.question }));
      } catch {}
    }));
    // Open responses from each in-scope run's survey data (one load per country).
    const openResponses = [];
    const byCountry = [...new Set(depts.map(d => `${d.country}|${d.year}`))];
    await Promise.all(byCountry.map(async (cy) => {
      const [country, year] = cy.split("|");
      const want = new Set(depts.filter(d => d.country === country).map(d => d.deptKey));
      try {
        const sd = await loadRunSurveyData(country, year);
        Object.entries(sd?.depts || {}).forEach(([k, dep]) => {
          if (!want.has(k)) return;
          (dep.openResponses || []).slice(0, 12).forEach(r => openResponses.push({ country, deptLabel: dep.label || k, text: r.translation || r.text }));
        });
      } catch {}
    }));
    return { notes, openResponses };
  };

  const run = async () => {
    setBusy(true); setErr("");
    try {
      const qual = await gatherQualitative(scope);
      setBrief(await synthesizeLeadership({ ...rollupFor(scope), notes: qual.notes, openResponses: qual.openResponses }));
    }
    catch (e) { setErr(e.message || "Couldn't synthesize right now."); }
    setBusy(false);
  };
  const pickScope = (s) => { setScope(s); setBrief(null); setErr(""); };   // changing scope clears the stale brief
  const priorities = (brief && brief.priorities) || [];
  const scopeChip = (val, label) => (
    <button key={val} onClick={() => pickScope(val)} style={{
      fontSize:12, fontWeight:600, padding:"5px 11px", borderRadius:20, cursor:"pointer",
      background: scope === val ? "#2C2621" : "#FFFFFF", color: scope === val ? "#fff" : "#5A4A3B",
      border:`1px solid ${scope === val ? "#2C2621" : "#E2D3C2"}` }}>{label}</button>
  );

  return (
    <div style={{ ...card, marginBottom:24, padding:"16px 18px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
        <span style={{ fontFamily:FONT_DISPLAY, fontSize:18, fontWeight:600, color:"#2C2621" }}>Leadership brief</span>
        <span style={{ fontSize:12, color:"#7A6F63" }}>AI synthesis — what matters now, and what to do about it</span>
        <button onClick={run} disabled={busy}
          style={{ ...navBtn, marginLeft:"auto", background: busy?"#ECE2D2":"#E0863C", color: busy?"#7A6F63":"#fff",
            border:"1px solid transparent", fontWeight:700, display:"inline-flex", alignItems:"center", gap:6 }}>
          {busy ? "Synthesizing…" : brief ? "↻ Refresh" : "✦ Synthesize"}
        </button>
      </div>

      {/* Scope: whole org, or one country */}
      {allCountries.length > 1 && (
        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginTop:12 }}>
          <span style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1, marginRight:2 }}>Summarize</span>
          {scopeChip("all", "All countries")}
          {allCountries.map(c => scopeChip(c, c))}
        </div>
      )}

      {!brief && !busy && (
        <div style={{ fontSize:12.5, color:"#A89C8D", marginTop:10, lineHeight:1.5 }}>
          {scope === "all"
            ? "Reads every country's latest pulse and tells you the story — the patterns worth acting on, and a next step for each."
            : `Focuses on ${scope} — its story, the patterns worth acting on, and a next step for each.`} Click a card to open that department.
        </div>
      )}
      {err && <div style={{ color:"#BE6650", fontSize:12, marginTop:10 }}>{err}</div>}
      {brief && brief.empty && <div style={{ fontSize:13, color:"#7A6F63", marginTop:12 }}>{brief.text}</div>}
      {brief && !brief.empty && (
        <div style={{ marginTop:14 }}>
          {brief.headline && <div style={{ fontSize:14.5, color:"#2C2621", lineHeight:1.55, marginBottom:14 }}>{brief.headline}</div>}
          {brief.text && priorities.length === 0 && <div style={{ fontSize:13, color:"#2C2621", whiteSpace:"pre-wrap", lineHeight:1.5 }}>{brief.text}</div>}
          <div style={{ display:"grid", gap:10 }}>
            {priorities.map((p,i) => {
              const clickable = !!(p.deptKey && p.country && p.country !== "Org-wide" && onOpenDept);
              return (
                <div key={i}
                  onClick={() => clickable && onOpenDept({ country:p.country, deptKey:p.deptKey, deptLabel:p.deptLabel })}
                  onMouseEnter={e => { if (clickable) e.currentTarget.style.background = "#F7EEDF"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "#FDFAF4"; }}
                  title={clickable ? `Open ${p.deptLabel} (${p.country})` : undefined}
                  style={{ background:"#FDFAF4", border:"1px solid #ECE2D2", borderRadius:12, padding:"12px 14px", cursor: clickable?"pointer":"default" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, flexWrap:"wrap" }}>
                    <span style={{ fontSize:11, fontWeight:800, color:"#9A6B26", fontVariantNumeric:"tabular-nums" }}>{i+1}</span>
                    <span style={{ fontSize:14, fontWeight:700, color:"#2C2621" }}>{p.title}</span>
                    {p.status && <span style={{ fontSize:10, fontWeight:700, color:sc(p.status), background:sb(p.status), border:`1px solid ${sbd(p.status)}`, borderRadius:5, padding:"2px 7px" }}>{p.status}</span>}
                    <span style={{ fontSize:11, color:"#7A6F63" }}>{p.country}{p.deptLabel ? ` · ${p.deptLabel}` : ""}</span>
                    {clickable && <span style={{ marginLeft:"auto", color:"#C9BBA8", fontSize:14, flexShrink:0 }} aria-hidden="true">→</span>}
                  </div>
                  {p.insight && <div style={{ fontSize:13, color:"#2C2621", lineHeight:1.5, marginBottom:6 }}>{p.insight}</div>}
                  {p.nextStep && <div style={{ fontSize:13, color:"#5A4A3B", lineHeight:1.5 }}><b style={{ color:"#B96524" }}>Next step:</b> {p.nextStep}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function LeadershipView({ country, setCountry, year, setYear, fileRef, handleFile,
  generating, genProgress, isAdmin, toggleAdmin, setView, allRuns = [], reloadRuns, runsLoading, openRun, onImportDirectorReview, canPreview, setPreviewAs, authUser, onSignOut }) {
  const isMobile = useIsMobile();
  const [detail, setDetail] = useState(null);   // { country, year, deptKey, deptLabel } for the drill-in modal
  const openDeptDetail = ({ country: c, deptKey, deptLabel }) =>
    setDetail({ country: c, year: latestByCountry[c]?.year, deptKey, deptLabel });
  const dirReviewRef = useRef(null);   // file input for importing a director review
  const [showUpload, setShowUpload] = useState(allRuns.length === 0);   // the Import panel
  const [showPreview, setShowPreview] = useState(false);                // the "See what others see" panel
  const [orgIssues, setOrgIssues] = useState(null);   // null = loading; array of question rows across the org
  const issuesLoadedRef = useRef("");

  // Live updates: refresh the shared review progress on open and every 30s, so
  // leaders watching the dashboard see departments turn green as directors
  // finish. The box itself is view-only. A ref keeps the interval stable.
  const reloadRef = useRef(reloadRuns);
  reloadRef.current = reloadRuns;
  useEffect(() => {
    reloadRef.current?.();
    const id = setInterval(() => reloadRef.current?.(), 30000);
    return () => clearInterval(id);
  }, []);

  // ── Org-wide rollup from the latest run of each country (fast: uses the
  // department summaries already loaded, no per-run fetches). ──
  const latestByCountry = {};
  allRuns.forEach(r => { if (!latestByCountry[r.country] || Number(r.year) > Number(latestByCountry[r.country].year)) latestByCountry[r.country] = r; });
  const latestRuns = Object.values(latestByCountry);
  const allDepts = latestRuns.flatMap(r => (r.depts || []).map(d => ({ ...d, country: r.country, year: r.year })));
  const withStatus = allDepts.filter(d => d.status);
  const counts = { Concern: 0, Watch: 0, Healthy: 0 };
  withStatus.forEach(d => { if (counts[d.status] != null) counts[d.status]++; });
  // Unique respondents org-wide = sum of each country's run-level unique count
  // (one survey row per person). Different countries are different people, so
  // summing across runs is correct — but NEVER sum per-department n's within a
  // run, since staff on multiple teams answer once per team and would be counted
  // twice. Runs missing the stored count (older/local) contribute 0.
  const totalResp = latestRuns.reduce((s, r) => s + (Number(r.respondents) || 0), 0);
  const finishedCt = allDepts.filter(d => d.reviewDone).length;
  const attention = withStatus
    .filter(d => d.status === "Concern" || d.status === "Watch")
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "Concern" ? -1 : 1) || (parseFloat(a.avg) || 9) - (parseFloat(b.avg) || 9));
  // Group by department type across countries (collapse culture splits LC1/LC2, JVK1/JVK2).
  const deptGroup = (d) => (d.group || String(d.key || "").replace(/([A-Za-z]+)[12]$/, "$1") || d.label);
  const byDept = {};
  withStatus.forEach(d => {
    const g = deptGroup(d);
    const e = byDept[g] || (byDept[g] = { label: (d.label || g).replace(/\s*\((1st|2nd).*?\)/i, "").trim() || g, Concern: 0, Watch: 0, Healthy: 0, concernCountries: [], total: 0 });
    if (e[d.status] != null) e[d.status]++;
    e.total++;
    if (d.status === "Concern") e.concernCountries.push(d.country);
  });
  const deptPattern = Object.values(byDept).sort((a, b) => (b.Concern - a.Concern) || (b.Watch - a.Watch) || a.label.localeCompare(b.label));

  // ── Needs attention, grouped BY COUNTRY ── One card per country that has any
  // Concern/Watch department, so leaders triage one country at a time (worst
  // first) rather than scanning a flat mixed list. This is the "where do we
  // step in" view: which countries are struggling, in which departments, and is
  // their review done yet.
  const attentionByCountry = (() => {
    const byC = {};
    attention.forEach(d => {
      const e = byC[d.country] || (byC[d.country] = { country: d.country, run: latestByCountry[d.country], depts: [], concern: 0, watch: 0 });
      e.depts.push(d);
      if (d.status === "Concern") e.concern++; else if (d.status === "Watch") e.watch++;
    });
    return Object.values(byC).sort((a, b) => (b.concern - a.concern) || (b.watch - a.watch) || String(a.country).localeCompare(String(b.country)));
  })();

  // ── Top issues (question level) ── Pull each country's latest run detail in
  // the background and collect every question, so leaders can see the specific
  // weak spots and recurring themes — not just department health.
  const runsKey = latestRuns.map(r => `${r.country}:${r.year}`).sort().join("|");
  useEffect(() => {
    if (!latestRuns.length) { setOrgIssues([]); return; }
    if (issuesLoadedRef.current === runsKey) return;
    issuesLoadedRef.current = runsKey;
    let alive = true;
    setOrgIssues(null);
    (async () => {
      const rows = [];
      await Promise.all(latestRuns.map(async (r) => {
        try {
          const sd = await loadRunSurveyData(r.country, r.year);
          Object.entries(sd?.depts || {}).forEach(([dkey, dep]) => {
            (dep.questions || []).forEach(q => {
              if (q && q.score != null && q.en) rows.push({ en: q.en, score: q.score, status: q.status, burden: q.burden, country: r.country, deptKey: dkey, deptLabel: dep.label || dep.key, year: r.year });
            });
          });
        } catch {}
      }));
      if (alive) setOrgIssues(rows);
    })();
    return () => { alive = false; };
  }, [runsKey]);

  // Lowest-scoring questions org-wide (the specific pain points), worst first.
  const topConcerns = (orgIssues || [])
    .filter(q => q.status === "Concern" || q.status === "Watch")
    .sort((a, b) => (parseFloat(a.score) || 9) - (parseFloat(b.score) || 9))
    .slice(0, 10);
  // Questions that are Concern/Watch in 2+ places — systemic, at the question level.
  const recurring = (() => {
    const g = {};
    (orgIssues || []).filter(q => q.status === "Concern" || q.status === "Watch").forEach(q => {
      const k = normQ(q.en);
      const e = g[k] || (g[k] = { en: q.en, where: [], scores: [] });
      e.where.push(`${q.country} · ${q.deptLabel}`); e.scores.push(parseFloat(q.score) || 0);
    });
    return Object.values(g).filter(e => e.where.length >= 2)
      .map(e => ({ ...e, avg: (e.scores.reduce((s, x) => s + x, 0) / e.scores.length) }))
      .sort((a, b) => b.where.length - a.where.length || a.avg - b.avg).slice(0, 6);
  })();

  // Data handed to the leadership brief. countriesData + the full concern/watch
  // question set let the panel build either an org-wide or a per-country brief.
  const briefCountries = attentionByCountry.map(c => ({
    country: c.country, year: c.run?.year, concern: c.concern, watch: c.watch,
    depts: c.depts.map(d => ({ deptKey: d.key, deptLabel: d.label || d.key, avg: d.avg, status: d.status })),
  }));
  const briefIssues = (orgIssues || [])
    .filter(q => q.status === "Concern" || q.status === "Watch")
    .map(q => ({ country: q.country, deptKey: q.deptKey, deptLabel: q.deptLabel, en: q.en, score: q.score, status: q.status }));
  const briefAllCountries = [...new Set(latestRuns.map(r => r.country).filter(Boolean))].sort();

  const Tile = ({ n, label, color }) => (
    <div style={{ ...card, padding:"14px 16px", textAlign:"center", minWidth:0 }}>
      <div style={{ fontFamily:FONT_DISPLAY, fontSize:28, fontWeight:600, color: color || "#2C2621", fontVariantNumeric:"tabular-nums" }}>{n}</div>
      <div style={{ fontSize:10.5, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:.6, marginTop:2 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:"#F6F1E8", padding: isMobile ? "24px 16px" : "40px 24px" }}>
      <div style={{ maxWidth:900, margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:24, flexWrap:"wrap" }}>
          <button onClick={() => setView("__back__")}
            style={{ ...navBtn, background:"transparent", border:"1px solid #ECE2D2" }}>← Back</button>
          <span style={{ fontFamily:FONT_DISPLAY, fontSize:22, fontWeight:600, color:"#2C2621" }}>Leadership</span>
          {authUser && authUser.role === "leader" && (
            <button onClick={() => setView("users")} style={{ ...navBtn, fontSize:12, padding:"6px 12px" }}>Manage people</button>
          )}
          {isAdmin && (
            <button onClick={() => setView("videos")} style={{ ...navBtn, fontSize:12, padding:"6px 12px" }}>Manage videos</button>
          )}
          {isAdmin && (
            <button onClick={() => { setShowUpload(v => !v); setShowPreview(false); }}
              style={{ ...navBtn, fontSize:12, padding:"6px 12px", background: showUpload ? "#FBEFE4" : undefined, borderColor: showUpload ? "#E0A56F" : undefined, color: showUpload ? "#B96524" : undefined }}>
              Import
            </button>
          )}
          {canPreview && (
            <button onClick={() => { setShowPreview(v => !v); setShowUpload(false); }}
              style={{ ...navBtn, fontSize:12, padding:"6px 12px", background: showPreview ? "#FBEFE4" : undefined, borderColor: showPreview ? "#E0A56F" : undefined, color: showPreview ? "#B96524" : undefined }}>
              See what others see
            </button>
          )}
          {authUser ? (
            <span style={{ marginLeft:"auto", fontSize:12, color:"#7A6F63" }}>
              {authUser.name} · <button onClick={onSignOut}
                style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#B96524", fontWeight:600, fontSize:12 }}>Sign out</button>
            </span>
          ) : (
            <button onClick={toggleAdmin} title="Admin tools for Mel & Chris"
              style={{ marginLeft:"auto", fontSize:12, color: isAdmin ? "#5C9A6D" : "#A89C8D",
                background:"transparent", border:"none", cursor:"pointer" }}>
              {isAdmin ? "🔓 admin on" : "🔒 admin off"}
            </button>
          )}
        </div>

        {canPreview && showPreview && <PreviewAsPanel allRuns={allRuns} setPreviewAs={setPreviewAs} setView={setView} />}

        {/* ── Director review progress — compact, at the very top ──
            One row per active country: how much of its director review is done.
            Click a row to open that run. View-only. */}
        {allRuns && allRuns.length > 0 && (
          <div style={{ ...card, padding:0, overflow:"hidden", marginBottom:24 }}>
            <div style={{ display:"flex", alignItems:"baseline", gap:8, padding:"11px 14px 7px" }}>
              <span style={{ fontSize:12, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5 }}>Director review progress</span>
              <span style={{ fontSize:11, color:"#A89C8D" }}>· click a country to open its review</span>
            </div>
            {[...latestRuns]
              .sort((a,b) => ((pctDone(a) >= 1 ? 1 : 0) - (pctDone(b) >= 1 ? 1 : 0)) || String(a.country).localeCompare(String(b.country)))
              .map((run) => {
                const depts = run.depts || [];
                const done = depts.filter(d => d.reviewDone).length;
                const total = depts.length;
                const allDone = total > 0 && done === total;
                const pct = total ? done / total : 0;
                return (
                  <div key={run.country} onClick={() => openRun && openRun(run)}
                    onMouseEnter={e => { if (openRun) e.currentTarget.style.background = "#FDFAF4"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                    title={openRun ? `Open ${run.country} ${run.year} review` : undefined}
                    style={{ display:"flex", alignItems:"center", gap:12, padding:"9px 14px", borderTop:"1px solid #F3EBE1", cursor: openRun ? "pointer" : "default" }}>
                    <span style={{ minWidth: isMobile ? 92 : 120, fontSize:13, fontWeight:650, color:"#2C2621" }}>
                      {run.country} <span style={{ fontWeight:500, color:"#A89C8D", fontSize:12 }}>{run.year}</span>
                    </span>
                    <div style={{ flex:1, height:6, background:"#EBDECB", borderRadius:4, overflow:"hidden", minWidth:50 }}>
                      <div style={{ width:`${pct*100}%`, height:"100%", background: allDone ? "#5C9A6D" : "#E0863C", transition:"width .3s" }} />
                    </div>
                    <span style={{ minWidth:64, textAlign:"right", fontSize:12, fontWeight:700,
                      color: allDone ? "#5C9A6D" : total === 0 ? "#A89C8D" : "#9A6B26" }}>
                      {total === 0 ? "—" : allDone ? "ready ✓" : `${done} / ${total}`}
                    </span>
                    {openRun && <span style={{ color:"#A89C8D", fontSize:14, flexShrink:0 }} aria-hidden="true">→</span>}
                  </div>
                );
              })}
          </div>
        )}

        {!isAdmin && (
          <div style={{ background:"#FBEFE4", border:"1px solid #ECE2D2", borderRadius:12, padding:"14px 16px", marginBottom:20, fontSize:13, color:"#9A6B26" }}>
            Turn on admin (lock icon, top right) to upload and process a new survey.
          </div>
        )}

        {isAdmin && showUpload && (
        <div style={{ ...card, marginBottom:24 }}>
          <div style={{ display:"flex", alignItems:"center", marginBottom:4 }}>
            <span style={{ fontSize:15, fontWeight:750, color:"#2C2621" }}>Import</span>
            <button onClick={() => setShowUpload(false)} title="Close"
              style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer", fontSize:18, color:"#7A6F63", lineHeight:1 }}>✕</button>
          </div>
          <div style={{ fontSize:12.5, color:"#7A6F63", marginBottom:18, lineHeight:1.5 }}>
            Bring data into the platform. Two kinds today — a new survey run from QuestionPro, or a completed director review.
          </div>

          {/* 1 — New survey run from QuestionPro */}
          <div style={{ fontSize:12, fontWeight:700, color:"#9A6B26", textTransform:"uppercase", letterSpacing:1.2, marginBottom:12 }}>
            New survey run <span style={{ color:"#A89C8D", fontWeight:500, textTransform:"none", letterSpacing:0 }}>· QuestionPro export (.xlsx / .csv)</span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:16, marginBottom:24 }}>
            <div>
              <label style={lbl}>Country</label>
              <input value={country} onChange={e=>setCountry(e.target.value)}
                placeholder="e.g. Poland" style={inp} />
            </div>
            <div>
              <label style={lbl}>Survey Year</label>
              <input value={year} onChange={e=>setYear(e.target.value)}
                placeholder="e.g. 2026" style={inp} />
            </div>
          </div>

          {generating ? (
            <div style={{ background:"#FFFFFF", borderRadius:12, padding:24, textAlign:"center" }}>
              <div style={{ width:40, height:40, border:"3px solid #E0863C", borderTopColor:"transparent", borderRadius:"50%", margin:"0 auto 16px", animation:"spin 1s linear infinite" }} />
              <div style={{ color:"#2C2621", fontWeight:600 }}>{genProgress.step || "Processing…"}</div>
              <div style={{ color:"#7A6F63", fontSize:12, marginTop:8 }}>This may take a minute while AI generates draft content</div>
            </div>
          ) : (
            <div
              onClick={() => country && year && fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); if(country&&year) e.currentTarget.style.borderColor="#E0863C"; }}
              onDragLeave={e => { e.preventDefault(); e.currentTarget.style.borderColor="#ECE2D2"; }}
              onDrop={e => {
                e.preventDefault();
                e.currentTarget.style.borderColor="#ECE2D2";
                if (!(country && year)) return;
                const file = e.dataTransfer.files?.[0];
                if (file) handleFile(file);
              }}
              style={{
                border:"2px dashed #ECE2D2", borderRadius:12, padding: isMobile ? 20 : 30,
                textAlign:"center", cursor: country&&year ? "pointer":"not-allowed",
                opacity: country&&year ? 1 : 0.5,
                transition:"border-color 0.2s",
              }}
              onMouseEnter={e => { if(country&&year) e.currentTarget.style.borderColor="#E0863C"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor="#ECE2D2"; }}
            >
              <div style={{ fontSize:32, marginBottom:12 }}>📊</div>
              <div style={{ color:"#2C2621", fontWeight:600, marginBottom:4 }}>Drop QuestionPro export here, or click to browse</div>
              <div style={{ color:"#7A6F63", fontSize:13 }}>.xlsx or .csv</div>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" style={{ display:"none" }}
                onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
            </div>
          )}

          {/* Import a completed director review — a leader action; it detects the
              country from the file and loads the review into that run's report. */}
          <div style={{ marginTop:18, paddingTop:16, borderTop:"1px solid #ECE2D2" }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#9A6B26", textTransform:"uppercase", letterSpacing:1.2, marginBottom:8 }}>
              Completed director review <span style={{ color:"#A89C8D", fontWeight:500, textTransform:"none", letterSpacing:0 }}>· Excel</span>
            </div>
            <div style={{ fontSize:12, color:"#7A6F63", lineHeight:1.5, marginBottom:10 }}>
              Loads the strengths, growth areas, leadership questions, and quotes from a director's review Excel into the matching country's report. We read the country from the file.
            </div>
            <input ref={dirReviewRef} type="file" accept=".xlsx" style={{ display:"none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f && onImportDirectorReview) onImportDirectorReview(f); e.target.value = ""; }} />
            <button onClick={() => dirReviewRef.current?.click()}
              style={{ ...navBtn, display:"inline-flex", alignItems:"center", gap:6 }}>
              <IconUpload/> Import director review (Excel)
            </button>
          </div>
        </div>
        )}

        {/* ── Org overview: summary tiles — collapsible, open by default ── */}
        {allDepts.length > 0 && (
          <div style={{ ...card, padding:0, overflow:"hidden", marginBottom:20 }}>
            <Disclosure title="Across the org" count="latest pulse per country" defaultOpen>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(90px,1fr))", gap:10, padding:"4px 0 4px" }}>
                <Tile n={latestRuns.length} label={latestRuns.length===1?"Country":"Countries"} />
                {totalResp > 0 && <Tile n={totalResp} label={totalResp===1?"Respondent":"Respondents"} />}
                <Tile n={counts.Concern} label="Concern" color="#BE6650" />
                <Tile n={counts.Watch} label="Watch" color="#C08636" />
                <Tile n={counts.Healthy} label="Healthy" color="#5C9A6D" />
                <Tile n={`${finishedCt}/${allDepts.length}`} label="Reviews done" color={finishedCt===allDepts.length?"#5C9A6D":"#2C2621"} />
              </div>
            </Disclosure>
          </div>
        )}

        {/* Leadership brief — synthesis, right after the dashboard numbers */}
        {allDepts.length > 0 && (
          <LeadershipBriefPanel countriesData={briefCountries} issues={briefIssues}
            allCountries={briefAllCountries} onOpenDept={openDeptDetail} />
        )}

        {/* ── Detail — collapsible, closed by default; open the one you want ── */}
        {allDepts.length > 0 && (
          <div style={{ ...card, padding:0, overflow:"hidden", marginBottom:32 }}>

            {attentionByCountry.length > 0 && (
              <Disclosure title="Needs attention" dot="#BE6650" flush
                count={`${attentionByCountry.length} ${attentionByCountry.length===1?"country":"countries"}`}>
                <div style={{ padding:"4px 14px 14px" }}>
                  <div style={{ fontSize:12.5, color:"#7A6F63", marginBottom:12, lineHeight:1.5 }}>
                    Where to step in, country by country — Concern/Watch departments, worst first. Click a country to open its review, or a department to read its detail.
                  </div>
                  <div style={{ display:"grid", gap:12 }}>
                    {attentionByCountry.map((c) => {
                      const total = (c.run?.depts || []).length;
                      const done = (c.run?.depts || []).filter(d => d.reviewDone).length;
                      const clickable = !!(c.run && openRun);
                      return (
                        <div key={c.country} style={{ background:"#fff", border:"1px solid #ECE2D2", borderRadius:10, overflow:"hidden" }}>
                          <div onClick={() => clickable && openRun(c.run)}
                            onMouseEnter={e => { if (clickable) e.currentTarget.style.background = "#FDFAF4"; }}
                            onMouseLeave={e => { e.currentTarget.style.background = "#FBEFE4"; }}
                            title={clickable ? `Open ${c.country} ${c.run.year} review` : undefined}
                            style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 14px", background:"#FBEFE4",
                              cursor: clickable ? "pointer" : "default", flexWrap:"wrap" }}>
                            <span style={{ fontFamily:FONT_DISPLAY, fontSize:17, fontWeight:600, color:"#2C2621" }}>{c.country}</span>
                            {c.concern > 0 && <span style={{ fontSize:10.5, fontWeight:700, color:"#BE6650", background:"#F6E5DE", border:"1px solid #E4C4BA", borderRadius:20, padding:"2px 9px" }}>{c.concern} concern</span>}
                            {c.watch   > 0 && <span style={{ fontSize:10.5, fontWeight:700, color:"#C08636", background:"#F7EEDC", border:"1px solid #E7D2A9", borderRadius:20, padding:"2px 9px" }}>{c.watch} watch</span>}
                            <span style={{ marginLeft:"auto", fontSize:11, fontWeight:700,
                              color: total>0 && done===total ? "#5C9A6D" : "#9A6B26" }}>
                              {total===0 ? "" : done===total ? "review ready ✓" : `review ${done}/${total}`}
                            </span>
                            {clickable && <span style={{ color:"#A89C8D", fontSize:14, flexShrink:0 }} aria-hidden="true">→</span>}
                          </div>
                          {c.depts.map((d,i) => (
                            <div key={`${d.key}-${i}`}
                              onClick={() => setDetail({ country: c.country, year: c.run?.year, deptKey: d.key, deptLabel: d.label || d.key })}
                              onMouseEnter={e => { e.currentTarget.style.background = "#FDFAF4"; }}
                              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                              title={`Open ${d.label || d.key} — read scores & notes here`}
                              style={{ display:"flex", alignItems:"center", gap:10, padding: isMobile?"8px 12px":"9px 14px", borderTop:"1px solid #F4ECDD", cursor:"pointer" }}>
                              <span style={{ width:8, height:8, borderRadius:"50%", background:sc(d.status), flexShrink:0 }} />
                              <span style={{ fontFamily:"ui-monospace,Menlo,monospace", fontSize:13, fontWeight:700, color:sc(d.status), width:42, flexShrink:0 }}>{d.avg}</span>
                              <span style={{ flex:1, fontSize:13, color:"#2C2621", minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.label || d.key}</span>
                              {!d.reviewDone && <span style={{ fontSize:10, color:"#A89C8D", flexShrink:0 }}>review pending</span>}
                              <span style={{ fontSize:10, fontWeight:700, color:sc(d.status), background:sb(d.status), border:`1px solid ${sbd(d.status)}`, borderRadius:5, padding:"2px 8px", flexShrink:0 }}>{d.status}</span>
                              <span style={{ color:"#C9BBA8", fontSize:13, flexShrink:0 }} aria-hidden="true">→</span>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Disclosure>
            )}

            {deptPattern.length > 0 && (
              <Disclosure title="By department, across countries" dot="#C08636" flush count={`${deptPattern.length}`}>
                <div>
                  {deptPattern.map((e,i) => {
                    const total = e.Concern + e.Watch + e.Healthy || 1;
                    return (
                      <div key={e.label+i} style={{ display:"flex", alignItems:"center", gap:12, padding: isMobile?"9px 12px":"10px 14px", borderTop:"1px solid #F4ECDD", flexWrap:"wrap" }}>
                        <span style={{ fontSize:13, fontWeight:650, color:"#2C2621", width: isMobile?"100%":150, flexShrink:0 }}>{e.label}</span>
                        <div style={{ flex:1, minWidth:120, display:"flex", height:8, borderRadius:5, overflow:"hidden", background:"#FDFAF4" }}>
                          {e.Concern>0 && <div style={{ width:`${e.Concern/total*100}%`, background:"#BE6650" }} />}
                          {e.Watch>0 &&   <div style={{ width:`${e.Watch/total*100}%`, background:"#C08636" }} />}
                          {e.Healthy>0 && <div style={{ width:`${e.Healthy/total*100}%`, background:"#5C9A6D" }} />}
                        </div>
                        <span style={{ fontSize:11, color:"#7A6F63", fontVariantNumeric:"tabular-nums", flexShrink:0 }}>
                          {[
                            e.Concern>0 && <b key="c" style={{ color:"#BE6650" }}>{e.Concern}</b>,
                            e.Watch>0   && <b key="w" style={{ color:"#C08636" }}>{e.Watch}</b>,
                            e.Healthy>0 && <b key="h" style={{ color:"#5C9A6D" }}>{e.Healthy}</b>,
                          ].filter(Boolean).map((el,ix) => <span key={ix}>{ix>0 && " · "}{el}</span>)}
                          {e.concernCountries.length>0 && <span style={{ color:"#A89C8D" }}> — {e.concernCountries.join(", ")}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Disclosure>
            )}

            <Disclosure title="Top issues" dot="#BE6650" flush
              count={orgIssues===null ? "…" : `${topConcerns.length}`}>
              <div>
                {orgIssues === null ? (
                  <div style={{ padding:"10px 14px", color:"#7A6F63", fontSize:13, fontStyle:"italic" }}>Reading the survey responses…</div>
                ) : topConcerns.length === 0 ? (
                  <div style={{ padding:"10px 14px", color:"#7A6F63", fontSize:13 }}>No concern- or watch-level questions across the org right now.</div>
                ) : (
                  topConcerns.map((q,i) => (
                    <div key={i}
                      onClick={() => q.deptKey && setDetail({ country: q.country, year: q.year, deptKey: q.deptKey, deptLabel: q.deptLabel })}
                      onMouseEnter={e => { if (q.deptKey) e.currentTarget.style.background = "#FDFAF4"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                      title={q.deptKey ? `Open ${q.deptLabel} (${q.country}) — scores & notes` : undefined}
                      style={{ display:"flex", alignItems:"flex-start", gap:11, padding: isMobile?"10px 12px":"10px 14px", borderTop:"1px solid #F4ECDD", cursor: q.deptKey ? "pointer" : "default" }}>
                      <span style={{ fontFamily:"ui-monospace,Menlo,monospace", fontSize:13, fontWeight:700, color:sc(q.status), width:42, flexShrink:0, textAlign:"right" }}>{Number(q.score).toFixed(2)}</span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, color:"#2C2621", lineHeight:1.4 }}>{q.en}{q.burden && <span style={{ color:"#C08636", fontSize:10 }}> · burden</span>}</div>
                        <div style={{ fontSize:11, color:"#7A6F63", marginTop:2 }}><b style={{ fontWeight:650 }}>{q.country}</b> · {q.deptLabel}</div>
                      </div>
                      <span style={{ fontSize:10, fontWeight:700, color:sc(q.status), background:sb(q.status), border:`1px solid ${sbd(q.status)}`, borderRadius:5, padding:"2px 8px", flexShrink:0 }}>{q.status}</span>
                    </div>
                  ))
                )}
              </div>
            </Disclosure>

            {recurring.length > 0 && (
              <Disclosure title="Recurring across teams" dot="#9A6B26" flush count={`${recurring.length}`}>
                <div>
                  {recurring.map((e,i) => (
                    <div key={i} style={{ padding: isMobile?"10px 12px":"10px 14px", borderTop:"1px solid #F4ECDD" }}>
                      <div style={{ display:"flex", alignItems:"baseline", gap:10 }}>
                        <span style={{ fontSize:11, fontWeight:800, color:"#9A6B26", flexShrink:0 }}>{e.where.length} teams</span>
                        <span style={{ fontSize:13, color:"#2C2621", lineHeight:1.4 }}>{e.en}</span>
                      </div>
                      <div style={{ fontSize:11, color:"#7A6F63", marginTop:3 }}>{e.where.join("  ·  ")}</div>
                    </div>
                  ))}
                </div>
              </Disclosure>
            )}

          </div>
        )}

      </div>

      {detail && (
        <DeptDetailModal country={detail.country} year={detail.year} deptKey={detail.deptKey}
          deptLabel={detail.deptLabel} me={authUser?.name || ""} isPCLead={isAdmin}
          onClose={() => setDetail(null)} />
      )}
    </div>
  );
}

// A short 2–4 char tag for a department, for the compact dashboard strip.
// Uses the code key when it already looks like one (HR, LD, MPD, LC1), the word
// initials for multi-word names (Learning & Development → L&D), or the first two
// letters otherwise (Counseling → Co).
function deptAbbr(d) {
  const key = d.key || d.label || "";
  if (/^[A-Za-z0-9]{1,4}$/.test(key)) return key.toUpperCase();
  const label = d.label || key;
  const words = label.replace(/&/g, " & ").split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.map(w => w[0]).join("").slice(0, 3).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

// Fraction of a run's departments whose director review is finished (0..1).
// A run with no departments counts as 0 so it sorts among the unfinished.
function pctDone(run) {
  const depts = run?.depts || [];
  if (!depts.length) return 0;
  return depts.filter(d => d.reviewDone).length / depts.length;
}

// ─── HOME VIEW ────────────────────────────────────────────────────────────────
function HomeView({ country, setCountry, year, setYear, fileRef, handleFile,
  generating, genProgress, allRuns, setAllRuns, setView, setSurveyData, setSelections,
  setCountry2, setYear2, isAdmin, toggleAdmin, runsLoading, setSbOverrides, setOpenToDept, authUser, onSignOut }) {

  const isMobile = useIsMobile();
  const countries = [...new Set(allRuns.map(r=>r.country))].sort();
  // A director owns one or more department codes across every country; the P&C
  // home leads with those. null = a leader (sees every department).
  const myDepts = authUser?.role === "director"
    ? String(authUser.department || "").split(",").map(s => s.trim()).filter(Boolean)
    : null;

  // Open a run into the director's review (loads local first, then merges shared
  // Airtable data). Shared by the featured card and the run list.
  const openRun = async (run, deptKey) => {
    setCountry2(run.country); setYear2(run.year);
    if (setOpenToDept) setOpenToDept(deptKey || null);
    let haveData = false;
    try {
      const _v = localStorage.getItem(`pulse:data:${run.country}:${run.year}`);
      if (_v) { setSurveyData(JSON.parse(_v)); haveData = true; }
      const _s = localStorage.getItem(`pulse:sel:${run.country}:${run.year}`);
      if (_s) setSelections(JSON.parse(_s));
    } catch {}
    setView("review");
    try {
      const sd2 = await loadRunSurveyData(run.country, run.year);
      if (sd2?.sbOverrides && Object.keys(sd2.sbOverrides).length) {
        setSbOverrides(prev => {
          const merged = { ...prev, ...sd2.sbOverrides };
          try { localStorage.setItem("pulse:sbOverrides", JSON.stringify(merged)); } catch {}
          return merged;
        });
      }
      // Merge the shared "finished" state from Airtable into a cached surveyData
      // so another admin's progress shows here even when we loaded from cache.
      if (sd2?.depts) {
        setSurveyData(prev => {
          if (!prev?.depts) return prev;
          const merged = { ...prev, depts: { ...prev.depts } };
          for (const k of Object.keys(sd2.depts)) {
            if (merged.depts[k]) merged.depts[k] = { ...merged.depts[k], reviewDone: !!sd2.depts[k].reviewDone };
          }
          try { localStorage.setItem(`pulse:data:${run.country}:${run.year}`, JSON.stringify(merged)); } catch {}
          return merged;
        });
      }
    } catch (e) { console.warn("SB override load failed:", e.message); }
    if (!haveData) {
      try {
        const sd = await loadRunSurveyData(run.country, run.year);
        if (sd && Object.keys(sd.depts).length) {
          setSurveyData(sd);
          try { localStorage.setItem(`pulse:data:${run.country}:${run.year}`, JSON.stringify(sd)); } catch {}
        }
      } catch (e) { console.warn("Airtable surveyData load failed:", e.message); }
      try {
        const shared = await loadRunSelections(run.country, run.year);
        if (shared && Object.keys(shared).length) {
          setSelections(shared);
          try { localStorage.setItem(`pulse:sel:${run.country}:${run.year}`, JSON.stringify(shared)); } catch {}
        }
      } catch (e) { console.warn("Airtable selections load failed:", e.message); }
    }
  };

  // The latest unfinished review to lead with — most recently saved run that
  // isn't marked complete/published. Falls back to the most recent run.
  const isFinished = (r) => /complete|publish|done|final/i.test(String(r.status || ""));
  const sortedByRecent = allRuns.slice().sort((a,b) => new Date(b.savedAt||0) - new Date(a.savedAt||0));

  return (
    <div style={{ minHeight:"100vh", background:"#F6F1E8", fontFamily:"'Inter',system-ui,sans-serif" }}>
      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#FFFFFF 0%,#F6F1E8 100%)", borderBottom:"1px solid #F7E7D5", padding: isMobile ? "16px" : "24px 40px", display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:3, color:"#E0863C", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Josiah Venture</div>
          <div style={{ fontFamily:FONT_DISPLAY, fontSize:24, fontWeight:600, color:"#2C2621" }}>
            {myDepts ? "Director Review & Platform" : "People & Culture Platform"}
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <HowToVideosButton />
          <button onClick={() => setView("__back__")} style={{ ...navBtn, background:"transparent", border:"1px solid #ECE2D2" }}>← Back</button>
          {authUser ? (
            <span style={{ fontSize:12, color:"#7A6F63", whiteSpace:"nowrap" }}>
              {authUser.name} · <button onClick={onSignOut}
                style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#B96524", fontWeight:600, fontSize:12 }}>Sign out</button>
            </span>
          ) : (
            /* Discreet admin toggle — only Mel & Chris use this (auth-off only). */
            <button onClick={toggleAdmin}
              title={isAdmin ? "Admin mode ON — click to hide admin tools" : "Admin mode"}
              style={{ background:"transparent", border:"none", cursor:"pointer",
                fontSize:16, color: isAdmin ? "#E0863C" : "#EAD9C9", padding:"4px 8px", lineHeight:1 }}>
              {isAdmin ? "🔓" : "🔒"}
            </button>
          )}
        </div>
      </div>

      <div style={{ maxWidth:900, margin:"0 auto", padding: isMobile ? "28px 16px" : "48px 24px" }}>

        {/* Intro */}
        <div style={{ marginBottom:22 }}>
          <div style={{ fontFamily:FONT_DISPLAY, fontSize:22, fontWeight:600, color:"#2C2621", marginBottom:4 }}>
            {myDepts ? "Your departments" : "People & Culture"}
          </div>
          <div style={{ fontSize:13.5, color:"#7A6F63", lineHeight:1.5 }}>
            {myDepts
              ? "Pick a country, then open a department — its review, the question-by-question notes, and behaviour tracking are all on one page."
              : "Every pulse by country. Open a department to see its review, notes, and tracking together."}
          </div>
        </div>

        {/* Empty state — never leave the body blank */}
        {allRuns.length === 0 && !generating && (
          <div style={{ textAlign:"center", color:"#7A6F63", padding:"48px 24px", fontSize:14 }}>
            {runsLoading
              ? "Loading reports…"
              : isAdmin
                ? "No reports yet. Add one from the Leadership section (Import → New survey run)."
                : "No reports available yet. If you expect to see reports here, check your connection or ask an admin."}
          </div>
        )}

        {/* Country-first — one card per run; open a department to work on it */}
        {allRuns.length > 0 && (
          <div style={{ display:"grid", gap:14 }}>
            {sortedByRecent.map((run, idx) => {
              const all = run.depts || [];
              const mine = all.filter(d => !myDepts || myDepts.includes(d.key));
              const list = mine.length ? mine : all;
              const cCon = all.filter(d => d.status === "Concern").length;
              const cWat = all.filter(d => d.status === "Watch").length;
              const cHea = all.filter(d => d.status === "Healthy").length;
              return (
                <div key={run.id} style={{ ...card, padding:"16px 20px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap", marginBottom: list.length ? 14 : 0 }}>
                    <span style={{ fontFamily:FONT_DISPLAY, fontSize:19, fontWeight:600, color:"#2C2621" }}>{run.country}</span>
                    <span style={{ fontSize:13, color:"#A89C8D" }}>{run.year}</span>
                    {idx === 0 && !isFinished(run) && (
                      <span style={{ fontSize:10.5, fontWeight:700, color:"#9A6B26", background:"#F7EEDC", borderRadius:4, padding:"2px 8px" }}>Most recent</span>
                    )}
                    {/* Country-at-a-glance — the old dashboard "window", folded in */}
                    <span style={{ display:"inline-flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                      {cCon > 0 && <span style={{ fontSize:10.5, fontWeight:700, color:"#BE6650", background:"#F6E5DE", border:"1px solid #E4C4BA", borderRadius:20, padding:"2px 9px" }}>{cCon} concern</span>}
                      {cWat > 0 && <span style={{ fontSize:10.5, fontWeight:700, color:"#C08636", background:"#F7EEDC", border:"1px solid #E7D2A9", borderRadius:20, padding:"2px 9px" }}>{cWat} watch</span>}
                      {cHea > 0 && <span style={{ fontSize:10.5, fontWeight:700, color:"#5C9A6D", background:"#E9F1E9", border:"1px solid #CDE3CD", borderRadius:20, padding:"2px 9px" }}>{cHea} healthy</span>}
                    </span>
                    <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
                      <button style={{ ...navBtn, fontSize:12, padding:"6px 12px" }} onClick={() => openRun(run)}>Open full review →</button>
                      {isAdmin && <button style={{ ...navBtn, fontSize:12, padding:"6px 12px", background:"#BE6650", color:"white", border:"1px solid transparent" }} onClick={() => {
                        const rc = run.country, ry = run.year;
                        if (!window.confirm(`Delete ${rc} ${ry}? This cannot be undone.`)) return;
                        setAllRuns(prev => {
                          const updated = prev.filter(r => !(r.country === rc && r.year === ry));
                          try { localStorage.setItem("pulse:runs", JSON.stringify(updated)); } catch(e) { console.error(e); }
                          return [...updated];
                        });
                        try { localStorage.removeItem(`pulse:data:${rc}:${ry}`); } catch(e) {}
                        try { localStorage.removeItem(`pulse:sel:${rc}:${ry}`); } catch(e) {}
                      }}>Delete</button>}
                    </div>
                  </div>
                  {list.length > 0 && (
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))", gap:8 }}>
                      {list.map(d => (
                        <button key={d.key} onClick={() => openRun(run, d.key)}
                          onMouseEnter={e => { e.currentTarget.style.background = "#F7EEDF"; }}
                          onMouseLeave={e => { e.currentTarget.style.background = "#FDFAF4"; }}
                          title={`Open ${d.label || d.key} — review, notes & tracking`}
                          style={{ display:"flex", flexDirection:"column", gap:3, textAlign:"left", cursor:"pointer",
                            background:"#FDFAF4", border:"1px solid #ECE2D2", borderLeft:`3px solid ${sc(d.status)}`,
                            borderRadius:8, padding:"9px 12px" }}>
                          <span style={{ fontSize:13, fontWeight:650, color:"#2C2621" }}>{d.label || d.key}</span>
                          <span style={{ fontSize:12, color:"#7A6F63" }}>
                            <b style={{ color:sc(d.status), fontVariantNumeric:"tabular-nums" }}>{d.avg ?? "—"}</b> · {d.status || "—"}
                            {d.reviewDone && <span style={{ color:"#5C9A6D" }}> · done ✓</span>}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform:rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── REVIEW VIEW ──────────────────────────────────────────────────────────────
function ReviewView({ country, year, surveyData, selections, toggleItem, setRewrite, addItem, saveSelections, saved, saveRefinement, refinements, setView, setSelections, isAdmin, toggleAdmin, sbOverrides, saveSbOverride, setSbOverrides, sbMaster, saveSbMaster, cloudLoading, syncStatus, me, saveMe, isPCLead, openToDept, setOpenToDept, toggleDeptFinished, canEditDept, authRole, authUser, onSignOut, authDepts, pendingImport, clearPendingImport }) {
  const canEdit = (d) => (canEditDept ? canEditDept(d) : true);
  const isMobile = useIsMobile();
  const [activeDept, setActiveDept] = useState(null);
  const [deptTab, setDeptTab] = useState("review");   // "review" | "notes" — which tab of the department page
  const [showHelp, setShowHelp] = useState(false);
  const [atBusy, setAtBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);

  // Apply a director-review Excel handed over from the Leadership section. The
  // parent has already opened this run, so country/year are correct here.
  const runImport = async (file) => {
    setImportMsg({ status:"working", lines:["Reading director review…"] });
    try {
      const { selections: imported, report, interpretations } = await parseDirectorReview(file, DEPARTMENTS);
      if (!Object.keys(imported).length) {
        setImportMsg({ status:"error", lines:["No matching department sheets found in that file."] });
        return;
      }
      setImportMsg({ status:"working", lines:["Imported — translating any non-English quotes…"] });
      for (const dk of Object.keys(imported)) {
        try { imported[dk] = { ...imported[dk], quotes: await translateMissingQuotes(imported[dk].quotes || []) }; } catch {}
      }
      setSelections(prev => ({ ...prev, ...imported }));
      try { localStorage.setItem(`pulse:sel:${country}:${year}`, JSON.stringify({ ...(selections||{}), ...imported })); } catch {}
      let sbCount = 0;
      if (interpretations?.length && setSbOverrides) {
        setSbOverrides(prev => {
          const updated = { ...prev };
          interpretations.forEach(it => it.deptKeys.forEach(dk => {
            updated[`${country}:${year}:${dk}:${normQ(it.question)}`] = it.text; sbCount++;
          }));
          try { localStorage.setItem("pulse:sbOverrides", JSON.stringify(updated)); } catch {}
          return updated;
        });
      }
      const extra = sbCount ? [`Applied ${sbCount} Survey Basics interpretation edit${sbCount===1?"":"s"} from the director.`] : [];
      setImportMsg({ status:"done", lines:["Imported director review:", ...report, ...extra] });
    } catch (err) {
      setImportMsg({ status:"error", lines:["Import failed: " + err.message] });
    }
  };
  // When Leadership hands over a file to import, run it once (this run is loaded).
  useEffect(() => {
    if (pendingImport) { runImport(pendingImport); clearPendingImport && clearPendingImport(); }
    // eslint-disable-next-line
  }, [pendingImport]);
  // Order departments by concern: Concern (red) first, then Watch (yellow), then
  // Healthy (green); within each band, lowest score first. Same order every report.
  const STATUS_ORDER = { Concern: 0, Watch: 1, Healthy: 2 };
  const depts = surveyData
    ? Object.values(surveyData.depts).filter(d=>d.n>0).sort((a,b) => {
        const sa = STATUS_ORDER[a.status] ?? 3, sb = STATUS_ORDER[b.status] ?? 3;
        if (sa !== sb) return sa - sb;
        return (parseFloat(a.avg)||0) - (parseFloat(b.avg)||0); // worst score first within a band
      })
    : [];

  useEffect(() => {
    if (openToDept && depts.some(d => d.key === openToDept)) {
      setActiveDept(openToDept);
      if (setOpenToDept) setOpenToDept(null);
    } else if (depts.length && !activeDept) {
      setActiveDept(depts[0].key);
    }
  }, [depts.length, openToDept]);

  const dept = depts.find(d=>d.key===activeDept);

  return (
    <div style={{ height: isMobile ? "auto" : "100vh", minHeight:"100vh", background:"#F6F1E8", fontFamily:"'Inter',system-ui,sans-serif", display:"flex", flexDirection:"column", overflow: isMobile ? "visible" : "hidden" }}>
      {/* Top bar — on desktop it stays fixed at the top while only the content pane scrolls, keeping the action buttons (Translate, Import, Save, Generate) visible; on mobile it scrolls with the page since the whole shell scrolls normally */}
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #ECE2D2", padding: isMobile ? "12px 14px" : "14px 24px", display:"flex", alignItems:"center", gap: isMobile ? 8 : 16, flexShrink:0, zIndex:100, flexWrap:"wrap" }}>
        <button onClick={()=>setView("__back__")} style={{ ...navBtn, background:"transparent", border:"1px solid #ECE2D2" }}>← Back</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontFamily:FONT_DISPLAY, fontSize:16, fontWeight:600, color:"#2C2621", lineHeight:1.15 }}>Director Review</div>
          <div style={{ fontSize:12, fontWeight:700, color:"#E0863C" }}>
            {country} {year}
            {cloudLoading && <span style={{ color:"#7A6F63", marginLeft:8, fontWeight:500, fontStyle:"italic" }}>☁ syncing…</span>}
          </div>
        </div>
        <HowToVideosButton />
        <button onClick={()=>setShowHelp(true)} style={{ ...navBtn, display:"inline-flex", alignItems:"center", gap:6, background:"white",
          border:"1px solid #ECE2D2", color:"#E0863C", fontWeight:700 }}>
          <IconHelp/> How scoring works
        </button>
        {/* Import is triggered from the Leadership section now; the review just
            applies it when a pending file arrives (pendingImport). */}
        {/* Quiet auto-sync indicator — replaces the manual push and save buttons.
            Edits save themselves; this just reassures the user it's handled. */}
        <span style={{ display:"inline-flex", alignItems:"center", gap:6, fontSize:12,
          color: syncStatus==="error" ? "#BE6650" : "#7A6F63", padding:"0 8px", whiteSpace:"nowrap" }}>
          {syncStatus==="saving" && <>☁ Saving…</>}
          {syncStatus==="saved"  && <span style={{ color:"#5C9A6D" }}>✓ Saved</span>}
          {syncStatus==="error"  && <>⚠ Sync failed — will retry on next edit</>}
          {syncStatus==="idle"   && <span style={{ color:"#A89C8D" }}>✓ All changes saved</span>}
        </span>
        {isAdmin && (
        <button onClick={()=>setView("report")} style={{ ...navBtn, background:"#E0863C" }}>
          Generate Report →
        </button>
        )}
        {authUser ? (
          <span style={{ marginLeft:"auto", fontSize:12, color:"#7A6F63", whiteSpace:"nowrap" }}>
            {authUser.name} · <button onClick={onSignOut}
              style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#B96524", fontWeight:600, fontSize:12 }}>Sign out</button>
          </span>
        ) : (
          /* Discreet admin toggle — only Mel & Chris use this (auth-off only). */
          <button
            onClick={toggleAdmin}
            title={isAdmin ? "Admin mode ON — click to hide admin tools" : "Admin mode"}
            style={{ marginLeft:"auto", background:"transparent", border:"none", cursor:"pointer",
              fontSize:14, color: isAdmin ? "#E0863C" : "#EAD9C9", padding:"4px 8px", lineHeight:1 }}>
            {isAdmin ? "🔓" : "🔒"}
          </button>
        )}
      </div>

      {showHelp && <ScoringHelpPanel onClose={()=>setShowHelp(false)} />}

      {importMsg && (
        <div style={{ margin:"12px 20px", padding:"12px 16px", borderRadius:8, flexShrink:0,
          maxHeight:"30vh", overflowY:"auto",
          background: importMsg.status==="error" ? "#F6E5DE" : importMsg.status==="done" ? "#E9F1E9" : "#FBEFE4",
          border: `1px solid ${importMsg.status==="error" ? "#E2B3A8" : importMsg.status==="done" ? "#AFD8BB" : "#ECE2D2"}` }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div style={{ fontSize:12, lineHeight:1.6, color:"#2C2621" }}>
              {importMsg.lines.map((l,i) => (
                <div key={i} style={{ fontWeight: i===0 ? 700 : 400 }}>{l}</div>
              ))}
            </div>
            <button onClick={()=>setImportMsg(null)} style={{ background:"none", border:"none",
              cursor:"pointer", color:"#7A6F63", fontSize:16, lineHeight:1 }}>×</button>
          </div>
          {importMsg.status==="done" && (
            <div style={{ fontSize:11, color:"#3E7A50", marginTop:8 }}>
              Review the imported edits in each department below, then generate the report when ready.
            </div>
          )}
        </div>
      )}

      <div style={{ display:"flex", flex:1, overflow: isMobile ? "visible" : "hidden" }}>
        {/* Sidebar — hidden on mobile; a full-width department dropdown (below) replaces it */}
        <div style={{ display: isMobile ? "none" : "block", width:220, background:"#FFFFFF", borderRight:"1px solid #ECE2D2", overflowY:"auto", flexShrink:0 }}>
          {depts.map(d => (
            <button key={d.key} onClick={()=>setActiveDept(d.key)}
              style={{
                display:"block", width:"100%", textAlign:"left",
                padding:"12px 16px", background: activeDept===d.key ? "#F6F1E8" : "transparent",
                border:"none", borderLeft: activeDept===d.key ? "3px solid #E0863C" : "3px solid transparent",
                cursor:"pointer",
              }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ width:8, height:8, borderRadius:"50%", background:sc(d.status), flexShrink:0 }} />
                <span style={{ color: activeDept===d.key ? "#2C2621":"#7A6F63", fontSize:13, fontWeight: activeDept===d.key?600:400 }}>{d.label}</span>
              </div>
              <div style={{ color:"#7A6F63", fontSize:11, marginLeft:16, marginTop:2 }}>{d.avg} · {d.n} respondents</div>
            </button>
          ))}
        </div>

        {/* Main panel — a department PAGE with tabs (Review · Notes) */}
        <div style={{ flex:1, overflowY: isMobile ? "visible" : "auto", padding: isMobile ? 14 : 24 }}>
          {/* Review progress — every department's finished state at a glance, so
              Mel & Chris can see when everything is ready to look at together. */}
          {depts.length > 0 && (() => {
            const finishedCount = depts.filter(d => d.reviewDone).length;
            const allDone = finishedCount === depts.length;
            return (
              <div style={{ background:"#FFFFFF", border:`1px solid ${allDone ? "#AFD8BB" : "#ECE2D2"}`,
                borderRadius:12, padding: isMobile ? "12px 14px" : "14px 18px", marginBottom:16 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, marginBottom:10, flexWrap:"wrap" }}>
                  <span style={{ fontSize:12, fontWeight:700, color:"#9A6B26", textTransform:"uppercase", letterSpacing:1.5 }}>Review progress</span>
                  <span style={{ fontSize:13, fontWeight:700, color: allDone ? "#5C9A6D" : "#7A6F63" }}>
                    {finishedCount} / {depts.length} finished{allDone ? " — ready to review ✓" : ""}
                  </span>
                </div>
                {/* Thin bar — view-only: which departments have marked their
                    review done (green + check). Marking done happens with the
                    "Mark finished" button on each department. */}
                <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                  {depts.map(d => (
                    <span key={d.key}
                      title={`${d.label} — ${d.status || ""} — ${d.reviewDone ? "finished" : "not finished yet"}`}
                      style={{ display:"inline-flex", alignItems:"center", gap:5,
                        padding:"2px 7px", borderRadius:5, lineHeight:1.7,
                        fontSize:11, fontWeight:700, letterSpacing:.2,
                        color: d.reviewDone ? "#5C9A6D" : "#7A6F63",
                        background: d.reviewDone ? "#E9F1E9" : "#F6F1E8",
                        border:`1px solid ${d.reviewDone ? "#C3DCC8" : "#ECE2D2"}` }}>
                      <span style={{ width:5, height:5, borderRadius:"50%", background:sc(d.status), flexShrink:0 }} />
                      {deptAbbr(d)}
                      {d.reviewDone && <span style={{ fontSize:9 }}>✓</span>}
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}
          {/* Mobile-only department picker — replaces the hidden sidebar */}
          {isMobile && depts.length > 0 && (
            <select
              value={activeDept || ""}
              onChange={e => setActiveDept(e.target.value)}
              style={{ width:"100%", marginBottom:16, padding:"12px 14px", fontSize:15,
                fontWeight:600, color:"#2C2621", background:"#FFFFFF",
                border:"1px solid #F7EEDC", borderRadius:10, appearance:"menulist" }}>
              {depts.map(d => (
                <option key={d.key} value={d.key}>{d.label} — {d.status} · {d.avg} avg</option>
              ))}
            </select>
          )}
          {dept && (
            <div style={{ marginBottom:18, borderBottom:"1px solid #ECE2D2" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12, flexWrap:"wrap" }}>
                <span style={{ fontFamily:FONT_DISPLAY, fontSize:22, fontWeight:600, color:"#2C2621" }}>{dept.label}</span>
                <span style={{ fontSize:12, fontWeight:700, color:sc(dept.status), background:sb(dept.status), border:`1px solid ${sbd(dept.status)}`, borderRadius:20, padding:"3px 10px" }}>{dept.status}</span>
                <span style={{ fontSize:12.5, color:"#7A6F63", fontVariantNumeric:"tabular-nums" }}>{dept.avg} avg · n={dept.n}</span>
                <span style={{ fontSize:12, color:"#A89C8D" }}>· {country} {year}</span>
                {/* The director marks THEIR department done here; only editable by
                    whoever owns it (or a leader). */}
                {canEdit(dept.key) && (
                  <button onClick={() => toggleDeptFinished(dept.key)}
                    style={{ marginLeft: isMobile ? 0 : "auto", fontSize:13, fontWeight:700, cursor:"pointer",
                      borderRadius:8, padding:"8px 14px", minHeight:38,
                      color: dept.reviewDone ? "#5C9A6D" : "#fff",
                      background: dept.reviewDone ? "#E9F1E9" : "#5C9A6D",
                      border: `1px solid ${dept.reviewDone ? "#C3DCC8" : "#5C9A6D"}` }}>
                    {dept.reviewDone ? "✓ Finished · Reopen" : "✓ Mark finished"}
                  </button>
                )}
              </div>
              <div style={{ display:"flex", gap:4 }}>
                {["review","notes"].map(tab => (
                  <button key={tab} onClick={() => setDeptTab(tab)}
                    style={{ fontSize:13, fontWeight:600, padding:"8px 16px", border:"none", cursor:"pointer",
                      background:"transparent", color: deptTab===tab ? "#E0863C" : "#7A6F63",
                      borderBottom: deptTab===tab ? "2px solid #E0863C" : "2px solid transparent" }}>
                    {tab === "review" ? "Review" : "Notes"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {dept && deptTab === "review" && !selections[dept.key] && (
            <div style={{ textAlign:"center", color:"#7A6F63", padding:"60px 24px" }}>
              {cloudLoading
                ? "☁ Loading this department's review from the shared workspace…"
                : "No review content is loaded for this department on this device yet. If it shows on another device, the shared sync hasn't completed here — try reloading. (You can still Generate Report.)"}
            </div>
          )}
          {dept && deptTab === "review" && selections[dept.key] && (
            <DeptReviewPanel
              dept={dept} sel={selections[dept.key]}
              toggleItem={toggleItem} setRewrite={setRewrite} addItem={addItem}
              saveRefinement={saveRefinement} refinements={refinements}
              country={country} year={year} canEdit={canEdit(dept.key)}
              sbOverrides={sbOverrides} saveSbOverride={saveSbOverride}
              sbMaster={sbMaster} saveSbMaster={saveSbMaster} isAdmin={isAdmin}
              me={me} saveMe={saveMe} isPCLead={isPCLead}
            />
          )}
          {dept && deptTab === "notes" && (
            <DeptNotesTab
              dept={dept} country={country} year={year}
              me={me} saveMe={saveMe} isPCLead={isPCLead} canEdit={canEdit(dept.key)}
              sbOverrides={sbOverrides} sbMaster={sbMaster}
            />
          )}
        </div>
      </div>
    </div>
  );
}


// ─── SCORING HELP PANEL ───────────────────────────────────────────────────────
// Turn a YouTube / Vimeo / Loom share link into its embeddable URL (or null).
function videoEmbedUrl(url) {
  if (!url) return null;
  let m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  m = String(url).match(/loom\.com\/(?:share|embed)\/([\w-]+)/);
  if (m) return `https://www.loom.com/embed/${m[1]}`;
  return null;
}

// One instructional video: optional title/description + a responsive 16:9 player
// (or a link if the host isn't recognised).
function HelpVideoEmbed({ v, showTitle }) {
  const embed = videoEmbedUrl(v.url);
  // A direct video file: a link ending in a video extension, or a file uploaded
  // to Airtable. Played with the browser's own <video> player.
  const fileSrc = (!embed && v.url && /\.(mp4|webm|mov|m4v|ogg)(\?|$)/i.test(v.url)) ? v.url : (v.fileUrl || "");
  return (
    <div style={{ marginBottom:14 }}>
      {showTitle && v.title && <div style={{ fontSize:13, fontWeight:700, color:"#2C2621", marginBottom:v.description?2:6 }}>{v.title}</div>}
      {v.description && <div style={{ fontSize:12, color:"#7A6F63", lineHeight:1.5, marginBottom:6 }}>{v.description}</div>}
      {embed ? (
        <div style={{ position:"relative", width:"100%", paddingBottom:"56.25%", borderRadius:10, overflow:"hidden", border:"1px solid #ECE2D2", background:"#000" }}>
          <iframe src={embed} title={v.title || "Instructional video"} loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen
            style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", border:"none" }} />
        </div>
      ) : fileSrc ? (
        <video controls playsInline preload="metadata" src={fileSrc}
          style={{ width:"100%", maxHeight:420, borderRadius:10, border:"1px solid #ECE2D2", background:"#000", display:"block" }} />
      ) : (
        <a href={v.url} target="_blank" rel="noopener noreferrer"
          style={{ display:"inline-flex", alignItems:"center", gap:6, fontSize:13, fontWeight:600, color:"#B96524", textDecoration:"none" }}>▶ Watch the video →</a>
      )}
    </div>
  );
}

// A popup that plays one video on top of whatever panel opened it.
function VideoPlayerModal({ video, onClose }) {
  const isMobile = useIsMobile();
  if (!video) return null;
  return (
    <div style={{ position:"fixed", top:0, left:0, right:0, bottom:0, background:"rgba(0,0,0,0.6)", zIndex:1100,
      display:"flex", alignItems:"center", justifyContent:"center", padding: isMobile?12:40 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background:"white", borderRadius:14, padding: isMobile?14:20,
        maxWidth:840, width:"calc(100% - 20px)", maxHeight:"92vh", overflow:"auto", fontFamily:"'Inter',system-ui,sans-serif" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, marginBottom:12 }}>
          <div style={{ fontSize:15, fontWeight:700, color:"#2C2621" }}>{video.title || "Video"}</div>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", fontSize:20, color:"#7A6F63", lineHeight:1, padding:"0 4px" }}>✕</button>
        </div>
        <HelpVideoEmbed v={video} />
      </div>
    </div>
  );
}

// A small "▶ Watch" button; opens the given video in a popup via onPlay.
function WatchButton({ video, onPlay }) {
  if (!video) return null;
  return (
    <button onClick={() => onPlay(video)}
      style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:700, color:"#B96524",
        background:"#FBEFE4", border:"0.5px solid #E0A56F", borderRadius:20, padding:"3px 10px", cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>
      ▶ Watch
    </button>
  );
}

// Sticky top banner shown to a leader while they preview the app as another
// role. In normal flow (pushes content down) and sticky, so it's always the
// first thing on screen and the always-available way back out — no matter how
// deep they've gone or how far they scroll.
function PreviewBanner({ preview, onExit }) {
  return (
    <div style={{ position:"sticky", top:0, zIndex:1200,
      background:"#2C2621", color:"#F6F1E8", padding:"10px 16px",
      display:"flex", alignItems:"center", justifyContent:"center", gap:14, flexWrap:"wrap",
      boxShadow:"0 4px 20px rgba(0,0,0,0.22)", fontFamily:"'Inter',system-ui,sans-serif" }}>
      <span style={{ fontSize:13.5 }}>
        👁 You’re previewing as <b style={{ color:"#F0B074" }}>{preview.label}</b> — this is exactly what they see.
      </span>
      <button onClick={onExit} style={{ background:"#E0863C", color:"#fff", border:"none",
        borderRadius:8, padding:"7px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>
        ← Exit preview
      </button>
    </div>
  );
}

// Director-facing "How to use the app" video library (a modal). Same Help Videos
// table, filtered to the "How to use the app" section.
function HowToVideosPanel({ onClose }) {
  const isMobile = useIsMobile();
  const [videos, setVideos] = useState(null);
  const [playing, setPlaying] = useState(null);
  useEffect(() => {
    loadHelpVideos()
      .then(vs => setVideos(vs.filter(v => (v.section || "").trim().toLowerCase() === "how to use the app")))
      .catch(() => setVideos([]));
  }, []);
  return (
    <div style={{ position:"fixed", top:0, left:0, right:0, bottom:0, background:"rgba(0,0,0,0.4)", zIndex:1000,
      display:"flex", alignItems:"flex-start", justifyContent:"center", paddingTop: isMobile?20:60, overflow:"auto" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"white", borderRadius:14, padding: isMobile?18:32,
        maxWidth:680, width:"calc(100% - 24px)", marginBottom:40, fontFamily:"'Inter',system-ui,sans-serif" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontFamily:FONT_DISPLAY, fontSize:20, fontWeight:600, color:"#2C2621" }}>How to use the app</div>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", fontSize:20, color:"#7A6F63", lineHeight:1, padding:"0 4px" }}>✕</button>
        </div>
        {videos === null ? (
          <div style={{ color:"#7A6F63", fontSize:13, fontStyle:"italic" }}>Loading…</div>
        ) : videos.length === 0 ? (
          <div style={{ color:"#7A6F63", fontSize:13 }}>No how-to videos yet — they'll appear here once they're added.</div>
        ) : (
          <div style={{ display:"grid", gap:8 }}>
            {videos.map(v => (
              <div key={v.id} style={{ display:"flex", alignItems:"center", gap:12, border:"1px solid #ECE2D2", borderRadius:10, padding:"12px 14px" }}>
                <div style={{ minWidth:0, flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:650, color:"#2C2621" }}>{v.title || "Video"}</div>
                  {v.description && <div style={{ fontSize:12, color:"#7A6F63", lineHeight:1.5, marginTop:2 }}>{v.description}</div>}
                </div>
                <WatchButton video={v} onPlay={setPlaying} />
              </div>
            ))}
          </div>
        )}
      </div>
      <VideoPlayerModal video={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}

// Inline "How-to videos" button for the director-page top bars (Home, Review,
// Workspace) — sits with the other header buttons. Reuses the existing
// HowToVideosPanel; matches the "How scoring works" button styling.
function HowToVideosButton({ style }) {
  const [showHowTo, setShowHowTo] = useState(false);
  return (
    <>
      <button onClick={() => setShowHowTo(true)} title="How-to videos"
        style={{ ...navBtn, display:"inline-flex", alignItems:"center", gap:6, background:"white",
          border:"1px solid #ECE2D2", color:"#E0863C", fontWeight:700, ...(style||{}) }}>
        <IconHelp/> How-to videos
      </button>
      {showHowTo && <HowToVideosPanel onClose={() => setShowHowTo(false)} />}
    </>
  );
}

function ScoringHelpPanel({ onClose }) {
  const isMobile = useIsMobile();
  const [videos, setVideos] = useState([]);
  const [playing, setPlaying] = useState(null);
  useEffect(() => { loadHelpVideos().then(setVideos).catch(() => setVideos([])); }, []);
  // A small "▶ Watch" button next to a section's title, if a video is tagged for
  // it. Clicking pops the video in its own window — the text stays put.
  const videoFor = (s) => videos.find(v => (v.section || "").trim().toLowerCase() === s.toLowerCase());
  const watch = (sec) => <WatchButton video={videoFor(sec)} onPlay={setPlaying} />;
  return (
    <div style={{
      position:"fixed", top:0, left:0, right:0, bottom:0,
      background:"rgba(0,0,0,0.4)", zIndex:1000,
      display:"flex", alignItems:"flex-start", justifyContent:"center",
      paddingTop: isMobile ? 20 : 60, overflow:"auto",
    }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:"white", borderRadius:14, padding: isMobile ? 18 : 32, maxWidth:680, width:"calc(100% - 24px)",
        marginBottom:40, fontFamily:"'Inter',system-ui,sans-serif",
      }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
          <div style={{ fontSize:16, fontWeight:700, color:"#2C2621" }}>How scoring works</div>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer",
            fontSize:20, color:"#7A6F63", lineHeight:1, padding:"0 4px" }}>✕</button>
        </div>

        {/* Overview video (optional) — a standalone Watch button at the top */}
        {videoFor("Overview") && <div style={{ marginBottom:16 }}>{watch("Overview")}</div>}

        {/* MEAN vs DIST */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5 }}>Two ways to measure a question</span>
          {watch("Two ways to measure")}
        </div>
        <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:12, marginBottom:20 }}>
          {[
            { label:"Mean", title:"The average score", color:"#3E7A50", bg:"#E9F1E9", bd:"#AFD8BB",
              desc:"Add up all responses and divide by how many people answered. Simple and reliable when most people are somewhere in the middle.",
              when:"Used for questions about personal experience or attitude — growth, connection, confidence — where one or two outliers won't distort the picture." },
            { label:"Dist", title:"The response distribution", color:"#B96524", bg:"#FDFAF4", bd:"#E2CDA0",
              desc:"Instead of averaging, it asks: are enough people on the positive side? An average can hide a divided team. DIST catches that.",
              when:"Used for questions about access, clarity, or concrete experience — things that should be true for everyone. If even a third of your team can't say yes, that matters." },
          ].map(f => (
            <div key={f.label} style={{ background:f.bg, border:`1px solid ${f.bd}`, borderRadius:10, padding:14 }}>
              <div style={{ fontSize:10, fontWeight:700, color:f.color, textTransform:"uppercase",
                letterSpacing:1.5, marginBottom:4 }}>{f.label} scale</div>
              <div style={{ fontSize:13, fontWeight:700, color:"#2C2621", marginBottom:8 }}>{f.title}</div>
              <div style={{ fontSize:12, color:"#2C2621", lineHeight:1.6, marginBottom:8 }}>{f.desc}</div>
              <div style={{ fontSize:11, color:"#7A6F63", lineHeight:1.5, background:"white",
                borderRadius:6, padding:"8px 10px" }}>
                <strong style={{ color:"#2C2621" }}>Used when:</strong> {f.when}
              </div>
            </div>
          ))}
        </div>

        {/* Real example */}
        <div style={{ background:"#F6F1E8", borderRadius:10, padding:14, marginBottom:20,
          border:"1px solid #ECE2D2" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10, flexWrap:"wrap" }}>
            <span style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5 }}>Why it matters — the same responses, two different answers</span>
            {watch("Why it matters")}
          </div>
          <div style={{ fontSize:12, color:"#2C2621", fontWeight:600, marginBottom:10 }}>
            9 single staff respond to: "My practical needs are adequately supported."
          </div>
          <div style={{ display:"flex", gap:6, marginBottom:12, alignItems:"flex-end", height:44 }}>
            {[[0,"#ECE2D2"],[1,"#BE6650"],[5,"#EBD0C8"],[3,"#5C9A6D"],[0,"#ECE2D2"]].map(([c,col],i)=>(
              <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                <div style={{ width:"100%", height:`${Math.max(c/5*36,c>0?6:2)}px`,
                  background:col, borderRadius:"3px 3px 0 0", display:"flex",
                  alignItems:"center", justifyContent:"center" }}>
                  {c>0 && <span style={{ fontSize:10, fontWeight:700, color:"white" }}>{c}</span>}
                </div>
                <span style={{ fontSize:9, color:"#A89C8D" }}>{["SD","D","U","A","SA"][i]}</span>
              </div>
            ))}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>{/* two small result tiles — narrow but readable, keep side-by-side */}
            <div style={{ background:"#F7EEDC", borderRadius:8, padding:10, textAlign:"center" }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#9A6B26", textTransform:"uppercase", letterSpacing:1 }}>Mean scale says</div>
              <div style={{ fontSize:18, fontWeight:800, color:"#C08636", margin:"4px 0" }}>3.22</div>
              <div style={{ fontSize:11, color:"#C08636" }}>→ Watch</div>
            </div>
            <div style={{ background:"#F6E5DE", borderRadius:8, padding:10, textAlign:"center" }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#A34D3B", textTransform:"uppercase", letterSpacing:1 }}>Dist scale says</div>
              <div style={{ fontSize:18, fontWeight:800, color:"#BE6650", margin:"4px 0" }}>33% positive</div>
              <div style={{ fontSize:11, color:"#BE6650" }}>→ Concern</div>
            </div>
          </div>
          <div style={{ marginTop:8, fontSize:11, color:"#7A6F63", lineHeight:1.6 }}>
            The average of 3.22 looks like a mild Watch. But only 3 out of 9 people agreed their
            needs are met. DIST flags this as Concern because for a question about whether staff
            feel supported, "most people aren't sure" is not a Watch result.
          </div>
        </div>

        {/* Three factors */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5 }}>Three things that determine a department's status</span>
          {watch("Department status")}
        </div>
        {[
          { num:"1", color:"#3E7A50", bg:"#E9F1E9", bd:"#AFD8BB",
            title:"Individual question scoring",
            desc:"Each question gets its own status (Concern, Watch, or Healthy) using either MEAN or DIST. This is what the heatmap helps you verify — does the distribution match what you see on your team?" },
          { num:"2", color:"#C08636", bg:"#F7EEDC", bd:"#E3B85C",
            title:"Burden questions are flipped",
            desc:'Some questions are worded negatively — "I feel alone," "I feel overwhelmed." For these, agreeing is a bad sign. Responses are inverted before scoring so the math always reads correctly. The heatmap colours flip to match: red on the right (Strongly Agree = bad), green on the left.' },
          { num:"3", color:"#BE6650", bg:"#F6E5DE", bd:"#E2B3A8",
            title:"Concern-count override — the most important rule",
            desc:"If 3 or more individual questions score Concern, the whole department is automatically flagged as Concern — regardless of its average. An average can hide real problems. Poland HR averaged 3.24 (normally Watch) but had 4 Concern questions, so it correctly shows Concern. This is the rule that protects against averages hiding what's actually happening." },
        ].map(f => (
          <div key={f.num} style={{ display:"flex", gap:12, marginBottom:12,
            background:f.bg, border:`1px solid ${f.bd}`, borderRadius:10, padding:14 }}>
            <div style={{ width:28, height:28, borderRadius:"50%", background:"white",
              border:`1.5px solid ${f.bd}`, display:"flex", alignItems:"center",
              justifyContent:"center", fontSize:13, fontWeight:700, color:f.color, flexShrink:0 }}>{f.num}</div>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:"#2C2621", marginBottom:5 }}>{f.title}</div>
              <div style={{ fontSize:12, color:"#2C2621", lineHeight:1.6 }}>{f.desc}</div>
            </div>
          </div>
        ))}

        {/* Status thresholds */}
        <div style={{ background:"#F6F1E8", border:"1px solid #ECE2D2", borderRadius:10,
          padding:14, marginTop:4 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10, flexWrap:"wrap" }}>
            <span style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5 }}>Status thresholds</span>
            {watch("Status thresholds")}
          </div>
          <div style={{ overflowX:"auto", WebkitOverflowScrolling:"touch" }}>
          <table style={{ width:"100%", minWidth: isMobile ? 380 : "auto", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr style={{ borderBottom:"1px solid #ECE2D2" }}>
                {["Status","Mean","Dist"].map(h=>(
                  <th key={h} style={{ textAlign:"left", padding:"4px 8px", fontSize:10,
                    fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ["Healthy","#3E7A50","3.50 or above","75%+ agreed, fewer than 15% disagreed"],
                ["Watch","#C08636","2.50 – 3.49","50%+ agreed, fewer than 30% disagreed"],
                ["Concern","#BE6650","Below 2.50","Fewer than 50% agreed, or too many disagreed"],
              ].map(([s,c,m,d])=>(
                <tr key={s} style={{ borderBottom:"1px solid #F6F1E8" }}>
                  <td style={{ padding:"7px 8px", fontWeight:700, color:c, fontSize:12 }}>{s}</td>
                  <td style={{ padding:"7px 8px", color:"#2C2621", fontSize:12 }}>{m}</td>
                  <td style={{ padding:"7px 8px", color:"#2C2621", fontSize:12 }}>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        <button onClick={onClose} style={{ marginTop:20, width:"100%", padding:"10px 0",
          background:"#E0863C", color:"white", border:"none", borderRadius:8,
          fontSize:13, fontWeight:700, cursor:"pointer" }}>
          Got it — back to the review
        </button>
      </div>
      <VideoPlayerModal video={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}

// Department meeting-notes panel: a timestamped running log; each note is Private
// or Shared on its own (default Private). Saves to Airtable so notes persist.
// A single note thread (for one question, or one section via a sentinel label).
// Notes are pre-loaded by the parent and passed in; this handles composing + display.
function NoteThread({ country, year, deptKey, questionLabel, displayLabel, notes, me, isPCLead, onAdded, onFlip, sub }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [visibility, setVisibility] = useState("Private");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const visible = (notes || []).filter(n =>
    n.visibility === "Public" || (me && n.author === me) || isPCLead);

  const fmt = (iso) => { if (!iso) return ""; try { const d = new Date(iso);
    return d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}); } catch { return ""; } };

  const save = async () => {
    if (!draft.trim()) return;
    if (!me) { setErr("Set your name in the department log above first."); return; }
    setSaving(true); setErr(null);
    try {
      await addQuestionNote({ country, year, deptKey, question: questionLabel, author: me,
        title: draft.trim().split("\n")[0].slice(0,80), body: draft.trim(), visibility });
      setDraft(""); await onAdded();
    } catch (e) { setErr("Couldn't save: " + e.message); }
    setSaving(false);
  };

  // Delete a note you wrote (or any, for P&C leadership); refresh from the server.
  const del = async (n) => {
    if (!window.confirm("Delete this note? This can't be undone.")) return;
    try { await deleteQuestionNote(n.id); await onAdded(); }
    catch (e) { setErr("Couldn't delete: " + e.message); }
  };

  return (
    <div style={{ borderTop:"1px solid #FDFAF4", padding:"10px 0" }}>
      <div style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, color:"#2C2621" }}>{displayLabel || questionLabel}</div>
          {sub}
        </div>
        <button onClick={() => setOpen(o=>!o)}
          style={{ fontSize:11, fontWeight:600, color:"#E0863C", background:"#F7E7D5",
            border:"0.5px solid #E0A56F", borderRadius:5, padding:"3px 9px", cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>
          {open ? "Close" : (visible.length ? `${visible.length} note${visible.length>1?"s":""}` : "Add note")}
        </button>
      </div>

      {open && (
        <div style={{ marginTop:8 }}>
          {visible.map(n => (
            <div key={n.id} style={{ padding:"6px 0", borderTop:"1px dashed #FDFAF4" }}>
              <div style={{ fontSize:11, color:"#7A6F63", display:"flex", gap:8, alignItems:"center" }}>
                <b style={{ color:"#5A4A3B" }}>{n.author || "Unknown"}</b>{fmt(n.created) && <span>{fmt(n.created)}</span>}
                <VisibilityChip visibility={n.visibility} onClick={() => onFlip(n)} />
                {(isPCLead || (me && n.author === me)) && (
                  <button onClick={() => del(n)} title="Delete this note"
                    style={{ marginLeft:"auto", fontSize:11, fontWeight:600, color:"#BE6650",
                      background:"none", border:"none", cursor:"pointer", padding:"2px 4px" }}>Delete</button>
                )}
              </div>
              <div style={{ fontSize:13, color:"#2C2621", lineHeight:1.5, whiteSpace:"pre-wrap" }}>{n.body}</div>
            </div>
          ))}
          {me && (
            <div style={{ fontSize:11, color:"#7A6F63", marginTop:6 }}>
              Posting as <b style={{ color:"#5A4A3B" }}>{me}</b> · {todayLabel()}
            </div>
          )}
          <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={2}
            placeholder="Write a note…"
            style={{ width:"100%", boxSizing:"border-box", fontSize:13, padding:8, marginTop:6,
              border:"1px solid #E2D3C2", borderRadius:8, resize:"vertical", fontFamily:"inherit" }} />
          <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:6, flexWrap:"wrap" }}>
            <VisibilityPicker value={visibility} onChange={setVisibility} isMobile={isMobile} />
            <button onClick={save} disabled={saving || !draft.trim()}
              style={{ ...navBtn, marginLeft:"auto", background:(saving||!draft.trim())?"#ECE2D2":"#E0863C", color:(saving||!draft.trim())?"#7A6F63":"#fff" }}>
              {saving ? "Saving…" : "Add"}
            </button>
          </div>
          {err && <div style={{ color:"#BE6650", fontSize:12, marginTop:6 }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

// The "Notes" tab of a department page — notes at every level:
// general department log, a thread per section, and a thread per question.
function DeptNotesTab({ dept, country, year, me, saveMe, isPCLead, canEdit = true, sbOverrides, sbMaster }) {
  const [qNotes, setQNotes] = useState(null);   // all question+section notes for this run+dept
  const [measures, setMeasures] = useState([]); // behavioural-change measures for this dept, by question
  const measureFor = (question) => measures.find(x => x.question === question) || null;
  const upsertMeasureLocal = (saved) => setMeasures(prev => {
    const i = prev.findIndex(x => x.id === saved.id || x.question === saved.question);
    if (i >= 0) { const next = prev.slice(); next[i] = saved; return next; }
    return [saved, ...prev];
  });

  // The Survey Basics interpretation shown next to a question — same resolution
  // the report/heatmap use: run override first, then promoted master, then the
  // default library text for the question's status band.
  const sbTextFor = (q) => {
    const m = findSurveyBasics(dept.key, q.en);
    if (!m) return "";
    const level = q.status === 'Healthy' ? 'high' : q.status === 'Watch' ? 'mid' : 'low';
    const sbKey = SB_KEY[dept.key] || String(dept.key || "").toLowerCase();
    const ovKey = `${country}:${year}:${dept.key}:${normQ(q.en)}`;
    const masterKey = `${sbKey}:${normQ(q.en)}:${level}`;
    return (sbMaster && sbMaster[masterKey]) || (sbOverrides && sbOverrides[ovKey]) || m[level] || "";
  };
  const SECTIONS = [
    { key: "§ Strengths", label: "Strengths" },
    { key: "§ Growth areas", label: "Growth areas" },
    { key: "§ Quotes", label: "Quotes" },
    { key: "§ Leadership questions", label: "Leadership questions" },
  ];

  const reload = async () => {
    try { setQNotes(await loadQuestionNotes(country, year, dept.key)); }
    catch { setQNotes([]); }
  };
  useEffect(() => {
    setQNotes(null); reload();
    // Behavioural-change measures are threaded by country+dept (not run), loaded once.
    loadMeasures(country, dept.key).then(setMeasures).catch(() => setMeasures([]));
    /* eslint-disable-next-line */
  }, [country, year, dept.key]);

  const notesFor = (label) => (qNotes || []).filter(n => n.question === label);
  const flip = async (n) => {
    const next = n.visibility === "Public" ? "Private" : "Public";
    setQNotes(prev => prev.map(x => x.id===n.id ? { ...x, visibility: next } : x));
    try { await setQuestionNoteVisibility(n.id, next); } catch { reload(); }
  };

  return (
    <div>
      {/* AI digest of everything the viewer can see */}
      <NotesDigest country={country} year={year} deptKey={dept.key} deptLabel={dept.label}
        me={me} isPCLead={isPCLead} openResponses={dept.openResponses || []} />

      {/* General department log */}
      <NotesPanel country={country} year={year} deptKey={dept.key} deptLabel={dept.label}
        me={me} saveMe={saveMe} isPCLead={isPCLead} />

      {/* Section notes */}
      <div style={{ marginTop:22, border:"1px solid #ECE2D2", borderRadius:12, overflow:"hidden" }}>
        <div style={{ background:"#FBEFE4", padding:"10px 14px", fontSize:13, fontWeight:700, color:"#9A6B26" }}>Notes by section</div>
        <div style={{ padding:"4px 14px 12px" }}>
          {qNotes === null ? <div style={{ fontSize:12, color:"#7A6F63", padding:"8px 0" }}>Loading…</div> :
            SECTIONS.map(s => (
              <NoteThread key={s.key} country={country} year={year} deptKey={dept.key}
                questionLabel={s.key} displayLabel={s.label} notes={notesFor(s.key)} me={me} isPCLead={isPCLead}
                onAdded={reload} onFlip={flip} />
            ))}
        </div>
      </div>

      {/* Question notes */}
      <div style={{ marginTop:22, border:"1px solid #ECE2D2", borderRadius:12, overflow:"hidden" }}>
        <div style={{ background:"#FBEFE4", padding:"10px 14px", fontSize:13, fontWeight:700, color:"#9A6B26" }}>Notes by question</div>
        <div style={{ padding:"4px 14px 12px" }}>
          {qNotes === null ? <div style={{ fontSize:12, color:"#7A6F63", padding:"8px 0" }}>Loading…</div> :
            (dept.questions || []).map((q, i) => {
              const sbText = sbTextFor(q);
              return (
              <NoteThread key={i} country={country} year={year} deptKey={dept.key}
                questionLabel={q.en} notes={notesFor(q.en)} me={me} isPCLead={isPCLead}
                onAdded={reload} onFlip={flip}
                displayLabel={
                  <div>
                    {/* 1) Score + status */}
                    <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:4 }}>
                      <span style={{ fontSize:15, fontWeight:800, color:sc(q.status) }}>{q.score?.toFixed(2)}</span>
                      <span style={{ fontSize:9, fontWeight:700, color:sc(q.status), background:sb(q.status),
                        border:`1px solid ${sbd(q.status)}`, borderRadius:4, padding:"2px 7px" }}>{q.status}</span>
                      {q.burden && <span style={{ fontSize:9, color:"#C08636" }}>Burden [inv.]</span>}
                    </div>
                    {/* 2) The question */}
                    <div style={{ fontSize:13, color:"#2C2621", lineHeight:1.5 }}>{q.en}</div>
                  </div>
                }
                sub={
                  <>
                    {/* 3) Survey Basics — what this score means, so directors know what they're noting */}
                    <div style={{ marginTop:6, borderLeft:"2px solid #F0DFCE", paddingLeft:8 }}>
                      <span style={{ fontSize:9, fontWeight:700, color:"#7A6F63",
                        textTransform:"uppercase", letterSpacing:.5, display:"block", marginBottom:2 }}>Survey Basics</span>
                      <span style={{ fontSize:12, color:"#5A4A3B", lineHeight:1.45, fontStyle: sbText ? "normal" : "italic" }}>
                        {sbText || "No Survey Basics interpretation is on file for this question."}
                      </span>
                    </div>
                    {/* 4) Behavioural-change tracking (threaded across runs) */}
                    <MeasurePanel country={country} deptKey={dept.key} question={q.en}
                      currentScore={q.score} author={me} canEdit={canEdit}
                      measure={measureFor(q.en)} onSaved={upsertMeasureLocal} />
                  </>
                } />
              );
            })}
        </div>
      </div>
    </div>
  );
}

// ─── QUESTION WORKSPACE ───────────────────────────────────────────────────────
// A question-first surface for directors (and leaders): pick a department and
// work through its questions one by one — read the score + Survey Basics, jot
// notes, and track behaviour change. Reuses Question Notes + the Measures panel;
// adds a progress summary and filters so a director can focus on what matters.
function WorkspaceView({ allRuns, setView, authRole, authUser, authDepts = [], canEditDept, me, isPCLead, sbOverrides, sbMaster }) {
  const isMobile = useIsMobile();
  const countries = [...new Set((allRuns || []).map(r => r.country))].filter(Boolean).sort();
  // Directors are international — they pick any country. Only country leaders lock.
  const lockedCountry = authRole === "country" ? (authUser && authUser.country) : null;
  // Directors are limited to their own department(s); everyone else sees all.
  const myDeptCodes = authRole === "director" ? authDepts : null;   // null = no restriction
  const [country, setCountry] = useState(lockedCountry || countries[0] || "");

  // Latest run for the chosen country drives the question set.
  const latestRun = (allRuns || []).filter(r => r.country === country)
    .sort((a, b) => Number(b.year) - Number(a.year))[0];
  const year = latestRun && latestRun.year;

  const [sd, setSd] = useState(null);          // { depts } for the run (null = loading)
  const [deptKey, setDeptKey] = useState((myDeptCodes && myDeptCodes[0]) || null);
  const [notes, setNotes] = useState([]);
  const [measures, setMeasures] = useState([]);
  const [filter, setFilter] = useState("attention");   // all | attention | tracked

  // Load the run's survey data when country/year changes.
  useEffect(() => {
    if (!country || !year) { setSd(null); return; }
    let alive = true;
    setSd(null);
    loadRunSurveyData(country, year).then(d => {
      if (!alive) return;
      setSd(d || { depts: {} });
      // Codes this viewer may open: a director's own department(s) that exist in
      // this run, otherwise every department in the run.
      const all = Object.keys((d && d.depts) || {});
      const codes = myDeptCodes ? all.filter(c => myDeptCodes.includes(c)) : all;
      setDeptKey(prev => (codes.includes(prev) ? prev : codes[0] || null));
    }).catch(() => { if (alive) setSd({ depts: {} }); });
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [country, year]);

  // Load notes + measures when the department changes.
  const reloadNotes = () => loadQuestionNotes(country, year, deptKey).then(setNotes).catch(() => setNotes([]));
  useEffect(() => {
    if (!country || !deptKey) { setNotes([]); setMeasures([]); return; }
    reloadNotes();
    loadMeasures(country, deptKey).then(setMeasures).catch(() => setMeasures([]));
    // eslint-disable-next-line
  }, [country, year, deptKey]);

  const canEdit = deptKey ? canEditDept(deptKey) : false;
  const dept = sd && deptKey ? sd.depts[deptKey] : null;
  const measureFor = (qtext) => measures.find(x => x.question === qtext) || null;
  const upsertMeasureLocal = (saved) => setMeasures(prev => {
    const i = prev.findIndex(x => x.id === saved.id || x.question === saved.question);
    if (i >= 0) { const n = prev.slice(); n[i] = saved; return n; }
    return [saved, ...prev];
  });
  const notesFor = (qtext) => notes.filter(n => n.question === qtext);
  const flip = async (n) => {
    const next = n.visibility === "Public" ? "Private" : "Public";
    setNotes(prev => prev.map(x => x.id === n.id ? { ...x, visibility: next } : x));
    try { await setQuestionNoteVisibility(n.id, next); } catch { reloadNotes(); }
  };
  const sbTextFor = (q) => {
    const m = findSurveyBasics(deptKey, q.en);
    if (!m) return "";
    const level = q.status === 'Healthy' ? 'high' : q.status === 'Watch' ? 'mid' : 'low';
    const sbKey = SB_KEY[deptKey] || String(deptKey || "").toLowerCase();
    const ovKey = `${country}:${year}:${deptKey}:${normQ(q.en)}`;
    const masterKey = `${sbKey}:${normQ(q.en)}:${level}`;
    return (sbMaster && sbMaster[masterKey]) || (sbOverrides && sbOverrides[ovKey]) || m[level] || "";
  };

  // Measure summary + progress.
  const latestOf = (mm) => mm.checks && mm.checks.length ? Number(mm.checks[mm.checks.length - 1].value) : (mm.baseline != null ? Number(mm.baseline) : null);
  const tracked = measures.length;
  const achieved = measures.filter(mm => mm.status === "Achieved" || (mm.target != null && latestOf(mm) != null && latestOf(mm) >= Number(mm.target))).length;
  const moves = measures.map(mm => (latestOf(mm) != null && mm.baseline != null) ? latestOf(mm) - Number(mm.baseline) : null).filter(v => v != null);
  const avgMove = moves.length ? (moves.reduce((a, b) => a + b, 0) / moves.length) : null;

  const allQs = (dept && dept.questions) || [];
  const questions = allQs
    .filter(q => filter === "all" ? true : filter === "tracked" ? !!measureFor(q.en) : (q.status === "Concern" || q.status === "Watch"))
    .sort((a, b) => (parseFloat(a.score) || 9) - (parseFloat(b.score) || 9));

  const depts = sd ? Object.values(sd.depts) : [];
  const Tile = ({ n, label, color }) => (
    <div style={{ ...card, padding: "12px 14px", textAlign: "center", minWidth: 0 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 600, color: color || "#2C2621", fontVariantNumeric: "tabular-nums" }}>{n}</div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: .5, marginTop: 2 }}>{label}</div>
    </div>
  );
  const filterBtn = (key, label) => (
    <button onClick={() => setFilter(key)} style={{
      fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 20, cursor: "pointer",
      background: filter === key ? "#2C2621" : "#FFFFFF", color: filter === key ? "#fff" : "#5A4A3B",
      border: `1px solid ${filter === key ? "#2C2621" : "#E2D3C2"}` }}>{label}</button>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#F6F1E8", fontFamily: "'Inter',system-ui,sans-serif", padding: isMobile ? "20px 14px" : "28px 20px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
          <button onClick={() => setView("__back__")} style={{ ...navBtn }}>← Back</button>
          <HowToVideosButton />
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 600, color: "#2C2621" }}>Question workspace</span>
        </div>

        {/* Scope pickers */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
          {!lockedCountry && countries.length > 0 && (
            <select value={country} onChange={e => setCountry(e.target.value)}
              style={{ fontSize: 13, padding: "8px 12px", border: "1px solid #E2D3C2", borderRadius: 8, background: "#fff", color: "#2C2621" }}>
              {countries.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {country && <span style={{ alignSelf: "center", fontSize: 12, color: "#A89C8D" }}>{country}{year ? ` · ${year}` : ""}</span>}
        </div>

        {/* Department picker — shown as clear tabs so a director over more than one
            department sees all of theirs at once (not hidden in a dropdown). */}
        {(() => {
          const myDepts = myDeptCodes ? depts.filter(d => myDeptCodes.includes(d.key)) : depts;
          if (myDepts.length <= 1) return null;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
              {myDeptCodes && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: 1, marginRight: 2 }}>
                  Your {myDepts.length} departments
                </span>
              )}
              {myDepts.map(d => {
                const active = d.key === deptKey;
                return (
                  <button key={d.key} onClick={() => setDeptKey(d.key)} style={{
                    fontSize: 12.5, fontWeight: 600, padding: "7px 13px", borderRadius: 20, cursor: "pointer",
                    background: active ? "#2C2621" : "#FFFFFF", color: active ? "#fff" : "#5A4A3B",
                    border: `1px solid ${active ? "#2C2621" : "#E2D3C2"}`,
                    display: "inline-flex", alignItems: "center", gap: 7 }}>
                    {d.status && <span style={{ width: 8, height: 8, borderRadius: "50%", background: sc(d.status), flexShrink: 0 }} />}
                    {d.label || d.key}
                  </button>
                );
              })}
            </div>
          );
        })()}

        {sd === null ? (
          <div style={{ ...card, color: "#7A6F63", fontSize: 13, fontStyle: "italic" }}>Loading the latest pulse…</div>
        ) : !dept ? (
          <div style={{ ...card, color: "#7A6F63", fontSize: 13 }}>
            {latestRun ? "No question data for this department in the latest run." : "No pulse run found for this country yet."}
          </div>
        ) : (
          <>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 600, color: "#2C2621", marginBottom: 12 }}>{dept.label || dept.key}</div>

            {/* AI digest of the notes + open responses this viewer can see */}
            <NotesDigest country={country} year={year} deptKey={deptKey} deptLabel={dept.label || dept.key}
              me={me} isPCLead={isPCLead} openResponses={dept.openResponses || []} />

            {/* Tracking summary */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(90px,1fr))", gap: 10, marginBottom: 16 }}>
              <Tile n={allQs.length} label="Questions" />
              <Tile n={tracked} label="Tracked" color="#B96524" />
              <Tile n={achieved} label="At target" color="#5C9A6D" />
              <Tile n={avgMove == null ? "–" : `${avgMove >= 0 ? "+" : ""}${avgMove.toFixed(2)}`} label="Avg movement" color={avgMove == null ? "#A89C8D" : avgMove >= 0 ? "#5C9A6D" : "#BE6650"} />
            </div>

            {/* Filters */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              {filterBtn("attention", "Needs attention")}
              {filterBtn("tracked", "Tracked")}
              {filterBtn("all", "All questions")}
            </div>

            {/* Question rows */}
            <div style={{ ...card, padding: 0, overflow: "hidden" }}>
              {questions.length === 0 ? (
                <div style={{ padding: "16px", fontSize: 13, color: "#7A6F63" }}>Nothing here — try another filter.</div>
              ) : questions.map((q, i) => (
                <div key={i} style={{ padding: isMobile ? "12px 14px" : "14px 16px", borderTop: i ? "1px solid #F3EBE1" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                    <span style={{ fontFamily: FONT_DISPLAY, fontSize: 17, fontWeight: 600, color: sc(q.status) }}>{q.score != null ? Number(q.score).toFixed(2) : "–"}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, color: sc(q.status), background: sb(q.status), border: `1px solid ${sbd(q.status)}`, borderRadius: 4, padding: "2px 7px" }}>{q.status}</span>
                    {q.burden && <span style={{ fontSize: 9, color: "#C08636" }}>Burden [inv.]</span>}
                  </div>
                  <div style={{ fontSize: 13.5, color: "#2C2621", lineHeight: 1.5 }}>{q.en}</div>
                  {sbTextFor(q) && (
                    <div style={{ marginTop: 6, borderLeft: "2px solid #F0DFCE", paddingLeft: 8 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: .5, display: "block", marginBottom: 2 }}>Survey Basics</span>
                      <span style={{ fontSize: 12, color: "#5A4A3B", lineHeight: 1.45 }}>{sbTextFor(q)}</span>
                    </div>
                  )}
                  <MeasurePanel country={country} deptKey={deptKey} question={q.en}
                    currentScore={q.score} author={me} canEdit={canEdit}
                    measure={measureFor(q.en)} onSaved={upsertMeasureLocal} />
                  <div style={{ marginTop: 6 }}>
                    <NoteThread country={country} year={year} deptKey={deptKey}
                      questionLabel={q.en} displayLabel={<span style={{ fontSize: 12, color: "#7A6F63" }}>Notes</span>}
                      notes={notesFor(q.en)} me={me} isPCLead={isPCLead} onAdded={reloadNotes} onFlip={flip} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NotesPanel({ country, year, deptKey, deptLabel, me, saveMe, isPCLead }) {
  const isMobile = useIsMobile();
  const [notes, setNotes] = useState(null);      // null = loading
  const [draft, setDraft] = useState("");
  const [visibility, setVisibility] = useState("Private");
  const [saving, setSaving] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [err, setErr] = useState(null);

  const reload = async () => {
    try {
      const list = await loadDepartmentNotes(country, year, deptKey);
      setNotes(list);
    } catch (e) { setErr(e.message); setNotes([]); }
  };
  useEffect(() => { setNotes(null); reload(); /* eslint-disable-next-line */ }, [country, year, deptKey]);

  // Visibility rule: show a note if it's Public, or you wrote it, or you're P&C lead.
  const visible = (notes || []).filter(n =>
    n.visibility === "Public" || (me && n.author === me) || isPCLead);

  const fmt = (iso) => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
        " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  };

  const save = async () => {
    if (!draft.trim()) return;
    if (!me) { setErr("Set your name first so the note is yours."); return; }
    setSaving(true); setErr(null);
    try {
      await addDepartmentNote({ country, year, deptKey, author: me,
        title: draft.trim().split("\n")[0].slice(0, 80), body: draft.trim(), visibility });
      setDraft("");
      await reload();
    } catch (e) { setErr("Couldn't save note: " + e.message); }
    setSaving(false);
  };

  const flip = async (n) => {
    const next = n.visibility === "Public" ? "Private" : "Public";
    // optimistic
    setNotes(prev => prev.map(x => x.id === n.id ? { ...x, visibility: next } : x));
    try { await setDepartmentNoteVisibility(n.id, next); }
    catch (e) { setErr("Couldn't change visibility: " + e.message); reload(); }
  };

  // You can delete a note you wrote; P&C leadership can delete any note.
  const canDelete = (n) => isPCLead || (me && n.author === me);
  const del = async (n) => {
    if (!window.confirm("Delete this note? This can't be undone.")) return;
    setNotes(prev => prev.filter(x => x.id !== n.id));   // optimistic
    try { await deleteDepartmentNote(n.id); }
    catch (e) { setErr("Couldn't delete note: " + e.message); reload(); }
  };

  return (
    <div style={{ marginTop: 22, border: "1px solid #ECE2D2", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ background: "#FBEFE4", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#9A6B26" }}>Meeting notes — {deptLabel || deptKey}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#7A6F63" }}>
          {me ? <>Signed in as <b style={{ color: "#5A4A3B" }}>{me}</b></> : "Not signed in"}
        </span>
      </div>

      <div style={{ padding: 14 }}>
        <div style={{ fontSize: 12, color: "#7A6F63", background:"#FDFAF4", border:"1px solid #FDFAF4",
          borderRadius:8, padding:"8px 12px", marginBottom:14, lineHeight:1.5 }}>
          Every note is <b>Private by default</b> — only you & P&C leadership (Mel &amp; Chris) see it.
          Set a note to <b>Shared</b> to let the team &amp; country leadership see that one. Each note is
          its own choice, and you can change any note anytime with its tag.
        </div>
        {!me && (
          <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#7A6F63" }}>Your name (so notes are yours):</span>
            <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="e.g. Mel"
              style={{ fontSize: 13, padding: "5px 9px", border: "1px solid #E2D3C2", borderRadius: 6 }} />
            <button onClick={() => saveMe(nameInput)} style={{ ...navBtn, background: "#E0863C", color: "#fff" }}>Set name</button>
          </div>
        )}

        {/* Composer */}
        {me && (
          <div style={{ fontSize: 11.5, color: "#7A6F63", marginBottom: 6 }}>
            Posting as <b style={{ color: "#5A4A3B" }}>{me}</b> · {todayLabel()} — your name &amp; the date are added automatically.
          </div>
        )}
        <textarea value={draft} onChange={e => setDraft(e.target.value)}
          placeholder="Write a note for this department — thoughts on the scores, what to raise in the next meeting…"
          rows={3}
          style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: 10,
            border: "1px solid #E2D3C2", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <VisibilityPicker value={visibility} onChange={setVisibility} isMobile={isMobile} />
          <button onClick={save} disabled={saving || !draft.trim()}
            style={{ ...navBtn, marginLeft: "auto", background: (saving || !draft.trim()) ? "#ECE2D2" : "#E0863C",
              color: (saving || !draft.trim()) ? "#7A6F63" : "#fff" }}>
            {saving ? "Saving…" : "Add note"}
          </button>
        </div>
        {err && <div style={{ color: "#BE6650", fontSize: 12, marginTop: 8 }}>{err}</div>}

        {/* Log */}
        <div style={{ marginTop: 16 }}>
          {notes === null && <div style={{ fontSize: 12, color: "#7A6F63" }}>Loading notes…</div>}
          {notes !== null && visible.length === 0 &&
            <div style={{ fontSize: 12, color: "#7A6F63" }}>No notes yet for this department.</div>}
          {visible.map(n => (
            <div key={n.id} style={{ borderTop: "1px solid #FDFAF4", padding: "10px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#5A4A3B" }}>{n.author || "Unknown"}</span>
                <span style={{ fontSize: 11, color: "#A89C8D" }}>{fmt(n.created)}</span>
                <VisibilityChip visibility={n.visibility} onClick={() => flip(n)} />
                {canDelete(n) && (
                  <button onClick={() => del(n)} title="Delete this note"
                    style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: "#BE6650",
                      background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}>Delete</button>
                )}
              </div>
              <div style={{ fontSize: 13, color: "#2C2621", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{n.body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DeptReviewPanel({ dept, sel, toggleItem, setRewrite, addItem, saveRefinement, refinements, country, year, canEdit = true, sbOverrides, saveSbOverride, sbMaster, saveSbMaster, isAdmin, me, saveMe, isPCLead }) {
  const isMobile = useIsMobile();
  // Which question's heatmap popup is open on mobile (index), or null. One at a time.
  const [openHeatmap, setOpenHeatmap] = useState(null);
  const sections = [
    { key:"strengths",    label:"Strengths",            color:"#5C9A6D", instruction:"Check to include. Uncheck to exclude. Click Edit to revise wording — it will appear exactly as written in the report." },
    { key:"growth",       label:"Growth areas",         color:"#C08636", instruction:"Check to include. Click Edit to revise wording." },
    { key:"leadershipQs", label:"Leadership questions", color:"#B96524", instruction:"Check to include. Select 1–2 maximum. Click Edit to revise." },
    { key:"quotes",       label:"Staff quotes",         color:"#5A4A3B", instruction:"Check to include. Up to 4 quotes appear verbatim. Edit only to correct a translation." },
  ];

  return (
    <div>
      {/* The department name + status + score now live once, in the page header
          above the Review/Notes tabs — no need to repeat them here. */}

      {/* Nested, collapsible review — one panel, drill in per part */}
      <div style={{ background:"#FFFFFF", border:"1px solid #ECE2D2", borderRadius:12, overflow:"hidden",
        boxShadow:"0 1px 2px rgba(58,38,22,.06), 0 6px 22px -8px rgba(58,38,22,.10)" }}>

        <Disclosure title="Question scores" count={`${(dept.questions||[]).length} questions`} dot="#E0863C" flush>
        {/* Heatmap — Question Scores */}
        <div style={{ overflowX:"auto", marginBottom:0 }}>
          {/* Column headers */}
          <div style={{ display:"grid",
            gridTemplateColumns: isMobile ? "48px 1fr" : "90px 52px 60px 1fr 52px 290px", gap:0,
            background:"#FBEFE4", borderBottom:"2px solid #ECE2D2", padding:"7px 12px",
            fontSize:10, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5 }}>
            {isMobile ? <><span>Score</span><span>Question</span></> : <>
            <span>Section</span>
            <span>Score</span>
            <span>Status</span>
            <span>Full Question Text</span>
            <span style={{textAlign:"center"}}>Scale</span>
            <span style={{textAlign:"center"}}>Heatmap — Strongly Disagree · Disagree · Unsure · Agree · Strongly Agree</span></>}
          </div>

          {[...dept.questions].sort((a,b) => {
            const o = {Concern:0,Watch:1,Healthy:2};
            return (o[a.status]??1)-(o[b.status]??1) || a.score-b.score;
          }).map((q,i) => {
            // counts = [SD=1, D=2, U=3, A=4, SA=5]
            const counts = q.counts || [0,0,0,0,0];
            const n = counts.reduce((a,b)=>a+b,0) || 1;
            // Heatmap colours matching the Excel workbook
            // For burden (inverted): high SA = bad outcome, so colours flip
            const CELL_COLORS = q.burden
              ? ["#5C9A6D","#7FB894","#EBD0C8","#D89080","#BE6650"] // SD=green, SA=red (burden inverted)
              : ["#BE6650","#D89080","#EBD0C8","#7FB894","#5C9A6D"]; // SD=red, SA=green
            const CELL_TEXT   = q.burden
              ? ["white","white","#A34D3B","white","white"]
              : ["white","white","white","white","white"];
            const LABELS = ["Strongly Disagree","Disagree","Unsure","Agree","Strongly Agree"];
            // Status row background
            const statusRowBg = {Concern:"#F6E5DE", Watch:"#F7EEDC", Healthy:"#E9F1E9"}[q.status] || "#F6F1E8";

            return (
              <div key={i} style={{ borderBottom:"1px solid #FBEFE4" }}>
                {/* Main row */}
                <div style={{ display:"grid",
                  gridTemplateColumns: isMobile ? "48px 1fr" : "90px 52px 60px 1fr 52px 290px",
                  gap:0, alignItems:"stretch", background: i%2===0?"#FFFFFF":"#F6F1E8",
                  position: isMobile ? "relative" : "static" }}>
                  {/* Section type (Q or Burden) — hidden on mobile */}
                  {!isMobile && (
                  <div style={{ padding:"10px 8px", display:"flex", alignItems:"center",
                    background: q.burden ? "#F7EEDC" : "#FBEFE4",
                    borderRight:"1px solid #ECE2D2" }}>
                    <span style={{ fontSize:10, fontWeight:700,
                      color: q.burden ? "#C08636" : "#7A6F63" }}>
                      {q.burden ? "Burden [inv.]" : "Q"}
                    </span>
                  </div>)}
                  {/* Score */}
                  <div style={{ padding:"10px 8px", display:"flex", alignItems:"center",
                    background:statusRowBg, borderRight: isMobile ? "none" : "1px solid #ECE2D2" }}>
                    <span style={{ fontSize:13, fontWeight:800, color:sc(q.status) }}>{q.score?.toFixed(2)}</span>
                  </div>
                  {/* Status — hidden on mobile (shown inside question block instead) */}
                  {!isMobile && (
                  <div style={{ padding:"10px 6px", display:"flex", alignItems:"center", justifyContent:"center",
                    background:statusRowBg, borderRight:"1px solid #ECE2D2" }}>
                    <span style={{ fontSize:9, fontWeight:700, color:sc(q.status),
                      background:sb(q.status), border:`1px solid ${sbd(q.status)}`,
                      borderRadius:4, padding:"2px 5px", textAlign:"center" }}>{q.status}</span>
                  </div>)}
                  {/* Question text + Survey Basics inline */}
                  <div style={{ padding:"10px 12px", verticalAlign:"top",
                    borderRight: isMobile ? "none" : "1px solid #ECE2D2", position:"relative" }}>
                    {isMobile && (
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                        <span style={{ fontSize:9, fontWeight:700, color:sc(q.status),
                          background:sb(q.status), border:`1px solid ${sbd(q.status)}`,
                          borderRadius:4, padding:"2px 6px" }}>{q.status}</span>
                        {q.burden && <span style={{ fontSize:9, color:"#C08636" }}>Burden [inv.]</span>}
                        <button onClick={() => setOpenHeatmap(openHeatmap===i ? null : i)}
                          style={{ marginLeft:"auto", fontSize:11, fontWeight:600, color:"#E0863C",
                            background:"#F7E7D5", border:"0.5px solid #E0A56F", borderRadius:5,
                            padding:"3px 10px", cursor:"pointer" }}>
                          {openHeatmap===i ? "Close" : "Heatmap"}
                        </button>
                      </div>
                    )}
                    <div style={{ fontSize:12, color:"#2C2621", lineHeight:1.5, marginBottom:6 }}>
                      {q.en}{q.burden && !isMobile ? <span style={{ color:"#C08636", fontSize:10, marginLeft:4 }}>[Burden]</span> : ""}
                    </div>
                    {/* Mobile heatmap popup — overlays the question, one at a time */}
                    {isMobile && openHeatmap===i && (
                      <div style={{ position:"absolute", top:4, left:8, right:8, zIndex:20,
                        background:"#FFFFFF", border:"1px solid #ECE2D2", borderRadius:10,
                        boxShadow:"0 8px 24px rgba(0,0,0,0.18)", padding:12 }}>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                          <span style={{ fontSize:11, fontWeight:700, color:"#2C2621" }}>Response breakdown</span>
                          <button onClick={() => setOpenHeatmap(null)} aria-label="Close"
                            style={{ fontSize:12, color:"#7A6F63", background:"none", border:"none",
                              cursor:"pointer", padding:"2px 6px" }}>✕</button>
                        </div>
                        <div style={{ display:"flex", gap:4 }}>
                          {counts.map((c, ci) => (
                            <div key={ci} style={{ flex:1, textAlign:"center" }}>
                              <div style={{ background: c>0?CELL_COLORS[ci]:"#FBEFE4", color: c>0?CELL_TEXT[ci]:"#F0DFCE",
                                borderRadius:5, padding:"8px 0", fontSize:13, fontWeight:700,
                                border: c>0?"none":"1px solid #ECE2D2" }}>{c}</div>
                              <div style={{ fontSize:8.5, fontWeight:600, color:"#7A6F63", marginTop:4, lineHeight:1.2 }}>
                                {LABELS[ci]}
                              </div>
                              <div style={{ fontSize:8, color:"#A89C8D", marginTop:2 }}>
                                {c>0 ? Math.round(c/n*100)+"%" : ""}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize:10, color:"#7A6F63", marginTop:10 }}>{n} respondents · mean {q.score?.toFixed(2)}</div>
                      </div>
                    )}
                    {(() => {
                      const sbMatch = findSurveyBasics(dept.key, q.en);
                      if (!sbMatch) return null;
                      // Level for this question based on its status
                      const level = q.status === 'Healthy' ? 'high' : q.status === 'Watch' ? 'mid' : 'low';
                      const origText = sbMatch[level];
                      // Precedence: the shared master default wins, then any legacy
                      // per-run override, then the built-in original. Editing writes
                      // the master, so an edit becomes the default for every report.
                      const sbKey = SB_KEY[dept.key] || String(dept.key||"").toLowerCase();
                      const masterKey = `${sbKey}:${normQ(q.en)}:${level}`;
                      const masterText = sbMaster?.[masterKey];
                      const ovKey = `${country}:${year}:${dept.key}:${normQ(q.en)}`;
                      const override = sbOverrides?.[ovKey];
                      const customized = !!masterText;
                      const sbText = masterText || override || origText;
                      const editId = `sbedit-${dept.key}-${i}`;
                      return (
                        <div>
                          <div style={{ display:"flex", alignItems:"flex-start", gap:6,
                            background:"#F6F1E8", borderRadius:5, padding:"5px 8px" }}>
                            <span style={{ fontSize:9, fontWeight:700, color:"#7A6F63",
                              textTransform:"uppercase", letterSpacing:.5,
                              whiteSpace:"nowrap", paddingTop:1, flexShrink:0 }}>Survey Basics</span>
                            <span style={{ fontSize:11, color: customized ? "#2C2621" : "#7A6F63",
                              fontStyle:"italic", lineHeight:1.4, flex:1 }}>
                              {sbText}
                              {customized && <span style={{ fontStyle:"normal", fontSize:9, fontWeight:700,
                                color:"#3E7A50", marginLeft:6 }}>★ default</span>}
                            </span>
                            {canEdit && (
                              <button
                                onClick={() => {
                                  const el = document.getElementById(editId);
                                  if (el) el.style.display = el.style.display === "block" ? "none" : "block";
                                }}
                                style={{ fontSize:10, color:"#E0863C", background:"#F7E7D5",
                                  border:"0.5px solid #E0A56F", borderRadius:4, padding:"2px 8px",
                                  cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>
                                Edit
                              </button>
                            )}
                          </div>
                          {canEdit && (
                            <div id={editId} style={{ display:"none", marginTop:5 }}>
                              <textarea
                                defaultValue={masterText || override || ""}
                                placeholder="Rewrite this interpretation. It becomes the default for this question in every report."
                                onBlur={(e) => saveSbMaster && saveSbMaster(sbKey, q.en, level, e.target.value)}
                                style={{ width:"100%", border:"0.5px solid #F0DFCE", borderRadius:5,
                                  padding:"6px 8px", fontSize:11, color:"#2C2621",
                                  background:"white", resize:"vertical", minHeight:44,
                                  fontFamily:"inherit", lineHeight:1.5 }}
                              />
                              <div style={{ fontSize:9, color:"#7A6F63", marginTop:3 }}>
                                Saves when you click away, and becomes the default {level==="low"?"Concern":level==="mid"?"Watch":"Healthy"} interpretation for this question in <b>every</b> report — current and future. Clear the box to restore the original.
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  {/* Scale — hidden on mobile */}
                  {!isMobile && (
                  <div style={{ padding:"10px 6px", display:"flex", alignItems:"center", justifyContent:"center",
                    borderRight:"1px solid #ECE2D2" }}>
                    <span style={{ fontSize:10, fontWeight:700, color:"#7A6F63",
                      background:"#FBEFE4", borderRadius:4, padding:"2px 6px" }}>
                      {q.scale.toUpperCase()}
                    </span>
                  </div>)}
                  {/* Heatmap cells — one per response option (desktop only; mobile uses popup) */}
                  {!isMobile && (
                  <div style={{ display:"flex", alignItems:"flex-start", padding:"8px 10px", gap:5 }}>
                    {counts.map((c, ci) => (
                      <div key={ci} style={{ flex:1, display:"flex", flexDirection:"column",
                        alignItems:"center", gap:3 }}>
                        {/* Coloured cell — fixed height so zeros don't shift labels */}
                        <div style={{
                          width:"100%", height:32,
                          background: c > 0 ? CELL_COLORS[ci] : "#FBEFE4",
                          borderRadius:5, flexShrink:0,
                          display:"flex", alignItems:"center", justifyContent:"center",
                          fontSize:13, fontWeight:700,
                          color: c > 0 ? "white" : "#F0DFCE",
                          border: c > 0 ? "none" : "1px solid #ECE2D2",
                        }}>
                          {c}
                        </div>
                        {/* Full label — fixed two-line height */}
                        <div style={{ fontSize:8, fontWeight:600, color:"#7A6F63",
                          textAlign:"center", lineHeight:1.25, height:22 }}>
                          {ci===0 && <><span>Strongly</span><br/><span>Disagree</span></>}
                          {ci===1 && <span>Disagree</span>}
                          {ci===2 && <span>Unsure</span>}
                          {ci===3 && <span>Agree</span>}
                          {ci===4 && <><span>Strongly</span><br/><span>Agree</span></>}
                        </div>
                        {/* Percentage — fixed height so row stays aligned */}
                        <div style={{ fontSize:8, color:"#A89C8D", textAlign:"center", height:12 }}>
                          {c > 0 ? Math.round(c/n*100)+"%" : ""}
                        </div>
                      </div>
                    ))}
                  </div>)}
                </div>

              </div>
            );
          })}
        </div>
        </Disclosure>

        {/* Content sections — each nested & collapsible, with an included-count */}
        {sections.map(sec => {
          const secItems = sel[sec.key] || [];
          const inc = secItems.filter(i => i.include).length;
          const countLabel = secItems.length ? `${inc} of ${secItems.length} included` : "none";
          return (
        <Disclosure key={sec.key} title={sec.label} count={countLabel} dot={sec.color} flush>
          {sec.key === "quotes" && dept.openQLabel && (
            <div style={{ margin:"0 14px 8px", padding:"6px 10px",
              background:"#FDFAF4", borderLeft:"3px solid #E0863C", borderRadius:4 }}>
              <span style={{ fontSize:9, fontWeight:700, color:"#B96524",
                textTransform:"uppercase", letterSpacing:.5, marginRight:6 }}>Responding to</span>
              <span style={{ fontSize:12, color:"#5A4A3B", fontStyle:"italic" }}>"{dept.openQLabel}"</span>
            </div>
          )}
          <div style={{ color:"#7A6F63", fontSize:11, margin:"0 14px 8px" }}>{sec.instruction}</div>
          {secItems.map((item, idx) => {
            const editId = `item-edit-${dept.key}-${sec.key}-${idx}`;
            return (
              <div key={idx} style={{ borderBottom:"1px solid #FBEFE4",
                background: item.include ? "white" : "#FDFAF4",
                opacity: item.include ? 1 : 0.6 }}>
                {/* Main row — tight, single line */}
                <div style={{ display:"flex", alignItems:"center", gap:10, padding: isMobile ? "11px 12px" : "9px 14px" }}>
                  <input type="checkbox" checked={item.include} disabled={!canEdit}
                    onChange={() => canEdit && toggleItem(dept.key, sec.key, idx)}
                    title={canEdit ? undefined : "You can only edit your own department"}
                    style={{ flexShrink:0, cursor: canEdit ? "pointer" : "default", accentColor:"#E0863C",
                      width: isMobile ? 20 : 15, height: isMobile ? 20 : 15, opacity: canEdit ? 1 : 0.55 }} />
                  <div style={{ flex:1 }}>
                    {(() => {
                      const displayText = item.rewrite.trim() || item.text;
                      const nonEng = item.isOriginalLang || looksNonEnglish(displayText);
                      return (
                        <>
                          <div style={{ fontSize:12, lineHeight:1.5,
                            color: item.include ? "#2C2621" : "#7A6F63",
                            textDecoration: item.include ? "none" : "line-through",
                            fontStyle: nonEng ? "italic" : "normal" }}>
                            {displayText}
                            {item.isRefined && !item.rewrite && (
                              <span style={{ marginLeft:8, fontSize:9, color:"#E0863C",
                                fontWeight:600, background:"#F7E7D5", borderRadius:4,
                                padding:"1px 5px" }}>✦ refined</span>
                            )}
                          </div>
                          {nonEng && (
                      <div style={{ marginTop:4, fontSize:11, lineHeight:1.4,
                        borderLeft:"2px solid #F0DFCE", paddingLeft:8 }}>
                        {item.translation ? (
                          <>
                            <span style={{ fontSize:9, fontWeight:700, color:"#7A6F63",
                              textTransform:"uppercase", letterSpacing:.5,
                              marginRight:6 }}>English translation</span>
                            <span style={{ color:"#5A4A3B" }}>{item.translation}</span>
                          </>
                        ) : (
                          <span style={{ fontSize:10, color:"#A89C8D", fontStyle:"italic" }}>
                            Original language response — translation not yet available
                          </span>
                        )}
                          </div>
                        )}
                        </>
                      );
                    })()}
                  </div>
                  {item.include && canEdit && (
                    <button
                      onClick={() => {
                        const el = document.getElementById(editId);
                        if (!el) return;
                        const opening = el.style.display !== "block";
                        el.style.display = opening ? "block" : "none";
                      }}
                      style={{ fontSize: isMobile ? 12 : 10, color:"#E0863C", background:"#F7E7D5",
                        border:"0.5px solid #E0A56F", borderRadius:5,
                        padding: isMobile ? "8px 14px" : "3px 9px", minHeight: isMobile ? 36 : "auto",
                        cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>
                      {item.rewrite.trim() ? "Edited ✓" : "Edit"}
                    </button>
                  )}
                </div>
                {/* Edit area — hidden by default */}
                {item.include && (
                  <div id={editId} style={{ display: (!item.text && !item.rewrite.trim()) ? "block" : "none", padding:"0 14px 10px 38px" }}>
                    <textarea
                      value={item.rewrite}
                      onChange={e => setRewrite(dept.key, sec.key, idx, e.target.value)}
                      onBlur={e => {
                        const val = e.target.value.trim();
                        if (val) saveRefinement(dept.key, sec.key, idx, val);
                      }}
                      placeholder={sec.key==="quotes"
                        ? "Leave blank to use as-is. Edit only if correcting a translation."
                        : (!item.text
                          ? `Write a new ${sec.label.replace(/s$/,"").toLowerCase()} — it appears exactly as written in the report.`
                          : "Type here to override wording exactly as it will appear in the report.")}
                      style={{ width:"100%", background:"#FBEFE4", border:"0.5px solid #F0DFCE",
                        borderRadius:6, padding:"7px 10px", color:"#2C2621", fontSize:12,
                        resize:"vertical", minHeight:52, fontFamily:"inherit",
                        lineHeight:1.5, boxSizing:"border-box" }}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {!secItems.length && (
            <div style={{ padding:"8px 14px", color:"#7A6F63", fontSize:13, fontStyle:"italic" }}>None generated — add one below.</div>
          )}
          {/* Directors can write in an item when none were generated (or add more). Quotes come from staff, so they aren't hand-added. */}
          {canEdit && sec.key !== "quotes" && (
            <div style={{ padding:"8px 14px 12px" }}>
              <button onClick={() => addItem(dept.key, sec.key)}
                style={{ fontSize:12, fontWeight:600, color:"#B96524", background:"#FBEFE4",
                  border:"1px dashed #E0A56F", borderRadius:7, padding: isMobile ? "9px 14px" : "7px 12px",
                  cursor:"pointer" }}>
                + Add {sec.label.replace(/s$/,"").toLowerCase()}
              </button>
            </div>
          )}
        </Disclosure>
          );
        })}
      </div>
    </div>
  );
}

// ─── REPORT VIEW ──────────────────────────────────────────────────────────────
function ReportView({ country, year, surveyData, getApproved, setView, sbOverrides, sbMaster, runRespondents }) {
  const isMobile = useIsMobile();
  const [activeDept, setActiveDept] = useState(null);
  // Same ordering as the review sidebar: Concern → Watch → Healthy, worst score first.
  const STATUS_ORDER = { Concern: 0, Watch: 1, Healthy: 2 };
  const depts = surveyData ? Object.values(surveyData.depts)
    .filter(d=>d.n>0)
    .sort((a,b) => {
      const sa = STATUS_ORDER[a.status] ?? 3, sb = STATUS_ORDER[b.status] ?? 3;
      if (sa !== sb) return sa - sb;
      return (parseFloat(a.avg)||0) - (parseFloat(b.avg)||0);
    }) : [];

  // For the SUMMARY only, combine culture-split departments (JVK1+JVK2 -> JVK,
  // LC1+LC2 -> Language & Culture) so the health overview matches the director's
  // report (9 departments). The detail pages below still use the split `depts`.
  const COMBINE = {
    JVK1: { group: "JVK", label: "JVK — Josiah Venture Kids" },
    JVK2: { group: "JVK", label: "JVK — Josiah Venture Kids" },
    LC1:  { group: "LC",  label: "Language & Culture" },
    LC2:  { group: "LC",  label: "Language & Culture" },
  };
  const summaryDepts = (() => {
    const singles = [];
    const groups = {}; // group -> combined dept
    for (const d of depts) {
      const c = COMBINE[d.key];
      if (!c) { singles.push(d); continue; }
      if (!groups[c.group]) groups[c.group] = { key: c.group, label: c.label, _questions: [], _n: 0 };
      groups[c.group]._questions.push(...(d.questions || []));
      groups[c.group]._n += d.n || 0;
    }
    const combined = Object.values(groups).map(g => {
      const scored = g._questions.filter(q => q.score);
      const avg = scored.length ? scored.reduce((a,q)=>a+q.score,0)/scored.length : 0;
      return { key: g.key, label: g.label, n: g._n, avg: +avg.toFixed(2),
               status: deptStatus(g._questions), questions: g._questions };
    });
    return [...singles, ...combined].sort((a,b) => {
      const sa = STATUS_ORDER[a.status] ?? 3, sb = STATUS_ORDER[b.status] ?? 3;
      if (sa !== sb) return sa - sb;
      return (parseFloat(a.avg)||0) - (parseFloat(b.avg)||0);
    });
  })();

  const concerns = summaryDepts.filter(d=>d.status==="Concern");
  const watches  = summaryDepts.filter(d=>d.status==="Watch");
  const healthys = summaryDepts.filter(d=>d.status==="Healthy");
  const overallAvg = summaryDepts.length ? (summaryDepts.reduce((a,d)=>a+d.avg,0)/summaryDepts.length).toFixed(2) : "—";
  // Unique respondents for the run: prefer the raw rows when present (a fresh
  // upload), else the stored run-level count. Never sum per-department n's — a
  // staff member on two teams answers twice and would be double-counted; the
  // Math.max fallback is only a last resort when no run-level count exists.
  const totalN = (surveyData?.raw?.length || null) ?? runRespondents
    ?? (depts.length ? depts.reduce((a,d)=>Math.max(a, Number(d.n)||0), 0) : null);

  // Tab ordering: keep culture-split pairs together, slotted by their COMBINED score,
  // with the worse half first inside each pair; standalone depts sort by their own score.
  const PAIR_OF = { JVK1:"JVK", JVK2:"JVK", LC1:"LC", LC2:"LC" };
  const orderedDepts = (() => {
    // combined score per group (from summaryDepts, which already computed it)
    const combinedScore = {};
    summaryDepts.forEach(s => { if (s.key==="JVK"||s.key==="LC") combinedScore[s.key]=parseFloat(s.avg)||0; });
    // group members
    const members = { JVK:[], LC:[] };
    const standalone = [];
    depts.forEach(d => { const g=PAIR_OF[d.key]; if (g) members[g].push(d); else standalone.push(d); });
    // build sortable units: each unit is {sortStatus, sortScore, items:[...]}
    const units = [];
    standalone.forEach(d => units.push({ st: STATUS_ORDER[d.status]??3, sc: parseFloat(d.avg)||0, items:[d] }));
    ["JVK","LC"].forEach(g => {
      if (!members[g].length) return;
      // worse half first (lowest own score first)
      const pair = members[g].slice().sort((a,b)=>(parseFloat(a.avg)||0)-(parseFloat(b.avg)||0));
      const cs = combinedScore[g] ?? 0;
      const st = cs>=3.50?"Healthy":cs>=2.50?"Watch":"Concern";
      units.push({ st: STATUS_ORDER[st]??3, sc: cs, items: pair });
    });
    // sort units by status band then combined/own score, then flatten
    units.sort((a,b)=> a.st!==b.st ? a.st-b.st : a.sc-b.sc);
    return units.flatMap(u => u.items);
  })();

  const activeDeptData = activeDept ? depts.find(d=>d.key===activeDept) : null;

  // Resolve a summary row key (which may be a combined "JVK"/"LC") to a real detail
  // department key — for pairs, open the worse half (lowest score). Then scroll to it.
  const openDept = (summaryKey) => {
    let target = summaryKey;
    if (summaryKey === "JVK" || summaryKey === "LC") {
      const halves = depts.filter(d => (summaryKey==="JVK" ? (d.key==="JVK1"||d.key==="JVK2")
                                                           : (d.key==="LC1"||d.key==="LC2")));
      const worse = halves.slice().sort((a,b)=>(parseFloat(a.avg)||0)-(parseFloat(b.avg)||0))[0];
      target = worse ? worse.key : summaryKey;
    }
    setActiveDept(target);
    // scroll to the detail section after it renders
    setTimeout(() => {
      const el = document.getElementById("dept-detail-section");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  };

  return (
    <div style={{ minHeight:"100vh", background:"#F6F1E8", fontFamily:"'Inter',system-ui,sans-serif" }}>
      {/* Toolbar */}
      <div className="no-print" style={{ background:"white", borderBottom:"1px solid #ECE2D2", padding: isMobile ? "10px 14px" : "12px 24px", display:"flex", gap:12, alignItems:"center", flexWrap: isMobile ? "wrap" : "nowrap", position:"sticky", top:0, zIndex:10 }}>
        <button onClick={()=>setView("__back__")} style={{ ...navBtn, background:"transparent", border:"1px solid #ECE2D2" }}>← Back</button>
        <div style={{ flex:1, order: isMobile ? 3 : 0, color:"#E0863C", fontWeight:700, fontSize: isMobile ? 11 : 13, letterSpacing:1, whiteSpace: isMobile ? "normal" : "nowrap" }}>
          JOSIAH VENTURE · {country.toUpperCase()} {year}
        </div>
        <button onClick={()=>window.print()} style={{ ...navBtn, background:"#E0863C", color:"white" }}>Download PDF</button>
      </div>

      <div style={{ maxWidth:960, margin:"0 auto", padding: isMobile ? "24px 16px" : "40px 24px" }}>

        {/* ── SUMMARY PAGE ── */}
        <div style={{ background:"white", borderRadius:16, padding: isMobile ? 18 : 40, marginBottom:32, border:"1px solid #ECE2D2", boxShadow:"0 2px 8px rgba(124,111,224,0.08)" }}>

          {/* Header */}
          <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:32, paddingBottom:24, borderBottom:"2px solid #FBEFE4" }}>
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:"#E0863C", letterSpacing:3, textTransform:"uppercase", marginBottom:8 }}>Josiah Venture</div>
              <div style={{ fontFamily:FONT_DISPLAY, fontSize:34, fontWeight:600, color:"#2C2621", marginBottom:4, letterSpacing:-.4 }}>{country} Staff Pulse Report</div>
              <div style={{ fontSize:15, color:"#7A6F63" }}>{year}{totalN ? ` · ${totalN} respondents` : ""} across {depts.length} departments</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:42, fontWeight:800, color:sc(overallAvg>=3.5?"Healthy":overallAvg>=2.5?"Watch":"Concern") }}>{overallAvg}</div>
              <div style={{ fontSize:11, color:"#7A6F63", marginTop:2 }}>Overall avg</div>
            </div>
          </div>

          {/* Score bar chart — all departments */}
          <div style={{ marginBottom:32 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Department Scores</div>
            {summaryDepts.map(d => (
              <div key={d.key} onClick={()=>openDept(d.key)}
                style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 12px", marginBottom:4,
                  borderRadius:8, cursor:"pointer", flexWrap: isMobile ? "wrap" : "nowrap",
                  background: activeDept===d.key ? sb(d.status) : "transparent",
                  border: activeDept===d.key ? `1px solid ${sbd(d.status)}` : "1px solid transparent",
                  transition:"all 0.15s" }}>
                <div style={{ width: isMobile ? "100%" : 180, fontSize:13, fontWeight:600, color:"#2C2621", flexShrink:0 }}>{d.label}</div>
                <div style={{ flex:1, background:"#FDFAF4", borderRadius:6, height:10, overflow:"hidden" }}>
                  <div style={{ width:`${((d.avg-1)/4)*100}%`, background:sc(d.status), height:"100%", borderRadius:6, transition:"width 0.6s ease" }} />
                </div>
                <div style={{ fontWeight:800, color:sc(d.status), fontSize:15, width:40, textAlign:"right" }}>{d.avg}</div>
                <span style={{ fontSize:10, fontWeight:700, color:sc(d.status), background:sb(d.status), border:`1px solid ${sbd(d.status)}`, borderRadius:4, padding:"2px 7px", width:60, textAlign:"center", flexShrink:0 }}>{d.status}</span>
                <div style={{ color:"#7A6F63", fontSize:11, width:40, textAlign:"right" }}>n={d.n}</div>
              </div>
            ))}
          </div>

          {/* Status group summary */}
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap:12 }}>
            {[["Concern","#F6E5DE","#BE6650",concerns],["Watch","#F7EEDC","#C08636",watches],["Healthy","#E9F1E9","#5C9A6D",healthys]].map(([label,bg,color,group])=>(
              <div key={label} style={{ background:bg, borderRadius:10, padding:"14px 16px" }}>
                <div style={{ fontSize:11, fontWeight:700, color, textTransform:"uppercase", letterSpacing:1.5, marginBottom:8 }}>{label} · {group.length}</div>
                {group.map(d=>(
                  <div key={d.key} style={{ fontSize:12, color:"#2C2621", padding:"3px 0", borderBottom:"1px solid rgba(0,0,0,0.05)" }}>{d.label}</div>
                ))}
                {!group.length && <div style={{ fontSize:12, color, opacity:0.5 }}>None</div>}
              </div>
            ))}
          </div>
        </div>

        {/* ── DEPT TABS ── */}
        <div className="no-print" style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:24 }}>
          {orderedDepts.map(d=>(
            <button key={d.key} onClick={()=>setActiveDept(d.key===activeDept?null:d.key)}
              style={{ padding:"8px 14px", borderRadius:8, fontSize:12, fontWeight:600,
                cursor:"pointer",
                border:`1px solid ${sbd(d.status)}`,
                background: activeDept===d.key ? sc(d.status) : sb(d.status),
                color: activeDept===d.key ? "white" : sc(d.status),
                display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ width:8, height:8, borderRadius:"50%", background: activeDept===d.key ? "white" : sc(d.status), flexShrink:0 }} />
              {d.label}
            </button>
          ))}
        </div>

        {/* ── DEPT DETAIL PAGES ── */}
        <div id="dept-detail-section" />
        {activeDept ? (
          // Single dept selected — show just that one
          <DeptReportPage dept={activeDeptData} getApproved={getApproved} country={country} year={year} sbOverrides={sbOverrides} sbMaster={sbMaster} />
        ) : (
          // No tab selected — show all for print
          <div>
            <div className="no-print" style={{ textAlign:"center", color:"#7A6F63", fontSize:13, padding:"16px 0 32px" }}>
              Select a department above to focus, or download PDF to get the full report.
            </div>
            <div className="print-only">
              {depts.map(dept => <DeptReportPage key={dept.key} dept={dept} getApproved={getApproved} country={country} year={year} sbOverrides={sbOverrides} sbMaster={sbMaster} />)}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @media print {
          .no-print { display:none !important; }
          .print-only { display:block !important; }
          body { background:white; }
          @page { margin:15mm; size:A4; }
          /* Force every collapsible section open and drop the toggle chrome */
          .pulse-disc-body { display:block !important; }
          .pulse-disc-chev, .pulse-disc-head { pointer-events:none; }
          .pulse-disc-chev { display:none !important; }
          .pulse-disc { border-top:1px solid #ECE2D2 !important; }
        }
        .print-only { display:none; }
      `}</style>
    </div>
  );
}

function DeptReportPage({ dept, getApproved, country, year, sbOverrides, sbMaster }) {
  const isMobile = useIsMobile();
  if (!dept) return null;
  const strengths    = getApproved(dept.key, "strengths");
  const growth       = getApproved(dept.key, "growth");
  const leadershipQs = getApproved(dept.key, "leadershipQs");
  const quotes       = getApproved(dept.key, "quotes").slice(0,4);

  const statusColor = sc(dept.status);
  const statusBg    = sb(dept.status);
  const statusBd    = sbd(dept.status);

  return (
    <div style={{ marginBottom:28, pageBreakInside:"avoid" }}>

      {/* Dept header — always visible */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12,
        marginBottom:12, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontFamily:FONT_DISPLAY, fontSize:24, fontWeight:600, color:"#2C2621", marginBottom:2 }}>{dept.label}</div>
          <div style={{ fontSize:13, color:"#7A6F63" }}>n = {dept.n} respondents</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:34, fontWeight:800, color:statusColor, lineHeight:1, fontVariantNumeric:"tabular-nums" }}>{dept.avg}</div>
          <span style={{ fontSize:11, fontWeight:700, color:statusColor, background:statusBg,
            border:`1px solid ${statusBd}`, borderRadius:20, padding:"3px 10px", display:"inline-block", marginTop:6 }}>
            {dept.status}
          </span>
        </div>
      </div>

      {/* Nested panel — each part its own section, all open (and print-safe) */}
      <div style={{ background:"#FFFFFF", border:"1px solid #ECE2D2", borderRadius:12, overflow:"hidden", boxShadow: C.shadow }}>

      {strengths.length > 0 && (
        <Disclosure title="What's working" count={`${strengths.length}`} dot="#5C9A6D" defaultOpen>
          {strengths.map((s,i) => (
            <div key={i} style={{ display:"flex", gap:10, marginBottom:8, alignItems:"flex-start" }}>
              <span style={{ color:"#5C9A6D", fontWeight:700, fontSize:14, marginTop:1, flexShrink:0 }}>✓</span>
              <span style={{ fontSize:13, color:"#2C2621", lineHeight:1.6 }}>{s}</span>
            </div>
          ))}
        </Disclosure>
      )}

      {growth.length > 0 && (
        <Disclosure title="Where attention is needed" count={`${growth.length}`} dot={statusColor} defaultOpen>
          {growth.map((g,i) => (
            <div key={i} style={{ display:"flex", gap:10, marginBottom:8, alignItems:"flex-start" }}>
              <span style={{ color:statusColor, fontWeight:700, fontSize:14, marginTop:1, flexShrink:0 }}>→</span>
              <span style={{ fontSize:13, color:"#2C2621", lineHeight:1.6 }}>{g}</span>
            </div>
          ))}
        </Disclosure>
      )}

      {/* Question scores table */}
      <Disclosure title="Question scores" count={`${(dept.questions||[]).length} questions`} dot="#E0863C" defaultOpen flush>
        <div style={{ overflowX:"auto", WebkitOverflowScrolling:"touch" }}>
        <table style={{ width:"100%", minWidth: isMobile ? 460 : "auto", borderCollapse:"collapse", fontSize:12 }}>
          <thead>
            <tr style={{ background:"#FBEFE4", borderRadius:6 }}>
              <th style={{ textAlign:"left", padding:"8px 10px", color:"#7A6F63", fontWeight:600, borderRadius:"6px 0 0 6px" }}>Question</th>
              <th style={{ textAlign:"center", padding:"8px 10px", color:"#7A6F63", fontWeight:600, width:55 }}>Score</th>
              <th style={{ textAlign:"center", padding:"8px 10px", color:"#7A6F63", fontWeight:600, width:75 }}>Status</th>
              <th style={{ textAlign:"center", padding:"8px 10px", color:"#7A6F63", fontWeight:600, width:45, borderRadius:"0 6px 6px 0" }}>Scale</th>
            </tr>
          </thead>
          <tbody>
            {[...dept.questions].sort((a,b)=>{
              const o={Concern:0,Watch:1,Healthy:2};
              return (o[a.status]??1)-(o[b.status]??1) || a.score-b.score;
            }).map((q,i)=>(
              <tr key={i} style={{ borderBottom:"1px solid #FBEFE4" }}>
                <td style={{ padding:"8px 10px", color:"#2C2621", lineHeight:1.5 }}>
                  {q.en}{q.burden ? <span style={{ color:"#7A6F63", fontSize:10 }}> [Burden]</span> : ""}
                  {(() => {
                    const sbMatch = findSurveyBasics(dept.key, q.en);
                    if (!sbMatch) return null;
                    const level = q.status === 'Healthy' ? 'high' : q.status === 'Watch' ? 'mid' : 'low';
                    const sbKey = SB_KEY[dept.key] || String(dept.key||"").toLowerCase();
                    const ovKey = `${country}:${year}:${dept.key}:${normQ(q.en)}`;
                    const masterKey = `${sbKey}:${normQ(q.en)}:${level}`;
                    const text = (sbMaster && sbMaster[masterKey]) || (sbOverrides && sbOverrides[ovKey]) || sbMatch[level];
                    if (!text) return null;
                    return (
                      <div style={{ fontSize:11, color:"#7A6F63", fontStyle:"italic",
                        lineHeight:1.4, marginTop:4 }}>
                        {text}
                      </div>
                    );
                  })()}
                </td>
                <td style={{ textAlign:"center", padding:"8px 10px", fontWeight:700, color:sc(q.status) }}>{q.score?.toFixed(2)}</td>
                <td style={{ textAlign:"center", padding:"8px 10px" }}>
                  <span style={{ fontSize:10, fontWeight:700, color:sc(q.status), background:sb(q.status),
                    border:`1px solid ${sbd(q.status)}`, borderRadius:4, padding:"2px 6px" }}>{q.status}</span>
                </td>
                <td style={{ textAlign:"center", padding:"8px 10px", color:"#7A6F63", fontSize:10 }}>{q.scale.toUpperCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Disclosure>

      {/* Leadership Questions */}
      {leadershipQs.length > 0 && (
        <Disclosure title="Questions for leadership" count={`${leadershipQs.length}`} dot="#B96524" defaultOpen>
          {leadershipQs.map((q,i) => (
            <div key={i} style={{ display:"flex", gap:12, marginBottom:10, alignItems:"flex-start" }}>
              <span style={{ background:"#E0863C", color:"white", borderRadius:"50%", width:20, height:20,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:11, fontWeight:700, flexShrink:0, marginTop:1 }}>{i+1}</span>
              <span style={{ fontSize:13, color:"#2C2621", lineHeight:1.6 }}>{q}</span>
            </div>
          ))}
        </Disclosure>
      )}

      {/* Staff Quotes */}
      {quotes.length > 0 && (
        <Disclosure title="What staff said" count={`${quotes.length}`} dot="#5A4A3B" defaultOpen>
          {dept.openQLabel && (
            <div style={{ fontSize:12, color:"#7A6F63", fontStyle:"italic", marginBottom:12 }}>
              In response to: "{dept.openQLabel}"
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns: (isMobile || quotes.length <= 1) ? "1fr" : "1fr 1fr", gap:12 }}>
            {quotes.map((q,i) => {
              const isObj = typeof q === 'object' && q !== null;
              const orig = isObj ? (q.rewrite?.trim() || q.text || q.original) : q;
              const trans = isObj ? q.translation : null;
              const isOrig = (isObj ? q.isOriginalLang : false) || looksNonEnglish(orig);
              return (
                <div key={i} style={{ background:"#FDFAF4", borderLeft:"3px solid #E2D3C2",
                  borderRadius:"0 8px 8px 0", padding:"12px 16px" }}>
                  <div style={{ fontSize:13, color:"#2C2621", lineHeight:1.7,
                    fontStyle: isOrig ? "italic" : "normal" }}>
                    "{orig}"
                  </div>
                  {isOrig && trans && (
                    <div style={{ marginTop:6, fontSize:11, color:"#7A6F63",
                      fontStyle:"normal", lineHeight:1.4,
                      borderLeft:"2px solid #E2D3C2", paddingLeft:8, marginLeft:0 }}>
                      <span style={{ fontSize:9, fontWeight:700, color:"#7A6F63",
                        textTransform:"uppercase", letterSpacing:.5, marginRight:6 }}>
                        Translation
                      </span>
                      {trans}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Disclosure>
      )}
      </div>
    </div>
  );
}

// ─── DASHBOARD VIEW ───────────────────────────────────────────────────────────
function DashboardView({ allRuns, dashCountry, setDashCountry, setView, country, year, surveyData, refinements, setRefinements, openReport, lockCountry, isLeader = true, authUser, onSignOut }) {
  const isMobile = useIsMobile();
  const countries = [...new Set(allRuns.map(r=>r.country))].sort();
  const DEPTS_ORDER = ["HR","LD","LC","MPD","Counseling","Women","Singles","Marriages","JVK"];
  // A country leader is locked to their country; everyone else uses the selector.
  const effDashCountry = lockCountry || dashCountry;

  // Build trend data per country+dept
  const runsByCountry = {};
  for (const run of allRuns) {
    if (!runsByCountry[run.country]) runsByCountry[run.country] = [];
    runsByCountry[run.country].push(run);
  }

  // Current country's latest run
  const currentRuns = effDashCountry === "all"
    ? allRuns
    : (runsByCountry[effDashCountry] || []);

  const latestByCountry = {};
  for (const run of allRuns) {
    if (!latestByCountry[run.country] || run.year > latestByCountry[run.country].year)
      latestByCountry[run.country] = run;
  }

  return (
    <div style={{ minHeight:"100vh", background:"#F6F1E8", fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #ECE2D2", padding: isMobile ? "12px 16px" : "14px 24px", display:"flex", alignItems:"center", gap: isMobile ? 10 : 16, flexWrap:"wrap" }}>
        <button onClick={()=>setView("__back__")} style={{ ...navBtn, background:"transparent", border:"1px solid #ECE2D2" }}>← Back</button>
        <div style={{ flex:1, fontFamily:FONT_DISPLAY, fontSize:18, color:"#2C2621", fontWeight:600 }}>{lockCountry ? `${lockCountry} Dashboard` : "P&C Dashboard"}</div>
        {!lockCountry && (
          <select value={dashCountry} onChange={e=>setDashCountry(e.target.value)}
            style={{ background:"#F6F1E8", border:"1px solid #ECE2D2", borderRadius:6, color:"#2C2621", padding:"6px 12px", fontSize:13 }}>
            <option value="all">All Countries</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {authUser && (
          <span style={{ fontSize:12, color:"#7A6F63", whiteSpace:"nowrap" }}>
            {authUser.name} · <button onClick={onSignOut}
              style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#B96524", fontWeight:600, fontSize:12 }}>Sign out</button>
          </span>
        )}
      </div>

      <div style={{ maxWidth:1100, margin:"0 auto", padding: isMobile ? "20px 14px" : "32px 24px" }}>

        {/* JV-wide overview grid */}
        {effDashCountry === "all" && (
          <>
            <div style={{ fontSize:13, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Latest Results by Country</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:16, marginBottom:40 }}>
              {Object.values(latestByCountry).map(run => {
                const concern = run.depts?.filter(d=>d.status==="Concern").length||0;
                const watch   = run.depts?.filter(d=>d.status==="Watch").length||0;
                const healthy = run.depts?.filter(d=>d.status==="Healthy").length||0;
                const overallStatus = concern>=3?"Concern":watch>=3?"Watch":"Healthy";
                return (
                  <div key={run.id} style={{ ...card, cursor:"pointer" }} onClick={()=>setDashCountry(run.country)}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
                      <div>
                        <div style={{ fontFamily:FONT_DISPLAY, color:"#2C2621", fontWeight:600, fontSize:18 }}>{run.country}</div>
                        <div style={{ color:"#7A6F63", fontSize:12 }}>{run.year}</div>
                      </div>
                      <span style={{ fontSize:11, fontWeight:700, color:sc(overallStatus), background:sb(overallStatus), border:`1px solid ${sbd(overallStatus)}`, borderRadius:6, padding:"3px 10px" }}>{overallStatus}</span>
                    </div>
                    <div style={{ display:"flex", gap:8 }}>
                      {[["Concern",concern,"#BE6650"],["Watch",watch,"#C08636"],["Healthy",healthy,"#5C9A6D"]].map(([l,n,c])=>(
                        <div key={l} style={{ flex:1, textAlign:"center", background:"#FDFAF4", borderRadius:8, padding:"10px 4px" }}>
                          <div style={{ fontFamily:FONT_DISPLAY, fontSize:24, fontWeight:600, color:c, fontVariantNumeric:"tabular-nums" }}>{n}</div>
                          <div style={{ fontSize:10, fontWeight:600, color:"#7A6F63", textTransform:"uppercase", letterSpacing:.5 }}>{l}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Cross-country dept heatmap */}
            <div style={{ fontSize:13, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Department Health — All Countries</div>
            <div style={{ background:"#FFFFFF", border:"1px solid #ECE2D2", boxShadow:C.shadow, borderRadius:12, overflow:"hidden", overflowX:"auto", WebkitOverflowScrolling:"touch", marginBottom:40 }}>
              <table style={{ width:"100%", minWidth: isMobile ? 520 : "auto", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid #ECE2D2" }}>
                    <th style={{ textAlign:"left", padding:"12px 16px", color:"#7A6F63" }}>Department</th>
                    {Object.keys(latestByCountry).map(c => (
                      <th key={c} style={{ textAlign:"center", padding:"12px 10px", color:"#7A6F63", fontWeight:600 }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DEPTS_ORDER.map(dk => (
                    <tr key={dk} style={{ borderBottom:"1px solid #ECE2D2" }}>
                      <td style={{ padding:"10px 16px", color:"#7A6F63", fontWeight:500 }}>{dk}</td>
                      {Object.values(latestByCountry).map(run => {
                        const d = run.depts?.find(dep=>dep.key===dk||dep.group===dk);
                        return (
                          <td key={run.country} style={{ textAlign:"center", padding:"10px" }}>
                            {d ? (
                              <span style={{ fontSize:11, fontWeight:700, color:sc(d.status), background:sb(d.status), borderRadius:4, padding:"2px 8px" }}>{d.avg}</span>
                            ) : <span style={{ color:"#ECE2D2" }}>—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Single country trend view */}
        {effDashCountry !== "all" && (
          <>
            <div style={{ fontSize:13, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>{effDashCountry} — Department Health</div>
            {(runsByCountry[effDashCountry]||[]).map(run => (
              <div key={run.id} style={{ marginBottom:32 }}>
                <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12, flexWrap:"wrap" }}>
                  <span style={{ color:"#E0863C", fontWeight:700, fontSize:13 }}>{run.year}</span>
                  {openReport && (
                    <button onClick={() => openReport(run)}
                      style={{ ...navBtn, fontSize:12, padding:"5px 12px", background:"#E0863C", color:"#fff", border:"1px solid transparent" }}>
                      View report →
                    </button>
                  )}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))", gap:12 }}>
                  {(run.depts||[]).slice().sort((a,b)=>{
                    const o={Concern:0,Watch:1,Healthy:2};
                    const sa=o[a.status]??3, sb=o[b.status]??3;
                    if (sa!==sb) return sa-sb;
                    return (parseFloat(a.avg)||0)-(parseFloat(b.avg)||0);
                  }).map(d => (
                    <div key={d.key} style={{ background:"#FFFFFF", borderRadius:10, padding:"14px 16px", border:`1px solid ${sbd(d.status)}` }}>
                      <div style={{ color:"#7A6F63", fontSize:11, marginBottom:6 }}>{d.label}</div>
                      <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                        <span style={{ fontFamily:FONT_DISPLAY, fontSize:24, fontWeight:600, color:sc(d.status) }}>{d.avg}</span>
                        <span style={{ fontSize:10, fontWeight:700, color:sc(d.status) }}>{d.status}</span>
                      </div>
                      <div style={{ color:"#7A6F63", fontSize:10, marginTop:4 }}>n={d.n}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Over-time trends — sparkline per department, anchored on 2026 */}
            <CountryTrends country={effDashCountry} runs={runsByCountry[effDashCountry] || []} deptsOrder={DEPTS_ORDER} baselineYear={2026} />
          </>
        )}
      {/* Refinements manager — leaders only (cross-country wording edits) */}
      {isLeader && (
      <div style={{ marginTop:32 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:2 }}>
            Saved Refinements ({Object.keys(refinements).length})
          </div>
          {Object.keys(refinements).length > 0 && (
            <button onClick={() => {
              if (window.confirm("Clear all saved refinements? This cannot be undone.")) {
                setRefinements({});
                try { localStorage.removeItem("pulse:refinements"); } catch {}
              }
            }} style={{ ...navBtn, background:"#BE6650", fontSize:12 }}>Clear All</button>
          )}
        </div>
        {Object.keys(refinements).length === 0 ? (
          <div style={{ color:"#7A6F63", fontSize:13, fontStyle:"italic" }}>
            No refinements saved yet. When directors edit wording in the Director Review, those edits are saved here and pre-filled in future country reports.
          </div>
        ) : (
          <div style={{ display:"grid", gap:8 }}>
            {Object.entries(refinements).map(([key, val]) => {
              const [deptKey, section, idx] = key.split(":");
              return (
                <div key={key} style={{ background:"#FFFFFF", borderRadius:8, padding:"12px 16px", display:"flex", alignItems:"flex-start", gap:12 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:"flex", gap:8, marginBottom:4 }}>
                      <span style={{ fontSize:10, fontWeight:700, color:"#E0863C", background:"#F7E7D5", borderRadius:4, padding:"2px 8px" }}>{deptKey}</span>
                      <span style={{ fontSize:10, fontWeight:700, color:"#7A6F63", background:"#F6F1E8", borderRadius:4, padding:"2px 8px" }}>{section}</span>
                      <span style={{ fontSize:10, color:"#7A6F63" }}>#{parseInt(idx)+1}</span>
                    </div>
                    <div style={{ color:"#2C2621", fontSize:13, lineHeight:1.5 }}>{val.text}</div>
                    <div style={{ color:"#7A6F63", fontSize:10, marginTop:4 }}>Saved {new Date(val.savedAt).toLocaleDateString()}</div>
                  </div>
                  <button onClick={() => {
                    const updated = { ...refinements };
                    delete updated[key];
                    setRefinements(updated);
                    try { localStorage.setItem("pulse:refinements", JSON.stringify(updated)); } catch {}
                  }} style={{ color:"#7A6F63", background:"none", border:"none", cursor:"pointer", fontSize:16, lineHeight:1 }}>×</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}
      </div>
    </div>
  );
}

