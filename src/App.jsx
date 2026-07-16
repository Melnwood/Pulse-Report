import { useState, useEffect, useCallback, useRef } from "react";
import SURVEY_BASICS from "./surveyBasics.json";
import { airtablePing, upsertRun, upsertDepartment, loadSelections, saveSelections as atSaveSelections, loadRunSelections, loadAllRuns, loadRunSurveyData, addDepartmentNote, loadDepartmentNotes, setDepartmentNoteVisibility } from "./airtable";

// Detect a phone-width screen so the report/review can switch to a stacked,
// touch-friendly layout. Updates on resize/rotate.
function useIsMobile(breakpoint = 700) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= breakpoint : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

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

// ─── COLOR / STATUS UTILS ─────────────────────────────────────────────────────
const STATUS_COLOR = { Concern:"#C0392B", Watch:"#D68910", Healthy:"#1E8449", null:"#9C8F82" };
const STATUS_BG    = { Concern:"#FDF2F2", Watch:"#FFFBEB", Healthy:"#F0FDF4", null:"#FAFAF8" };
const STATUS_BORDER= { Concern:"#FCA5A5", Watch:"#FCD34D", Healthy:"#86EFAC", null:"#E2E8F0" };
const sc = s => STATUS_COLOR[s] || STATUS_COLOR[null];
const sb = s => STATUS_BG[s]    || STATUS_BG[null];
const sbd= s => STATUS_BORDER[s]|| STATUS_BORDER[null];

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

// Generate exactly two thoughtful, status-aware leadership questions for one
// department, on demand. Uses the department's status + weakest questions.
// Returns an array of two strings, or throws a descriptive error.
async function generateLeadershipQuestions(dept) {
  const concernQs = (dept.questions || []).filter(q => q.status === 'Concern')
    .map(q => `- ${q.score?.toFixed(2)} "${q.en}"`).join("\n") || "None";
  const watchQs = (dept.questions || []).filter(q => q.status === 'Watch')
    .map(q => `- ${q.score?.toFixed(2)} "${q.en}"`).join("\n") || "None";

  const prompt = `You are helping prepare a JV (Josiah Venture) People & Culture Pulse Report for the ${dept.label} department. This goes to the department's leader.

Department overall status: ${dept.status} (average ${dept.avg} out of 5, n=${dept.n}).
Scoring: Healthy >= 3.50, Watch 2.50-3.49, Concern < 2.50. Lower means staff are struggling more.

Concern-level questions:
${concernQs}

Watch-level questions:
${watchQs}

Write exactly TWO leadership questions for this department's leader. Their purpose is to help the leader personally reflect and figure out how to GO LEARN what is really happening with their team — not to hand them a conclusion.

- Ground them in this department's actual weakest areas above.
- Calibrate to the overall status: Concern = help them honestly confront a significant gap; Watch = help them investigate something mixed before it worsens; Healthy = help them protect a strength while staying curious about blind spots.
- Each should prompt the leader to think about HOW they'll find this out — what conversations to have, what to observe, who to ask.
- Open, non-defensive, thought-provoking. No yes/no questions. No jargon.

Return ONLY a JSON array of exactly two strings, no markdown:
["first question", "second question"]`;

  const res = await fetch("/.netlify/functions/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const rawBody = await res.text();
  if (!res.ok) throw new Error(`Function returned HTTP ${res.status}: ${rawBody.slice(0,300)}`);
  let data;
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`Function response was not JSON: ${rawBody.slice(0,300)}`); }
  if (data.error) throw new Error(`API error: ${typeof data.error === "string" ? data.error : JSON.stringify(data.error).slice(0,300)}`);
  const text = data.content?.find(b => b.type === "text")?.text;
  if (!text) throw new Error(`Unexpected response shape: ${JSON.stringify(data).slice(0,300)}`);
  let arr;
  try { arr = JSON.parse(text.replace(/\`\`\`json|\`\`\`/g, "").trim()); }
  catch { throw new Error(`Question JSON parse failed. Model returned: ${text.slice(0,300)}`); }
  if (!Array.isArray(arr) || !arr.length) throw new Error("Model did not return a question array.");
  return arr.slice(0, 2).map(String);
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
  const [view, setView]           = useState("sections");   // sections | home | review | report | dashboard | country | leadership
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
          overallAvg: null, respondents: surveyData?.raw?.length ?? null });
        await upsertDepartment(runId, runName, {
          key: deptKey, label: d.label, avg: d.avg, status: d.status, n: d.n,
          openQLabel: d.openQLabel,
          surveyDataJSON: JSON.stringify({ questions: d.questions || [] }).slice(0, 95000),
          sbOverridesJSON: JSON.stringify(slice),
        });
      } catch (e) { console.warn("SB override sync failed:", e.message); }
    }, 1200);
  };

  // MASTER Survey Basics overrides — promoted interpretations that become the default
  // for ALL countries/years. Keyed sbKey:normalizedQuestion:level (e.g. "hr:...:low").
  // (localStorage for now; syncs to Airtable once the master table is wired.)
  const [sbMaster, setSbMaster] = useState(() => {
    try { const r = localStorage.getItem("pulse:sbMaster"); return r ? JSON.parse(r) : {}; }
    catch { return {}; }
  });
  // Promote a rewrite into the master for a specific question + level.
  const promoteSbToMaster = (sbKey, qText, level, text) => {
    const key = `${sbKey}:${normQ(qText)}:${level}`;
    const updated = { ...sbMaster };
    if (text && text.trim()) updated[key] = text.trim();
    else delete updated[key];
    setSbMaster(updated);
    try { localStorage.setItem("pulse:sbMaster", JSON.stringify(updated)); } catch(e) {}
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
  // or double-press. Saves are idempotent (upsert), so they can't create duplicates.
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
          respondents: surveyData?.raw?.length ?? null,
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

  // ── VIEWS ──────────────────────────────────────────────────────────────────

  if (view === "sections") return (
    <SectionsView setView={setView} isPCLead={isPCLead} isAdmin={isAdmin} toggleAdmin={toggleAdmin} />
  );

  if (view === "country") return (
    <ComingSoonSection title="Country dashboards"
      blurb="Each country's latest pulse report and key info synthesized over time as new pulses are added. Coming next."
      setView={setView} />
  );

  if (view === "leadership") return (
    <LeadershipView
      country={country} setCountry={setCountry} year={year} setYear={setYear}
      fileRef={fileRef} handleFile={handleFile}
      generating={generating} genProgress={genProgress}
      isAdmin={isAdmin} toggleAdmin={toggleAdmin} setView={setView} />
  );

  if (view === "home") return (
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
      isAdmin={isAdmin} toggleAdmin={toggleAdmin}
      runsLoading={runsLoading}
    />
  );

  if (view === "review") return (
    <ReviewView
      country={country} year={year}
      surveyData={surveyData} selections={selections}
      toggleItem={toggleItem} setRewrite={setRewrite}
      saveSelections={saveSelections} saved={saved}
      saveRefinement={saveRefinement} refinements={refinements}
      setView={setView} setSelections={setSelections}
      isAdmin={isAdmin} toggleAdmin={toggleAdmin}
      sbOverrides={sbOverrides} saveSbOverride={saveSbOverride} setSbOverrides={setSbOverrides}
      sbMaster={sbMaster} promoteSbToMaster={promoteSbToMaster}
      cloudLoading={cloudLoading} syncStatus={syncStatus}
      me={me} saveMe={saveMe} isPCLead={isPCLead}
      openToDept={openToDept} setOpenToDept={setOpenToDept}
    />
  );

  if (view === "report") return (
    <ReportView
      country={country} year={year}
      surveyData={surveyData} getApproved={getApproved}
      setView={setView}
      sbOverrides={sbOverrides} sbMaster={sbMaster}
    />
  );

  if (view === "dashboard") return (
    <DashboardView
      allRuns={allRuns} dashCountry={dashCountry}
      setDashCountry={setDashCountry} setView={setView}
      country={country} year={year} surveyData={surveyData}
      refinements={refinements} setRefinements={setRefinements}
    />
  );
}

// ─── SECTIONS LANDING ─────────────────────────────────────────────────────────
// Top level of the app, organized by audience: Country dashboards (for each
// country), People & Culture (for directors — review + department pages + notes),
// and Leadership (for Mel & Chris — sees everything, overall dashboard).
function SectionsView({ setView, isPCLead, isAdmin, toggleAdmin }) {
  const cards = [
    { key: "country", title: "Country dashboards", to: "country",
      blurb: "Each country's latest pulse report and how it's trending over time." },
    { key: "pc", title: "People & Culture", to: "home",
      blurb: "Director's review, department pages, and notes across every pulse." },
    { key: "leadership", title: "Leadership", to: "leadership",
      blurb: "Everything across the org, with an overall dashboard. Mel & Chris." },
  ];
  return (
    <div style={{ minHeight:"100vh", background:"#FBF7F2", padding:"40px 24px" }}>
      <div style={{ maxWidth:900, margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"baseline", gap:12, marginBottom:4 }}>
          <span style={{ fontSize:24, fontWeight:800, color:"#1E1B3A" }}>JV Pulse</span>
          <span style={{ fontSize:14, color:"#9C8F82" }}>People & Culture</span>
          <button onClick={toggleAdmin} title="Admin tools for Mel & Chris"
            style={{ marginLeft:"auto", fontSize:12, color: isAdmin ? "#2E7D32" : "#B4A897",
              background:"transparent", border:"none", cursor:"pointer" }}>
            {isAdmin ? "🔓 admin" : "🔒"}
          </button>
        </div>
        <div style={{ fontSize:14, color:"#7A6E62", marginBottom:28 }}>Where would you like to go?</div>

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(240px, 1fr))", gap:16 }}>
          {cards.map(c => (
            <button key={c.key} onClick={() => setView(c.to)}
              style={{ textAlign:"left", background:"#fff", border:"1px solid #EFE3D6", borderRadius:14,
                padding:"22px 20px", cursor:"pointer", transition:"border-color .15s",
                display:"flex", flexDirection:"column", gap:8, minHeight:130 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#FF9E5C"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#EFE3D6"}>
              <span style={{ fontSize:17, fontWeight:700, color:"#1E1B3A" }}>{c.title}</span>
              <span style={{ fontSize:13, color:"#7A6E62", lineHeight:1.5 }}>{c.blurb}</span>
              <span style={{ marginTop:"auto", fontSize:13, fontWeight:600, color:"#FF6600" }}>Open →</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Placeholder for sections not yet built — keeps navigation coherent.
function ComingSoonSection({ title, blurb, setView }) {
  return (
    <div style={{ minHeight:"100vh", background:"#FBF7F2", padding:"40px 24px" }}>
      <div style={{ maxWidth:720, margin:"0 auto" }}>
        <button onClick={() => setView("sections")}
          style={{ ...navBtn, background:"transparent", border:"1px solid #F5E4D5", marginBottom:24 }}>← Sections</button>
        <div style={{ background:"#fff", border:"1px solid #EFE3D6", borderRadius:14, padding:"36px 28px" }}>
          <div style={{ fontSize:20, fontWeight:700, color:"#1E1B3A", marginBottom:8 }}>{title}</div>
          <div style={{ fontSize:14, color:"#7A6E62", lineHeight:1.6 }}>{blurb}</div>
        </div>
      </div>
    </div>
  );
}

// ─── LEADERSHIP VIEW ──────────────────────────────────────────────────────────
// For Mel & Chris. Home of survey upload/processing (a leadership action), with the
// overall dashboard to be added here later.
function LeadershipView({ country, setCountry, year, setYear, fileRef, handleFile,
  generating, genProgress, isAdmin, toggleAdmin, setView }) {
  return (
    <div style={{ minHeight:"100vh", background:"#FBF7F2", padding:"40px 24px" }}>
      <div style={{ maxWidth:720, margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:24 }}>
          <button onClick={() => setView("sections")}
            style={{ ...navBtn, background:"transparent", border:"1px solid #F5E4D5" }}>← Sections</button>
          <span style={{ fontSize:20, fontWeight:700, color:"#1E1B3A" }}>Leadership</span>
          <button onClick={toggleAdmin} title="Admin tools for Mel & Chris"
            style={{ marginLeft:"auto", fontSize:12, color: isAdmin ? "#2E7D32" : "#B4A897",
              background:"transparent", border:"none", cursor:"pointer" }}>
            {isAdmin ? "🔓 admin on" : "🔒 admin off"}
          </button>
        </div>

        {!isAdmin && (
          <div style={{ background:"#FFF4EC", border:"1px solid #F5E4D5", borderRadius:12, padding:"14px 16px", marginBottom:20, fontSize:13, color:"#8A5A2B" }}>
            Turn on admin (lock icon, top right) to upload and process a new survey.
          </div>
        )}

        {isAdmin && (
        <div style={card}>
          <div style={{ fontSize:13, fontWeight:700, color:"#FF6600", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>New Survey Run</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:24 }}>
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
              <div style={{ width:40, height:40, border:"3px solid #FF6600", borderTopColor:"transparent", borderRadius:"50%", margin:"0 auto 16px", animation:"spin 1s linear infinite" }} />
              <div style={{ color:"#1E1B3A", fontWeight:600 }}>{genProgress.step || "Processing…"}</div>
              <div style={{ color:"#9C8F82", fontSize:12, marginTop:8 }}>This may take a minute while AI generates draft content</div>
            </div>
          ) : (
            <div
              onClick={() => country && year && fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); if(country&&year) e.currentTarget.style.borderColor="#FF6600"; }}
              onDragLeave={e => { e.preventDefault(); e.currentTarget.style.borderColor="#F5E4D5"; }}
              onDrop={e => {
                e.preventDefault();
                e.currentTarget.style.borderColor="#F5E4D5";
                if (!(country && year)) return;
                const file = e.dataTransfer.files?.[0];
                if (file) handleFile(file);
              }}
              style={{
                border:"2px dashed #F5E4D5", borderRadius:12, padding:48,
                textAlign:"center", cursor: country&&year ? "pointer":"not-allowed",
                opacity: country&&year ? 1 : 0.5,
                transition:"border-color 0.2s",
              }}
              onMouseEnter={e => { if(country&&year) e.currentTarget.style.borderColor="#FF6600"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor="#F5E4D5"; }}
            >
              <div style={{ fontSize:32, marginBottom:12 }}>📊</div>
              <div style={{ color:"#1E1B3A", fontWeight:600, marginBottom:4 }}>Drop QuestionPro export here, or click to browse</div>
              <div style={{ color:"#9C8F82", fontSize:13 }}>.xlsx or .csv</div>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" style={{ display:"none" }}
                onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
            </div>
          )}
        </div>
        )}

        <div style={{ marginTop:20, fontSize:13, color:"#9C8F82" }}>
          An overall leadership dashboard — every country and department at a glance — will live here.
        </div>
      </div>
    </div>
  );
}

// ─── HOME VIEW ────────────────────────────────────────────────────────────────
function HomeView({ country, setCountry, year, setYear, fileRef, handleFile,
  generating, genProgress, allRuns, setAllRuns, setView, setSurveyData, setSelections,
  setCountry2, setYear2, isAdmin, toggleAdmin, runsLoading, setSbOverrides, setOpenToDept }) {

  const countries = [...new Set(allRuns.map(r=>r.country))].sort();

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
  const featured = sortedByRecent.find(r => !isFinished(r)) || sortedByRecent[0] || null;

  return (
    <div style={{ minHeight:"100vh", background:"#F8F7F4", fontFamily:"'Inter',system-ui,sans-serif" }}>
      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#FFFFFF 0%,#F8F7F4 100%)", borderBottom:"1px solid #FFEBDA", padding:"24px 40px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:3, color:"#FF6600", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Josiah Venture</div>
          <div style={{ fontSize:22, fontWeight:700, color:"#1E1B3A" }}>Pulse Report Platform</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <button onClick={() => setView("sections")} style={{ ...navBtn, background:"transparent", border:"1px solid #F5E4D5" }}>← Sections</button>
          <button onClick={() => setView("dashboard")} style={navBtn}>
            P&C Dashboard
          </button>
          {/* Discreet admin toggle — only Mel & Chris use this. */}
          <button onClick={toggleAdmin}
            title={isAdmin ? "Admin mode ON — click to hide admin tools" : "Admin mode"}
            style={{ background:"transparent", border:"none", cursor:"pointer",
              fontSize:16, color: isAdmin ? "#FF6600" : "#EAD9C9", padding:"4px 8px", lineHeight:1 }}>
            {isAdmin ? "🔓" : "🔒"}
          </button>
        </div>
      </div>

      <div style={{ maxWidth:900, margin:"0 auto", padding:"48px 24px" }}>

        {/* Survey upload now lives in the Leadership section. */}

        {/* Featured — continue the latest unfinished review, click a department to open its page */}
        {featured && (
          <div style={{ ...card, padding:"22px 24px", marginBottom:28, border:"1px solid #FFD9BE" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
              <span style={{ fontSize:11, fontWeight:700, color:"#FF6600", textTransform:"uppercase", letterSpacing:2 }}>Continue the review</span>
              {!isFinished(featured) && (
                <span style={{ fontSize:11, fontWeight:700, color:"#854F0B", background:"#FAEEDA", borderRadius:4, padding:"2px 8px" }}>In progress</span>
              )}
            </div>
            <div style={{ fontSize:20, fontWeight:700, color:"#1E1B3A", marginBottom:2 }}>{featured.country} — {featured.year}</div>
            <div style={{ fontSize:13, color:"#9C8F82", marginBottom:16 }}>{featured.depts?.length || 0} departments</div>

            {featured.depts?.length ? (
              <>
                <div style={{ fontSize:12, color:"#7A6E62", marginBottom:8 }}>Open a department to go to its page:</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:16 }}>
                  {featured.depts.map(d => (
                    <button key={d.key} onClick={() => openRun(featured, d.key)}
                      style={{ display:"inline-flex", alignItems:"center", gap:6, fontSize:13, fontWeight:600,
                        color:"#1E1B3A", background:"#FFF7F0", border:"1px solid #F0DCC9", borderRadius:8,
                        padding:"7px 12px", cursor:"pointer" }}>
                      <span style={{ width:8, height:8, borderRadius:"50%", background:sc(d.status) }} />
                      {d.label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            <button onClick={() => openRun(featured)} style={{ ...navBtn, background:"#FF7A1A", color:"#fff" }}>
              Open review →
            </button>
          </div>
        )}

        {/* Empty state — never leave the body blank */}
        {allRuns.length === 0 && !generating && (
          <div style={{ textAlign:"center", color:"#9C8F82", padding:"48px 24px", fontSize:14 }}>
            {runsLoading
              ? "Loading reports…"
              : isAdmin
                ? "No reports yet. Upload a QuestionPro export above to create one."
                : "No reports available yet. If you expect to see reports here, check your connection or ask an admin."}
          </div>
        )}

        {/* Previous runs */}
        {allRuns.length > 0 && (
          <div style={{ marginTop:32 }}>
            <div style={{ fontSize:13, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Previous Runs</div>
            <div style={{ display:"grid", gap:12 }}>
              {allRuns.slice().reverse().map(run => (
                <div key={run.id} style={{ ...card, display:"flex", justifyContent:"space-between", alignItems:"center", padding:"16px 20px" }}>
                  <div>
                    <div style={{ color:"#1E1B3A", fontWeight:600 }}>{run.country} — {run.year}</div>
                    <div style={{ color:"#9C8F82", fontSize:12, marginTop:2 }}>{run.depts?.length} departments · {new Date(run.savedAt).toLocaleDateString()}</div>
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    {run.depts?.slice(0,5).map(d => (
                      <span key={d.key} style={{ fontSize:11, fontWeight:700, color:sc(d.status), background:sb(d.status), border:`1px solid ${sbd(d.status)}`, borderRadius:4, padding:"2px 6px" }}>
                        {d.label?.split(" ")[0]}
                      </span>
                    ))}
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button style={navBtn} onClick={() => openRun(run)}>Open</button>
                    {isAdmin && <button style={{ ...navBtn, background:"#C0392B", color:"white" }} onClick={() => {
                      const rc = run.country;
                      const ry = run.year;
                      const ri = run.id;
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
              ))}
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform:rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── REVIEW VIEW ──────────────────────────────────────────────────────────────
function ReviewView({ country, year, surveyData, selections, toggleItem, setRewrite, saveSelections, saved, saveRefinement, refinements, setView, setSelections, isAdmin, toggleAdmin, sbOverrides, saveSbOverride, setSbOverrides, sbMaster, promoteSbToMaster, cloudLoading, syncStatus, me, saveMe, isPCLead, openToDept, setOpenToDept }) {
  const [activeDept, setActiveDept] = useState(null);
  const [deptTab, setDeptTab] = useState("review");   // "review" | "notes" — which tab of the department page
  const [showHelp, setShowHelp] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [genQs, setGenQs] = useState(false);
  const [atBusy, setAtBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const importInputRef = useRef(null);
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
    <div style={{ height:"100vh", background:"#F8F7F4", fontFamily:"'Inter',system-ui,sans-serif", display:"flex", flexDirection:"column", overflow:"hidden" }}>
      {/* Top bar — stays fixed at the top; only the content pane below scrolls so the action buttons (Translate, Import, Save, Generate) stay visible while scrolling */}
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #F5E4D5", padding:"14px 24px", display:"flex", alignItems:"center", gap:16, flexShrink:0, zIndex:100, flexWrap:"wrap" }}>
        <button onClick={()=>setView("home")} style={{ ...navBtn, background:"transparent", border:"1px solid #F5E4D5" }}>← Home</button>
        <div style={{ flex:1 }}>
          <span style={{ color:"#FF6600", fontWeight:700, fontSize:13 }}>{country} {year}</span>
          <span style={{ color:"#9C8F82", marginLeft:8, fontSize:13 }}>Director Review</span>
          {cloudLoading && <span style={{ color:"#FF6600", marginLeft:10, fontSize:11, fontStyle:"italic" }}>☁ syncing…</span>}
        </div>
        <button onClick={()=>setShowHelp(true)} style={{ ...navBtn, background:"white",
          border:"1px solid #F5E4D5", color:"#FF6600", fontWeight:700 }}>
          ? How scoring works
        </button>
        <input ref={importInputRef} type="file" accept=".xlsx" style={{ display:"none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setImportMsg({ status:"working", lines:["Reading director review…"] });
            try {
              const { selections: imported, report, interpretations } = await parseDirectorReview(file, DEPARTMENTS);
              if (!Object.keys(imported).length) {
                setImportMsg({ status:"error", lines:["No matching department sheets found in that file."] });
              } else {
                // Merge into existing selections so untouched depts are preserved
                setSelections(prev => ({ ...prev, ...imported }));
                try { localStorage.setItem(`pulse:sel:${country}:${year}`, JSON.stringify({ ...(selections||{}), ...imported })); } catch {}
                // Apply the director's Section 1 interpretation rewrites as Survey Basics overrides.
                let sbCount = 0;
                if (interpretations?.length && setSbOverrides) {
                  setSbOverrides(prev => {
                    const updated = { ...prev };
                    interpretations.forEach(it => {
                      it.deptKeys.forEach(dk => {
                        const key = `${country}:${year}:${dk}:${normQ(it.question)}`;
                        updated[key] = it.text;
                        sbCount++;
                      });
                    });
                    try { localStorage.setItem("pulse:sbOverrides", JSON.stringify(updated)); } catch {}
                    return updated;
                  });
                }
                const extra = sbCount ? [`Applied ${sbCount} Survey Basics interpretation edit${sbCount===1?"":"s"} from the director.`] : [];
                setImportMsg({ status:"done", lines:["Imported director review:", ...report, ...extra] });
              }
            } catch (err) {
              setImportMsg({ status:"error", lines:["Import failed: " + err.message] });
            }
            e.target.value = ""; // allow re-import of same file
          }} />
        {isAdmin && (<>
        <button onClick={() => importInputRef.current?.click()}
          style={{ ...navBtn, background:"white", border:"1px solid #F5E4D5", color:"#1E1B3A" }}>
          ⬆ Import director review (Excel)
        </button>
        <button
          disabled={translating}
          onClick={async () => {
            setTranslating(true);
            try {
              const updated = {};
              for (const dk of Object.keys(selections)) {
                const secs = selections[dk];
                const newQuotes = await translateMissingQuotes(secs.quotes || []);
                updated[dk] = { ...secs, quotes: newQuotes };
              }
              setSelections(updated);
              try { localStorage.setItem(`pulse:sel:${country}:${year}`, JSON.stringify(updated)); } catch {}
              setImportMsg({ status:"done", lines:["Translations updated for all non-English quotes."] });
            } catch(e) {
              setImportMsg({ status:"error", lines:["Translation failed: " + e.message] });
            }
            setTranslating(false);
          }}
          style={{ ...navBtn, background:"white", border:"1px solid #F5E4D5",
            color: translating ? "#9C8F82" : "#1E1B3A", cursor: translating ? "wait" : "pointer" }}>
          {translating ? "Translating…" : "🌐 Translate quotes"}
        </button>
        <button
          disabled={genQs}
          onClick={async () => {
            setGenQs(true);
            try {
              const updated = { ...selections };
              const targets = dept ? [dept] : depts;   // active dept, or all if none active
              let count = 0;
              for (const d of targets) {
                if (!updated[d.key]) continue;
                const qs = await generateLeadershipQuestions(d);
                updated[d.key] = {
                  ...updated[d.key],
                  leadershipQs: qs.map(text => ({ text, include:true, rewrite:"", isRefined:false })),
                };
                count += qs.length;
              }
              setSelections(updated);
              try { localStorage.setItem(`pulse:sel:${country}:${year}`, JSON.stringify(updated)); } catch {}
              setImportMsg({ status:"done", lines:[`Generated ${count} leadership question${count===1?"":"s"} for ${dept ? dept.label : "all departments"}.`] });
            } catch(e) {
              setImportMsg({ status:"error", lines:["Leadership question generation failed: " + e.message] });
            }
            setGenQs(false);
          }}
          style={{ ...navBtn, background:"white", border:"1px solid #F5E4D5",
            color: genQs ? "#9C8F82" : "#1E1B3A", cursor: genQs ? "wait" : "pointer" }}>
          {genQs ? "Generating…" : "✦ Generate leadership questions"}
        </button>
        </>)}
        {/* Quiet auto-sync indicator — replaces the manual push and save buttons.
            Edits save themselves; this just reassures the user it's handled. */}
        <span style={{ display:"inline-flex", alignItems:"center", gap:6, fontSize:12,
          color: syncStatus==="error" ? "#C0392B" : "#9C8F82", padding:"0 8px", whiteSpace:"nowrap" }}>
          {syncStatus==="saving" && <>☁ Saving…</>}
          {syncStatus==="saved"  && <span style={{ color:"#1E8449" }}>✓ Saved</span>}
          {syncStatus==="error"  && <>⚠ Sync failed — will retry on next edit</>}
          {syncStatus==="idle"   && <span style={{ color:"#C9BCAF" }}>✓ All changes saved</span>}
        </span>
        {isAdmin && (
        <button onClick={()=>setView("report")} style={{ ...navBtn, background:"#FF7A1A" }}>
          Generate Report →
        </button>
        )}
        {/* Discreet admin toggle — only Mel & Chris use this. Small lock at the far right. */}
        <button
          onClick={toggleAdmin}
          title={isAdmin ? "Admin mode ON — click to hide admin tools" : "Admin mode"}
          style={{ marginLeft:"auto", background:"transparent", border:"none", cursor:"pointer",
            fontSize:14, color: isAdmin ? "#FF6600" : "#EAD9C9", padding:"4px 8px", lineHeight:1 }}>
          {isAdmin ? "🔓" : "🔒"}
        </button>
      </div>

      {showHelp && <ScoringHelpPanel onClose={()=>setShowHelp(false)} />}

      {importMsg && (
        <div style={{ margin:"12px 20px", padding:"12px 16px", borderRadius:8, flexShrink:0,
          maxHeight:"30vh", overflowY:"auto",
          background: importMsg.status==="error" ? "#FDF2F2" : importMsg.status==="done" ? "#F0FDF4" : "#FFF4EC",
          border: `1px solid ${importMsg.status==="error" ? "#FCA5A5" : importMsg.status==="done" ? "#86EFAC" : "#F5E4D5"}` }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div style={{ fontSize:12, lineHeight:1.6, color:"#1E1B3A" }}>
              {importMsg.lines.map((l,i) => (
                <div key={i} style={{ fontWeight: i===0 ? 700 : 400 }}>{l}</div>
              ))}
            </div>
            <button onClick={()=>setImportMsg(null)} style={{ background:"none", border:"none",
              cursor:"pointer", color:"#9C8F82", fontSize:16, lineHeight:1 }}>×</button>
          </div>
          {importMsg.status==="done" && (
            <div style={{ fontSize:11, color:"#166534", marginTop:8 }}>
              Review the imported edits in each department below, then generate the report when ready.
            </div>
          )}
        </div>
      )}

      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>
        {/* Sidebar */}
        <div style={{ width:220, background:"#FFFFFF", borderRight:"1px solid #F5E4D5", overflowY:"auto", flexShrink:0 }}>
          {depts.map(d => (
            <button key={d.key} onClick={()=>setActiveDept(d.key)}
              style={{
                display:"block", width:"100%", textAlign:"left",
                padding:"12px 16px", background: activeDept===d.key ? "#F8F7F4" : "transparent",
                border:"none", borderLeft: activeDept===d.key ? "3px solid #FF6600" : "3px solid transparent",
                cursor:"pointer",
              }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ width:8, height:8, borderRadius:"50%", background:sc(d.status), flexShrink:0 }} />
                <span style={{ color: activeDept===d.key ? "#1E1B3A":"#7A6E62", fontSize:13, fontWeight: activeDept===d.key?600:400 }}>{d.label}</span>
              </div>
              <div style={{ color:"#8A7A6B", fontSize:11, marginLeft:16, marginTop:2 }}>{d.avg} · {d.n} respondents</div>
            </button>
          ))}
        </div>

        {/* Main panel — a department PAGE with tabs (Review · Notes) */}
        <div style={{ flex:1, overflowY:"auto", padding:24 }}>
          {dept && (
            <div style={{ marginBottom:18, borderBottom:"1px solid #EFE3D6" }}>
              <div style={{ display:"flex", alignItems:"baseline", gap:12, marginBottom:12 }}>
                <span style={{ fontSize:20, fontWeight:700, color:"#1E1B3A" }}>{dept.label}</span>
                <span style={{ fontSize:12, color:"#9C8F82" }}>{country} {year}</span>
              </div>
              <div style={{ display:"flex", gap:4 }}>
                {["review","notes"].map(tab => (
                  <button key={tab} onClick={() => setDeptTab(tab)}
                    style={{ fontSize:13, fontWeight:600, padding:"8px 16px", border:"none", cursor:"pointer",
                      background:"transparent", color: deptTab===tab ? "#FF6600" : "#8A7A6B",
                      borderBottom: deptTab===tab ? "2px solid #FF6600" : "2px solid transparent" }}>
                    {tab === "review" ? "Review" : "Notes"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {dept && deptTab === "review" && !selections[dept.key] && (
            <div style={{ textAlign:"center", color:"#9C8F82", padding:"60px 24px" }}>
              {cloudLoading
                ? "☁ Loading this department's review from the shared workspace…"
                : "No review content is loaded for this department on this device yet. If it shows on another device, the shared sync hasn't completed here — try reloading. (You can still Generate Report.)"}
            </div>
          )}
          {dept && deptTab === "review" && selections[dept.key] && (
            <DeptReviewPanel
              dept={dept} sel={selections[dept.key]}
              toggleItem={toggleItem} setRewrite={setRewrite}
              saveRefinement={saveRefinement} refinements={refinements}
              country={country} year={year}
              sbOverrides={sbOverrides} saveSbOverride={saveSbOverride}
              sbMaster={sbMaster} promoteSbToMaster={promoteSbToMaster} isAdmin={isAdmin}
              me={me} saveMe={saveMe} isPCLead={isPCLead}
            />
          )}
          {dept && deptTab === "notes" && (
            <DeptNotesTab
              dept={dept} country={country} year={year}
              me={me} saveMe={saveMe} isPCLead={isPCLead}
            />
          )}
        </div>
      </div>
    </div>
  );
}


// ─── SCORING HELP PANEL ───────────────────────────────────────────────────────
function ScoringHelpPanel({ onClose }) {
  return (
    <div style={{
      position:"fixed", top:0, left:0, right:0, bottom:0,
      background:"rgba(0,0,0,0.4)", zIndex:1000,
      display:"flex", alignItems:"flex-start", justifyContent:"center",
      paddingTop:60, overflow:"auto",
    }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:"white", borderRadius:14, padding:32, maxWidth:680, width:"calc(100% - 48px)",
        marginBottom:40, fontFamily:"'Inter',system-ui,sans-serif",
      }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
          <div style={{ fontSize:16, fontWeight:700, color:"#1E1B3A" }}>How scoring works</div>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer",
            fontSize:20, color:"#9C8F82", lineHeight:1, padding:"0 4px" }}>✕</button>
        </div>

        {/* MEAN vs DIST */}
        <div style={{ fontSize:11, fontWeight:700, color:"#9C8F82", textTransform:"uppercase",
          letterSpacing:1.5, marginBottom:12 }}>Two ways to measure a question</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:20 }}>
          {[
            { label:"Mean", title:"The average score", color:"#166534", bg:"#F0FDF4", bd:"#86EFAC",
              desc:"Add up all responses and divide by how many people answered. Simple and reliable when most people are somewhere in the middle.",
              when:"Used for questions about personal experience or attitude — growth, connection, confidence — where one or two outliers won't distort the picture." },
            { label:"Dist", title:"The response distribution", color:"#1E3A8A", bg:"#EFF6FF", bd:"#93C5FD",
              desc:"Instead of averaging, it asks: are enough people on the positive side? An average can hide a divided team. DIST catches that.",
              when:"Used for questions about access, clarity, or concrete experience — things that should be true for everyone. If even a third of your team can't say yes, that matters." },
          ].map(f => (
            <div key={f.label} style={{ background:f.bg, border:`1px solid ${f.bd}`, borderRadius:10, padding:14 }}>
              <div style={{ fontSize:10, fontWeight:700, color:f.color, textTransform:"uppercase",
                letterSpacing:1.5, marginBottom:4 }}>{f.label} scale</div>
              <div style={{ fontSize:13, fontWeight:700, color:"#1E1B3A", marginBottom:8 }}>{f.title}</div>
              <div style={{ fontSize:12, color:"#374151", lineHeight:1.6, marginBottom:8 }}>{f.desc}</div>
              <div style={{ fontSize:11, color:"#6B7280", lineHeight:1.5, background:"white",
                borderRadius:6, padding:"8px 10px" }}>
                <strong style={{ color:"#374151" }}>Used when:</strong> {f.when}
              </div>
            </div>
          ))}
        </div>

        {/* Real example */}
        <div style={{ background:"#F9FAFB", borderRadius:10, padding:14, marginBottom:20,
          border:"1px solid #E5E7EB" }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#9C8F82", textTransform:"uppercase",
            letterSpacing:1.5, marginBottom:10 }}>Why it matters — the same responses, two different answers</div>
          <div style={{ fontSize:12, color:"#1E1B3A", fontWeight:600, marginBottom:10 }}>
            9 single staff respond to: "My practical needs are adequately supported."
          </div>
          <div style={{ display:"flex", gap:6, marginBottom:12, alignItems:"flex-end", height:44 }}>
            {[[0,"#E5E7EB"],[1,"#E24B4A"],[5,"#F2C4CE"],[3,"#639922"],[0,"#E5E7EB"]].map(([c,col],i)=>(
              <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                <div style={{ width:"100%", height:`${Math.max(c/5*36,c>0?6:2)}px`,
                  background:col, borderRadius:"3px 3px 0 0", display:"flex",
                  alignItems:"center", justifyContent:"center" }}>
                  {c>0 && <span style={{ fontSize:10, fontWeight:700, color:"white" }}>{c}</span>}
                </div>
                <span style={{ fontSize:9, color:"#9CA3AF" }}>{["SD","D","U","A","SA"][i]}</span>
              </div>
            ))}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            <div style={{ background:"#FFFBEB", borderRadius:8, padding:10, textAlign:"center" }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#92400E", textTransform:"uppercase", letterSpacing:1 }}>Mean scale says</div>
              <div style={{ fontSize:18, fontWeight:800, color:"#B45309", margin:"4px 0" }}>3.22</div>
              <div style={{ fontSize:11, color:"#B45309" }}>→ Watch</div>
            </div>
            <div style={{ background:"#FEF2F2", borderRadius:8, padding:10, textAlign:"center" }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#991B1B", textTransform:"uppercase", letterSpacing:1 }}>Dist scale says</div>
              <div style={{ fontSize:18, fontWeight:800, color:"#B91C1C", margin:"4px 0" }}>33% positive</div>
              <div style={{ fontSize:11, color:"#B91C1C" }}>→ Concern</div>
            </div>
          </div>
          <div style={{ marginTop:8, fontSize:11, color:"#6B7280", lineHeight:1.6 }}>
            The average of 3.22 looks like a mild Watch. But only 3 out of 9 people agreed their
            needs are met. DIST flags this as Concern because for a question about whether staff
            feel supported, "most people aren't sure" is not a Watch result.
          </div>
        </div>

        {/* Three factors */}
        <div style={{ fontSize:11, fontWeight:700, color:"#9C8F82", textTransform:"uppercase",
          letterSpacing:1.5, marginBottom:12 }}>Three things that determine a department's status</div>
        {[
          { num:"1", color:"#166534", bg:"#F0FDF4", bd:"#86EFAC",
            title:"Individual question scoring",
            desc:"Each question gets its own status (Concern, Watch, or Healthy) using either MEAN or DIST. This is what the heatmap helps you verify — does the distribution match what you see on your team?" },
          { num:"2", color:"#B45309", bg:"#FFFBEB", bd:"#FCD34D",
            title:"Burden questions are flipped",
            desc:'Some questions are worded negatively — "I feel alone," "I feel overwhelmed." For these, agreeing is a bad sign. Responses are inverted before scoring so the math always reads correctly. The heatmap colours flip to match: red on the right (Strongly Agree = bad), green on the left.' },
          { num:"3", color:"#B91C1C", bg:"#FEF2F2", bd:"#FCA5A5",
            title:"Concern-count override — the most important rule",
            desc:"If 3 or more individual questions score Concern, the whole department is automatically flagged as Concern — regardless of its average. An average can hide real problems. Poland HR averaged 3.24 (normally Watch) but had 4 Concern questions, so it correctly shows Concern. This is the rule that protects against averages hiding what's actually happening." },
        ].map(f => (
          <div key={f.num} style={{ display:"flex", gap:12, marginBottom:12,
            background:f.bg, border:`1px solid ${f.bd}`, borderRadius:10, padding:14 }}>
            <div style={{ width:28, height:28, borderRadius:"50%", background:"white",
              border:`1.5px solid ${f.bd}`, display:"flex", alignItems:"center",
              justifyContent:"center", fontSize:13, fontWeight:700, color:f.color, flexShrink:0 }}>{f.num}</div>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:"#1E1B3A", marginBottom:5 }}>{f.title}</div>
              <div style={{ fontSize:12, color:"#374151", lineHeight:1.6 }}>{f.desc}</div>
            </div>
          </div>
        ))}

        {/* Status thresholds */}
        <div style={{ background:"#F9FAFB", border:"1px solid #E5E7EB", borderRadius:10,
          padding:14, marginTop:4 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#9C8F82", textTransform:"uppercase",
            letterSpacing:1.5, marginBottom:10 }}>Status thresholds</div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr style={{ borderBottom:"1px solid #E5E7EB" }}>
                {["Status","Mean","Dist"].map(h=>(
                  <th key={h} style={{ textAlign:"left", padding:"4px 8px", fontSize:10,
                    fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ["Healthy","#166534","3.50 or above","75%+ agreed, fewer than 15% disagreed"],
                ["Watch","#B45309","2.50 – 3.49","50%+ agreed, fewer than 30% disagreed"],
                ["Concern","#B91C1C","Below 2.50","Fewer than 50% agreed, or too many disagreed"],
              ].map(([s,c,m,d])=>(
                <tr key={s} style={{ borderBottom:"1px solid #F3F4F6" }}>
                  <td style={{ padding:"7px 8px", fontWeight:700, color:c, fontSize:12 }}>{s}</td>
                  <td style={{ padding:"7px 8px", color:"#374151", fontSize:12 }}>{m}</td>
                  <td style={{ padding:"7px 8px", color:"#374151", fontSize:12 }}>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button onClick={onClose} style={{ marginTop:20, width:"100%", padding:"10px 0",
          background:"#FF6600", color:"white", border:"none", borderRadius:8,
          fontSize:13, fontWeight:700, cursor:"pointer" }}>
          Got it — back to the review
        </button>
      </div>
    </div>
  );
}

// Department meeting-notes panel: a timestamped running log with a Private/Public
// toggle. Private notes are visible only to their author and to P&C leadership
// (Mel & Chris). Saves to Airtable so notes persist across devices and meetings.
// The "Notes" tab of a department page. Hosts notes at every level for this
// department + survey. Department-level log first (verified), with section- and
// question-level notes added as the next build increment.
function DeptNotesTab({ dept, country, year, me, saveMe, isPCLead }) {
  return (
    <div>
      <NotesPanel country={country} year={year} deptKey={dept.key} deptLabel={dept.label}
        me={me} saveMe={saveMe} isPCLead={isPCLead} />
    </div>
  );
}

function NotesPanel({ country, year, deptKey, deptLabel, me, saveMe, isPCLead }) {
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

  return (
    <div style={{ marginTop: 22, border: "1px solid #EFE3D6", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ background: "#FFF4EC", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#8A5A2B" }}>Meeting notes — {deptLabel || deptKey}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#9C8F82" }}>
          {me ? <>Signed in as <b style={{ color: "#5A4A3B" }}>{me}</b></> : "Not signed in"}
        </span>
      </div>

      <div style={{ padding: 14 }}>
        {!me && (
          <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#7A6E62" }}>Your name (so notes are yours):</span>
            <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="e.g. Mel"
              style={{ fontSize: 13, padding: "5px 9px", border: "1px solid #E2D3C2", borderRadius: 6 }} />
            <button onClick={() => saveMe(nameInput)} style={{ ...navBtn, background: "#FF6600", color: "#fff" }}>Set name</button>
          </div>
        )}

        {/* Composer */}
        <textarea value={draft} onChange={e => setDraft(e.target.value)}
          placeholder="Write a note for this department — thoughts on the scores, what to raise in the next meeting…"
          rows={3}
          style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: 10,
            border: "1px solid #E2D3C2", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#7A6E62" }}>Who can see this:</span>
          <div style={{ display: "inline-flex", border: "1px solid #E2D3C2", borderRadius: 8, overflow: "hidden" }}>
            <button type="button" onClick={() => setVisibility("Private")}
              style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", border: "none", cursor: "pointer",
                background: visibility === "Private" ? "#5A4A3B" : "transparent",
                color: visibility === "Private" ? "#fff" : "#8A7A6B" }}>
              Private
            </button>
            <button type="button" onClick={() => setVisibility("Public")}
              style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", border: "none", cursor: "pointer",
                borderLeft: "1px solid #E2D3C2",
                background: visibility === "Public" ? "#2E7D32" : "transparent",
                color: visibility === "Public" ? "#fff" : "#8A7A6B" }}>
              Public
            </button>
          </div>
          <span style={{ fontSize: 11, color: "#9C8F82" }}>
            {visibility === "Public"
              ? "country leader & team can see this"
              : "only you & P&C leadership (Mel & Chris)"}
          </span>
          <button onClick={save} disabled={saving || !draft.trim()}
            style={{ ...navBtn, marginLeft: "auto", background: (saving || !draft.trim()) ? "#E7DDD2" : "#FF6600",
              color: (saving || !draft.trim()) ? "#9C8F82" : "#fff" }}>
            {saving ? "Saving…" : "Add note"}
          </button>
        </div>
        {err && <div style={{ color: "#C0392B", fontSize: 12, marginTop: 8 }}>{err}</div>}

        {/* Log */}
        <div style={{ marginTop: 16 }}>
          {notes === null && <div style={{ fontSize: 12, color: "#9C8F82" }}>Loading notes…</div>}
          {notes !== null && visible.length === 0 &&
            <div style={{ fontSize: 12, color: "#9C8F82" }}>No notes yet for this department.</div>}
          {visible.map(n => (
            <div key={n.id} style={{ borderTop: "1px solid #F2E7DB", padding: "10px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#5A4A3B" }}>{n.author || "Unknown"}</span>
                <span style={{ fontSize: 11, color: "#A99C8E" }}>{fmt(n.created)}</span>
                <button onClick={() => flip(n)} title="Toggle who can see this note"
                  style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, cursor: "pointer",
                    color: n.visibility === "Public" ? "#2E7D32" : "#8A7A6B",
                    background: n.visibility === "Public" ? "#E8F5E9" : "#F3ECE3",
                    border: "1px solid " + (n.visibility === "Public" ? "#A5D6A7" : "#E2D3C2"),
                    borderRadius: 4, padding: "2px 8px" }}>
                  {n.visibility === "Public" ? "Public" : "Private"}
                </button>
              </div>
              <div style={{ fontSize: 13, color: "#332E29", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{n.body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DeptReviewPanel({ dept, sel, toggleItem, setRewrite, saveRefinement, refinements, country, year, sbOverrides, saveSbOverride, sbMaster, promoteSbToMaster, isAdmin, me, saveMe, isPCLead }) {
  const isMobile = useIsMobile();
  // Which question's heatmap popup is open on mobile (index), or null. One at a time.
  const [openHeatmap, setOpenHeatmap] = useState(null);
  const sections = [
    { key:"strengths",    label:"✓ Strengths",            color:"#1E8449", instruction:"Check to include. Uncheck to exclude. Click Edit to revise wording — it will appear exactly as written in the report." },
    { key:"growth",       label:"→ Growth areas",         color:"#D68910", instruction:"Check to include. Click Edit to revise wording." },
    { key:"leadershipQs", label:"? Leadership questions", color:"#3B3882", instruction:"Check to include. Select 1–2 maximum. Click Edit to revise." },
    { key:"quotes",       label:"Staff quotes",           color:"#4B5563", instruction:"Check to include. Up to 4 quotes appear verbatim. Edit only to correct a translation." },
  ];

  return (
    <div>
      {/* Dept header */}
      <div style={{ marginBottom:24 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8 }}>
          <div style={{ fontSize:20, fontWeight:700, color:"#1E1B3A" }}>{dept.label}</div>
          <span style={{ fontSize:12, fontWeight:700, color:sc(dept.status), background:sb(dept.status), border:`1px solid ${sbd(dept.status)}`, borderRadius:6, padding:"3px 10px" }}>{dept.status}</span>
          <span style={{ color:"#9C8F82", fontSize:13 }}>{dept.avg} avg · n={dept.n}</span>
        </div>



        {/* Heatmap — Question Scores */}
        <div style={{ background:"#FFFFFF", border:"1px solid #F5E4D5", borderRadius:10, overflow:"hidden", marginBottom:0 }}>
          {/* Column headers */}
          <div style={{ display:"grid",
            gridTemplateColumns: isMobile ? "48px 1fr" : "90px 52px 60px 1fr 52px 290px", gap:0,
            background:"#FFF4EC", borderBottom:"2px solid #F5E4D5", padding:"7px 12px",
            fontSize:10, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:1.5 }}>
            {isMobile ? <><span>Score</span><span>Question</span></> : <>
            <span>Section</span>
            <span>Score</span>
            <span>Status</span>
            <span>Full Question Text</span>
            <span style={{textAlign:"center"}}>Scale</span>
            <span style={{textAlign:"center"}}>Heatmap — SD · D · U · A · SA</span></>}
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
              ? ["#1E8449","#5DBB8A","#F2C4CE","#E87F7F","#C0392B"] // SD=green, SA=red (burden inverted)
              : ["#C0392B","#E87F7F","#F2C4CE","#5DBB8A","#1E8449"]; // SD=red, SA=green
            const CELL_TEXT   = q.burden
              ? ["white","white","#7B2D3E","white","white"]
              : ["white","white","white","white","white"];
            const LABELS = ["SD","D","U","A","SA"];
            // Status row background
            const statusRowBg = {Concern:"#FDF2F2", Watch:"#FFFBEB", Healthy:"#F0FDF4"}[q.status] || "#F8F8F8";

            return (
              <div key={i} style={{ borderBottom:"1px solid #FFF1E6" }}>
                {/* Main row */}
                <div style={{ display:"grid",
                  gridTemplateColumns: isMobile ? "48px 1fr" : "90px 52px 60px 1fr 52px 290px",
                  gap:0, alignItems:"stretch", background: i%2===0?"#FFFFFF":"#FAFAF8",
                  position: isMobile ? "relative" : "static" }}>
                  {/* Section type (Q or Burden) — hidden on mobile */}
                  {!isMobile && (
                  <div style={{ padding:"10px 8px", display:"flex", alignItems:"center",
                    background: q.burden ? "#FFF8E1" : "#FFF4EC",
                    borderRight:"1px solid #F5E4D5" }}>
                    <span style={{ fontSize:10, fontWeight:700,
                      color: q.burden ? "#B45309" : "#8A7A6B" }}>
                      {q.burden ? "Burden [inv.]" : "Q"}
                    </span>
                  </div>)}
                  {/* Score */}
                  <div style={{ padding:"10px 8px", display:"flex", alignItems:"center",
                    background:statusRowBg, borderRight: isMobile ? "none" : "1px solid #F5E4D5" }}>
                    <span style={{ fontSize:13, fontWeight:800, color:sc(q.status) }}>{q.score?.toFixed(2)}</span>
                  </div>
                  {/* Status — hidden on mobile (shown inside question block instead) */}
                  {!isMobile && (
                  <div style={{ padding:"10px 6px", display:"flex", alignItems:"center", justifyContent:"center",
                    background:statusRowBg, borderRight:"1px solid #F5E4D5" }}>
                    <span style={{ fontSize:9, fontWeight:700, color:sc(q.status),
                      background:sb(q.status), border:`1px solid ${sbd(q.status)}`,
                      borderRadius:4, padding:"2px 5px", textAlign:"center" }}>{q.status}</span>
                  </div>)}
                  {/* Question text + Survey Basics inline */}
                  <div style={{ padding:"10px 12px", verticalAlign:"top",
                    borderRight: isMobile ? "none" : "1px solid #F5E4D5", position:"relative" }}>
                    {isMobile && (
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                        <span style={{ fontSize:9, fontWeight:700, color:sc(q.status),
                          background:sb(q.status), border:`1px solid ${sbd(q.status)}`,
                          borderRadius:4, padding:"2px 6px" }}>{q.status}</span>
                        {q.burden && <span style={{ fontSize:9, color:"#B45309" }}>Burden [inv.]</span>}
                        <button onClick={() => setOpenHeatmap(openHeatmap===i ? null : i)}
                          style={{ marginLeft:"auto", fontSize:11, fontWeight:600, color:"#FF6600",
                            background:"#FFEBDA", border:"0.5px solid #FFA766", borderRadius:5,
                            padding:"3px 10px", cursor:"pointer" }}>
                          {openHeatmap===i ? "Close" : "Heatmap"}
                        </button>
                      </div>
                    )}
                    <div style={{ fontSize:12, color:"#1E1B3A", lineHeight:1.5, marginBottom:6 }}>
                      {q.en}{q.burden && !isMobile ? <span style={{ color:"#B45309", fontSize:10, marginLeft:4 }}>[Burden]</span> : ""}
                    </div>
                    {/* Mobile heatmap popup — overlays the question, one at a time */}
                    {isMobile && openHeatmap===i && (
                      <div style={{ position:"absolute", top:4, left:8, right:8, zIndex:20,
                        background:"#FFFFFF", border:"1px solid #E8D9CA", borderRadius:10,
                        boxShadow:"0 8px 24px rgba(0,0,0,0.18)", padding:12 }}>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                          <span style={{ fontSize:11, fontWeight:700, color:"#1E1B3A" }}>Response breakdown</span>
                          <button onClick={() => setOpenHeatmap(null)} aria-label="Close"
                            style={{ fontSize:12, color:"#9C8F82", background:"none", border:"none",
                              cursor:"pointer", padding:"2px 6px" }}>✕</button>
                        </div>
                        <div style={{ display:"flex", gap:4 }}>
                          {counts.map((c, ci) => (
                            <div key={ci} style={{ flex:1, textAlign:"center" }}>
                              <div style={{ background: c>0?CELL_COLORS[ci]:"#FFF4EC", color: c>0?CELL_TEXT[ci]:"#C8C4E8",
                                borderRadius:5, padding:"8px 0", fontSize:13, fontWeight:700,
                                border: c>0?"none":"1px solid #F5E4D5" }}>{c}</div>
                              <div style={{ fontSize:8, fontWeight:600, color:"#9C8F82", marginTop:4, lineHeight:1.2 }}>
                                {LABELS[ci]}
                              </div>
                              <div style={{ fontSize:8, color:"#C9BCAF", marginTop:2 }}>
                                {c>0 ? Math.round(c/n*100)+"%" : ""}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize:10, color:"#7A6E62", marginTop:10 }}>{n} respondents · mean {q.score?.toFixed(2)}</div>
                      </div>
                    )}
                    {(() => {
                      const sbMatch = findSurveyBasics(dept.key, q.en);
                      if (!sbMatch) return null;
                      // Level for this question based on its status
                      const level = q.status === 'Healthy' ? 'high' : q.status === 'Watch' ? 'mid' : 'low';
                      const origText = sbMatch[level];
                      // Precedence: this-report override > promoted master default > original.
                      const sbKey = SB_KEY[dept.key] || String(dept.key||"").toLowerCase();
                      const masterKey = `${sbKey}:${normQ(q.en)}:${level}`;
                      const masterText = sbMaster?.[masterKey];
                      const sbDefault = masterText || origText;
                      const ovKey = `${country}:${year}:${dept.key}:${normQ(q.en)}`;
                      const override = sbOverrides?.[ovKey];
                      const sbText = override || sbDefault;
                      const editId = `sbedit-${dept.key}-${i}`;
                      return (
                        <div>
                          <div style={{ display:"flex", alignItems:"flex-start", gap:6,
                            background:"#F8F7F4", borderRadius:5, padding:"5px 8px" }}>
                            <span style={{ fontSize:9, fontWeight:700, color:"#9C8F82",
                              textTransform:"uppercase", letterSpacing:.5,
                              whiteSpace:"nowrap", paddingTop:1, flexShrink:0 }}>Survey Basics</span>
                            <span style={{ fontSize:11, color: override ? "#1E1B3A" : "#7A6E62",
                              fontStyle:"italic", lineHeight:1.4, flex:1 }}>
                              {sbText}
                              {override && <span style={{ fontStyle:"normal", fontSize:9, fontWeight:700,
                                color:"#FF6600", marginLeft:6 }}>(edited)</span>}
                            </span>
                            <button
                              onClick={() => {
                                const el = document.getElementById(editId);
                                if (el) el.style.display = el.style.display === "block" ? "none" : "block";
                              }}
                              style={{ fontSize:10, color:"#FF6600", background:"#FFEBDA",
                                border:"0.5px solid #FFA766", borderRadius:4, padding:"2px 8px",
                                cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>
                              Edit
                            </button>
                          </div>
                          <div id={editId} style={{ display:"none", marginTop:5 }}>
                            <textarea
                              defaultValue={override || ""}
                              placeholder="Type your own interpretation if this doesn't match what you see on your team."
                              onBlur={(e) => saveSbOverride && saveSbOverride(dept.key, q.en, e.target.value)}
                              style={{ width:"100%", border:"0.5px solid #F0DFCE", borderRadius:5,
                                padding:"6px 8px", fontSize:11, color:"#1E1B3A",
                                background:"white", resize:"vertical", minHeight:44,
                                fontFamily:"inherit", lineHeight:1.5 }}
                            />
                            <div style={{ fontSize:9, color:"#9C8F82", marginTop:3 }}>
                              Saves automatically when you click away. Clear the box to restore the default.
                            </div>
                            {/* Admin-only: promote this rewrite to the master Survey Basics for all reports */}
                            {isAdmin && override && override !== masterText && (
                              <div style={{ marginTop:6, display:"flex", alignItems:"center", gap:8 }}>
                                <button
                                  onClick={() => promoteSbToMaster && promoteSbToMaster(sbKey, q.en, level, override)}
                                  style={{ fontSize:10, fontWeight:600, color:"white", background:"#FF6600",
                                    border:"none", borderRadius:4, padding:"3px 10px", cursor:"pointer" }}>
                                  ★ Promote to master ({level})
                                </button>
                                <span style={{ fontSize:9, color:"#9C8F82" }}>
                                  Makes this the default {level==="low"?"Concern":level==="mid"?"Watch":"Healthy"} interpretation for this question in every future report.
                                </span>
                              </div>
                            )}
                            {isAdmin && masterText && (
                              <div style={{ marginTop:4, fontSize:9, color:"#166534" }}>
                                ★ A promoted master interpretation is active for this question ({level}).
                                {" "}
                                <button onClick={() => promoteSbToMaster && promoteSbToMaster(sbKey, q.en, level, "")}
                                  style={{ fontSize:9, color:"#C0392B", background:"none", border:"none",
                                    cursor:"pointer", textDecoration:"underline", padding:0 }}>
                                  Remove from master
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                  {/* Scale — hidden on mobile */}
                  {!isMobile && (
                  <div style={{ padding:"10px 6px", display:"flex", alignItems:"center", justifyContent:"center",
                    borderRight:"1px solid #F5E4D5" }}>
                    <span style={{ fontSize:10, fontWeight:700, color:"#8A7A6B",
                      background:"#FFF4EC", borderRadius:4, padding:"2px 6px" }}>
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
                          background: c > 0 ? CELL_COLORS[ci] : "#FFF4EC",
                          borderRadius:5, flexShrink:0,
                          display:"flex", alignItems:"center", justifyContent:"center",
                          fontSize:13, fontWeight:700,
                          color: c > 0 ? "white" : "#C8C4E8",
                          border: c > 0 ? "none" : "1px solid #F5E4D5",
                        }}>
                          {c}
                        </div>
                        {/* Full label — fixed two-line height */}
                        <div style={{ fontSize:8, fontWeight:600, color:"#9C8F82",
                          textAlign:"center", lineHeight:1.25, height:22 }}>
                          {ci===0 && <><span>Strongly</span><br/><span>Disagree</span></>}
                          {ci===1 && <span>Disagree</span>}
                          {ci===2 && <span>Unsure</span>}
                          {ci===3 && <span>Agree</span>}
                          {ci===4 && <><span>Strongly</span><br/><span>Agree</span></>}
                        </div>
                        {/* Percentage — fixed height so row stays aligned */}
                        <div style={{ fontSize:8, color:"#C9BCAF", textAlign:"center", height:12 }}>
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
      </div>

      {/* Sections */}
      {sections.map(sec => (
        <div key={sec.key} style={{ marginBottom:20, background:"#FFFFFF", borderRadius:10, overflow:"hidden" }}>
          <div style={{ padding:"12px 16px", borderBottom:"1px solid #F5E4D5" }}>
            <div style={{ color:sec.color, fontWeight:700, fontSize:13 }}>{sec.label}</div>
            {sec.key === "quotes" && dept.openQLabel && (
              <div style={{ marginTop:6, marginBottom:2, padding:"6px 10px",
                background:"#FFF4EC", borderLeft:"3px solid #FF7A1A", borderRadius:4 }}>
                <span style={{ fontSize:9, fontWeight:700, color:"#FF6600",
                  textTransform:"uppercase", letterSpacing:.5, marginRight:6 }}>Responding to</span>
                <span style={{ fontSize:12, color:"#5C5048", fontStyle:"italic" }}>"{dept.openQLabel}"</span>
              </div>
            )}
            <div style={{ color:"#9C8F82", fontSize:11, marginTop:2 }}>{sec.instruction}</div>
          </div>
          {(sel[sec.key] || []).map((item, idx) => {
            const editId = `item-edit-${dept.key}-${sec.key}-${idx}`;
            return (
              <div key={idx} style={{ borderBottom:"1px solid #FFF1E6",
                background: item.include ? "white" : "#FAF9FE",
                opacity: item.include ? 1 : 0.6 }}>
                {/* Main row — tight, single line */}
                <div style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 14px" }}>
                  <input type="checkbox" checked={item.include}
                    onChange={() => toggleItem(dept.key, sec.key, idx)}
                    style={{ flexShrink:0, cursor:"pointer", accentColor:"#FF6600",
                      width:15, height:15 }} />
                  <div style={{ flex:1 }}>
                    {(() => {
                      const displayText = item.rewrite.trim() || item.text;
                      const nonEng = item.isOriginalLang || looksNonEnglish(displayText);
                      return (
                        <>
                          <div style={{ fontSize:12, lineHeight:1.5,
                            color: item.include ? "#1E1B3A" : "#9C8F82",
                            textDecoration: item.include ? "none" : "line-through",
                            fontStyle: nonEng ? "italic" : "normal" }}>
                            {displayText}
                            {item.isRefined && !item.rewrite && (
                              <span style={{ marginLeft:8, fontSize:9, color:"#FF7A1A",
                                fontWeight:600, background:"#FFEBDA", borderRadius:4,
                                padding:"1px 5px" }}>✦ refined</span>
                            )}
                          </div>
                          {nonEng && (
                      <div style={{ marginTop:4, fontSize:11, lineHeight:1.4,
                        borderLeft:"2px solid #F0DFCE", paddingLeft:8 }}>
                        {item.translation ? (
                          <>
                            <span style={{ fontSize:9, fontWeight:700, color:"#9C8F82",
                              textTransform:"uppercase", letterSpacing:.5,
                              marginRight:6 }}>English translation</span>
                            <span style={{ color:"#5C5048" }}>{item.translation}</span>
                          </>
                        ) : (
                          <span style={{ fontSize:10, color:"#C9BCAF", fontStyle:"italic" }}>
                            Original language response — translation not yet available
                          </span>
                        )}
                          </div>
                        )}
                        </>
                      );
                    })()}
                  </div>
                  {item.include && (
                    <button
                      onClick={() => {
                        const el = document.getElementById(editId);
                        if (!el) return;
                        const opening = el.style.display !== "block";
                        el.style.display = opening ? "block" : "none";
                      }}
                      style={{ fontSize:10, color:"#FF6600", background:"#FFEBDA",
                        border:"0.5px solid #FFA766", borderRadius:5, padding:"3px 9px",
                        cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>
                      {item.rewrite.trim() ? "Edited ✓" : "Edit"}
                    </button>
                  )}
                </div>
                {/* Edit area — hidden by default */}
                {item.include && (
                  <div id={editId} style={{ display:"none", padding:"0 14px 10px 38px" }}>
                    <textarea
                      value={item.rewrite}
                      onChange={e => setRewrite(dept.key, sec.key, idx, e.target.value)}
                      onBlur={e => {
                        const val = e.target.value.trim();
                        if (val) saveRefinement(dept.key, sec.key, idx, val);
                      }}
                      placeholder={sec.key==="quotes"
                        ? "Leave blank to use as-is. Edit only if correcting a translation."
                        : "Type here to override wording exactly as it will appear in the report. Saves for future countries."}
                      style={{ width:"100%", background:"#FFF4EC", border:"0.5px solid #F0DFCE",
                        borderRadius:6, padding:"7px 10px", color:"#1E1B3A", fontSize:12,
                        resize:"vertical", minHeight:52, fontFamily:"inherit",
                        lineHeight:1.5, boxSizing:"border-box" }}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {(!sel[sec.key]?.length) && (
            <div style={{ padding:"16px", color:"#8A7A6B", fontSize:13, fontStyle:"italic" }}>No items generated for this section.</div>
          )}
        </div>
      ))}

    </div>
  );
}

// ─── REPORT VIEW ──────────────────────────────────────────────────────────────
function ReportView({ country, year, surveyData, getApproved, setView, sbOverrides, sbMaster }) {
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
  const totalN = surveyData?.raw?.length ?? depts.reduce((a,d)=>Math.max(a,d.n),0);

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
    <div style={{ minHeight:"100vh", background:"#F8F7F4", fontFamily:"'Inter',system-ui,sans-serif" }}>
      {/* Toolbar */}
      <div className="no-print" style={{ background:"white", borderBottom:"1px solid #F5E4D5", padding:"12px 24px", display:"flex", gap:12, alignItems:"center", position:"sticky", top:0, zIndex:10 }}>
        <button onClick={()=>setView("review")} style={{ ...navBtn, background:"transparent", border:"1px solid #F5E4D5" }}>← Director Review</button>
        <div style={{ flex:1, color:"#FF6600", fontWeight:700, fontSize:13, letterSpacing:1 }}>
          JOSIAH VENTURE · {country.toUpperCase()} {year}
        </div>
        <button onClick={()=>window.print()} style={{ ...navBtn, background:"#FF6600", color:"white" }}>Download PDF</button>
      </div>

      <div style={{ maxWidth:960, margin:"0 auto", padding:"40px 24px" }}>

        {/* ── SUMMARY PAGE ── */}
        <div style={{ background:"white", borderRadius:16, padding:40, marginBottom:32, border:"1px solid #F5E4D5", boxShadow:"0 2px 8px rgba(124,111,224,0.08)" }}>

          {/* Header */}
          <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:32, paddingBottom:24, borderBottom:"2px solid #FFF4EC" }}>
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:"#FF6600", letterSpacing:3, textTransform:"uppercase", marginBottom:8 }}>Josiah Venture</div>
              <div style={{ fontSize:32, fontWeight:800, color:"#1E1B3A", marginBottom:4 }}>{country} Staff Pulse Report</div>
              <div style={{ fontSize:15, color:"#9C8F82" }}>{year} · {totalN} respondents across {depts.length} departments</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:42, fontWeight:800, color:sc(overallAvg>=3.5?"Healthy":overallAvg>=2.5?"Watch":"Concern") }}>{overallAvg}</div>
              <div style={{ fontSize:11, color:"#9C8F82", marginTop:2 }}>Overall avg</div>
            </div>
          </div>

          {/* Score bar chart — all departments */}
          <div style={{ marginBottom:32 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Department Scores</div>
            {summaryDepts.map(d => (
              <div key={d.key} onClick={()=>openDept(d.key)}
                style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 12px", marginBottom:4,
                  borderRadius:8, cursor:"pointer",
                  background: activeDept===d.key ? sb(d.status) : "transparent",
                  border: activeDept===d.key ? `1px solid ${sbd(d.status)}` : "1px solid transparent",
                  transition:"all 0.15s" }}>
                <div style={{ width:180, fontSize:13, fontWeight:600, color:"#1E1B3A", flexShrink:0 }}>{d.label}</div>
                <div style={{ flex:1, background:"#F1EFF9", borderRadius:6, height:10, overflow:"hidden" }}>
                  <div style={{ width:`${((d.avg-1)/4)*100}%`, background:sc(d.status), height:"100%", borderRadius:6, transition:"width 0.6s ease" }} />
                </div>
                <div style={{ fontWeight:800, color:sc(d.status), fontSize:15, width:40, textAlign:"right" }}>{d.avg}</div>
                <span style={{ fontSize:10, fontWeight:700, color:sc(d.status), background:sb(d.status), border:`1px solid ${sbd(d.status)}`, borderRadius:4, padding:"2px 7px", width:60, textAlign:"center", flexShrink:0 }}>{d.status}</span>
                <div style={{ color:"#9C8F82", fontSize:11, width:40, textAlign:"right" }}>n={d.n}</div>
              </div>
            ))}
          </div>

          {/* Status group summary */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
            {[["Concern","#FDF2F2","#C0392B",concerns],["Watch","#FFFBEB","#D68910",watches],["Healthy","#F0FDF4","#1E8449",healthys]].map(([label,bg,color,group])=>(
              <div key={label} style={{ background:bg, borderRadius:10, padding:"14px 16px" }}>
                <div style={{ fontSize:11, fontWeight:700, color, textTransform:"uppercase", letterSpacing:1.5, marginBottom:8 }}>{label} · {group.length}</div>
                {group.map(d=>(
                  <div key={d.key} style={{ fontSize:12, color:"#1E1B3A", padding:"3px 0", borderBottom:"1px solid rgba(0,0,0,0.05)" }}>{d.label}</div>
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
            <div className="no-print" style={{ textAlign:"center", color:"#9C8F82", fontSize:13, padding:"16px 0 32px" }}>
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
        }
        .print-only { display:none; }
      `}</style>
    </div>
  );
}

function DeptReportPage({ dept, getApproved, country, year, sbOverrides, sbMaster }) {
  if (!dept) return null;
  const strengths    = getApproved(dept.key, "strengths");
  const growth       = getApproved(dept.key, "growth");
  const leadershipQs = getApproved(dept.key, "leadershipQs");
  const quotes       = getApproved(dept.key, "quotes").slice(0,4);

  const statusColor = sc(dept.status);
  const statusBg    = sb(dept.status);
  const statusBd    = sbd(dept.status);

  return (
    <div style={{ background:"white", borderRadius:16, padding:36, marginBottom:28,
      border:"1px solid #F5E4D5", boxShadow:"0 2px 8px rgba(124,111,224,0.07)",
      pageBreakInside:"avoid" }}>

      {/* Dept header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between",
        paddingBottom:20, marginBottom:24, borderBottom:`2px solid ${statusBd}` }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:"#1E1B3A", marginBottom:4 }}>{dept.label}</div>
          <div style={{ fontSize:13, color:"#9C8F82" }}>n = {dept.n} respondents</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:36, fontWeight:800, color:statusColor, lineHeight:1 }}>{dept.avg}</div>
          <span style={{ fontSize:11, fontWeight:700, color:statusColor, background:statusBg,
            border:`1px solid ${statusBd}`, borderRadius:6, padding:"3px 10px", display:"inline-block", marginTop:6 }}>
            {dept.status}
          </span>
        </div>
      </div>

      {/* Strengths + Growth — two column */}
      {(strengths.length > 0 || growth.length > 0) && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20, marginBottom:24 }}>
          {strengths.length > 0 && (
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:"#1E8449", textTransform:"uppercase",
                letterSpacing:2, marginBottom:12 }}>What is working</div>
              {strengths.map((s,i) => (
                <div key={i} style={{ display:"flex", gap:10, marginBottom:10, alignItems:"flex-start" }}>
                  <span style={{ color:"#1E8449", fontWeight:700, fontSize:14, marginTop:1, flexShrink:0 }}>✓</span>
                  <span style={{ fontSize:13, color:"#1E1B3A", lineHeight:1.6 }}>{s}</span>
                </div>
              ))}
            </div>
          )}
          {growth.length > 0 && (
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:statusColor, textTransform:"uppercase",
                letterSpacing:2, marginBottom:12 }}>Where attention is needed</div>
              {growth.map((g,i) => (
                <div key={i} style={{ display:"flex", gap:10, marginBottom:10, alignItems:"flex-start" }}>
                  <span style={{ color:statusColor, fontWeight:700, fontSize:14, marginTop:1, flexShrink:0 }}>→</span>
                  <span style={{ fontSize:13, color:"#1E1B3A", lineHeight:1.6 }}>{g}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Question scores table */}
      <div style={{ marginBottom:24 }}>
        <div style={{ fontSize:10, fontWeight:700, color:"#9C8F82", textTransform:"uppercase",
          letterSpacing:2, marginBottom:10 }}>Question Scores — Concern · Watch · Healthy</div>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
          <thead>
            <tr style={{ background:"#FFF4EC", borderRadius:6 }}>
              <th style={{ textAlign:"left", padding:"8px 10px", color:"#9C8F82", fontWeight:600, borderRadius:"6px 0 0 6px" }}>Question</th>
              <th style={{ textAlign:"center", padding:"8px 10px", color:"#9C8F82", fontWeight:600, width:55 }}>Score</th>
              <th style={{ textAlign:"center", padding:"8px 10px", color:"#9C8F82", fontWeight:600, width:75 }}>Status</th>
              <th style={{ textAlign:"center", padding:"8px 10px", color:"#9C8F82", fontWeight:600, width:45, borderRadius:"0 6px 6px 0" }}>Scale</th>
            </tr>
          </thead>
          <tbody>
            {[...dept.questions].sort((a,b)=>{
              const o={Concern:0,Watch:1,Healthy:2};
              return (o[a.status]??1)-(o[b.status]??1) || a.score-b.score;
            }).map((q,i)=>(
              <tr key={i} style={{ borderBottom:"1px solid #FFF4EC" }}>
                <td style={{ padding:"8px 10px", color:"#1E1B3A", lineHeight:1.5 }}>
                  {q.en}{q.burden ? <span style={{ color:"#9C8F82", fontSize:10 }}> [Burden]</span> : ""}
                  {(() => {
                    const sbMatch = findSurveyBasics(dept.key, q.en);
                    if (!sbMatch) return null;
                    const level = q.status === 'Healthy' ? 'high' : q.status === 'Watch' ? 'mid' : 'low';
                    const sbKey = SB_KEY[dept.key] || String(dept.key||"").toLowerCase();
                    const ovKey = `${country}:${year}:${dept.key}:${normQ(q.en)}`;
                    const masterKey = `${sbKey}:${normQ(q.en)}:${level}`;
                    const text = (sbOverrides && sbOverrides[ovKey]) || (sbMaster && sbMaster[masterKey]) || sbMatch[level];
                    if (!text) return null;
                    return (
                      <div style={{ fontSize:11, color:"#7A6E62", fontStyle:"italic",
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
                <td style={{ textAlign:"center", padding:"8px 10px", color:"#9C8F82", fontSize:10 }}>{q.scale.toUpperCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Leadership Questions */}
      {leadershipQs.length > 0 && (
        <div style={{ background:"#FFF1E6", borderRadius:10, padding:20, marginBottom:24,
          border:"1px solid #F0DFCE" }}>
          <div style={{ fontSize:10, fontWeight:700, color:"#3B3882", textTransform:"uppercase",
            letterSpacing:2, marginBottom:12 }}>Questions for leadership</div>
          {leadershipQs.map((q,i) => (
            <div key={i} style={{ display:"flex", gap:12, marginBottom:10, alignItems:"flex-start" }}>
              <span style={{ background:"#FF6600", color:"white", borderRadius:"50%", width:20, height:20,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:11, fontWeight:700, flexShrink:0, marginTop:1 }}>{i+1}</span>
              <span style={{ fontSize:13, color:"#1E1B3A", lineHeight:1.6 }}>{q}</span>
            </div>
          ))}
        </div>
      )}

      {/* Staff Quotes */}
      {quotes.length > 0 && (
        <div>
          <div style={{ fontSize:10, fontWeight:700, color:"#9C8F82", textTransform:"uppercase",
            letterSpacing:2, marginBottom:4 }}>What staff said</div>
          {dept.openQLabel && (
            <div style={{ fontSize:12, color:"#7A6E62", fontStyle:"italic", marginBottom:12 }}>
              In response to: "{dept.openQLabel}"
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns: quotes.length > 1 ? "1fr 1fr" : "1fr", gap:12 }}>
            {quotes.map((q,i) => {
              const isObj = typeof q === 'object' && q !== null;
              const orig = isObj ? (q.rewrite?.trim() || q.text || q.original) : q;
              const trans = isObj ? q.translation : null;
              const isOrig = (isObj ? q.isOriginalLang : false) || looksNonEnglish(orig);
              return (
                <div key={i} style={{ background:"#F8F7F4", borderLeft:"3px solid #F0DFCE",
                  borderRadius:"0 8px 8px 0", padding:"12px 16px" }}>
                  <div style={{ fontSize:13, color:"#1E1B3A", lineHeight:1.7,
                    fontStyle: isOrig ? "italic" : "normal" }}>
                    "{orig}"
                  </div>
                  {isOrig && trans && (
                    <div style={{ marginTop:6, fontSize:11, color:"#8A7A6B",
                      fontStyle:"normal", lineHeight:1.4,
                      borderLeft:"2px solid #F0DFCE", paddingLeft:8, marginLeft:0 }}>
                      <span style={{ fontSize:9, fontWeight:700, color:"#9C8F82",
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
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD VIEW ───────────────────────────────────────────────────────────
function DashboardView({ allRuns, dashCountry, setDashCountry, setView, country, year, surveyData, refinements, setRefinements }) {
  const countries = [...new Set(allRuns.map(r=>r.country))].sort();
  const DEPTS_ORDER = ["HR","LD","LC","MPD","Counseling","Women","Singles","Marriages","JVK"];

  // Build trend data per country+dept
  const runsByCountry = {};
  for (const run of allRuns) {
    if (!runsByCountry[run.country]) runsByCountry[run.country] = [];
    runsByCountry[run.country].push(run);
  }

  // Current country's latest run
  const currentRuns = dashCountry === "all"
    ? allRuns
    : (runsByCountry[dashCountry] || []);

  const latestByCountry = {};
  for (const run of allRuns) {
    if (!latestByCountry[run.country] || run.year > latestByCountry[run.country].year)
      latestByCountry[run.country] = run;
  }

  return (
    <div style={{ minHeight:"100vh", background:"#F8F7F4", fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #F5E4D5", padding:"14px 24px", display:"flex", alignItems:"center", gap:16 }}>
        <button onClick={()=>setView("home")} style={{ ...navBtn, background:"transparent", border:"1px solid #F5E4D5" }}>← Home</button>
        <div style={{ flex:1, color:"#1E1B3A", fontWeight:700 }}>P&C Dashboard</div>
        <select value={dashCountry} onChange={e=>setDashCountry(e.target.value)}
          style={{ background:"#F8F7F4", border:"1px solid #F5E4D5", borderRadius:6, color:"#1E1B3A", padding:"6px 12px", fontSize:13 }}>
          <option value="all">All Countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"32px 24px" }}>

        {/* JV-wide overview grid */}
        {dashCountry === "all" && (
          <>
            <div style={{ fontSize:13, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Latest Results by Country</div>
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
                        <div style={{ color:"#1E1B3A", fontWeight:700, fontSize:16 }}>{run.country}</div>
                        <div style={{ color:"#9C8F82", fontSize:12 }}>{run.year}</div>
                      </div>
                      <span style={{ fontSize:11, fontWeight:700, color:sc(overallStatus), background:sb(overallStatus), border:`1px solid ${sbd(overallStatus)}`, borderRadius:6, padding:"3px 10px" }}>{overallStatus}</span>
                    </div>
                    <div style={{ display:"flex", gap:12 }}>
                      {[["Concern",concern,"#C0392B"],["Watch",watch,"#D68910"],["Healthy",healthy,"#1E8449"]].map(([l,n,c])=>(
                        <div key={l} style={{ flex:1, textAlign:"center", background:"#FFFFFF", borderRadius:8, padding:"10px 4px" }}>
                          <div style={{ fontSize:22, fontWeight:800, color:c }}>{n}</div>
                          <div style={{ fontSize:10, color:"#9C8F82" }}>{l}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Cross-country dept heatmap */}
            <div style={{ fontSize:13, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Department Health — All Countries</div>
            <div style={{ background:"#FFFFFF", borderRadius:12, overflow:"hidden", marginBottom:40 }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid #F5E4D5" }}>
                    <th style={{ textAlign:"left", padding:"12px 16px", color:"#9C8F82" }}>Department</th>
                    {Object.keys(latestByCountry).map(c => (
                      <th key={c} style={{ textAlign:"center", padding:"12px 10px", color:"#9C8F82", fontWeight:600 }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DEPTS_ORDER.map(dk => (
                    <tr key={dk} style={{ borderBottom:"1px solid #F5E4D5" }}>
                      <td style={{ padding:"10px 16px", color:"#7A6E62", fontWeight:500 }}>{dk}</td>
                      {Object.values(latestByCountry).map(run => {
                        const d = run.depts?.find(dep=>dep.key===dk||dep.group===dk);
                        return (
                          <td key={run.country} style={{ textAlign:"center", padding:"10px" }}>
                            {d ? (
                              <span style={{ fontSize:11, fontWeight:700, color:sc(d.status), background:sb(d.status), borderRadius:4, padding:"2px 8px" }}>{d.avg}</span>
                            ) : <span style={{ color:"#F5E4D5" }}>—</span>}
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
        {dashCountry !== "all" && (
          <>
            <div style={{ fontSize:13, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>{dashCountry} — Department Health</div>
            {(runsByCountry[dashCountry]||[]).map(run => (
              <div key={run.id} style={{ marginBottom:32 }}>
                <div style={{ color:"#FF6600", fontWeight:700, fontSize:13, marginBottom:12 }}>{run.year}</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))", gap:12 }}>
                  {(run.depts||[]).slice().sort((a,b)=>{
                    const o={Concern:0,Watch:1,Healthy:2};
                    const sa=o[a.status]??3, sb=o[b.status]??3;
                    if (sa!==sb) return sa-sb;
                    return (parseFloat(a.avg)||0)-(parseFloat(b.avg)||0);
                  }).map(d => (
                    <div key={d.key} style={{ background:"#FFFFFF", borderRadius:10, padding:"14px 16px", border:`1px solid ${sbd(d.status)}` }}>
                      <div style={{ color:"#7A6E62", fontSize:11, marginBottom:6 }}>{d.label}</div>
                      <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                        <span style={{ fontSize:22, fontWeight:800, color:sc(d.status) }}>{d.avg}</span>
                        <span style={{ fontSize:10, fontWeight:700, color:sc(d.status) }}>{d.status}</span>
                      </div>
                      <div style={{ color:"#8A7A6B", fontSize:10, marginTop:4 }}>n={d.n}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Trend chart (text-based for now) */}
            {(runsByCountry[dashCountry]||[]).length > 1 && (
              <div style={{ background:"#FFFFFF", borderRadius:12, padding:20, marginTop:24 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:1.5, marginBottom:16 }}>Trend — Year over Year</div>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                  <thead>
                    <tr style={{ borderBottom:"1px solid #F5E4D5" }}>
                      <th style={{ textAlign:"left", padding:"8px 12px", color:"#9C8F82" }}>Department</th>
                      {[...(runsByCountry[dashCountry]||[])].sort((a,b)=>a.year-b.year).map(r=>(
                        <th key={r.year} style={{ textAlign:"center", padding:"8px 12px", color:"#9C8F82" }}>{r.year}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DEPTS_ORDER.map(dk => {
                      const rows = [...(runsByCountry[dashCountry]||[])].sort((a,b)=>a.year-b.year)
                        .map(r => r.depts?.find(d=>d.key===dk||d.group===dk));
                      if (rows.every(r=>!r)) return null;
                      return (
                        <tr key={dk} style={{ borderBottom:"1px solid #F5E4D5" }}>
                          <td style={{ padding:"8px 12px", color:"#7A6E62" }}>{dk}</td>
                          {rows.map((d,i)=>(
                            <td key={i} style={{ textAlign:"center", padding:"8px 12px" }}>
                              {d ? (
                                <span style={{ fontWeight:700, color:sc(d.status) }}>{d.avg}</span>
                              ) : <span style={{ color:"#F5E4D5" }}>—</span>}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* OKR placeholder */}
            <div style={{ background:"#FFFFFF", borderRadius:12, padding:24, marginTop:24, border:"1px dashed #F5E4D5" }}>
              <div style={{ fontSize:11, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:1.5, marginBottom:8 }}>OKR Integration</div>
              <div style={{ color:"#8A7A6B", fontSize:13 }}>Key Results tied to staff health metrics will appear here once OKR system integration is connected.</div>
            </div>
          </>
        )}
      {/* Refinements manager — always visible in P&C view */}
      <div style={{ marginTop:32 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:2 }}>
            Saved Refinements ({Object.keys(refinements).length})
          </div>
          {Object.keys(refinements).length > 0 && (
            <button onClick={() => {
              if (window.confirm("Clear all saved refinements? This cannot be undone.")) {
                setRefinements({});
                try { localStorage.removeItem("pulse:refinements"); } catch {}
              }
            }} style={{ ...navBtn, background:"#C0392B", fontSize:12 }}>Clear All</button>
          )}
        </div>
        {Object.keys(refinements).length === 0 ? (
          <div style={{ color:"#8A7A6B", fontSize:13, fontStyle:"italic" }}>
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
                      <span style={{ fontSize:10, fontWeight:700, color:"#FF7A1A", background:"#FFEBDA", borderRadius:4, padding:"2px 8px" }}>{deptKey}</span>
                      <span style={{ fontSize:10, fontWeight:700, color:"#9C8F82", background:"#F8F7F4", borderRadius:4, padding:"2px 8px" }}>{section}</span>
                      <span style={{ fontSize:10, color:"#8A7A6B" }}>#{parseInt(idx)+1}</span>
                    </div>
                    <div style={{ color:"#1E1B3A", fontSize:13, lineHeight:1.5 }}>{val.text}</div>
                    <div style={{ color:"#8A7A6B", fontSize:10, marginTop:4 }}>Saved {new Date(val.savedAt).toLocaleDateString()}</div>
                  </div>
                  <button onClick={() => {
                    const updated = { ...refinements };
                    delete updated[key];
                    setRefinements(updated);
                    try { localStorage.setItem("pulse:refinements", JSON.stringify(updated)); } catch {}
                  }} style={{ color:"#9C8F82", background:"none", border:"none", cursor:"pointer", fontSize:16, lineHeight:1 }}>×</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

// ─── SHARED STYLES ────────────────────────────────────────────────────────────
const card = {
  background:"#FFFFFF", borderRadius:12, padding:24,
  border:"1px solid #F5E4D5",
  boxShadow:"0 1px 4px rgba(124,111,224,0.07)",
};
const navBtn = {
  background:"#FFEBDA", border:"none", borderRadius:8,
  color:"#1E1B3A", padding:"8px 16px", fontSize:13, fontWeight:600,
  cursor:"pointer",
};
const lbl = { display:"block", fontSize:11, fontWeight:700, color:"#9C8F82", textTransform:"uppercase", letterSpacing:1, marginBottom:6 };
const inp = { width:"100%", background:"#F8F7F4", border:"1px solid #F5E4D5", borderRadius:8, padding:"10px 14px", color:"#1E1B3A", fontSize:14, boxSizing:"border-box" };
