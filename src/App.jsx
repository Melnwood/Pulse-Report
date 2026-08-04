import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useIsMobile, sc, sb, sbd, card, navBtn, lbl, inp, C, FONT_DISPLAY } from "./theme";
import Disclosure from "./components/Disclosure";
import QuestionHeatmap from "./components/QuestionHeatmap";
import { VisibilityPicker, VisibilityChip } from "./components/Visibility";
import { IconHelp, IconUpload } from "./components/Icons";
import Login from "./components/Login";
import UsersView from "./components/UsersView";
import VideosView from "./components/VideosView";
import { authStatus, tokenValid, getUser, logout, listCountryLeaders } from "./authClient";
import CountryLeadersView from "./components/CountryLeadersView";
import SURVEY_BASICS from "./surveyBasics.json";
import { airtablePing, upsertRun, upsertDepartment, loadSelections, saveSelections as atSaveSelections, loadRunSelections, loadAllRuns, loadRunSurveyData, setDepartmentReviewStatus, addDepartmentNote, loadDepartmentNotes, setDepartmentNoteVisibility, deleteDepartmentNote, addQuestionNote, loadQuestionNotes, setQuestionNoteVisibility, updateQuestionNote, deleteQuestionNote, loadMeasures, loadSurveyBasicsMaster, saveSurveyBasicsMaster, loadHelpVideos, loadPrep, savePrep, saveBrief, loadBriefs, baseYear, periodSeq, periodCmp, loadSurveys, createSurvey, setSurveyStatus, loadSurveyResponses, updateSurvey, deleteSurvey, loadCheckins, addCheckins, removeCheckin } from "./airtable";
import { synthesizeLeadership, languageForCountry, translateBatch, translateToEnglish, nativeLanguageLabel } from "./ai";
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

// Every JV country, so country dropdowns (survey links, country leaders, invite
// email) aren't limited to countries that already have a pulse report in the
// system. Merged with whatever names runs/leaders already use — the name
// already in use wins on spelling, so nothing shows up twice.
const JV_COUNTRIES = [
  "Albania", "Bulgaria", "Croatia", "Czech Republic", "Estonia", "Germany",
  "Hungary", "Latvia", "Lithuania", "Moldova", "Montenegro", "North Macedonia",
  "Poland", "Romania", "Serbia", "Slovakia", "Slovenia", "Ukraine",
];
const mergeCountries = (...lists) => {
  const seen = new Map();
  lists.flat().forEach(c => {
    const k = String(c || "").trim().toLowerCase();
    if (k && !seen.has(k)) seen.set(k, String(c).trim());
  });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
};

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
      { col:35, en:"My uplink rhythms (meetings, guidance, support) help me thrive in ministry.", burden:false, scale:"dist" },
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
  // Concern-count override: a department flips to Concern when at least 40% of
  // its scored questions are individually at Concern (rounded up — 4 of 9,
  // 3 of 7, 2 of 5). A percentage rather than a hard count, so small
  // departments like Language & Culture (4 questions) are protected by the
  // same rule as big ones. Otherwise status follows the average.
  const statuses = questions.map(q => q.status).filter(Boolean);
  const concerns = statuses.filter(s => s === "Concern").length;
  if (statuses.length && concerns >= Math.ceil(statuses.length * 0.4)) return "Concern";
  const scores = questions.map(q=>q.score).filter(Boolean);
  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : null;
  if (!avg) return null;
  // Majority-flagged guard: a department where MORE THAN HALF the questions are
  // Watch or Concern can never show Healthy — a couple of strong scores can pull
  // the average over 3.50 while most questions still need attention (Hungary
  // Counseling: 7 of 9 flagged, average 3.502). It shows at least Watch.
  const flagged = statuses.filter(s => s === "Concern" || s === "Watch").length;
  if (avg >= 3.50) return (statuses.length && flagged > statuses.length / 2) ? "Watch" : "Healthy";
  if (avg >= 2.50) return "Watch";
  return "Concern";
}

// ── Borderline status override ──────────────────────────────────────────────
// When a question's score/distribution sits within this margin of a band boundary,
// the director may nudge it to the adjacent band. Single tunable constant.
const BORDERLINE_MARGIN = 0.15;

function distPosNeg(vals, burden) {
  const nums = (vals || []).filter(v => v >= 1 && v <= 5);
  const inv = burden ? nums.map(v => 6 - v) : nums;
  const n = inv.length || 1;
  return { pos: inv.filter(v => v >= 4).length / n, neg: inv.filter(v => v <= 2).length / n };
}

// If the question sits near a band boundary, return the two adjacent bands
// (lowest first) the director may choose between; otherwise null.
function borderlineOptions(q) {
  const auto = q.autoStatus || q.status;
  if (!auto) return null;
  const isDist = q.scale === "dist" && (q.vals || []).filter(v => v >= 1 && v <= 5).length >= 5;
  if (isDist) {
    const { pos, neg } = distPosNeg(q.vals, q.burden);
    const dHigh = Math.min(Math.abs(pos - 0.75), Math.abs(neg - 0.15));  // Watch/Healthy line
    const dLow  = Math.min(Math.abs(pos - 0.50), Math.abs(neg - 0.30));  // Concern/Watch line
    if (auto === "Healthy") return dHigh <= BORDERLINE_MARGIN ? { options: ["Watch", "Healthy"] } : null;
    if (auto === "Concern") return dLow  <= BORDERLINE_MARGIN ? { options: ["Concern", "Watch"] } : null;
    if (dHigh <= BORDERLINE_MARGIN && dHigh <= dLow) return { options: ["Watch", "Healthy"] };
    if (dLow  <= BORDERLINE_MARGIN) return { options: ["Concern", "Watch"] };
    return null;
  }
  const s = q.score;
  if (s == null) return null;
  if (Math.abs(s - 3.50) <= BORDERLINE_MARGIN) return { options: ["Watch", "Healthy"] };
  if (Math.abs(s - 2.50) <= BORDERLINE_MARGIN) return { options: ["Concern", "Watch"] };
  return null;
}

// Department-level borderline: when the department's AVERAGE sits within the
// margin of a band line, the director may choose between the two adjacent
// bands. Only offered when the automatic status came from the average itself —
// the Concern-count and majority-flagged protections can't be overridden away.
const DEPT_OVERRIDE_KEY = "§ Department";
function deptBorderlineOptions(avg, auto) {
  const s = parseFloat(avg);
  if (!s || !auto) return null;
  const avgBand = s >= 3.50 ? "Healthy" : s >= 2.50 ? "Watch" : "Concern";
  if (auto !== avgBand) return null;   // a protection rule set this — not a judgment call
  if (Math.abs(s - 3.50) <= BORDERLINE_MARGIN) return { options: ["Watch", "Healthy"] };
  if (Math.abs(s - 2.50) <= BORDERLINE_MARGIN) return { options: ["Concern", "Watch"] };
  return null;
}

// Master question lookup by survey column — the CODE is the source of truth for
// each question's scale/burden/wording. Loaded runs render a snapshot frozen in
// Airtable's "Survey Data JSON" at import time, so a code change (e.g. a scale
// moving from mean → dist) would otherwise only affect NEW imports and appear to
// "revert" on every reload. Re-sourcing from this map makes such changes
// retroactive for every stored run with no re-import.
const MASTER_BY_COL = (() => {
  const m = new Map();
  for (const d of DEPARTMENTS) for (const mq of d.questions) m.set(mq.col, mq);
  return m;
})();
const MASTER_BY_NORM = (() => {
  const m = new Map();
  for (const d of DEPARTMENTS) for (const mq of d.questions) m.set(normQ(mq.en), mq);
  return m;
})();

// Apply saved status overrides onto a surveyData object — and, first, re-source
// each question's scale/burden/wording from the code question master and
// recompute its AUTO band under the corrected scale (score VALUES stay exactly
// as stored). Then swap in the director-chosen status where one exists and
// recompute each department's roll-up from the effective statuses. Runs even
// with no overrides (the re-sourcing must always happen). Returns a NEW object;
// the input is untouched.
function applyStatusOverrides(sd, overrides, country, year) {
  if (!sd || !sd.depts) return sd;
  const ov = overrides || {};
  const depts = {};
  for (const [key, d] of Object.entries(sd.depts)) {
    const questions = (d.questions || []).map(q => {
      // 1. Re-source scale/burden/en from the code master (by col; fall back to
      //    normalized text for older snapshots without a col).
      const master = (q.col != null && MASTER_BY_COL.get(q.col)) || MASTER_BY_NORM.get(normQ(q.en)) || null;
      const eff = master ? { ...q, en: master.en, burden: master.burden, scale: master.scale } : { ...q };
      // 2. Recompute the auto band under the corrected scale from the stored
      //    response values. Scores are NOT touched.
      let auto;
      if (Array.isArray(eff.vals) && eff.vals.length) {
        auto = getStatus(eff.vals, eff).status || eff.autoStatus || eff.status;
      } else {
        auto = eff.autoStatus || eff.status;
      }
      // 3. Only then apply any borderline override (check the master wording
      //    first, then the frozen wording older overrides were keyed under).
      const chosen = ov[`${country}:${year}:${key}:${normQ(eff.en)}`] ||
                     ov[`${country}:${year}:${key}:${normQ(q.en)}`];
      return { ...eff, autoStatus: auto, status: (chosen && chosen !== auto) ? chosen : auto };
    });
    // Department roll-up, then any DEPARTMENT-level borderline choice on top —
    // honored only while the department is still genuinely on the bubble, so a
    // stale override silently clears if the data or rules move on.
    const deptAuto = deptStatus(questions);
    const scores = questions.map(q => q.score).filter(Boolean);
    const deptAvg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const deptChosen = ov[`${country}:${year}:${key}:${normQ(DEPT_OVERRIDE_KEY)}`];
    const bl = deptBorderlineOptions(deptAvg, deptAuto);
    depts[key] = { ...d, questions, autoStatus: deptAuto,
      status: (deptChosen && bl && bl.options.includes(deptChosen)) ? deptChosen : deptAuto };
  }
  return { ...sd, depts };
}

// ─── PARSE SURVEY FILE ────────────────────────────────────────────────────────
async function parseSurveyFile(file) {
  const { read, utils } = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb  = read(buf);
  const ws  = wb.Sheets["Raw Data"] || wb.Sheets[wb.SheetNames[0]];
  const raw = utils.sheet_to_json(ws, { header:1, defval:null });
  const headerRow = raw[0] || [];
  const dataRows = raw.slice(2).filter(r => r[1] === "Completed" || r[1] === "Complete");
  return computeSurveyData(headerRow, dataRows);
}

// The scoring pipeline proper — shared by the QuestionPro Excel import and the
// in-app staff survey (whose answers convert to the same row shape), so there
// is exactly ONE way scores get computed.
function computeSurveyData(headerRow, dataRows) {
  const routing = resolveRouting(headerRow);   // resolves marital/kids/culture column indices from headers

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

// ─── IN-APP STAFF SURVEY ──────────────────────────────────────────────────────
// Staff answers live as { d:{demographics}, a:{col:1-5}, open:{col:"text"} } and
// convert to the SAME column-indexed rows the QuestionPro export produces —
// one pipeline, two doors.
const LIKERT = ["Strongly disagree", "Disagree", "Unsure", "Agree", "Strongly agree"];
const SURVEY_ROW_HEADER = (() => {
  const h = new Array(120).fill("");
  h[ROUTING_FALLBACK.marital] = "Marital status";
  h[ROUTING_FALLBACK.kids]    = "Do you have children living in your household?";
  h[ROUTING_FALLBACK.culture] = "Are you serving cross-culturally?";
  return h;
})();
function surveyAnswersToRow(ans) {
  const row = new Array(120).fill(null);
  row[1] = "Completed";
  const d = ans.d || {};
  row[ROUTING_FALLBACK.marital] = d.marital || "";
  row[ROUTING_FALLBACK.kids]    = d.kids || "";
  row[ROUTING_FALLBACK.culture] = d.culture != null ? Number(d.culture) : null;
  Object.entries(ans.a || {}).forEach(([c, v]) => { const n = Number(v); if (n >= 1 && n <= 5) row[Number(c)] = n; });
  Object.entries(ans.open || {}).forEach(([c, v]) => { if (String(v || "").trim()) row[Number(c)] = String(v); });
  return row;
}
// Which sections a respondent answers, from their demographics. Mirrors the
// import routing: culture code 1 = serving cross-culturally (2nd culture),
// code 2 = home culture (1st culture).
function surveySectionsFor(d = {}) {
  return DEPARTMENTS.filter(dept => {
    switch (dept.key) {
      case "HR": case "LD": case "MPD": case "Counseling": return true;
      case "LC1":  return d.culture === 2;
      case "LC2":  return d.culture === 1;
      case "Women": return d.woman === true;
      case "Singles": return d.marital === "Single";
      case "Marriages": return d.marital === "Married";
      case "JVK1": return d.kids === "Yes" && d.culture === 2;
      case "JVK2": return d.kids === "Yes" && d.culture === 1;
      default: return false;
    }
  });
}
// The public survey endpoint (no login — token + resume code only).
async function surveyApi(payload) {
  const res = await fetch("/.netlify/functions/survey", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("The survey service gave an unexpected reply — try again in a moment."); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
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

  // Role-based landing: someone with only one place to go goes straight there —
  // directors land on People & Culture, country leaders land on their country's
  // dashboard. The chooser screen is only for Mel & Chris (leaders), who
  // genuinely have a choice to make. Runs whenever "sections" would show, so
  // single-destination roles never see the middle page. Previews follow suit.
  useEffect(() => {
    if (view !== "sections" || !authed || !viewRole) return;
    if (viewRole === "director") setViewRaw("home");
    else if (viewRole === "country") setViewRaw("dashboard");
    else if (viewRole === "leader") setViewRaw("leadership");
  }, [view, authed, viewRole]);   // eslint-disable-line

  const [country, setCountry]     = useState("");
  const [year, setYear]           = useState(new Date().getFullYear().toString());
  const [surveyData, setSurveyData] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState({});
  const [selections, setSelections] = useState({});    // { deptKey: { strengths:[{text,include,rewrite}], ... } }
  const [saved, setSaved]         = useState(false);
  // Autosync status: "idle" | "saving" | "saved" | "error". Shown as a quiet indicator.
  const [syncStatus, setSyncStatus] = useState("idle");
  // The time of the last confirmed save to the shared database. Shown to the user
  // as "Saved at 3:42 PM" so they can SEE their work was saved, and when. Every
  // write path in the review (item edits, rewrites, survey-basics text, status
  // calls) reports through the helpers below into this one honest indicator.
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const markSaving    = () => setSyncStatus("saving");
  const markSaved     = () => { setLastSavedAt(Date.now()); setSyncStatus("saved");
    setTimeout(() => setSyncStatus(s => s === "saved" ? "idle" : s), 2500); };
  const markSaveError = () => setSyncStatus("error");
  const syncTimer = useRef(null);
  const lastSyncedRef = useRef("");   // JSON of last-synced selections, to skip no-op saves
  const lastSyncedByDept = useRef({}); // JSON of last-synced selections per dept, to save only what changed
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
    markSaving();
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
        markSaved();
      } catch (e) { console.warn("SB override sync failed:", e.message); markSaveError(); }
    }, 1200);
  };

  // Borderline status overrides — a director's chosen band for a near-boundary
  // question. Keyed country:year:deptKey:normalizedQuestion. Persisted (localStorage
  // cache + Airtable, mirroring sbOverrides). Invisible downstream; only the review
  // shows a marker.
  const [statusOverrides, setStatusOverrides] = useState(() => {
    try { const r = localStorage.getItem("pulse:statusOverrides"); return r ? JSON.parse(r) : {}; }
    catch { return {}; }
  });
  const saveStatusOverride = (deptKey, qText, status) => {
    const key = `${country}:${year}:${deptKey}:${normQ(qText)}`;
    const updated = { ...statusOverrides };
    if (status) updated[key] = status;
    else delete updated[key];   // clearing restores the auto band
    setStatusOverrides(updated);
    try { localStorage.setItem("pulse:statusOverrides", JSON.stringify(updated)); } catch {}
    syncStatusOverridesForDept(deptKey, updated);
  };
  const statusSyncTimers = useRef({});
  const syncStatusOverridesForDept = (deptKey, allOverrides) => {
    if (!country || !year || !surveyData?.depts?.[deptKey]) return;
    const prefix = `${country}:${year}:${deptKey}:`;
    const slice = {};
    Object.entries(allOverrides).forEach(([k, v]) => { if (k.startsWith(prefix)) slice[k] = v; });
    if (statusSyncTimers.current[deptKey]) clearTimeout(statusSyncTimers.current[deptKey]);
    markSaving();
    statusSyncTimers.current[deptKey] = setTimeout(async () => {
      try {
        const runName = `${country} ${year}`;
        // Bake the effective status into the stored department + question data so
        // downstream readers (dashboards read the stored Status; a reloaded report
        // reads the stored questions) honor the override with no marker.
        const eff = applyStatusOverrides({ depts: { [deptKey]: surveyData.depts[deptKey] } }, allOverrides, country, year).depts[deptKey];
        const runId = await upsertRun({ country, year, status: "In Review", overallAvg: null, respondents: surveyData?.raw?.length || null });
        await upsertDepartment(runId, runName, {
          key: deptKey, label: eff.label, avg: eff.avg, status: eff.status, n: eff.n,
          openQLabel: eff.openQLabel,
          surveyDataJSON: JSON.stringify({ questions: eff.questions || [] }).slice(0, 95000),
          statusOverridesJSON: JSON.stringify(slice),
        });
        markSaved();
      } catch (e) { console.warn("Status override sync failed:", e.message); markSaveError(); }
    }, 1200);
  };

  // The survey data everything downstream reads, with borderline overrides applied
  // (question statuses swapped, department roll-ups recomputed). The raw surveyData
  // keeps the auto statuses; the review compares the two to show its marker.
  const effSurveyData = useMemo(
    () => applyStatusOverrides(surveyData, statusOverrides, country, year),
    [surveyData, statusOverrides, country, year]
  );

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
    markSaving();
    saveSurveyBasicsMaster({ key, sbKey, question: qText, level, text: clean, author: effMe })
      .then(markSaved)
      .catch(e => { console.warn("Survey Basics master save failed:", e.message); markSaveError(); });
  };

  // Country-leader directory — powers the personalized report greeting and the
  // note attribution. Keyed lower(country) -> { name, email }. Refreshed after
  // edits on the Country Leaders screen.
  const [countryLeaders, setCountryLeaders] = useState({});
  const reloadCountryLeaders = useCallback(() => {
    listCountryLeaders().then(list => {
      const m = {};
      (list || []).forEach(l => { if (l.country) m[String(l.country).toLowerCase()] = { name: l.name, email: l.email }; });
      setCountryLeaders(m);
    });
  }, []);
  useEffect(() => {
    if (authGate === "open" || authGate === "authed") reloadCountryLeaders();
  }, [authGate, reloadCountryLeaders]);
  const leaderForCountry = country ? (countryLeaders[String(country).toLowerCase()] || null) : null;

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
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false; lastSyncedRef.current = snapshot;
      // Seed per-dept snapshots so the first edit only re-saves the dept that changed.
      const seed = {}; Object.entries(selections).forEach(([k, v]) => { seed[k] = JSON.stringify(v); });
      lastSyncedByDept.current = seed;
      return;
    }
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
        let anyFailed = false;
        for (const [deptKey, sel] of Object.entries(selections)) {
          const d = surveyData?.depts?.[deptKey];
          if (!d) continue;
          // A director may only WRITE their own department(s). The browser holds the
          // whole run's selections, but attempting to save a department they don't own
          // returns 403 "Outside your department" from the server — and that would
          // abort this entire sync, silently dropping the director's real edits along
          // with it. So skip any department this user can't edit. (Leaders and the
          // auth-off state can edit all, so nothing is skipped for them.)
          if (!canEditDept(deptKey)) continue;
          // Only write departments whose selections actually changed since the last
          // successful sync — cuts Airtable requests (and rate-limit risk) sharply.
          const deptSnap = JSON.stringify(sel);
          if (lastSyncedByDept.current[deptKey] === deptSnap) continue;
          // Save each department independently: one department's failure must never
          // discard the others' saves (or roll back the whole run's edits).
          try {
            const deptRecId = await upsertDepartment(runId, runName, {
              key: deptKey, label: d.label, avg: d.avg, status: d.status, n: d.n,
              openQLabel: d.openQLabel,
              surveyDataJSON: JSON.stringify({ questions: d.questions || [] }).slice(0, 95000),
            });
            await atSaveSelections(deptRecId, sel);
            lastSyncedByDept.current[deptKey] = deptSnap;
          } catch (err) {
            anyFailed = true;
            console.warn(`Autosync: department "${deptKey}" did not save:`, err.message);
          }
        }
        if (anyFailed) {
          markSaveError();
        } else {
          lastSyncedRef.current = snapshot;
          markSaved();
        }
      } catch (e) {
        console.warn("Autosync failed:", e.message);
        setSyncStatus("error");
      } finally {
        syncInFlightRef.current = false;
      }
    }, 1500);

    return () => { if (syncTimer.current) clearTimeout(syncTimer.current); };
  }, [selections, country, year, surveyData]);

  const saveRun = async (data, yearOv, countryOv) => {
    const yr = yearOv ?? year;
    const cn = countryOv ?? country;
    const run = {
      id: `${cn}-${yr}-${Date.now()}`,
      country: cn, year: yr,
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
    const runs = [...allRuns.filter(r => !(r.country===cn && String(r.year)===String(yr))), run];
    setAllRuns(runs);
    try { localStorage.setItem("pulse:runs", JSON.stringify(runs)); } catch(e) {}
    try { localStorage.setItem(`pulse:data:${cn}:${yr}`, JSON.stringify(data)); } catch(e) {}
  };

  const handleFile = async (file) => {
    if (!country || !year) { alert("Enter country and year first."); return; }
    // A pulse report already on file for this country + period? Offer to ADD a
    // new one (keeps both — it becomes e.g. "2026·2") instead of overwriting.
    // Teams can pulse once a year or several times; every report keeps its own
    // identity, notes, prep, and point on the trends.
    let effYear = year;
    const sameYear = allRuns.filter(r => r.country === country && baseYear(r.year) === baseYear(year));
    if (sameYear.some(r => String(r.year) === String(year))) {
      const addNew = window.confirm(
        `${country} already has a ${year} Pulse Report.\n\n` +
        `OK — add this as a NEW pulse report (keeps both; this one becomes "${baseYear(year)}\u00b7${Math.max(...sameYear.map(r => periodSeq(r.year))) + 1}").\n` +
        `Cancel — replace the existing ${year} report.`);
      if (addNew) {
        effYear = `${baseYear(year)}\u00b7${Math.max(...sameYear.map(r => periodSeq(r.year))) + 1}`;
        setYear(effYear);
      }
    }
    setGenerating(true);
    setGenProgress({ step: "Parsing survey file…" });
    try {
      const data = await parseSurveyFile(file);
      await runGeneratedImport(data, effYear, country);
    } catch(e) {
      alert("Error parsing file: " + e.message);
    } finally {
      setGenerating(false);
      setGenProgress({});
    }
  };

  // The shared generation flow: score data in hand (from the Excel import OR
  // the in-app staff survey), produce the AI draft content, store the run, and
  // land in the review. One path, two doors.
  const runGeneratedImport = async (data, effYear, effCountry) => {
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
        const gen = await generateDeptContent(d, effCountry);

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
      await saveRun(data, effYear, effCountry);
      setView("review");
  };

  // Import completed in-app survey responses into the pulse report — converts
  // each respondent's answer sheet to the shared row shape and runs the same
  // pipeline as the Excel import.
  const startSurveyImport = async (survey) => {
    try {
      const resps = await loadSurveyResponses(survey.run);
      const completed = resps.filter(r => r.status === "Completed");
      if (!completed.length) { alert("No completed surveys yet for " + survey.run + "."); return; }
      const partial = resps.length - completed.length;
      if (partial > 0 && !window.confirm(
        `${completed.length} completed survey${completed.length === 1 ? "" : "s"} will be imported.\n` +
        `${partial} still in progress and will NOT be included.\n\nContinue?`)) return;
      if (allRuns.some(r => r.country === survey.country && String(r.year) === String(survey.period)) &&
          !window.confirm(`${survey.run} already has report data — importing will regenerate it from the ${completed.length} survey answers. Continue?`)) return;
      setCountry(survey.country); setYear(survey.period);
      setGenerating(true);
      setGenProgress({ step: "Reading survey answers…" });
      const rows = completed.map(r => surveyAnswersToRow(r.answers));
      const data = computeSurveyData(SURVEY_ROW_HEADER, rows);
      await runGeneratedImport(data, survey.period, survey.country);
    } catch (e) {
      alert("Survey import failed: " + e.message);
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

  // The reports list is fetched once on mount — which can happen before login or
  // before the backend function has warmed up. If that first fetch failed or was
  // slow, the list would stay empty and the user would see "No reports available
  // yet" after logging in, with no automatic recovery. Re-fetch once the user is
  // authenticated so a failed/slow initial load heals itself.
  useEffect(() => {
    if (authGate !== "authed") return;
    let alive = true;
    (async () => {
      setRunsLoading(true);
      try { await reloadRuns(); }
      finally { if (alive) setRunsLoading(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [authGate]);

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
      if (sd?.statusOverrides && Object.keys(sd.statusOverrides).length) {
        setStatusOverrides(prev => { const m = { ...prev, ...sd.statusOverrides };
          try { localStorage.setItem("pulse:statusOverrides", JSON.stringify(m)); } catch {} return m; });
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
      .sort((a, b) => periodCmp(b.year, a.year))[0];
    if (!run) { window.alert(`No pulse run found for "${detected || "that file"}". Upload the survey for that country first, then import the director review.`); return; }
    setPendingImport(file);
    openRunShared(run, "review");
  };

  // A staff survey link (?survey=TOKEN) opens the survey directly — no login,
  // no app shell. This must come before every auth gate: staff have no accounts.
  const surveyToken = (() => {
    try { return new URLSearchParams(window.location.search).get("survey"); } catch { return null; }
  })();
  if (surveyToken) return <StaffSurveyView token={surveyToken} />;

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

  if (view === "leaders" && effIsAdmin) return wrap(
    <CountryLeadersView setView={setView}
      countries={mergeCountries(allRuns.map(r => r.country), JV_COUNTRIES)}
      onChanged={reloadCountryLeaders} />
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
      authUser={authUser} onSignOut={signOut}
      countryLeaders={countryLeaders}
      onImportSurveyResponses={startSurveyImport} />
  );

  if (view === "home") return wrap(
    <HomeView
      country={country} setCountry={setCountry}
      year={year} setYear={setYear}
      fileRef={fileRef} handleFile={handleFile}
      generating={generating} genProgress={genProgress}
      allRuns={allRuns} setAllRuns={setAllRuns} setView={setView}
      setSurveyData={setSurveyData} setSelections={setSelections}
      setSbOverrides={setSbOverrides} setStatusOverrides={setStatusOverrides}
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
      surveyData={effSurveyData} selections={selections}
      toggleItem={toggleItem} setRewrite={setRewrite} addItem={addItem}
      saveSelections={saveSelections} saved={saved}
      saveRefinement={saveRefinement} refinements={refinements}
      setView={setView} setSelections={setSelections}
      isAdmin={effIsAdmin} toggleAdmin={toggleAdmin}
      pendingImport={pendingImport} clearPendingImport={() => setPendingImport(null)}
      sbOverrides={sbOverrides} saveSbOverride={saveSbOverride} setSbOverrides={setSbOverrides}
      statusOverrides={statusOverrides} saveStatusOverride={saveStatusOverride}
      sbMaster={sbMaster} saveSbMaster={saveSbMaster}
      cloudLoading={cloudLoading} syncStatus={syncStatus} lastSavedAt={lastSavedAt}
      me={effMe} saveMe={saveMe} isPCLead={effIsPCLead}
      openToDept={openToDept} setOpenToDept={setOpenToDept}
      toggleDeptFinished={toggleDeptFinished}
      canEditDept={canEditDept} authRole={viewRole} authUser={viewUser} onSignOut={signOut} authDepts={authDepts}
      leaderName={leaderForCountry ? leaderForCountry.name : null}
    />
  );

  if (view === "report") return wrap(
    <ReportView
      country={country} year={year}
      surveyData={effSurveyData} getApproved={getApproved}
      // Run-level unique respondent count (survives reload; raw rows don't).
      runRespondents={allRuns.find(r => r.country === country && String(r.year) === String(year))?.respondents ?? null}
      setView={setView}
      sbOverrides={sbOverrides} sbMaster={sbMaster}
      me={effMe} saveMe={saveMe} isPCLead={effIsPCLead}
      leaderName={leaderForCountry ? leaderForCountry.name : null}
      // The country report looks EXACTLY the same however you reach it: the
      // country's own leader gets the prep layer, and so do Mel & Chris (P&C)
      // — no separate "admin flavor" of the page. Department leaders still get
      // the plain report (the server blocks them from prep anyway).
      prepMode={viewRole === "country" || effIsPCLead}
      prepAuthor={(viewUser && viewUser.name) || effMe || ""}
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
      country={country} year={year} surveyData={effSurveyData}
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
    <div style={{ minHeight:"100vh", background:"#F6F1E8" }}>
      {/* Full-width white banner — the same treatment as every other page.
          (No Back here: this is home.) */}
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #ECE2D2", padding: isMobile ? "12px 16px" : "14px 24px",
        display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
        <span style={{ fontFamily:FONT_DISPLAY, fontSize:22, fontWeight:600, color:"#2C2621", letterSpacing:-.2 }}>JV Pulse</span>
        <span style={{ fontSize:14, color:"#7A6F63" }}>People & Culture</span>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:12 }}>
          {/* No How-to videos here — those live in the People & Culture
              (director) screens only, not on the shared home. */}
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
      <div style={{ padding: isMobile ? "28px 16px" : "36px 24px" }}>
      <div style={{ maxWidth:900, margin:"0 auto" }}>
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
      </div>
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
    const label = names.length === 1 ? `${names[0]} department leader`
      : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]} department leader`;
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
        {modeBtn("director", "View as a P&C department leader")}
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
            Pick one or more departments (department leaders can cover several — e.g. Counseling &amp; Marriages):
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
function LeadershipBriefPanel({ countriesData = [], issues = [], allCountries = [], onOpenDept, author = "" }) {
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState(null);
  const [err, setErr] = useState("");
  const [scope, setScope] = useState("all");   // "all" or a country name
  // Every synthesis is kept (time-stamped, in Airtable) so past briefs can be
  // reread and compared as the data grows. viewingSaved marks that the brief on
  // screen came from the archive, not a fresh run.
  const [history, setHistory] = useState(null);   // null = loading
  const [viewingSaved, setViewingSaved] = useState(null);
  useEffect(() => {
    let alive = true;
    loadBriefs().then(list => { if (alive) setHistory(list); }).catch(() => { if (alive) setHistory([]); });
    return () => { alive = false; };
  }, []);

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
    setBusy(true); setErr(""); setViewingSaved(null);
    try {
      const qual = await gatherQualitative(scope);
      const b = await synthesizeLeadership({ ...rollupFor(scope), notes: qual.notes, openResponses: qual.openResponses });
      setBrief(b);
      // Archive every real result — time-stamped, so it can be reread later.
      if (b && !b.empty && (b.priorities || []).length) {
        const scopeName = scope === "all" ? "All countries" : scope;
        saveBrief({ scope: scopeName, headline: b.headline || "", priorities: b.priorities, author })
          .then(() => loadBriefs().then(setHistory).catch(() => {}))
          .catch(e => console.warn("Brief archive save failed:", e.message));
      }
    }
    catch (e) { setErr(e.message || "Couldn't synthesize right now."); }
    setBusy(false);
  };
  const pickScope = (s) => { setScope(s); setBrief(null); setErr(""); setViewingSaved(null); };   // changing scope clears the stale brief
  const openSaved = (h) => {
    setBrief({ empty: false, headline: h.headline, priorities: h.priorities });
    setViewingSaved(h);
    setErr("");
  };
  const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }); } catch { return ""; } };
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
      {viewingSaved && (
        <div style={{ marginTop:12, fontSize:12, fontWeight:600, color:"#9A6B26", background:"#F7EEDC",
          border:"1px solid #E8D5AE", borderRadius:8, padding:"7px 11px", display:"inline-block" }}>
          📁 Saved brief — {viewingSaved.scope}, {fmtWhen(viewingSaved.created)}{viewingSaved.author ? ` · ${viewingSaved.author}` : ""}. Press Synthesize for a fresh one.
        </div>
      )}
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

      {/* Past briefs — every synthesis, time-stamped. Click one to reread it. */}
      {history && history.length > 0 && (
        <details style={{ marginTop:14, borderTop:"1px solid #F4ECDD", paddingTop:10 }}>
          <summary style={{ cursor:"pointer", fontSize:12, fontWeight:700, color:"#7A6F63",
            textTransform:"uppercase", letterSpacing:1, listStyle:"none" }}>
            📁 Past briefs · {history.length}
          </summary>
          <div style={{ marginTop:8 }}>
            {history.slice(0, 20).map(h => (
              <button key={h.id} onClick={() => openSaved(h)}
                style={{ display:"flex", alignItems:"baseline", gap:10, width:"100%", textAlign:"left",
                  background: viewingSaved && viewingSaved.id === h.id ? "#F7EEDF" : "transparent",
                  border:"none", borderTop:"1px solid #F4ECDD", padding:"8px 6px", cursor:"pointer" }}>
                <span style={{ fontSize:12, fontWeight:700, color:"#B96524", whiteSpace:"nowrap", flexShrink:0 }}>{fmtWhen(h.created)}</span>
                <span style={{ fontSize:12, fontWeight:700, color:"#2C2621", whiteSpace:"nowrap", flexShrink:0 }}>{h.scope}</span>
                <span style={{ fontSize:12, color:"#7A6F63", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {h.headline || `${h.priorities.length} priorities`}
                </span>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── STAFF SURVEY MANAGEMENT (leaders) ───────────────────────────────────────
// Create a survey link per country + pulse period, watch responses come in
// (by code, never by name), read any one person's whole survey, close the
// window, and import completed answers straight into the pulse report.
function RespondentSurveyModal({ resp, onClose }) {
  const d = (resp.answers && resp.answers.d) || {};
  const a = (resp.answers && resp.answers.a) || {};
  const open = (resp.answers && resp.answers.open) || {};
  const demo = [
    d.culture === 1 ? "Serving cross-culturally" : d.culture === 2 ? "Serving in home culture" : null,
    d.marital === "Single" ? "Single" : d.marital === "Married" ? "Married" : null,
    d.kids === "Yes" ? "Kids at home" : d.kids === "No" ? "No kids at home" : null,
    d.woman === true ? "Woman" : d.woman === false ? "Man" : null,
  ].filter(Boolean);
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(44,38,33,0.5)", zIndex:1100,
      overflowY:"auto", padding:"36px 14px 60px" }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth:640, margin:"0 auto", background:"#fff",
        borderRadius:14, padding:"20px 22px", boxShadow:"0 24px 60px rgba(44,38,33,.35)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
          <span style={{ fontFamily:FONT_DISPLAY, fontSize:19, fontWeight:600, color:"#2C2621" }}>Respondent {resp.code}</span>
          <span style={{ fontSize:11, fontWeight:700, borderRadius:5, padding:"2px 8px",
            color: resp.status === "Completed" ? "#5C9A6D" : "#C08636",
            background: resp.status === "Completed" ? "#E9F1E9" : "#F7EEDC",
            border: `1px solid ${resp.status === "Completed" ? "#C7E0CB" : "#E8D5AE"}` }}>{resp.status}</span>
          <button onClick={onClose} style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer",
            fontSize:19, color:"#7A6F63", lineHeight:1 }}>✕</button>
        </div>
        <div style={{ fontSize:12, color:"#7A6F63", marginBottom:12 }}>
          {demo.join(" · ") || "No demographics yet"}{resp.language && resp.language !== "English" ? ` · took it in ${resp.language}` : ""}
        </div>
        {DEPARTMENTS.map(dept => {
          const qa = dept.questions.filter(qq => a[qq.col] != null);
          const openText = String(open[dept.openQ] || "").trim();
          if (!qa.length && !openText) return null;
          return (
            <div key={dept.key} style={{ marginBottom:16 }}>
              <div style={{ fontSize:12, fontWeight:700, color:"#B96524", textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>{dept.label}</div>
              {qa.map(qq => {
                const v = a[qq.col];
                const eff = qq.burden ? 6 - v : v;
                const col = eff >= 4 ? "#5C9A6D" : eff >= 3 ? "#C08636" : "#BE6650";
                return (
                  <div key={qq.col} style={{ display:"flex", gap:10, alignItems:"flex-start", padding:"6px 0", borderBottom:"1px solid #F6F1E8" }}>
                    <span style={{ flex:1, fontSize:12.5, color:"#2C2621", lineHeight:1.45 }}>
                      {qq.en}{qq.burden ? <span style={{ color:"#7A6F63", fontSize:10 }}> [Burden]</span> : ""}
                    </span>
                    <span style={{ flexShrink:0, fontSize:11, fontWeight:700, color:col, background:"#FDFAF4",
                      border:"1px solid #ECE2D2", borderRadius:6, padding:"3px 8px", whiteSpace:"nowrap" }}>
                      {v} · {LIKERT[v - 1]}
                    </span>
                  </div>
                );
              })}
              {openText && (
                <div style={{ marginTop:8, fontSize:12.5, color:"#5A4A3B", background:"#FDFAF4",
                  borderLeft:"3px solid #E2D3C2", borderRadius:"0 8px 8px 0", padding:"9px 12px", lineHeight:1.55, whiteSpace:"pre-wrap" }}>
                  <span style={{ display:"block", fontSize:10, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:.5, marginBottom:3 }}>{dept.openQLabel}</span>
                  {openText}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// "Country Pulse Report agendas" — where Mel & Chris build out the FULL meeting
// agenda for each country on top of what the country leader queued up. Everyone
// (leader + department leaders) sees the full agenda in their meeting views;
// only P&C sees the leading notes attached to each item.
function CountryAgendasPanel({ latestRuns = [] }) {
  const [open, setOpen] = useState(null); // country name
  const runs = [...latestRuns].sort((a, b) => String(a.country).localeCompare(String(b.country)));
  if (!runs.length) return null;
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden", marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "11px 14px 7px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: 1.5 }}>Country Pulse Report agendas</span>
        <span style={{ fontSize: 11, color: "#A89C8D" }}>· build the full meeting agenda — your leading notes stay with P&C</span>
      </div>
      {runs.map(run => (
        <div key={run.country} style={{ borderTop: "1px solid #F3EBE1" }}>
          <button onClick={() => setOpen(open === run.country ? null : run.country)}
            style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", padding: "10px 14px",
              background: "none", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 650, color: "#2C2621" }}>
            <span style={{ color: "#A89C8D", fontSize: 11 }}>{open === run.country ? "▾" : "▸"}</span>
            {run.country} <span style={{ fontWeight: 500, color: "#A89C8D", fontSize: 12 }}>{run.year}</span>
          </button>
          {open === run.country && <CountryAgendaEditor run={run} />}
        </div>
      ))}
    </div>
  );
}

function CountryAgendaEditor({ run }) {
  const [prep, setPrep] = useState(null);
  const [err, setErr] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newDept, setNewDept] = useState("");
  const [notesDraft, setNotesDraft] = useState({}); // agenda item id -> leading note text
  const deptList = (run.depts || []).map(d => ({ key: d.key, label: d.label || d.key }));
  const deptLabelFor = (k) => (deptList.find(d => d.key === k) || {}).label || k;
  const reload = async () => {
    try {
      const p = await loadPrep(run.country, run.year);
      setPrep(p); setNotesDraft(p.leaderNotes || {});
    } catch (e) { setErr(e.message); setPrep({ agenda: [], leaderNotes: {}, author: "" }); }
  };
  useEffect(() => { reload(); /* eslint-disable-line */ }, [run.country, run.year]);
  const agenda = prep ? [...(prep.agenda || [])].sort((a, b) => (a.order || 0) - (b.order || 0)) : [];

  const saveAgenda = async (items) => {
    const withOrder = items.map((a, i) => ({ ...a, order: i + 1 }));
    setPrep(p => ({ ...p, agenda: withOrder }));
    setErr("");
    try { await savePrep(run.country, run.year, { agenda: withOrder }); }
    catch (e) { setErr("Couldn't save the agenda: " + e.message); reload(); }
  };
  const move = (i, dir) => {
    const items = [...agenda]; const j = i + dir;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    saveAgenda(items);
  };
  const remove = (i) => {
    if (!window.confirm(`Take "${agenda[i].label}" off the ${run.country} agenda?`)) return;
    saveAgenda(agenda.filter((_, x) => x !== i));
  };
  const add = () => {
    const label = newLabel.trim();
    if (!label) return;
    const id = "pc" + Math.random().toString(36).slice(2, 10);
    saveAgenda([...agenda, { id, label, deptKey: newDept || null, by: "PC" }]);
    setNewLabel("");
  };
  const saveNote = async (itemId) => {
    const next = { ...((prep && prep.leaderNotes) || {}) };
    const text = (notesDraft[itemId] || "").trim();
    if (text) next[itemId] = text; else delete next[itemId];
    setPrep(p => ({ ...p, leaderNotes: next }));
    try { await savePrep(run.country, run.year, { leaderNotes: next }); }
    catch (e) { setErr("Couldn't save your leading note: " + e.message); }
  };

  if (!prep) return <div style={{ padding: "4px 14px 12px", fontSize: 12.5, color: "#7A6F63" }}>Loading…</div>;
  return (
    <div style={{ padding: "0 14px 14px 34px" }}>
      {err && <div style={{ color: "#BE6650", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {agenda.length === 0 && (
        <div style={{ fontSize: 12.5, color: "#A89C8D", fontStyle: "italic", marginBottom: 8 }}>
          Nothing on the agenda yet — add the first item below{prep.author ? `, or wait for ${prep.author}'s prep` : ""}.
        </div>
      )}
      {agenda.map((a, i) => (
        <div key={a.id || i} style={{ borderBottom: "1px solid #F8F2E8", padding: "8px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ background: "#E0863C", color: "#fff", borderRadius: "50%", width: 18, height: 18,
              display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 13, color: "#2C2621", lineHeight: 1.45, minWidth: 160 }}>{a.label}</span>
            {a.deptKey && (
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "#7A6F63", background: "#FDFAF4",
                border: "1px solid #ECE2D2", borderRadius: 10, padding: "1px 8px", whiteSpace: "nowrap" }}>{deptLabelFor(a.deptKey)}</span>
            )}
            <span style={{ fontSize: 10, fontWeight: 700, color: a.by === "PC" ? "#B96524" : "#A89C8D" }}>
              {a.by === "PC" ? "added by P&C" : `from ${prep.author || "the leader"}`}
            </span>
            <span style={{ display: "flex", gap: 3 }}>
              <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up"
                style={{ ...navBtn, fontSize: 11, padding: "2px 8px", opacity: i === 0 ? .4 : 1 }}>↑</button>
              <button onClick={() => move(i, 1)} disabled={i === agenda.length - 1} title="Move down"
                style={{ ...navBtn, fontSize: 11, padding: "2px 8px", opacity: i === agenda.length - 1 ? .4 : 1 }}>↓</button>
              <button onClick={() => remove(i)} title="Remove from agenda"
                style={{ ...navBtn, fontSize: 11, padding: "2px 8px", color: "#BE6650", borderColor: "#E8C7BC" }}>✕</button>
            </span>
          </div>
          <textarea rows={1} value={notesDraft[a.id] || ""} placeholder="Your leading note for this item (only P&C sees this)…"
            onChange={e => setNotesDraft(prev => ({ ...prev, [a.id]: e.target.value }))}
            onBlur={() => saveNote(a.id)}
            style={{ width: "100%", boxSizing: "border-box", fontSize: 12.5, padding: "7px 10px", marginTop: 6,
              border: "1px dashed #E2D3C2", borderRadius: 8, resize: "vertical", fontFamily: "inherit",
              background: (notesDraft[a.id] || "").trim() ? "#FBEFE4" : "#FFFDF9", lineHeight: 1.5 }} />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Add an agenda item…"
          onKeyDown={e => { if (e.key === "Enter") add(); }}
          style={{ flex: 1, minWidth: 180, fontSize: 13, padding: "8px 10px", border: "1px solid #E2D3C2", borderRadius: 8 }} />
        <select value={newDept} onChange={e => setNewDept(e.target.value)}
          style={{ fontSize: 12.5, padding: "8px 10px", border: "1px solid #E2D3C2", borderRadius: 8, background: "#fff" }}>
          <option value="">No department</option>
          {deptList.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        <button onClick={add} disabled={!newLabel.trim()} style={{ ...navBtn, fontSize: 12, padding: "7px 14px" }}>Add</button>
      </div>
    </div>
  );
}

// "Pulse survey progress" — one row per OPEN survey: who's finished, who's in
// the middle, and (once someone says how many staff should take it) how many
// haven't started. Shown on the P&C Leadership page for every country, and on
// a country's own dashboard for just that country. Renders nothing when no
// survey is running. The country leader (or P&C) can set the expected count
// right here — the server only lets a country leader touch that one number.
function PulseSurveyProgress({ country = null, refreshKey = "" }) {
  const isMobile = useIsMobile();
  const [items, setItems] = useState(null); // [{sv, resps}]
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cmp = (s) => String(s || "").trim().toLowerCase();
        const svs = (await loadSurveys()).filter(sv =>
          sv.status === "Open" && (!country || cmp(sv.country) === cmp(country)));
        const withResps = await Promise.all(svs.map(async sv => {
          try { return { sv, resps: await loadSurveyResponses(sv.run) }; }
          catch { return { sv, resps: [] }; }
        }));
        if (alive) setItems(withResps);
      } catch { if (alive) setItems([]); }
    })();
    return () => { alive = false; };
  }, [country, refreshKey]);
  if (!items || !items.length) return null;
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden", marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "11px 14px 7px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: 1.5 }}>Pulse survey progress</span>
        <span style={{ fontSize: 11, color: "#A89C8D" }}>· a survey is out right now</span>
      </div>
      {items.map(({ sv, resps }) => <SurveyProgressRow key={sv.id} sv={sv} resps={resps} isMobile={isMobile} />)}
    </div>
  );
}

function SurveyProgressRow({ sv, resps, isMobile }) {
  const finished = resps.filter(r => r.status === "Completed").length;
  const inProgress = resps.length - finished;
  // The check-off list — emails, completely separate from the anonymous answers.
  // Loaded right away: the pasted staff list IS the "how many should take it"
  // number, so the "haven't started" count needs it from the first glance.
  const [rosterOpen, setRosterOpen] = useState(false);
  const [roster, setRoster] = useState(null);
  const [addText, setAddText] = useState("");
  const [rosterBusy, setRosterBusy] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const loadRoster = async () => {
    try { setRoster(await loadCheckins(sv.run)); } catch { setRoster([]); }
  };
  useEffect(() => { loadRoster(); /* eslint-disable-line */ }, [sv.run]);
  const toggleRoster = () => setRosterOpen(v => !v);
  const addEmails = async () => {
    const existing = new Set((roster || []).map(r => r.email.toLowerCase()));
    const emails = [...new Set(addText.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))]
      .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !existing.has(e));
    if (!emails.length) { setAddText(""); return; }
    setRosterBusy(true);
    try { await addCheckins(sv.run, emails); setAddText(""); await loadRoster(); }
    catch (e) { window.alert("Couldn't add those emails: " + e.message); }
    setRosterBusy(false);
  };
  const removeEmail = async (row) => {
    setRosterBusy(true);
    try { await removeCheckin(row.id); await loadRoster(); }
    catch (e) { window.alert("Couldn't remove that: " + e.message); }
    setRosterBusy(false);
  };
  // The pasted staff list is the denominator — "haven't started" is simply the
  // people on the list who haven't signed in yet.
  const rosterCount = roster ? roster.length : null;
  const notStarted = rosterCount ? roster.filter(r => r.status === "Invited").length : null;
  const total = rosterCount ? Math.max(rosterCount, resps.length) : resps.length;
  const seg = (n) => total > 0 ? `${(n / total) * 100}%` : "0%";
  return (
    <div style={{ padding: "10px 14px", borderTop: "1px solid #F3EBE1" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 650, color: "#2C2621" }}>
          {sv.country} <span style={{ fontWeight: 500, color: "#A89C8D", fontSize: 12 }}>{sv.period}</span>
        </span>
        {sv.sendDate && (
          <span style={{ fontSize: 11.5, color: "#A89C8D" }}>
            went out {new Date(sv.sendDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#5A4A3B" }}>
          <b style={{ color: "#5C9A6D" }}>{finished}</b> finished
          {" · "}<b style={{ color: "#C08636" }}>{inProgress}</b> in progress
          {notStarted != null && <>{" · "}<b style={{ color: "#7A6F63" }}>{notStarted}</b> haven't started</>}
        </span>
      </div>
      <div style={{ display: "flex", height: 8, background: "#EBDECB", borderRadius: 5, overflow: "hidden", marginTop: 8 }}>
        <div style={{ width: seg(finished), background: "#5C9A6D", transition: "width .3s" }} />
        <div style={{ width: seg(inProgress), background: "#E0A56F", transition: "width .3s" }} />
      </div>
      <div style={{ marginTop: 6, fontSize: 11.5, color: "#7A6F63", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button onClick={toggleRoster}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#B96524", fontWeight: 700, fontSize: 11.5, padding: 0 }}>
          {rosterOpen ? "▾" : "▸"} Who's taken it{rosterCount ? ` (${roster.filter(r => r.status === "Finished").length} of ${rosterCount} ✓)` : ""}
        </button>
        {sv.token && (
          <button onClick={() => { if (!roster) loadRoster(); setEmailOpen(true); }}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#B96524", fontWeight: 700, fontSize: 11.5, padding: 0 }}>
            ✉ Email the survey to your staff
          </button>
        )}
        <span style={{ marginLeft: "auto", color: "#A89C8D" }}>
          {rosterCount ? `${rosterCount} on the list` : "Add staff emails to see who's still missing"}
        </span>
      </div>

      {rosterOpen && (
        <div style={{ marginTop: 8, background: "#FDFAF4", border: "1px solid #F3EBE1", borderRadius: 10, padding: "10px 12px" }}>
          <div style={{ fontSize: 11, color: "#A89C8D", lineHeight: 1.5, marginBottom: 8 }}>
            Add your staff's emails and each person gets a check-off as they finish. Their emails are never
            connected to their answers — you see <b>that</b> someone finished, never <b>what</b> they said.
          </div>
          {!roster ? (
            <div style={{ fontSize: 12, color: "#7A6F63" }}>Loading…</div>
          ) : roster.length === 0 ? null : (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "2px 16px", marginBottom: 8 }}>
              {roster.map(r => (
                <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, padding: "3px 0" }}>
                  <span title={r.status} style={{ width: 16, textAlign: "center" }}>
                    {r.status === "Finished" ? "✅" : r.status === "Started" ? "🟡" : "⚪"}
                  </span>
                  <span style={{ flex: 1, color: "#2C2621", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.email}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 700,
                    color: r.status === "Finished" ? "#5C9A6D" : r.status === "Started" ? "#C08636" : "#A89C8D" }}>
                    {r.status === "Finished" ? "Finished" : r.status === "Started" ? "In progress" : "Not started"}
                  </span>
                  <button onClick={() => removeEmail(r)} disabled={rosterBusy} title="Remove from the list"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#C9BEB0", fontSize: 13, padding: "0 2px" }}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <textarea rows={2} value={addText} onChange={e => setAddText(e.target.value)}
              placeholder="Paste staff emails here — commas, spaces, or one per line"
              style={{ flex: 1, minWidth: 220, fontSize: 12.5, padding: "7px 10px", border: "1px solid #E2D3C2",
                borderRadius: 8, resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }} />
            <button onClick={addEmails} disabled={rosterBusy || !addText.trim()}
              style={{ ...navBtn, fontSize: 12, padding: "7px 13px" }}>{rosterBusy ? "…" : "Add to list"}</button>
          </div>
        </div>
      )}
      {emailOpen && <StaffEmailModal sv={sv} roster={roster || []} onClose={() => setEmailOpen(false)} />}
    </div>
  );
}

function StaffSurveysModal({ countries = [], runs = [], onClose, onImport, generating }) {
  const [surveys, setSurveys] = useState(null);
  const [resps, setResps] = useState({});        // run -> responses
  const [expanded, setExpanded] = useState(null); // run
  const [viewing, setViewing] = useState(null);   // respondent
  const [creating, setCreating] = useState(false);
  const [newCountry, setNewCountry] = useState(countries[0] || "");
  const [otherCountry, setOtherCountry] = useState(""); // used when "Somewhere else…" is picked
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10)); // send-out day
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");

  const reload = async () => {
    try { setSurveys(await loadSurveys()); } catch (e) { setErr(e.message); setSurveys([]); }
  };
  useEffect(() => { reload(); }, []);
  const loadResps = async (run) => {
    try { const list = await loadSurveyResponses(run); setResps(prev => ({ ...prev, [run]: list })); }
    catch (e) { setErr(e.message); }
  };
  const toggleExpand = (run) => {
    const next = expanded === run ? null : run;
    setExpanded(next);
    if (next && !resps[next]) loadResps(next);
  };
  const create = async () => {
    const country = (newCountry === "__other__" ? otherCountry : newCountry).trim();
    if (!country || !newDate) return;
    // The pulse period comes from the send-out date's year. If that country
    // already has a report or survey for the year, this becomes "2026·2", "·3"…
    const cmp = (s) => String(s || "").trim().toLowerCase();
    const year = newDate.slice(0, 4);
    const taken = new Set();
    runs.forEach(r => { if (cmp(r.country) === cmp(country)) taken.add(String(r.year)); });
    (surveys || []).forEach(sv => { if (cmp(sv.country) === cmp(country)) taken.add(String(sv.period)); });
    let period = year;
    for (let n = 2; taken.has(period); n++) period = `${year}·${n}`;
    setBusy(true); setErr("");
    try { await createSurvey({ country, period, sendDate: newDate }); setCreating(false); await reload(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const flip = async (sv) => {
    try { await setSurveyStatus(sv.id, sv.status === "Open" ? "Closed" : "Open"); await reload(); }
    catch (e) { setErr(e.message); }
  };

  // Fixing a survey that was set up wrong. Country/year can change freely until
  // someone has answered; after that only the send date (same year) and the
  // expected count are editable — delete is always available, with a warning.
  const [editing, setEditing] = useState(null); // survey id
  const [eCountry, setECountry] = useState("");
  const [eOther, setEOther] = useState("");
  const [eDate, setEDate] = useState("");
  const openEdit = (sv) => {
    setErr("");
    setEditing(editing === sv.id ? null : sv.id);
    setECountry(countries.includes(sv.country) ? sv.country : "__other__");
    setEOther(sv.country);
    setEDate(sv.sendDate || "");
    if (!resps[sv.run]) loadResps(sv.run);
  };
  const saveEdit = async (sv) => {
    const cmp = (s) => String(s || "").trim().toLowerCase();
    const country = (eCountry === "__other__" ? eOther : eCountry).trim();
    if (!country || !eDate) return;
    setBusy(true); setErr("");
    try {
      const hasResps = (resps[sv.run] || []).length > 0;
      const countryChanged = cmp(country) !== cmp(sv.country);
      const yearChanged = eDate.slice(0, 4) !== String(sv.period).slice(0, 4);
      if ((countryChanged || yearChanged) && hasResps) {
        setErr("People have already answered this survey, so its country and year can't change. You can adjust the date within the same year — or delete the survey and start over.");
      } else if (countryChanged || yearChanged) {
        const year = eDate.slice(0, 4);
        const taken = new Set();
        runs.forEach(r => { if (cmp(r.country) === cmp(country)) taken.add(String(r.year)); });
        (surveys || []).forEach(s2 => { if (s2.id !== sv.id && cmp(s2.country) === cmp(country)) taken.add(String(s2.period)); });
        let period = year;
        for (let n = 2; taken.has(period); n++) period = `${year}·${n}`;
        await updateSurvey(sv.id, { country, period, sendDate: eDate });
        setEditing(null); await reload();
      } else {
        await updateSurvey(sv.id, { sendDate: eDate });
        setEditing(null); await reload();
      }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const del = async (sv) => {
    setBusy(true); setErr("");
    try {
      const list = resps[sv.run] || await loadSurveyResponses(sv.run);
      const msg = list.length
        ? `Delete the ${sv.run} survey?\n\n${list.length} ${list.length === 1 ? "person has" : "people have"} already answered — their answers will be deleted too. This can't be undone.`
        : `Delete the ${sv.run} survey link? This can't be undone.`;
      if (window.confirm(msg)) { await deleteSurvey(sv.id, sv.run); setEditing(null); await reload(); }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const copyLink = async (sv) => {
    try {
      await navigator.clipboard.writeText(`${APP_URL}/?survey=${sv.token}`);
      setCopied(sv.id); setTimeout(() => setCopied(""), 2200);
    } catch {}
  };

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(44,38,33,0.45)", zIndex:1000,
      overflowY:"auto", padding:"36px 14px 60px" }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth:720, margin:"0 auto", background:"#fff",
        borderRadius:14, padding:"20px 22px", boxShadow:"0 24px 60px rgba(44,38,33,.35)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
          <span style={{ fontFamily:FONT_DISPLAY, fontSize:19, fontWeight:600, color:"#2C2621" }}>Staff surveys</span>
          <button onClick={() => { setCreating(v => !v); setErr(""); }}
            style={{ ...navBtn, marginLeft:"auto", fontSize:12, padding:"6px 12px", background:"#E0863C", color:"#fff", border:"1px solid transparent" }}>
            + New survey link
          </button>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", fontSize:19, color:"#7A6F63", lineHeight:1 }}>✕</button>
        </div>
        <div style={{ fontSize:12.5, color:"#7A6F63", lineHeight:1.55, marginBottom:14 }}>
          Share a link with a country's staff; they answer right in the app — anonymously, with a personal
          code to pause and resume. Watch responses arrive, open any one survey by its code, then close the
          window and import the answers straight into the pulse report.
        </div>
        {err && <div style={{ color:"#BE6650", fontSize:12.5, marginBottom:10 }}>{err}</div>}

        {creating && (
          <div style={{ background:"#FDFAF4", border:"1px solid #ECE2D2", borderRadius:10, padding:"12px 14px", marginBottom:14,
            display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
            <select value={newCountry} onChange={e => setNewCountry(e.target.value)}
              style={{ fontSize:13, padding:"8px 10px", border:"1px solid #E2D3C2", borderRadius:8, background:"#fff" }}>
              {countries.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="__other__">Somewhere else…</option>
            </select>
            {newCountry === "__other__" && (
              <input value={otherCountry} onChange={e => setOtherCountry(e.target.value)} placeholder="Country name"
                style={{ fontSize:13, padding:"8px 10px", border:"1px solid #E2D3C2", borderRadius:8, width:140 }} />
            )}
            <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
              style={{ fontSize:13, padding:"8px 10px", border:"1px solid #E2D3C2", borderRadius:8, fontFamily:"inherit" }} />
            <button onClick={create} disabled={busy} style={{ ...navBtn, fontSize:12, padding:"7px 14px" }}>
              {busy ? "Creating…" : "Create link"}
            </button>
            <span style={{ fontSize:11, color:"#A89C8D", flexBasis:"100%" }}>
              Pick the day the survey goes out. The report is named for that year — a second pulse in the same year becomes "·2" automatically.
            </span>
          </div>
        )}

        {surveys === null ? (
          <div style={{ fontSize:13, color:"#7A6F63" }}>Loading…</div>
        ) : surveys.length === 0 ? (
          <div style={{ fontSize:13, color:"#7A6F63" }}>No survey links yet — create the first one.</div>
        ) : surveys.map(sv => {
          const list = resps[sv.run];
          const done = list ? list.filter(r => r.status === "Completed").length : null;
          return (
            <div key={sv.id} style={{ border:"1px solid #ECE2D2", borderRadius:12, marginBottom:10, overflow:"hidden" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 14px", flexWrap:"wrap", background:"#FDFAF4" }}>
                <button onClick={() => toggleExpand(sv.run)}
                  style={{ background:"none", border:"none", cursor:"pointer", fontSize:14, fontWeight:700, color:"#2C2621", padding:0 }}>
                  {expanded === sv.run ? "▾" : "▸"} {sv.run}
                </button>
                <span style={{ fontSize:11, fontWeight:700, borderRadius:5, padding:"2px 8px",
                  color: sv.status === "Open" ? "#5C9A6D" : "#7A6F63",
                  background: sv.status === "Open" ? "#E9F1E9" : "#F1EAE1",
                  border: `1px solid ${sv.status === "Open" ? "#C7E0CB" : "#E4D8C8"}` }}>{sv.status}</span>
                {sv.sendDate && (
                  <span style={{ fontSize:11.5, color:"#7A6F63" }}>
                    goes out {new Date(sv.sendDate + "T00:00:00").toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" })}
                  </span>
                )}
                {list && <span style={{ fontSize:12, color:"#7A6F63" }}>{done} completed · {list.length - done} in progress</span>}
                <span style={{ marginLeft:"auto", display:"flex", gap:8, flexWrap:"wrap" }}>
                  <button onClick={() => copyLink(sv)} style={{ ...navBtn, fontSize:11.5, padding:"5px 11px" }}>
                    {copied === sv.id ? "✓ Copied" : "Copy staff link"}
                  </button>
                  <button onClick={() => flip(sv)} style={{ ...navBtn, fontSize:11.5, padding:"5px 11px" }}>
                    {sv.status === "Open" ? "Close survey" : "Reopen"}
                  </button>
                  <button onClick={() => openEdit(sv)} style={{ ...navBtn, fontSize:11.5, padding:"5px 11px",
                    background: editing === sv.id ? "#FBEFE4" : undefined, borderColor: editing === sv.id ? "#E0A56F" : undefined }}>
                    {editing === sv.id ? "Close edit" : "Edit"}
                  </button>
                  <button onClick={() => del(sv)} disabled={busy}
                    style={{ ...navBtn, fontSize:11.5, padding:"5px 11px", color:"#BE6650", borderColor:"#E8C7BC" }}>
                    Delete
                  </button>
                  <button onClick={() => onImport && onImport(sv)} disabled={generating}
                    style={{ ...navBtn, fontSize:11.5, padding:"5px 11px", background:"#5C9A6D", color:"#fff", border:"1px solid transparent" }}>
                    Import into report →
                  </button>
                </span>
              </div>
              {editing === sv.id && (
                <div style={{ padding:"12px 14px", borderTop:"1px solid #F3EBE1", background:"#fff",
                  display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                  <select value={eCountry} onChange={e => setECountry(e.target.value)}
                    style={{ fontSize:13, padding:"7px 10px", border:"1px solid #E2D3C2", borderRadius:8, background:"#fff" }}>
                    {countries.map(c => <option key={c} value={c}>{c}</option>)}
                    <option value="__other__">Somewhere else…</option>
                  </select>
                  {eCountry === "__other__" && (
                    <input value={eOther} onChange={e => setEOther(e.target.value)} placeholder="Country name"
                      style={{ fontSize:13, padding:"7px 10px", border:"1px solid #E2D3C2", borderRadius:8, width:130 }} />
                  )}
                  <input type="date" value={eDate} onChange={e => setEDate(e.target.value)}
                    style={{ fontSize:13, padding:"7px 10px", border:"1px solid #E2D3C2", borderRadius:8, fontFamily:"inherit" }} />
                  <button onClick={() => saveEdit(sv)} disabled={busy}
                    style={{ ...navBtn, fontSize:12, padding:"6px 13px" }}>{busy ? "Saving…" : "Save changes"}</button>
                  {(resps[sv.run] || []).length > 0 && (
                    <span style={{ fontSize:11, color:"#A89C8D", flexBasis:"100%" }}>
                      {(resps[sv.run] || []).length} answered already, so country and year are locked — date (same year) and staff count are fine to change.
                    </span>
                  )}
                </div>
              )}
              {expanded === sv.run && (
                <div style={{ padding:"10px 14px" }}>
                  {!list ? (
                    <div style={{ fontSize:12.5, color:"#7A6F63" }}>Loading responses…</div>
                  ) : list.length === 0 ? (
                    <div style={{ fontSize:12.5, color:"#A89C8D", fontStyle:"italic" }}>No one has started yet — share the staff link.</div>
                  ) : list.map(r => {
                    const secs = surveySectionsFor((r.answers && r.answers.d) || {});
                    const total = secs.reduce((acc, dd) => acc + dd.questions.length, 0);
                    const ans = Object.keys((r.answers && r.answers.a) || {}).length;
                    return (
                      <div key={r.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 0", borderTop:"1px solid #F6F1E8", flexWrap:"wrap" }}>
                        <span style={{ fontSize:13, fontWeight:800, color:"#B96524", letterSpacing:1 }}>{r.code}</span>
                        <span style={{ fontSize:11.5, fontWeight:700,
                          color: r.status === "Completed" ? "#5C9A6D" : "#C08636" }}>{r.status}</span>
                        <span style={{ fontSize:11.5, color:"#7A6F63" }}>
                          {total ? `${ans} of ${total} questions` : `${ans} answers`}
                          {r.updated ? ` · ${new Date(r.updated).toLocaleDateString(undefined, { month:"short", day:"numeric" })}` : ""}
                        </span>
                        <button onClick={() => setViewing(r)} style={{ ...navBtn, marginLeft:"auto", fontSize:11, padding:"4px 10px" }}>View survey</button>
                      </div>
                    );
                  })}
                  <button onClick={() => loadResps(sv.run)} style={{ ...navBtn, fontSize:11, padding:"4px 10px", marginTop:8 }}>↻ Refresh</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {viewing && <RespondentSurveyModal resp={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

// The agreed invitation wording for a country leader — one warm email that
// gives them the address, explains first sign-in, and sets the heart of the
// meeting. Placeholders are filled per country; the text is editable per send.
const APP_URL = "https://jv-pulse.netlify.app";
function inviteEmailFor(countryName, leader) {
  const first = leader && leader.name ? String(leader.name).trim().split(/\s+/)[0] : "friend";
  const email = (leader && leader.email) || "your JV email";
  return {
    subject: `Your ${countryName} Pulse Report is ready`,
    body: `Hi ${first},

Your team's Pulse Report is ready — and it's worth some unhurried time to read and understand. It gathers what your staff shared in the latest survey into one honest picture: where your team is healthy, where attention is needed, and the exact questions worth talking about together.

Here's how to get in:

1. Go to ${APP_URL}
2. Sign in with this email address (${email}). The first time, it will ask you to choose your own password.
3. You'll land straight on your ${countryName} page — click any department in the chart to go deeper.

As you read, react to each department by clicking into the available note boxes, answer the leadership questions, and add whatever you want us to talk through to your meeting agenda. When you're done, press "I've finished my part of the Pulse report" so we know you're ready.

This isn't about scores — it's about your people, and we're really looking forward to walking through it with you.

With you,
Mel & Chris for the People & Culture team`,
  };
}

// The email a country leader sends their staff when a survey opens: what the
// Pulse Report is, how leadership uses it, and how the sign-in stays separate
// from the anonymous answers. The survey link is filled in automatically.
function staffEmailFor(sv) {
  const link = `${APP_URL}/?survey=${sv.token}`;
  return {
    subject: `Your voice matters — the ${sv.country} Pulse Survey is open`,
    body: `Hi everyone,

It's Pulse Survey time — the moment where every one of us gets to say, honestly and confidentially, how it's really going.

What it is: a survey about how you're doing — your work, your team, the support you're getting. Your answers come together into the Pulse Report: one honest picture of where our team is healthy and where something needs attention.

How it helps: leadership and the People & Culture team read the combined picture and sit down together over it. Real conversations and real changes come out of what you share — this is how leadership listens.

About your answers: you'll sign in with your email so we know who has finished, but your email is kept completely separate from your answers. We can see THAT you finished — never WHAT you said. Your answers are tied only to a personal code the survey gives you, so you can pause and pick it up again anytime, even on another device.

Take it here: ${link}

It works in your own language too — look for the language button at the top. And wherever a question asks you to write something, feel free to write in your own language; it gets translated on our side. Please give it some unhurried time; honest answers are what make it worth doing.

Thank you — your voice is a gift to the whole team.

With gratitude,
Your ${sv.country} leadership`,
  };
}

// Preview + send window for the staff email. Staff go in BCC so nobody's
// address is shared with the whole list.
function StaffEmailModal({ sv, roster = [], onClose }) {
  const tmpl = staffEmailFor(sv);
  const [subject, setSubject] = useState(tmpl.subject);
  const [body, setBody] = useState(tmpl.body);
  const [copied, setCopied] = useState(false);
  const emails = roster.map(r => r.email).filter(Boolean);
  const mailto = `mailto:?bcc=${encodeURIComponent(emails.join(","))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Bcc: ${emails.join(", ")}\nSubject: ${subject}\n\n${body}`);
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    } catch {}
  };
  const inpStyle = { width:"100%", boxSizing:"border-box", fontSize:13, padding:"9px 11px",
    border:"1px solid #E2D3C2", borderRadius:8, fontFamily:"inherit" };
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(44,38,33,0.45)", zIndex:1100,
      overflowY:"auto", padding:"40px 16px 60px" }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth:640, margin:"0 auto", background:"#fff",
        borderRadius:14, padding:"20px 22px", boxShadow:"0 24px 60px rgba(44,38,33,.35)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
          <span style={{ fontFamily:FONT_DISPLAY, fontSize:19, fontWeight:600, color:"#2C2621" }}>Email the survey to your staff</span>
          <button onClick={onClose} style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer",
            fontSize:19, color:"#7A6F63", lineHeight:1 }}>✕</button>
        </div>
        <div style={{ fontSize:12.5, color:"#7A6F63", lineHeight:1.5, marginBottom:12 }}>
          Everything's written for you — what the Pulse Report is, how it helps, and how their answers stay
          anonymous — with the survey link inside. Tweak anything, then open it in your mail app.
        </div>
        <div style={{ fontSize:12, color:"#5A4A3B", marginBottom:12, background:"#FDFAF4",
          border:"1px solid #ECE2D2", borderRadius:8, padding:"8px 11px", lineHeight:1.5 }}>
          {emails.length
            ? <><b>Bcc ({emails.length}):</b> {emails.join(", ")}</>
            : <>No staff emails on the list yet — add them under "Who's taken it" first, or just add addresses in your mail app.</>}
        </div>
        <div style={{ marginBottom:10 }}>
          <label style={{ display:"block", fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>Subject</label>
          <input style={inpStyle} value={subject} onChange={e => setSubject(e.target.value)} />
        </div>
        <div style={{ marginBottom:14 }}>
          <label style={{ display:"block", fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>Message</label>
          <textarea rows={14} style={{ ...inpStyle, resize:"vertical", lineHeight:1.55 }}
            value={body} onChange={e => setBody(e.target.value)} />
        </div>
        <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
          <a href={mailto} style={{ ...navBtn, background:"#E0863C", color:"#fff", border:"1px solid transparent",
            fontWeight:700, textDecoration:"none", display:"inline-block" }}>✉ Open in your email app</a>
          <button onClick={copy} style={{ ...navBtn }}>{copied ? "✓ Copied" : "Copy email text"}</button>
          <span style={{ fontSize:11.5, color:"#A89C8D" }}>Nothing sends until you press Send in your mail app.</span>
        </div>
      </div>
    </div>
  );
}

// Pick a country, get the agreed email pre-addressed and pre-written — tweak if
// needed, then open it in your mail app or copy it out.
function InviteLeaderModal({ countries = [], leaders = {}, onClose, onManageLeaders }) {
  const [sel, setSel] = useState(countries[0] || "");
  const leader = leaders[String(sel).toLowerCase()] || null;
  const tmpl = inviteEmailFor(sel, leader);
  const [subject, setSubject] = useState(tmpl.subject);
  const [body, setBody] = useState(tmpl.body);
  const [copied, setCopied] = useState(false);
  const pick = (c) => {
    setSel(c); setCopied(false);
    const l = leaders[String(c).toLowerCase()] || null;
    const t = inviteEmailFor(c, l);
    setSubject(t.subject); setBody(t.body);
  };
  const mailto = leader && leader.email
    ? `mailto:${encodeURIComponent(leader.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`To: ${leader ? `${leader.name} <${leader.email}>` : ""}\nSubject: ${subject}\n\n${body}`);
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    } catch {}
  };
  const inpStyle = { width:"100%", boxSizing:"border-box", fontSize:13, padding:"9px 11px",
    border:"1px solid #E2D3C2", borderRadius:8, fontFamily:"inherit" };
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(44,38,33,0.45)", zIndex:1000,
      overflowY:"auto", padding:"40px 16px 60px" }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth:640, margin:"0 auto", background:"#fff",
        borderRadius:14, padding:"20px 22px", boxShadow:"0 24px 60px rgba(44,38,33,.35)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
          <span style={{ fontFamily:FONT_DISPLAY, fontSize:19, fontWeight:600, color:"#2C2621" }}>Email a country leader</span>
          <button onClick={onClose} style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer",
            fontSize:19, color:"#7A6F63", lineHeight:1 }}>✕</button>
        </div>
        <div style={{ fontSize:12.5, color:"#7A6F63", lineHeight:1.5, marginBottom:14 }}>
          The agreed invitation — pre-addressed, with the sign-in steps and their country page. Tweak it if you like, then open it in your mail app.
        </div>
        <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap", marginBottom:12 }}>
          <select value={sel} onChange={e => pick(e.target.value)}
            style={{ ...inpStyle, width:"auto", minWidth:160, background:"#FDFAF4" }}>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {leader && leader.email ? (
            <span style={{ fontSize:12.5, color:"#2C2621" }}>
              To: <b>{leader.name}</b> <span style={{ color:"#7A6F63" }}>&lt;{leader.email}&gt;</span>
            </span>
          ) : (
            <span style={{ fontSize:12.5, color:"#BE6650" }}>
              No leader on file for {sel} — {onManageLeaders
                ? <button onClick={onManageLeaders} style={{ background:"none", border:"none", padding:0, cursor:"pointer",
                    color:"#B96524", fontWeight:700, fontSize:12.5, textDecoration:"underline" }}>add them in Country leaders</button>
                : "add them in System → Country leaders"} first.
            </span>
          )}
        </div>
        <div style={{ marginBottom:10 }}>
          <label style={{ display:"block", fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>Subject</label>
          <input style={inpStyle} value={subject} onChange={e => setSubject(e.target.value)} />
        </div>
        <div style={{ marginBottom:14 }}>
          <label style={{ display:"block", fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>Message</label>
          <textarea rows={14} style={{ ...inpStyle, resize:"vertical", lineHeight:1.55 }}
            value={body} onChange={e => setBody(e.target.value)} />
        </div>
        <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
          {mailto ? (
            <a href={mailto} style={{ ...navBtn, background:"#E0863C", color:"#fff", border:"1px solid transparent",
              fontWeight:700, textDecoration:"none", display:"inline-block" }}>✉ Open in your email app</a>
          ) : (
            <span style={{ ...navBtn, background:"#ECE2D2", color:"#7A6F63", cursor:"default" }}>✉ Open in your email app</span>
          )}
          <button onClick={copy} style={{ ...navBtn }}>{copied ? "✓ Copied" : "Copy email text"}</button>
          <span style={{ fontSize:11.5, color:"#A89C8D" }}>Nothing sends until you press Send in your mail app.</span>
        </div>
      </div>
    </div>
  );
}

function LeadershipView({ country, setCountry, year, setYear, fileRef, handleFile,
  generating, genProgress, isAdmin, toggleAdmin, setView, allRuns = [], reloadRuns, runsLoading, openRun, onImportDirectorReview, canPreview, setPreviewAs, authUser, onSignOut, countryLeaders = {}, onImportSurveyResponses }) {
  const isMobile = useIsMobile();
  const [detail, setDetail] = useState(null);   // { country, year, deptKey, deptLabel } for the drill-in modal
  const openDeptDetail = ({ country: c, deptKey, deptLabel }) =>
    setDetail({ country: c, year: latestByCountry[c]?.year, deptKey, deptLabel });
  const dirReviewRef = useRef(null);   // file input for importing a director review
  const [showUpload, setShowUpload] = useState(false);   // the Import panel — closed until asked for (System → Import)
  const [sysMenu, setSysMenu] = useState(false);         // the System dropdown in the banner
  const [inviteOpen, setInviteOpen] = useState(false);   // the pre-written country-leader email
  const [surveysOpen, setSurveysOpen] = useState(false); // staff survey links + responses
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
  allRuns.forEach(r => { if (!latestByCountry[r.country] || periodCmp(r.year, latestByCountry[r.country].year) > 0) latestByCountry[r.country] = r; });
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
    <div style={{ minHeight:"100vh", background:"#F6F1E8" }}>
      {/* Full-width white banner — the same treatment every page gets: Back in
          the upper-left, the page name, tools and identity on the right. */}
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #ECE2D2", padding: isMobile ? "12px 16px" : "14px 24px",
        display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          {/* No Back here — this is Mel & Chris's home page now. */}
          <span style={{ fontFamily:FONT_DISPLAY, fontSize:22, fontWeight:600, color:"#2C2621" }}>People &amp; Culture Leadership</span>
          {/* Mel & Chris land here — these two buttons are their doors into the
              other sections now that the chooser screen is gone for leaders. */}
          <button onClick={() => setView("home")} style={{ ...navBtn, fontSize:12, padding:"6px 12px", background:"#E0863C", color:"#fff", border:"1px solid transparent" }}>Department Leader Review</button>
          <button onClick={() => setView("dashboard")} style={{ ...navBtn, fontSize:12, padding:"6px 12px" }}>Country dashboards</button>
          {/* System — the admin plumbing lives under one quiet menu */}
          {(isAdmin || (authUser && authUser.role === "leader")) && (
            <div style={{ position:"relative" }}>
              <button onClick={() => setSysMenu(v => !v)}
                style={{ ...navBtn, fontSize:12, padding:"6px 12px",
                  background: sysMenu ? "#FBEFE4" : undefined, borderColor: sysMenu ? "#E0A56F" : undefined,
                  color: sysMenu ? "#B96524" : undefined }}>
                ⚙ System ▾
              </button>
              {sysMenu && (<>
                <div onClick={() => setSysMenu(false)} style={{ position:"fixed", inset:0, zIndex:190 }} />
                <div style={{ position:"absolute", top:"115%", left:0, zIndex:200, background:"#fff",
                  border:"1px solid #ECE2D2", borderRadius:10, boxShadow:"0 10px 30px rgba(44,38,33,.18)",
                  minWidth:190, overflow:"hidden", padding:"4px 0" }}>
                  {[
                    isAdmin && ["📋 Staff surveys", () => setSurveysOpen(true)],
                    isAdmin && ["✉ Email a country leader", () => setInviteOpen(true)],
                    (authUser && authUser.role === "leader") && ["Manage people", () => setView("users")],
                    isAdmin && ["Country leaders", () => setView("leaders")],
                    isAdmin && ["Manage videos", () => setView("videos")],
                    isAdmin && [showUpload ? "Close import" : "Import", () => { setShowUpload(v => !v); setShowPreview(false); }],
                  ].filter(Boolean).map(([label, go]) => (
                    <button key={label} onClick={() => { setSysMenu(false); go(); }}
                      onMouseEnter={e => e.currentTarget.style.background = "#FDFAF4"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                      style={{ display:"block", width:"100%", textAlign:"left", fontSize:12.5, fontWeight:600,
                        color:"#2C2621", background:"transparent", border:"none", cursor:"pointer", padding:"9px 14px" }}>
                      {label}
                    </button>
                  ))}
                </div>
              </>)}
            </div>
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

      <div style={{ padding: isMobile ? "24px 16px" : "32px 24px" }}>
      <div style={{ maxWidth:900, margin:"0 auto" }}>

        {canPreview && showPreview && <PreviewAsPanel allRuns={allRuns} setPreviewAs={setPreviewAs} setView={setView} />}

        {/* ── Pulse survey progress — any survey out in the field right now ── */}
        <PulseSurveyProgress refreshKey={String(surveysOpen)} />

        {/* ── Country Pulse Report agendas — P&C builds the full meeting plan ── */}
        <CountryAgendasPanel latestRuns={latestRuns} />

        {/* ── Director review progress — compact, at the very top ──
            One row per active country: how much of its director review is done.
            Click a row to open that run. View-only. */}
        {allRuns && allRuns.length > 0 && (
          <div style={{ ...card, padding:0, overflow:"hidden", marginBottom:24 }}>
            <div style={{ display:"flex", alignItems:"baseline", gap:8, padding:"11px 14px 7px" }}>
              <span style={{ fontSize:12, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5 }}>Department leader review progress</span>
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
            Bring data into the platform. Two kinds today — a new survey run from QuestionPro, or a completed department leader review.
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
              Completed department leader review <span style={{ color:"#A89C8D", fontWeight:500, textTransform:"none", letterSpacing:0 }}>· Excel</span>
            </div>
            <div style={{ fontSize:12, color:"#7A6F63", lineHeight:1.5, marginBottom:10 }}>
              Loads the strengths, growth areas, leadership questions, and quotes from a department leader's review Excel into the matching country's report. We read the country from the file.
            </div>
            <input ref={dirReviewRef} type="file" accept=".xlsx" style={{ display:"none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f && onImportDirectorReview) onImportDirectorReview(f); e.target.value = ""; }} />
            <button onClick={() => dirReviewRef.current?.click()}
              style={{ ...navBtn, display:"inline-flex", alignItems:"center", gap:6 }}>
              <IconUpload/> Import department leader review (Excel)
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
            allCountries={briefAllCountries} onOpenDept={openDeptDetail} author={authUser?.name || ""} />
        )}

        {/* ── The patterns at a glance — warm visuals for the two questions
            leadership actually asks: which departments need attention across
            countries, and which issues keep coming back. ── */}
        {(deptPattern.length > 0 || recurring.length > 0) && (
          <div style={{ ...card, marginBottom:24, padding: isMobile ? "16px" : "20px 22px" }}>
            <div style={{ fontFamily:FONT_DISPLAY, fontSize:18, fontWeight:600, color:"#2C2621", marginBottom:2 }}>The patterns at a glance</div>
            <div style={{ fontSize:12.5, color:"#7A6F63", marginBottom:18 }}>Where attention is needed across countries — and what keeps coming back.</div>
            <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 22 : 28 }}>

              {/* Needs attention — by department, across countries */}
              <div>
                <div style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5, marginBottom:12 }}>
                  Needs attention · by department
                </div>
                {deptPattern.slice(0, 9).map(e => {
                  const total = e.Concern + e.Watch + e.Healthy || 1;
                  const flaggedN = e.Concern + e.Watch;
                  return (
                    <div key={e.label} style={{ marginBottom:12 }}>
                      <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:4 }}>
                        <span style={{ fontSize:12.5, fontWeight:650, color:"#2C2621" }}>{e.label}</span>
                        <span style={{ marginLeft:"auto", fontSize:11, fontWeight:700,
                          color: flaggedN ? "#B96524" : "#5C9A6D", whiteSpace:"nowrap" }}>
                          {flaggedN ? `${flaggedN} of ${total} ${total === 1 ? "country" : "countries"}` : "all healthy"}
                        </span>
                      </div>
                      <div style={{ display:"flex", height:14, borderRadius:8, overflow:"hidden",
                        background:"#FDFAF4", border:"1px solid #F4ECDD" }}>
                        {e.Concern > 0 && <div style={{ width:`${e.Concern/total*100}%`, background:"#D98874" }} />}
                        {e.Watch > 0 &&   <div style={{ width:`${e.Watch/total*100}%`, background:"#E4B061" }} />}
                        {e.Healthy > 0 && <div style={{ width:`${e.Healthy/total*100}%`, background:"#9CC4A4" }} />}
                      </div>
                      {e.concernCountries.length > 0 && (
                        <div style={{ fontSize:10.5, color:"#A89C8D", marginTop:3 }}>Concern in {e.concernCountries.join(", ")}</div>
                      )}
                    </div>
                  );
                })}
                <div style={{ display:"flex", gap:14, marginTop:10 }}>
                  {[["Concern","#D98874"],["Watch","#E4B061"],["Healthy","#9CC4A4"]].map(([l,c]) => (
                    <span key={l} style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:10.5, color:"#7A6F63" }}>
                      <span style={{ width:9, height:9, borderRadius:3, background:c, display:"inline-block" }} />{l}
                    </span>
                  ))}
                </div>
              </div>

              {/* Top issues — recurring across teams */}
              <div>
                <div style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5, marginBottom:12 }}>
                  Keeps coming back · across teams
                </div>
                {recurring.length === 0 ? (
                  <div style={{ fontSize:12.5, color:"#A89C8D", fontStyle:"italic" }}>
                    No question is low in more than one team right now.
                  </div>
                ) : recurring.map((e, i) => (
                  <div key={i} style={{ marginBottom:14, paddingBottom:12,
                    borderBottom: i < recurring.length - 1 ? "1px solid #F4ECDD" : "none" }}>
                    <div style={{ fontSize:12.5, color:"#2C2621", lineHeight:1.45, marginBottom:6 }}>{e.en}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
                      {(e.where || []).map((w, wi) => (
                        <span key={wi} title={w}
                          style={{ width:15, height:15, borderRadius:5, background:"#E4B061",
                            border:"1px solid #D9A24E", display:"inline-block" }} />
                      ))}
                      <span style={{ fontSize:11.5, fontWeight:800, color:"#B96524", marginLeft:4,
                        fontFamily:FONT_DISPLAY }}>{e.where.length} teams</span>
                      <span style={{ fontSize:10.5, color:"#A89C8D" }}>· avg {e.avg.toFixed(2)}</span>
                    </div>
                    <div style={{ fontSize:10.5, color:"#A89C8D", marginTop:4, lineHeight:1.5 }}>{(e.where || []).join(" · ")}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
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
      </div>

      {detail && (
        <DeptDetailModal country={detail.country} year={detail.year} deptKey={detail.deptKey}
          deptLabel={detail.deptLabel} me={authUser?.name || ""} isPCLead={isAdmin}
          onClose={() => setDetail(null)} />
      )}
      {surveysOpen && (
        <StaffSurveysModal
          countries={mergeCountries(briefAllCountries, Object.values(countryLeaders).map(l => l.country), JV_COUNTRIES)}
          runs={allRuns}
          onClose={() => setSurveysOpen(false)}
          onImport={(sv) => { setSurveysOpen(false); onImportSurveyResponses && onImportSurveyResponses(sv); }}
          generating={generating} />
      )}
      {inviteOpen && (
        <InviteLeaderModal
          countries={mergeCountries(briefAllCountries, Object.values(countryLeaders).map(l => l.country), JV_COUNTRIES)}
          leaders={countryLeaders}
          onClose={() => setInviteOpen(false)}
          onManageLeaders={() => { setInviteOpen(false); setView("leaders"); }} />
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
  setCountry2, setYear2, isAdmin, toggleAdmin, runsLoading, setSbOverrides, setStatusOverrides, setOpenToDept, authUser, onSignOut }) {

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
      if (sd2?.statusOverrides && Object.keys(sd2.statusOverrides).length && setStatusOverrides) {
        setStatusOverrides(prev => {
          const merged = { ...prev, ...sd2.statusOverrides };
          try { localStorage.setItem("pulse:statusOverrides", JSON.stringify(merged)); } catch {}
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
        {/* Back lives in the upper-left corner on every page — same spot everywhere. */}
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <button onClick={() => setView("__back__")} style={{ ...navBtn, background:"transparent", border:"1px solid #ECE2D2" }}>← Back</button>
          <div>
            <div style={{ fontSize:11, letterSpacing:3, color:"#E0863C", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Josiah Venture</div>
            <div style={{ fontFamily:FONT_DISPLAY, fontSize:24, fontWeight:600, color:"#2C2621" }}>
              {myDepts ? "Department Leader Review & Platform" : "People & Culture Platform"}
            </div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <HowToVideosButton />
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
// Every Concern / Watch question across ALL departments in one list — so a
// mostly-healthy country (all-green departments, like Hungary) still surfaces
// the specific questions worth a conversation. Toggle between the two bands,
// expand a row for its heatmap, and jump straight into the department.
// Used by both the Pulse Report and the Director Review.
function FlaggedQuestionsPanel({ depts, onOpenDept, openLabel = "Open department →", tr = (s) => s, isMobile }) {
  const flagged = [];
  for (const d of depts) for (const q of (d.questions || []))
    if (q.status === "Concern" || q.status === "Watch") flagged.push({ ...q, deptKey: d.key, deptLabel: d.label });
  const nC = flagged.filter(q => q.status === "Concern").length;
  const nW = flagged.filter(q => q.status === "Watch").length;
  const [band, setBand] = useState(nC > 0 ? "Concern" : "Watch");
  if (!flagged.length) return null;
  // Grouped by department (in the same order the report lists them), each
  // department's flagged questions together, worst score first within a group.
  const groups = [];
  for (const d of depts) {
    const qs = flagged.filter(q => q.deptKey === d.key && q.status === band)
      .sort((a, b) => (parseFloat(a.score) || 9) - (parseFloat(b.score) || 9));
    if (qs.length) groups.push({ deptKey: d.key, deptLabel: d.label, deptStatus: d.status, qs });
  }

  return (
    <div id="flagged-section" style={{ background:"white", borderRadius:16, padding: isMobile ? 16 : 24, marginBottom:32,
      border:"1px solid #ECE2D2", boxShadow:"0 2px 8px rgba(124,111,224,0.08)" }}>
      <style>{`
        details.pulse-fqrow > summary { list-style: none; cursor: pointer; }
        details.pulse-fqrow > summary::-webkit-details-marker { display: none; }
        details.pulse-fqrow > summary .pulse-fqrow-caret { transition: transform .15s; }
        details.pulse-fqrow[open] > summary .pulse-fqrow-caret { transform: rotate(90deg); }
      `}</style>
      <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap", marginBottom:4 }}>
        <span style={{ fontFamily:FONT_DISPLAY, fontSize:19, fontWeight:600, color:"#2C2621" }}>
          {tr("Concern & Watch questions")}
        </span>
        <span style={{ marginLeft:"auto", display:"flex", gap:6 }}>
          {[["Concern", nC], ["Watch", nW]].map(([s, n]) => (
            <button key={s} onClick={() => setBand(s)}
              style={{ fontSize:12, fontWeight:700, cursor:"pointer", borderRadius:20, padding:"6px 14px",
                color: band === s ? "white" : sc(s),
                background: band === s ? sc(s) : sb(s),
                border:`1px solid ${band === s ? sc(s) : sbd(s)}` }}>
              {s} · {n}
            </button>
          ))}
        </span>
      </div>
      <div style={{ fontSize:12.5, color:"#7A6F63", lineHeight:1.5, marginBottom:14 }}>
        {tr("Every question at this level, across every department — including the healthy ones.")}
      </div>
      {groups.length === 0 ? (
        <div style={{ fontSize:13, color:"#5C9A6D", fontWeight:600 }}>
          {band === "Concern" ? "No Concern questions — nothing at the most serious level." : "No Watch questions."}
        </div>
      ) : groups.map(g => (
        <div key={g.deptKey} style={{ marginBottom:14 }}>
          {/* Department header — all of a department's flagged questions live together */}
          <div style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px",
            background:sb(g.deptStatus), border:`1px solid ${sbd(g.deptStatus)}`, borderRadius:8 }}>
            <span style={{ width:8, height:8, borderRadius:"50%", background:sc(g.deptStatus), flexShrink:0 }} />
            <span style={{ fontSize:12.5, fontWeight:700, color:"#2C2621" }}>{tr(g.deptLabel)}</span>
            <span style={{ marginLeft:"auto", fontSize:11, color:"#7A6F63", fontVariantNumeric:"tabular-nums" }}>
              {g.qs.length} {g.qs.length === 1 ? "question" : "questions"}
            </span>
          </div>
          {g.qs.map((q, i) => (
            <details key={`${q.col ?? i}`} className="pulse-fqrow"
              style={{ borderTop: i === 0 ? "none" : "1px solid #F6F1E8" }}>
              <summary style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 4px" }}>
                <span style={{ fontWeight:800, color:sc(q.status), fontSize:15, width:44, flexShrink:0,
                  fontVariantNumeric:"tabular-nums", paddingTop:1 }}>{q.score}</span>
                <span style={{ flex:1, minWidth:0, fontSize:13, color:"#2C2621", lineHeight:1.5, paddingTop:1 }}>
                  {tr(q.en)}{q.burden ? <span style={{ color:"#7A6F63", fontSize:10 }}> [Burden]</span> : ""}
                </span>
                {!isMobile && (
                  <span style={{ fontSize:10, fontWeight:700, color:"#7A6F63", background:"#FBEFE4",
                    borderRadius:4, padding:"2px 6px", flexShrink:0, marginTop:3 }}>{String(q.scale || "").toUpperCase()}</span>
                )}
                <span style={{ display:"inline-flex", alignItems:"center", gap:4, fontSize:11, fontWeight:600, flexShrink:0, marginTop:1,
                  color:"#E0863C", background:"#F7E7D5", border:"0.5px solid #E0A56F", borderRadius:5, padding:"3px 9px" }}>
                  <svg className="pulse-fqrow-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#B96524"
                    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                  Heatmap
                </span>
              </summary>
              <div style={{ padding:"2px 4px 12px 54px", maxWidth:560 }}>
                <QuestionHeatmap q={q} />
                {onOpenDept && (
                  <button onClick={() => onOpenDept(q.deptKey)}
                    style={{ marginTop:8, fontSize:12, fontWeight:700, cursor:"pointer", borderRadius:7,
                      padding:"7px 13px", color:"#B96524", background:"#FBEFE4", border:"1px solid #E0A56F" }}>
                    {tr(openLabel)}
                  </button>
                )}
              </div>
            </details>
          ))}
        </div>
      ))}
    </div>
  );
}

function ReviewView({ country, year, surveyData, selections, toggleItem, setRewrite, addItem, saveSelections, saved, saveRefinement, refinements, setView, setSelections, isAdmin, toggleAdmin, sbOverrides, saveSbOverride, setSbOverrides, statusOverrides, saveStatusOverride, sbMaster, saveSbMaster, cloudLoading, syncStatus, lastSavedAt, me, saveMe, isPCLead, openToDept, setOpenToDept, toggleDeptFinished, canEditDept, authRole, authUser, onSignOut, authDepts, pendingImport, clearPendingImport, leaderName }) {
  const canEdit = (d) => (canEditDept ? canEditDept(d) : true);
  const isMobile = useIsMobile();
  const [activeDept, setActiveDept] = useState(null);
  const [deptTab, setDeptTab] = useState("review");   // "review" | "notes" — which tab of the department page
  const [showHelp, setShowHelp] = useState(false);
  const [atBusy, setAtBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);

  // The country leader's agenda — on the Meeting Notes tab the department list
  // follows THEIR order, so the meeting walks the room through the departments
  // the way the leader prioritized them. Off-agenda departments follow after,
  // in their usual order.
  const [leaderAgenda, setLeaderAgenda] = useState([]);
  useEffect(() => {
    let alive = true;
    if (!country || !year) { setLeaderAgenda([]); return; }
    loadPrep(country, year)
      .then(p => { if (alive) setLeaderAgenda([...(p.agenda || [])].sort((a, b) => (a.order || 0) - (b.order || 0))); })
      .catch(() => { if (alive) setLeaderAgenda([]); });
    return () => { alive = false; };
  }, [country, year]);

  // Apply a director-review Excel handed over from the Leadership section. The
  // parent has already opened this run, so country/year are correct here.
  const runImport = async (file) => {
    setImportMsg({ status:"working", lines:["Reading department leader review…"] });
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
      const extra = sbCount ? [`Applied ${sbCount} Survey Basics interpretation edit${sbCount===1?"":"s"} from the department leader.`] : [];
      setImportMsg({ status:"done", lines:["Imported department leader review:", ...report, ...extra] });
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

  // On Meeting Notes, the sidebar walks the country leader's agenda order:
  // agenda departments first (in the leader's priority order), everything else
  // after in the usual order. The Review tab keeps its worst-first sort.
  const agendaRank = new Map();
  leaderAgenda.forEach((a, i) => { if (a.deptKey && !agendaRank.has(a.deptKey)) agendaRank.set(a.deptKey, i); });
  const agendaOrdered = deptTab === "notes" && agendaRank.size > 0;
  const sidebarDepts = agendaOrdered
    ? [...depts].sort((a, b) => (agendaRank.has(a.key) ? agendaRank.get(a.key) : 999) - (agendaRank.has(b.key) ? agendaRank.get(b.key) : 999))
    : depts;

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
          <div style={{ fontFamily:FONT_DISPLAY, fontSize:16, fontWeight:600, color:"#2C2621", lineHeight:1.15 }}>Department Leader Review</div>
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
          {syncStatus==="saving" ? <>☁ Saving…</>
           : syncStatus==="error" ? <>⚠ Not saved yet — we’ll keep trying</>
           : lastSavedAt ? <span style={{ color:"#5C9A6D" }}>✓ Saved at {new Date(lastSavedAt).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })}</span>
           : <span style={{ color:"#A89C8D" }}>✓ All changes saved</span>}
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
          {/* All flagged questions in one place — before the department list, so a
              mostly-green country's talking points are still one click away. */}
          {(() => {
            const n = depts.reduce((a, d) => a + (d.questions || []).filter(q => q.status === "Concern" || q.status === "Watch").length, 0);
            return n > 0 && (
              <button onClick={() => setActiveDept("__flagged__")}
                style={{ display:"block", width:"100%", textAlign:"left", padding:"12px 16px",
                  background: activeDept === "__flagged__" ? "#F6F1E8" : "transparent",
                  border:"none", borderBottom:"1px solid #ECE2D2",
                  borderLeft: activeDept === "__flagged__" ? "3px solid #BE6650" : "3px solid transparent",
                  cursor:"pointer" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:12 }}>⚠</span>
                  <span style={{ color: activeDept === "__flagged__" ? "#2C2621" : "#7A6F63", fontSize:13,
                    fontWeight: activeDept === "__flagged__" ? 600 : 400 }}>Concern &amp; Watch</span>
                </div>
                <div style={{ color:"#7A6F63", fontSize:11, marginLeft:20, marginTop:2 }}>{n} questions across all departments</div>
              </button>
            );
          })()}
          {agendaOrdered && (
            <div style={{ padding:"9px 16px 5px", fontSize:10, fontWeight:800, color:"#B96524",
              textTransform:"uppercase", letterSpacing:1 }}>
              {leaderName ? `${leaderName}'s agenda order` : "Agenda order"}
            </div>
          )}
          {sidebarDepts.map(d => (
            <button key={d.key} onClick={()=>setActiveDept(d.key)}
              style={{
                display:"block", width:"100%", textAlign:"left",
                padding:"12px 16px", background: activeDept===d.key ? "#F6F1E8" : "transparent",
                border:"none", borderLeft: activeDept===d.key ? "3px solid #E0863C" : "3px solid transparent",
                cursor:"pointer",
              }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                {agendaOrdered && agendaRank.has(d.key) ? (
                  <span style={{ background:"#E0863C", color:"#fff", borderRadius:"50%", width:15, height:15,
                    display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:800, flexShrink:0 }}>
                    {agendaRank.get(d.key) + 1}
                  </span>
                ) : (
                  <span style={{ width:8, height:8, borderRadius:"50%", background:sc(d.status), flexShrink:0 }} />
                )}
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
              <option value="__flagged__">⚠ Concern &amp; Watch questions</option>
              {sidebarDepts.map(d => (
                <option key={d.key} value={d.key}>
                  {agendaOrdered && agendaRank.has(d.key) ? `${agendaRank.get(d.key) + 1}. ` : ""}{d.label} — {d.status} · {d.avg} avg
                </option>
              ))}
            </select>
          )}
          {/* The flagged-questions page — same panel the Pulse Report uses */}
          {activeDept === "__flagged__" && (
            <FlaggedQuestionsPanel depts={depts} onOpenDept={(k) => setActiveDept(k)}
              openLabel="Open review →" isMobile={isMobile} />
          )}
          {dept && (
            <div style={{ marginBottom:18, borderBottom:"1px solid #ECE2D2" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12, flexWrap:"wrap" }}>
                <span style={{ fontFamily:FONT_DISPLAY, fontSize:22, fontWeight:600, color:"#2C2621" }}>{dept.label}</span>
                <span style={{ fontSize:12, fontWeight:700, color:sc(dept.status), background:sb(dept.status), border:`1px solid ${sbd(dept.status)}`, borderRadius:20, padding:"3px 10px" }}>{dept.status}</span>
                <DeptBorderlineChooser dept={dept} canEdit={canEdit(dept.key)} saveStatusOverride={saveStatusOverride} />
                <span style={{ fontSize:12.5, color:"#7A6F63", fontVariantNumeric:"tabular-nums" }}>{dept.avg} avg · n={dept.n}</span>
                <span style={{ fontSize:12, color:"#A89C8D" }}>· {country} {year}</span>
                {/* The director marks THEIR department done here; only editable by
                    whoever owns it (or a leader). */}
                {canEdit(dept.key) && (
                  <button onClick={() => toggleDeptFinished(dept.key)}
                    style={{ marginLeft: isMobile ? 0 : "auto", fontSize:13, fontWeight:700, cursor:"pointer",
                      borderRadius:8, padding:"8px 14px", minHeight:38,
                      color: dept.reviewDone ? "#5C9A6D" : "#fff",
                      background: dept.reviewDone ? "#E9F1E9" : "#BE6650",
                      border: `1px solid ${dept.reviewDone ? "#C3DCC8" : "#BE6650"}` }}>
                    {dept.reviewDone ? "✓ Finished · Reopen" : "Click to mark finished"}
                  </button>
                )}
              </div>
              <div style={{ display:"flex", gap:4 }}>
                {["review","notes"].map(tab => (
                  <button key={tab} onClick={() => setDeptTab(tab)}
                    style={{ fontSize:13, fontWeight:600, padding:"8px 16px", border:"none", cursor:"pointer",
                      background:"transparent", color: deptTab===tab ? "#E0863C" : "#7A6F63",
                      borderBottom: deptTab===tab ? "2px solid #E0863C" : "2px solid transparent" }}>
                    {tab === "review" ? "Review" : "Meeting Notes"}
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
              statusOverrides={statusOverrides} saveStatusOverride={saveStatusOverride}
              sbMaster={sbMaster} saveSbMaster={saveSbMaster} isAdmin={isAdmin}
              me={me} saveMe={saveMe} isPCLead={isPCLead}
            />
          )}
          {dept && deptTab === "notes" && (
            <DeptMeetingNotesPage
              dept={dept} country={country} year={year}
              me={me} saveMe={saveMe} isPCLead={isPCLead}
              getApproved={(deptKey, section) =>
                (selections[deptKey]?.[section] || [])
                  .filter(i => i.include)
                  .map(i => {
                    // key = the ORIGINAL text — that's what notes are filed under
                    // in the review, even when the display text was rewritten.
                    const text = (i.rewrite || "").trim() || i.text;
                    if (section === 'quotes') return { text, key: i.text, translation: i.translation || null, isOriginalLang: !!i.isOriginalLang };
                    return { text, key: i.text };
                  })}
              sbOverrides={sbOverrides} sbMaster={sbMaster}
              leaderName={leaderName}
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
// A video with no Audience set is for everyone; otherwise it shows only to the
// audience(s) ticked on the Manage videos screen.
const videoForAudience = (v, audience) => !(v.audience || []).length || v.audience.includes(audience);

function HowToVideosPanel({ onClose, audience = "Department leaders" }) {
  const isMobile = useIsMobile();
  const [videos, setVideos] = useState(null);
  const [playing, setPlaying] = useState(null);
  useEffect(() => {
    loadHelpVideos()
      .then(vs => setVideos(vs.filter(v => (v.section || "").trim().toLowerCase() === "how to use the app" && videoForAudience(v, audience))))
      .catch(() => setVideos([]));
    // eslint-disable-next-line
  }, [audience]);
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
function HowToVideosButton({ style, audience = "Department leaders" }) {
  const [showHowTo, setShowHowTo] = useState(false);
  return (
    <>
      <button onClick={() => setShowHowTo(true)} title="How-to videos"
        style={{ ...navBtn, display:"inline-flex", alignItems:"center", gap:6, background:"white",
          border:"1px solid #ECE2D2", color:"#E0863C", fontWeight:700, ...(style||{}) }}>
        <IconHelp/> How-to videos
      </button>
      {showHowTo && <HowToVideosPanel onClose={() => setShowHowTo(false)} audience={audience} />}
    </>
  );
}

function ScoringHelpPanel({ onClose, audience = "Department leaders" }) {
  const isMobile = useIsMobile();
  const [videos, setVideos] = useState([]);
  const [playing, setPlaying] = useState(null);
  useEffect(() => { loadHelpVideos().then(setVideos).catch(() => setVideos([])); }, []);
  // A small "▶ Watch" button next to a section's title, if a video is tagged for
  // it (and for this viewer's audience). Clicking pops the video in its own
  // window — the text stays put.
  const videoFor = (s) => videos.find(v => (v.section || "").trim().toLowerCase() === s.toLowerCase() && videoForAudience(v, audience));
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
          <span style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5 }}>Four things that determine a department's status</span>
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
            desc:"If 40% or more of a department's questions score Concern, the whole department is automatically flagged as Concern — regardless of its average. It's a percentage, not a fixed count, so small departments are covered by the same rule as big ones: that's 4 of HR's 9 questions, or 2 of JV Kids' 5. An average can hide real problems: one country's HR team averaged 3.24 (normally Watch) but had 4 Concern questions, so it correctly showed Concern. This is the rule that protects against averages hiding what's actually happening." },
          { num:"4", color:"#C08636", bg:"#F7EEDC", bd:"#E3B85C",
            title:"Majority-flagged guard — mostly-flagged can't look Healthy",
            desc:"If more than half of a department's questions are Watch or Concern, the department can never show Healthy — it shows at least Watch. A couple of strong scores can pull the average just over 3.50 while most questions still need attention. In one country, Counseling had 7 of its 9 questions at Watch or Concern, yet the average squeaked to 3.50 — this rule makes it correctly show Watch." },
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
function DeptNotesTab({ dept, country, year, me, saveMe, isPCLead, sel = {} }) {
  const isMobile = useIsMobile();
  const [qNotes, setQNotes] = useState(null);   // all director notes for this run+dept
  const [openRef, setOpenRef] = useState(null); // which reference panel is open (closed by default)

  // Read-only reference to the review content, so a director can glance at the
  // questions / strengths / growth / leadership questions / quotes while in the meeting.
  const statusOrder = { Concern: 0, Watch: 1, Healthy: 2 };
  const refQuestions = [...(dept.questions || [])].sort((a, b) => (statusOrder[a.status] ?? 1) - (statusOrder[b.status] ?? 1) || a.score - b.score);
  const refItems = (key) => (sel[key] || []).filter(it => it.include).map(it => (it.rewrite && it.rewrite.trim()) ? it.rewrite.trim() : it.text).filter(Boolean);
  const REF = [
    { key: "questions", label: "Questions", n: refQuestions.length },
    { key: "strengths", label: "Strengths", n: refItems("strengths").length },
    { key: "growth", label: "Growth areas", n: refItems("growth").length },
    { key: "leadershipQs", label: "Leadership questions", n: refItems("leadershipQs").length },
    { key: "quotes", label: "Staff quotes", n: refItems("quotes").length },
  ].filter(r => r.n > 0);

  const reload = async () => {
    try { setQNotes(await loadQuestionNotes(country, year, dept.key)); }
    catch { setQNotes([]); }
  };
  useEffect(() => { setQNotes(null); reload(); /* eslint-disable-next-line */ }, [country, year, dept.key]);

  const flip = async (n) => {
    const next = n.visibility === "Public" ? "Private" : "Public";
    setQNotes(prev => prev.map(x => x.id === n.id ? { ...x, visibility: next } : x));
    try { await setQuestionNoteVisibility(n.id, next); } catch { reload(); }
  };

  // Notes the viewer can see: public ones, their own, and (for P&C leads) all.
  const visible = (qNotes || []).filter(n => (n.body || "").trim() && (n.visibility === "Public" || n.author === me || isPCLead));
  const aboutLabel = (question) => {
    const s = String(question || "");
    return s.startsWith("§") ? s.replace(/^§\s*/, "") + " (section)" : s;
  };
  const fmt = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch { return ""; } };

  const noteCard = { border: "1px solid #ECE2D2", borderRadius: 10, background: "#fff", padding: "11px 13px", marginBottom: 9 };
  const h3 = { fontFamily: FONT_DISPLAY, fontSize: 15, fontWeight: 600, color: "#2C2621", margin: "0 0 3px" };
  const subline = { fontSize: 12, color: "#7A6F63", margin: "0 0 12px", lineHeight: 1.45 };

  return (
    <div>
      {REF.length > 0 && (
        <div style={{ border: "1px solid #ECE2D2", borderRadius: 12, background: "#FDFAF4", padding: "10px 12px", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: .5, marginRight: 2 }}>Reference</span>
            {REF.map(r => (
              <button key={r.key} onClick={() => setOpenRef(openRef === r.key ? null : r.key)}
                style={{ fontSize: 12, fontWeight: 600, cursor: "pointer", borderRadius: 7, padding: "5px 11px",
                  border: "1px solid " + (openRef === r.key ? "#E0863C" : "#ECE2D2"),
                  background: openRef === r.key ? "#F7E7D5" : "#fff",
                  color: openRef === r.key ? "#B96524" : "#7A6F63" }}>
                {r.label}
              </button>
            ))}
          </div>
          {openRef && (
            <div style={{ marginTop: 10, borderTop: "1px solid #ECE2D2", paddingTop: 10, maxHeight: 320, overflowY: "auto" }}>
              {openRef === "questions"
                ? refQuestions.map((q, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid #F3EBDD", alignItems: "flex-start" }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: sc(q.status), minWidth: 34 }}>{q.score != null ? q.score.toFixed(2) : ""}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, color: sc(q.status), background: sb(q.status), border: `1px solid ${sbd(q.status)}`, borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap" }}>{q.status}</span>
                      <span style={{ fontSize: 12.5, color: "#2C2621", lineHeight: 1.45 }}>{q.en}</span>
                    </div>))
                : refItems(openRef).map((t, i) => (
                    <div key={i} style={{ fontSize: 12.5, color: "#2C2621", lineHeight: 1.45, padding: "5px 0", borderBottom: "1px solid #F3EBDD" }}>• {t}</div>))
              }
            </div>
          )}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 18, alignItems: "start" }}>
      <div>
        <div style={h3}>Department leader&apos;s notes</div>
        <div style={subline}>Every note added with the Department Leader&apos;s Note button in the review, in one place.</div>
        {qNotes === null ? <div style={{ fontSize: 12, color: "#7A6F63" }}>Loading&hellip;</div> :
          visible.length === 0 ? <div style={{ fontSize: 12.5, color: "#A89C8D", fontStyle: "italic" }}>No department leader&apos;s notes yet. Add them with the Department Leader&apos;s Note button on the Review tab.</div> :
          visible.map(n => (
            <div key={n.id} style={noteCard}>
              <div style={{ fontSize: 11, color: "#7A6F63", marginBottom: 5, lineHeight: 1.4 }}>{aboutLabel(n.question)}</div>
              <div style={{ fontSize: 13, color: "#2C2621", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{n.body}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
                <button onClick={() => flip(n)} title="Toggle who can see this"
                  style={{ fontSize: 9, fontWeight: 700, borderRadius: 4, padding: "2px 7px", cursor: "pointer", border: "1px solid",
                    ...(n.visibility === "Public" ? { color: "#5C9A6D", background: "#E9F1E9", borderColor: "#C7E0CB" } : { color: "#7A6F63", background: "#F1EAE1", borderColor: "#E4D8C8" }) }}>
                  {n.visibility === "Public" ? "Shared" : "Private"}
                </button>
                <span style={{ fontSize: 11, color: "#A89C8D" }}>{n.author}{n.created ? " · " + fmt(n.created) : ""}</span>
              </div>
            </div>
          ))}
      </div>
      <div>
        <div style={h3}>Meeting notes</div>
        <div style={subline}>Write notes as you talk through the report together in your meeting.</div>
        <NotesPanel country={country} year={year} deptKey={dept.key} deptLabel={dept.label} me={me} saveMe={saveMe} isPCLead={isPCLead} />
      </div>
      </div>
    </div>
  );
}

// ─── MEETING NOTES PAGE ───────────────────────────────────────────────────────
// A native-<details> collapsible section (everything on the meeting-notes page
// starts collapsed; the caret rotates when open).
function MnSection({ title, count, dot, children, defaultOpen = false }) {
  return (
    <details open={defaultOpen || undefined} className="pulse-mn" style={{ background:"#FFFFFF", border:"1px solid #ECE2D2",
      borderRadius:12, overflow:"hidden", marginBottom:14,
      boxShadow:"0 1px 2px rgba(58,38,22,.06), 0 6px 22px -8px rgba(58,38,22,.10)" }}>
      <summary style={{ display:"flex", alignItems:"center", gap:9, padding:"12px 14px",
        cursor:"pointer", listStyle:"none" }}>
        <svg className="pulse-mn-caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#A89C8D"
          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink:0, transition:"transform .15s" }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
        {dot && <span style={{ width:8, height:8, borderRadius:"50%", background:dot, flexShrink:0 }} />}
        <span style={{ fontSize:13, fontWeight:700, color:"#2C2621" }}>{title}</span>
        {count != null && <span style={{ marginLeft:"auto", fontSize:11, color:"#7A6F63",
          fontVariantNumeric:"tabular-nums" }}>{count}</span>}
      </summary>
      <div style={{ padding:"2px 14px 14px" }}>{children}</div>
    </details>
  );
}

// Convention: a country leader's answer to a leadership question is stored as a
// Question Note whose question field is "LQA: <the leadership question>" (written
// by the Country Leader Prep flow). The meeting-notes page surfaces them here.
const LEADER_ANSWER_PREFIX = "LQA: ";

// The Meeting Notes page, rebuilt to MIRROR the department leader review —
// same sections, same order, no deviation: Question scores, Strengths, Growth
// areas, Leadership questions, Staff quotes. Every note lives with the thing
// it's about (the country leader's notes carry the warm accent), the agenda
// sits on the right with one simple meeting-notes pad under it. Heatmaps are
// the same QuestionHeatmap the review renders — identical by construction.
function DeptMeetingNotesPage({ dept, country, year, me, saveMe, isPCLead, getApproved, sbOverrides, sbMaster, leaderName }) {
  const isMobile = useIsMobile();
  const [dNotes, setDNotes] = useState(null);   // department-level notes
  const [qNotes, setQNotes] = useState(null);   // question-level notes

  const reload = async () => {
    try { setDNotes(await loadDepartmentNotes(country, year, dept.key)); } catch { setDNotes([]); }
    try { setQNotes(await loadQuestionNotes(country, year, dept.key)); } catch { setQNotes([]); }
  };
  useEffect(() => { setDNotes(null); setQNotes(null); reload(); /* eslint-disable-next-line */ }, [country, year, dept.key]);

  // The country leader's whole prep — agenda, per-department reactions
  // (matches / what's working / where attention is needed), and the five
  // Reflect essay answers. All of it belongs in the meeting.
  const [prepData, setPrepData] = useState(null);
  useEffect(() => {
    let alive = true;
    loadPrep(country, year)
      .then(p => { if (alive) setPrepData(p); })
      .catch(() => { if (alive) setPrepData({ reactions: {}, reflections: {}, agenda: [] }); });
    return () => { alive = false; };
  }, [country, year]);
  const agenda = [...((prepData && prepData.agenda) || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const reaction = (prepData && prepData.reactions && prepData.reactions[dept.key]) || null;
  const reflections = (prepData && prepData.reflections) || {};

  const hasBody = n => (n.body || "").trim();
  const isAnswer = n => String(n.question || "").startsWith(LEADER_ANSWER_PREFIX);
  const canSee = n => n.visibility === "Public" || (me && n.author === me) || isPCLead;
  const isLeaderNote = n => !!leaderName && n.author === leaderName;
  const visQ = (qNotes || []).filter(n => hasBody(n) && canSee(n));

  // Notes attached to one question, oldest first — the conversation in order.
  const notesFor = (qText) => visQ.filter(n => !isAnswer(n) && n.question === qText)
    .sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));
  // Department-level notes: dept notes plus "§ …" question notes.
  const deptLevel = [
    ...(dNotes || []).filter(n => hasBody(n) && canSee(n)),
    ...visQ.filter(n => !isAnswer(n) && String(n.question || "").startsWith("§")),
  ].sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));
  // Leadership-question answers — ONLY the country leader's own (never anyone
  // else's public notes; that was showing Chris under David's name).
  const answers = visQ.filter(isAnswer).filter(n => !leaderName || n.author === leaderName);
  const answerFor = (qText) => answers.find(n =>
    String(n.question).slice(LEADER_ANSWER_PREFIX.length).trim() === String(qText).trim());

  const strengths    = getApproved(dept.key, "strengths");
  const growth       = getApproved(dept.key, "growth");
  const leadershipQs = getApproved(dept.key, "leadershipQs");
  const quotes       = getApproved(dept.key, "quotes");
  const questions    = dept.questions || [];
  const loading = dNotes === null || qNotes === null;
  const qWithNotes = loading ? 0 : questions.filter(q => notesFor(q.en).length > 0).length;
  const myNoteOn = (qText) => visQ.some(n => n.author === me && n.question === qText);

  const fmt = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { month:"short", day:"numeric" }); } catch { return ""; } };

  // One note card — the country leader's notes carry the warm accent so the
  // room can always tell whose voice it is.
  const NoteCard = ({ n }) => {
    const lead = isLeaderNote(n);
    return (
      <div style={{ borderRadius:10, padding:"10px 13px", marginTop:8,
        background: lead ? "#FBEFE4" : "#FDFAF4",
        border: `1px solid ${lead ? "#E0A56F" : "#ECE2D2"}` }}>
        <div style={{ fontSize:10.5, fontWeight:800, letterSpacing:.4, textTransform:"uppercase",
          color: lead ? "#B96524" : "#7A6F63", marginBottom:4 }}>
          {n.author || "Unknown"}{lead ? " — country leader" : ""}
        </div>
        <div style={{ fontSize:13, color:"#2C2621", lineHeight:1.55, whiteSpace:"pre-wrap" }}>{n.body}</div>
        {n.translation && (
          <div style={{ marginTop:6, fontSize:12, color:"#7A6F63", borderLeft:"2px solid #E2D3C2", paddingLeft:8, lineHeight:1.5, whiteSpace:"pre-wrap" }}>
            <span style={{ fontSize:9, fontWeight:800, textTransform:"uppercase", letterSpacing:.5, marginRight:6 }}>English (AI)</span>{n.translation}
          </div>
        )}
        {n.created && <div style={{ fontSize:10.5, color:"#A89C8D", marginTop:5 }}>{fmt(n.created)}</div>}
      </div>
    );
  };
  const bulletRow = { display:"flex", gap:9, alignItems:"flex-start", fontSize:13, lineHeight:1.55, color:"#2C2621", marginBottom:7 };
  const BulletDot = ({ color }) => <span style={{ width:7, height:7, borderRadius:"50%", background:color, marginTop:6, flexShrink:0 }} />;

  // The country leader's prep text (what's working / attention / reflect
  // answers) rendered like their notes — warm accent, English copy when the
  // original isn't in English.
  const PrepCard = ({ body, en, prompt }) => !String(body || "").trim() ? null : (
    <div style={{ borderRadius:10, padding:"10px 13px", marginTop:8, background:"#FBEFE4", border:"1px solid #E0A56F" }}>
      <div style={{ fontSize:10.5, fontWeight:800, letterSpacing:.4, textTransform:"uppercase", color:"#B96524", marginBottom:4 }}>
        {leaderName || "Country leader"} — country leader
      </div>
      {prompt && <div style={{ fontSize:12, color:"#7A6F63", fontStyle:"italic", marginBottom:4, lineHeight:1.5 }}>{prompt}</div>}
      <div style={{ fontSize:13, color:"#2C2621", lineHeight:1.55, whiteSpace:"pre-wrap" }}>{body}</div>
      {String(en || "").trim() && (
        <div style={{ marginTop:6, fontSize:12, color:"#7A6F63", borderLeft:"2px solid #E2D3C2", paddingLeft:8, lineHeight:1.5, whiteSpace:"pre-wrap" }}>
          <span style={{ fontSize:9, fontWeight:800, textTransform:"uppercase", letterSpacing:.5, marginRight:6 }}>English (AI)</span>{en}
        </div>
      )}
    </div>
  );

  // One approved line (strength / growth area / leadership question / quote)
  // with everything filed under it in the review: notes keyed by the line's
  // ORIGINAL text, plus the same compact note button the review offers.
  const ItemWithNotes = ({ item, dotColor, quote }) => {
    const itemNotes = loading ? [] : notesFor(item.key).concat(item.key !== item.text ? notesFor(item.text) : []);
    return (
      <div style={{ marginBottom:10 }}>
        {quote ? (
          <div style={{ fontSize:13, lineHeight:1.6, color:"#5A4A3B", background:"#FDFAF4",
            borderLeft:"3px solid #E2D3C2", borderRadius:"0 9px 9px 0", padding:"9px 13px", fontStyle:"italic" }}>
            "{item.text}"
            {item.translation && <div style={{ fontStyle:"normal", fontSize:12, color:"#7A6F63", marginTop:5 }}>{item.translation}</div>}
          </div>
        ) : (
          <div style={{ ...bulletRow, marginBottom:0 }}><BulletDot color={dotColor} />{item.text}</div>
        )}
        {itemNotes.map(n => <NoteCard key={n.id} n={n} />)}
        <div className="no-print" style={{ marginTop:6, marginLeft: quote ? 0 : 16 }}>
          <DirectorNoteButton country={country} year={year} deptKey={dept.key} question={item.key}
            label={item.text} me={me} hasNote={myNoteOn(item.key)} onSaved={reload} compact />
        </div>
      </div>
    );
  };

  return (
    <div>
      <style>{`
        details.pulse-mn > summary::-webkit-details-marker { display: none; }
        details.pulse-mn[open] > summary .pulse-mn-caret { transform: rotate(90deg); }
        details.pulse-mnq > summary::-webkit-details-marker { display: none; }
        details.pulse-mnq[open] > summary .pulse-mn-caret { transform: rotate(90deg); }
      `}</style>
      <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1.6fr 1fr", gap:16, alignItems:"start" }}>

        {/* ── LEFT: the department's story, in the SAME order as the review ── */}
        <div>
          {/* The country leader's reaction to this department, right up top. */}
          {reaction && reaction.choice && (
            <div style={{ background:"#FBEFE4", border:"1px solid #E0A56F", borderRadius:12, padding:"10px 14px",
              marginBottom:14, fontSize:13, color:"#2C2621", lineHeight:1.55 }}>
              <b style={{ color:"#B96524" }}>{leaderName || "Country leader"}:</b>{" "}
              "{reaction.choice}" — does this department's survey match what they're seeing or experiencing.
            </div>
          )}

          {/* 1. Question scores */}
          <MnSection title="Question scores" dot="#E0863C" defaultOpen
            count={loading ? "…" : `${questions.length} questions${qWithNotes ? ` · ${qWithNotes} with notes` : ""}`}>
            {questions.map((q, qi) => {
              const notesHere = loading ? [] : notesFor(q.en);
              return (
                <details key={qi} className="pulse-mnq" style={{ borderTop:"1px solid #F8F2E8" }}>
                  <summary style={{ display:"flex", alignItems:"center", gap:9, padding:"10px 2px", cursor:"pointer", listStyle:"none" }}>
                    <svg className="pulse-mn-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A89C8D"
                      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, transition:"transform .15s" }}>
                      <path d="M9 6l6 6-6 6" /></svg>
                    <span style={{ flex:1, fontSize:13.5, lineHeight:1.45, color:"#2C2621" }}>{q.en}</span>
                    {notesHere.length > 0 && (
                      <span style={{ fontSize:10.5, fontWeight:700, color:"#B96524", background:"#FBEFE4", border:"1px solid #E0A56F", borderRadius:10, padding:"1px 8px", whiteSpace:"nowrap" }}>
                        {notesHere.length} note{notesHere.length === 1 ? "" : "s"}
                      </span>
                    )}
                    <span style={{ fontSize:12, fontWeight:800, borderRadius:7, padding:"2px 9px", whiteSpace:"nowrap", fontVariantNumeric:"tabular-nums",
                      color:sc(q.status), background:sb(q.status), border:`1px solid ${sbd(q.status)}` }}>
                      {q.score != null ? Number(q.score).toFixed(2) : "—"}
                    </span>
                  </summary>
                  <div style={{ padding:"4px 2px 14px 21px" }}>
                    <QuestionHeatmap q={q} />
                    {/* The question NEVER appears without its Survey Basics — same
                        text and precedence as the review (master → override → built-in). */}
                    {(() => {
                      const sbMatch = findSurveyBasics(dept.key, q.en);
                      if (!sbMatch) return null;
                      const level = q.status === "Healthy" ? "high" : q.status === "Watch" ? "mid" : "low";
                      const sbKey = SB_KEY[dept.key] || String(dept.key || "").toLowerCase();
                      const masterText = sbMaster?.[`${sbKey}:${normQ(q.en)}:${level}`];
                      const override = sbOverrides?.[`${country}:${year}:${dept.key}:${normQ(q.en)}`];
                      const sbText = masterText || override || sbMatch[level];
                      if (!sbText) return null;
                      return (
                        <div style={{ display:"flex", alignItems:"flex-start", gap:6,
                          background:"#F6F1E8", borderRadius:5, padding:"5px 8px", marginTop:8 }}>
                          <span style={{ fontSize:9, fontWeight:700, color:"#7A6F63",
                            textTransform:"uppercase", letterSpacing:.5, whiteSpace:"nowrap", paddingTop:1, flexShrink:0 }}>Survey Basics</span>
                          <span style={{ fontSize:11, color:"#2C2621", fontStyle:"italic", lineHeight:1.4, flex:1 }}>{sbText}</span>
                        </div>
                      );
                    })()}
                    {notesHere.map(n => <NoteCard key={n.id} n={n} />)}
                    <div className="no-print" style={{ marginTop:10 }}>
                      <DirectorNoteButton country={country} year={year} deptKey={dept.key} question={q.en}
                        label={q.en} me={me} hasNote={myNoteOn(q.en)} onSaved={reload} btnLabel="+ Add a note" />
                    </div>
                  </div>
                </details>
              );
            })}
          </MnSection>

          {/* 2. Strengths — plus the country leader's "What's working" note */}
          <MnSection title="Strengths" dot="#5C9A6D" count={`${strengths.length}`}>
            {strengths.length ? strengths.map((item, i) => (
              <ItemWithNotes key={i} item={item} dotColor="#5C9A6D" />
            )) : <div style={{ fontSize:12.5, color:"#A89C8D", fontStyle:"italic" }}>Nothing approved for this department yet.</div>}
            {reaction && <PrepCard body={reaction.noteWorking} en={reaction.noteWorkingEn} prompt="Their notes on what's working:" />}
          </MnSection>

          {/* 3. Growth areas — plus the country leader's "Where attention is needed" note */}
          <MnSection title="Growth areas" dot="#C08636" count={`${growth.length}`}>
            {growth.length ? growth.map((item, i) => (
              <ItemWithNotes key={i} item={item} dotColor="#BE6650" />
            )) : <div style={{ fontSize:12.5, color:"#A89C8D", fontStyle:"italic" }}>Nothing approved for this department yet.</div>}
            {reaction && <PrepCard body={reaction.noteAttention} en={reaction.noteAttentionEn} prompt="Their notes on where attention is needed:" />}
          </MnSection>

          {/* 4. Leadership questions — ONLY the country leader's answers */}
          <MnSection title="Leadership questions" dot="#B96524"
            count={loading ? "…" : (answers.length ? `${answers.length} answered` : `${leadershipQs.length}`)}>
            {leadershipQs.length === 0 && answers.length === 0 ? (
              <div style={{ fontSize:12.5, color:"#A89C8D", fontStyle:"italic" }}>No leadership questions selected for this department.</div>
            ) : (
              <>
                {leadershipQs.map((item, i) => {
                  const a = answerFor(item.text) || answerFor(item.key);
                  const itemNotes = loading ? [] : notesFor(item.key).concat(item.key !== item.text ? notesFor(item.text) : []);
                  return (
                    <div key={i} style={{ marginBottom:12 }}>
                      <div style={{ fontSize:13, fontWeight:650, color:"#2C2621", lineHeight:1.5 }}>{item.text}</div>
                      {a ? <NoteCard n={a} /> : (
                        <div style={{ fontSize:12, color:"#A89C8D", fontStyle:"italic", marginTop:4 }}>
                          {leaderName || "The country leader"} hasn't answered this one yet.
                        </div>
                      )}
                      {itemNotes.map(n => <NoteCard key={n.id} n={n} />)}
                      <div className="no-print" style={{ marginTop:6 }}>
                        <DirectorNoteButton country={country} year={year} deptKey={dept.key} question={item.key}
                          label={item.text} me={me} hasNote={myNoteOn(item.key)} onSaved={reload} compact />
                      </div>
                    </div>
                  );
                })}
                {answers.filter(a => !leadershipQs.some(item => {
                  const q = String(a.question).slice(LEADER_ANSWER_PREFIX.length).trim();
                  return q === String(item.text).trim() || q === String(item.key).trim();
                })).map(a => (
                  <div key={a.id} style={{ marginBottom:12 }}>
                    <div style={{ fontSize:13, fontWeight:650, color:"#2C2621", lineHeight:1.5 }}>
                      {String(a.question).slice(LEADER_ANSWER_PREFIX.length)}
                    </div>
                    <NoteCard n={a} />
                  </div>
                ))}
              </>
            )}
          </MnSection>

          {/* 5. Staff quotes */}
          <MnSection title="Staff quotes" dot="#7A6F63" count={`${quotes.length}`}>
            {quotes.length ? quotes.map((item, i) => (
              <ItemWithNotes key={i} item={item} quote />
            )) : <div style={{ fontSize:12.5, color:"#A89C8D", fontStyle:"italic" }}>No quotes approved for this department.</div>}
          </MnSection>

          {/* Notes about this department as a whole (either leader) */}
          {!loading && deptLevel.length > 0 && (
            <MnSection title="Notes about this department" dot="#E0863C" count={`${deptLevel.length}`}>
              {deptLevel.map(n => <NoteCard key={n.id} n={n} />)}
            </MnSection>
          )}
        </div>

        {/* ── RIGHT: agenda, then Reflect, then the meeting-notes pad ── */}
        <div>
          <MnSection title="Meeting agenda" dot="#E0863C" count={`${agenda.length}`} defaultOpen>
              <div style={{ fontSize:11.5, color:"#7A6F63", marginBottom:8 }}>
                What {leaderName || "the country leader"} wants to walk through — most important first.
              </div>
              {agenda.length === 0 && (
                <div style={{ fontSize:12.5, color:"#A89C8D", fontStyle:"italic" }}>
                  Nothing on the agenda yet — {leaderName || "the country leader"} adds departments with the
                  "+ Agenda" button while preparing.
                </div>
              )}
              {agenda.map((a, i) => {
                const here = a.deptKey === dept.key;
                const leadNote = isPCLead && prepData && prepData.leaderNotes && prepData.leaderNotes[a.id];
                return (
                  <div key={a.id || i} style={{ padding:"6px 8px", borderRadius:8, marginBottom:4,
                    background: here ? "#FBEFE4" : "transparent",
                    border: here ? "1px solid #E0A56F" : "1px solid transparent" }}>
                    <div style={{ display:"flex", gap:8, alignItems:"flex-start" }}>
                      <span style={{ background:"#E0863C", color:"white", borderRadius:"50%", width:18, height:18,
                        display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, flexShrink:0 }}>{i + 1}</span>
                      <span style={{ flex:1, fontSize:12.5, color:"#2C2621", fontWeight: here ? 700 : 500, lineHeight:1.45 }}>
                        {a.label}{here && <span style={{ color:"#B96524", fontSize:10.5, fontWeight:700 }}> · this department</span>}
                      </span>
                    </div>
                    {/* P&C's leading note — the server never sends this field to anyone else */}
                    {leadNote && (
                      <div style={{ margin:"5px 0 0 26px", fontSize:11.5, color:"#8A5A2B", background:"#FBEFE4",
                        border:"1px dashed #E0A56F", borderRadius:7, padding:"5px 9px", lineHeight:1.5 }}>
                        <span style={{ fontSize:8.5, fontWeight:800, textTransform:"uppercase", letterSpacing:.5, marginRight:5 }}>P&C leading note</span>
                        {leadNote}
                      </div>
                    )}
                  </div>
                );
              })}
          </MnSection>

          {/* Reflect — the country leader's five essay answers for this meeting */}
          {REFLECT_QS.some(qd => String(reflections[qd.key] || "").trim()) && (
            <MnSection title="Reflect" dot="#B96524"
              count={`${REFLECT_QS.filter(qd => String(reflections[qd.key] || "").trim()).length} of ${REFLECT_QS.length} answered`} defaultOpen>
              <div style={{ fontSize:11.5, color:"#7A6F63", marginBottom:8 }}>
                {leaderName || "The country leader"}'s reflections on the whole report, written while preparing.
              </div>
              {REFLECT_QS.map(qd => String(reflections[qd.key] || "").trim() ? (
                <div key={qd.key} style={{ marginBottom:10 }}>
                  <div style={{ fontSize:11, fontWeight:800, letterSpacing:.5, textTransform:"uppercase", color:"#B96524" }}>{qd.label}</div>
                  <div style={{ fontSize:12, color:"#7A6F63", fontStyle:"italic", lineHeight:1.5, margin:"2px 0 4px" }}>{qd.prompt}</div>
                  <div style={{ fontSize:13, color:"#2C2621", lineHeight:1.55, whiteSpace:"pre-wrap" }}>{reflections[qd.key]}</div>
                  {String(reflections[qd.key + "En"] || "").trim() && (
                    <div style={{ marginTop:4, fontSize:12, color:"#7A6F63", borderLeft:"2px solid #E2D3C2", paddingLeft:8, lineHeight:1.5, whiteSpace:"pre-wrap" }}>
                      <span style={{ fontSize:9, fontWeight:800, textTransform:"uppercase", letterSpacing:.5, marginRight:6 }}>English (AI)</span>{reflections[qd.key + "En"]}
                    </div>
                  )}
                </div>
              ) : null)}
            </MnSection>
          )}

          <MnSection title="Meeting notes" dot="#5C9A6D" defaultOpen>
            <div style={{ fontSize:11.5, color:"#7A6F63", marginBottom:8 }}>
              Just write — decisions, follow-ups, anything worth remembering. Every note saves with your name and today's date.
            </div>
            <NotesPanel country={country} year={year} deptKey={dept.key} deptLabel={dept.label}
              me={me} saveMe={saveMe} isPCLead={isPCLead} meetingMode />
          </MnSection>
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
    .sort((a, b) => periodCmp(b.year, a.year))[0];
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

// meetingMode (the Meeting Notes page): no privacy choice — every note is
// always shared with the People & Culture team (author + P&C see it; the
// country leader doesn't). The pad is already per-department, so what's
// written on Singles is for Singles.
function NotesPanel({ country, year, deptKey, deptLabel, me, saveMe, isPCLead, meetingMode = false }) {
  // Privacy reminder dismissal — keyed by pulse report (country+period), so it
  // greets people once each pulse and then stays out of the way.
  const privacyKey = `pulse:notesPrivacySeen:${country}:${year}`;
  const [privacySeen, setPrivacySeen] = useState(() => {
    try { return localStorage.getItem(privacyKey) === "1"; } catch { return false; }
  });
  const dismissPrivacy = () => {
    setPrivacySeen(true);
    try { localStorage.setItem(privacyKey, "1"); } catch {}
  };
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
      // Meeting notes are always for the P&C team: stored "Private", which the
      // app serves to the author + P&C only — never the country leader.
      await addDepartmentNote({ country, year, deptKey, author: me,
        title: draft.trim().split("\n")[0].slice(0, 80), body: draft.trim(),
        visibility: meetingMode ? "Private" : visibility });
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
        {/* The privacy reminder shows once per pulse report — the ✕ tucks it
            away on this device until the next pulse comes around. */}
        {!privacySeen && (
          <div style={{ fontSize: 12, color: "#7A6F63", background:"#FDFAF4", border:"1px solid #FDFAF4",
            borderRadius:8, padding:"8px 12px", marginBottom:14, lineHeight:1.5, display:"flex", gap:10, alignItems:"flex-start" }}>
            <span style={{ flex:1 }}>
              {meetingMode ? (
                <>Notes here go to the <b>People &amp; Culture team</b> — you and P&amp;C see them; the country
                leader doesn't. After the meetings, P&amp;C gathers what everyone wrote for each department.</>
              ) : (
                <>Every note is <b>Private by default</b> — only you & P&C leadership (Mel &amp; Chris) see it.
                Set a note to <b>Shared</b> to let the team &amp; country leadership see that one. Each note is
                its own choice, and you can change any note anytime with its tag.</>
              )}
            </span>
            <button onClick={dismissPrivacy} title="Got it — hide until the next pulse report"
              style={{ background:"none", border:"none", cursor:"pointer", color:"#A89C8D", fontSize:15, lineHeight:1, padding:"0 2px", flexShrink:0 }}>✕</button>
          </div>
        )}
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
          {meetingMode ? (
            <span style={{ fontSize: 11, fontWeight: 700, color: "#5C9A6D", background: "#E9F1E9",
              border: "1px solid #C7E0CB", borderRadius: 6, padding: "3px 10px" }}>
              Shared with the People &amp; Culture team
            </span>
          ) : (
            <VisibilityPicker value={visibility} onChange={setVisibility} isMobile={isMobile} />
          )}
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
                {meetingMode ? (
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#5C9A6D", background: "#E9F1E9",
                    border: "1px solid #C7E0CB", borderRadius: 5, padding: "2px 7px" }}>P&amp;C team</span>
                ) : (
                  <VisibilityChip visibility={n.visibility} onClick={() => flip(n)} />
                )}
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

// Borderline band chooser for a near-boundary question (shown in the review only).
// Offers the two adjacent bands with the current one selected; picking the auto
// band clears the override. Returns null when the question isn't borderline.
function BorderlineChooser({ q, deptKey, canEdit, saveStatusOverride }) {
  const bl = borderlineOptions(q);
  if (!bl) return null;
  const overridden = q.status !== q.autoStatus;
  return (
    <span className="no-print" style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: .4 }}>Borderline</span>
      {bl.options.map(band => {
        const on = q.status === band;
        return (
          <button key={band} disabled={!canEdit}
            onClick={() => canEdit && saveStatusOverride && saveStatusOverride(deptKey, q.en, band === q.autoStatus ? null : band)}
            style={{ fontSize: 10.5, fontWeight: 700, cursor: canEdit ? "pointer" : "default", borderRadius: 5, padding: "3px 9px",
              border: "1px solid " + (on ? sbd(band) : "#ECE2D2"), background: on ? sb(band) : "#fff", color: on ? sc(band) : "#7A6F63" }}>
            {band}
          </button>
        );
      })}
      {overridden && <span style={{ fontSize: 10, color: "#9C8F82", fontStyle: "italic" }}>· you set this</span>}
    </span>
  );
}

// The department-level bubble: when the whole department's average sits near a
// band line, offer the two adjacent bands next to its status pill in the review.
function DeptBorderlineChooser({ dept, canEdit, saveStatusOverride }) {
  const scores = (dept.questions || []).map(q => q.score).filter(Boolean);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const auto = dept.autoStatus || dept.status;
  const bl = deptBorderlineOptions(avg, auto);
  if (!bl) return null;
  const overridden = dept.status !== auto;
  return (
    <span className="no-print" style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: .4 }}>Borderline dept</span>
      {bl.options.map(band => {
        const on = dept.status === band;
        return (
          <button key={band} disabled={!canEdit}
            onClick={() => canEdit && saveStatusOverride && saveStatusOverride(dept.key, DEPT_OVERRIDE_KEY, band === auto ? null : band)}
            style={{ fontSize: 10.5, fontWeight: 700, cursor: canEdit ? "pointer" : "default", borderRadius: 5, padding: "3px 9px",
              border: "1px solid " + (on ? sbd(band) : "#ECE2D2"), background: on ? sb(band) : "#fff", color: on ? sc(band) : "#7A6F63" }}>
            {band}
          </button>
        );
      })}
      {overridden && <span style={{ fontSize: 10, color: "#9C8F82", fontStyle: "italic" }}>· you set this</span>}
    </span>
  );
}

// A small "Director's Note" button that opens a popup to write a note about one
// question or review item. The note autosaves as you type (no save button) into
// the existing Question Notes store — one note per item, updated in place.
// forcePublic: country leaders don't get a Private option — everything they
// write on their report is shared with the People & Culture team, and the
// dialog says so instead of offering the toggle.
function DirectorNoteButton({ country, year, deptKey, question, label, me, hasNote, onSaved, compact, btnLabel = "Department Leader's Note", forcePublic = false }) {
  const [open, setOpen] = useState(false);
  const [noteId, setNoteId] = useState(null);
  const [text, setText] = useState("");
  const [vis, setVis] = useState(forcePublic ? "Public" : "Private");
  const [saved, setSaved] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [saveErr, setSaveErr] = useState(false);
  const timer = useRef(null);

  const openModal = async () => {
    setOpen(true); setSaved(false); setSavedAt(null); setSaveErr(false);
    try {
      const all = await loadQuestionNotes(country, year, deptKey);   // this run's dept notes
      const mine = (all || []).find(n => n.question === question && n.author === me)
                || (all || []).find(n => n.question === question);
      if (mine) { setNoteId(mine.id); setText(mine.body || ""); setVis(forcePublic ? "Public" : (mine.visibility || "Private")); }
      else { setNoteId(null); setText(""); setVis(forcePublic ? "Public" : "Private"); }
    } catch { setNoteId(null); setText(""); }
  };
  const persist = async (t, v) => {
    if (!t.trim()) return;
    try {
      const effVis = forcePublic ? "Public" : v;
      if (!noteId) { const id = await addQuestionNote({ country, year, deptKey, question, author: me, body: t, visibility: effVis }); if (id) setNoteId(id); }
      else { await updateQuestionNote(noteId, { body: t, visibility: effVis }); }
      setSaved(true); setSavedAt(Date.now()); setSaveErr(false); onSaved && onSaved();
    } catch { setSaveErr(true); /* keep what's typed */ }
  };
  const onType = (v) => { setText(v); setSaved(false); setSaveErr(false); clearTimeout(timer.current); timer.current = setTimeout(() => persist(v, vis), 500); };
  const setVisibility = (v) => { setVis(v); persist(text, v); };
  const close = () => { clearTimeout(timer.current); if (text.trim() && !saved) persist(text, vis); setOpen(false); };

  const bstyle = { fontSize: compact ? 10 : 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
    borderRadius: 5, padding: compact ? "3px 8px" : "4px 10px", display: "inline-flex", alignItems: "center", gap: 4,
    color: hasNote ? "#5C9A6D" : "#E0863C", background: hasNote ? "#E9F1E9" : "#F7E7D5", border: "0.5px solid " + (hasNote ? "#C7E0CB" : "#E0A56F") };

  return (<>
    <button onClick={openModal} style={bstyle}>{hasNote ? "✓" : "✎"} {btnLabel}</button>
    {open && (
      <div onClick={e => { if (e.target === e.currentTarget) close(); }}
        style={{ position: "fixed", inset: 0, background: "rgba(44,38,33,.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ background: "#fff", borderRadius: 14, width: "min(560px,100%)", boxShadow: "0 24px 60px rgba(44,38,33,.35)", overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 12, padding: "14px 16px", borderBottom: "1px solid #ECE2D2", background: "#FDFAF4" }}>
            <div><div style={{ fontSize: 10, fontWeight: 700, letterSpacing: .5, textTransform: "uppercase", color: "#E0863C", marginBottom: 3 }}>{btnLabel}</div>
              <div style={{ fontSize: 13, lineHeight: 1.45, color: "#2C2621" }}>{label || question}</div></div>
            <button onClick={close} aria-label="Close" style={{ marginLeft: "auto", border: "none", background: "none", fontSize: 18, color: "#7A6F63", cursor: "pointer", lineHeight: 1 }}>✕</button>
          </div>
          <div style={{ padding: "14px 16px" }}>
            <textarea autoFocus value={text} onChange={e => onType(e.target.value)} placeholder="Type your note here — it saves automatically."
              style={{ width: "100%", minHeight: 120, border: "1px solid #F0DFCE", borderRadius: 8, padding: "10px 12px", fontSize: 13.5, fontFamily: "inherit", color: "#2C2621", lineHeight: 1.55, resize: "vertical", boxSizing: "border-box" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {forcePublic ? (
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#5C9A6D", background: "#E9F1E9",
                  border: "1px solid #C7E0CB", borderRadius: 6, padding: "6px 11px" }}>
                  All of your notes are shared with the People &amp; Culture team
                </span>
              ) : (
              <div style={{ display: "flex", gap: 4 }}>
                {["Private", "Public"].map(v => (
                  <button key={v} onClick={() => setVisibility(v)} style={{ fontSize: 11.5, fontWeight: 600, borderRadius: 6, padding: "6px 11px", cursor: "pointer",
                    border: "1px solid " + (vis === v ? "#2C2621" : "#ECE2D2"), background: vis === v ? "#2C2621" : "#fff", color: vis === v ? "#fff" : "#7A6F63" }}>
                    {v === "Private" ? "Private to me" : "Share with team"}</button>
                ))}
              </div>
              )}
              <span style={{ fontSize: 11, fontWeight: 600 }}>
                {saveErr ? <span style={{ color: "#BE6650" }}>⚠ Not saved — check connection</span>
                 : savedAt ? <span style={{ color: "#5C9A6D" }}>✓ Saved at {new Date(savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                 : null}
              </span>
              <button onClick={close} style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "#7A6F63", background: "transparent", border: "1px solid #ECE2D2", borderRadius: 7, padding: "6px 12px", cursor: "pointer" }}>Done</button>
            </div>
          </div>
        </div>
      </div>
    )}
  </>);
}

function DeptReviewPanel({ dept, sel, toggleItem, setRewrite, addItem, saveRefinement, refinements, country, year, canEdit = true, sbOverrides, saveSbOverride, statusOverrides, saveStatusOverride, sbMaster, saveSbMaster, isAdmin, me, saveMe, isPCLead }) {
  const [noted, setNoted] = useState({});
  const reloadNoted = async () => {
    try {
      const all = await loadQuestionNotes(country, year, dept.key);
      const m = {}; (all || []).forEach(n => { if ((n.body || "").trim()) m[n.question] = true; });
      setNoted(m);
    } catch { /* offline */ }
  };
  useEffect(() => { reloadNoted(); /* eslint-disable-next-line */ }, [country, year, dept.key]);
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
                        <span style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", justifyContent:"flex-end" }}>
                          <BorderlineChooser q={q} deptKey={dept.key} canEdit={canEdit} saveStatusOverride={saveStatusOverride} />
                          <DirectorNoteButton country={country} year={year} deptKey={dept.key} question={q.en} label={q.en} me={me} hasNote={!!noted[q.en]} onSaved={reloadNoted} compact />
                          <button onClick={() => setOpenHeatmap(openHeatmap===i ? null : i)}
                            style={{ fontSize:11, fontWeight:600, color:"#E0863C",
                              background:"#F7E7D5", border:"0.5px solid #E0A56F", borderRadius:5,
                              padding:"3px 10px", cursor:"pointer" }}>
                            {openHeatmap===i ? "Close" : "Heatmap"}
                          </button>
                        </span>
                      </div>
                    )}
                    <div style={{ fontSize:12, color:"#2C2621", lineHeight:1.5, marginBottom:6 }}>
                      {q.en}{q.burden && !isMobile ? <span style={{ color:"#C08636", fontSize:10, marginLeft:4 }}>[Burden]</span> : ""}
                    </div>
                    {!isMobile && (
                      <div className="no-print" style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginTop:2 }}>
                        <BorderlineChooser q={q} deptKey={dept.key} canEdit={canEdit} saveStatusOverride={saveStatusOverride} />
                        <DirectorNoteButton country={country} year={year} deptKey={dept.key} question={q.en} label={q.en} me={me} hasNote={!!noted[q.en]} onSaved={reloadNoted} compact />
                      </div>
                    )}

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
                  {/* Heatmap cells — the shared renderer (desktop only; mobile uses popup) */}
                  {!isMobile && (
                  <div style={{ padding:"8px 10px" }}>
                    <QuestionHeatmap q={q} showMeta={false} />
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
                  <DirectorNoteButton country={country} year={year} deptKey={dept.key} question={item.text} label={item.rewrite?.trim() || item.text} me={me} hasNote={!!noted[item.text]} onSaved={reloadNoted} compact />
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

// ─── COUNTRY LEADER PREP (Priority 4) ─────────────────────────────────────────
// The five standing reflection questions — identical for every country.
const REFLECT_QS = [
  { key: "celebrate", label: "Celebrate",       prompt: "Based on your healthy departments, is there anything that you and your team are doing that helps create and sustain this health? If so, what is it?" },
  { key: "evaluate",  label: "Evaluate",        prompt: "Where are you most concerned — and does this report match what daily life actually looks like?" },
  { key: "honest",    label: "Be honest",       prompt: "What have you tried this year that hasn't moved the needle?" },
  { key: "help",      label: "Ask for help",    prompt: "What's the real leadership work in front of you this year — and what do you need from us?" },
  { key: "improve",   label: "Help us improve", prompt: "How was the survey experience for your team this cycle — and is there anything we could change to make it clearer, easier, or more valuable next time?" },
];

// ── Report language flip ──
// The disclaimer shown whenever the report is being read in translation, and
// the fixed UI strings the flip translates (headings + prep prompts). The
// report's CONTENT strings are gathered per department at flip time.
const TR_DISCLAIMER = "This is an automatic AI translation and may contain mistakes — the English report is the original.";
const TR_UI_STRINGS = () => [
  TR_DISCLAIMER,
  "What's working", "Where attention is needed", "Question scores",
  "Questions for leadership", "What staff said",
  "As you read over this department's survey information, do you feel like it matches what you're seeing or experiencing?", "Yes, this matches", "Partly", "This doesn't match",
  "+ Agenda", "✓ On agenda", "Adds this department to your Pulse meeting agenda.",
  "Department Scores", "(Click on a department to see more details.)",
  "Concern & Watch questions", "Every question at this level, across every department — including the healthy ones.",
  "Open department →", "How scoring works",
  "Prepare for your Pulse meeting", "✓ You've finished your part — thank you!", "Close department",
  "Prepare for your pulse meeting", "Meeting agenda — most important first", " (drag to reorder)", "Reflect",
  "Your notes on what's working — saves when you click away, and goes to People & Culture with your prep.",
  "Your notes on where attention is needed — saves when you click away, and goes to People & Culture with your prep.",
  "Your answer for the team — saves when you click away, and appears in this department's Meeting Notes.",
  "Write your answer — it saves when you click away.",
  "✓ I've finished my part of the Pulse report",
  "Required before your pulse meeting — this sends your agenda, notes, question answers, and reflections to People & Culture.",
  "Work through each department above — say whether the survey matches what you're seeing or experiencing, jot your notes under What's working and Where attention is needed, answer the leadership questions, and add the departments you want to discuss to the agenda. Then finish the reflections below and click the finish button.",
  ...REFLECT_QS.flatMap(q => [q.label, q.prompt]),
];

// The prep standing sections at the bottom of the country report: the meeting
// agenda (drag to reorder, most important first), the five reflections, and the
// required "Mark prep ready" gate. edit = the country leader; view = P&C reading
// the same prep once it exists.
function PrepFooter({ mode, prep, savePrepPatch, depts, country, isMobile, tr = (s) => s }) {
  const edit = mode === "edit";
  const agenda = [...(prep.agenda || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const [dragIdx, setDragIdx] = useState(null);
  const [refl, setRefl] = useState(prep.reflections || {});
  const reorder = (from, to) => {
    if (from == null || to == null || from === to) return;
    const next = [...agenda];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    savePrepPatch({ agenda: next.map((a, i) => ({ ...a, order: i })) });
  };
  const reacted = depts.filter(d => ((prep.reactions || {})[d.key] || {}).choice).length;
  const reflDone = REFLECT_QS.filter(q => ((edit ? refl : (prep.reflections || {}))[q.key] || "").trim()).length;
  // Save the reflections (merged over what's stored, so the English copies below
  // survive), then keep a best-effort English copy of each non-English answer —
  // stored as "<key>En" in the same blob — so P&C reads them without a dictionary.
  const saveRefl = () => {
    const old = prep.reflections || {};
    savePrepPatch({ reflections: { ...old, ...refl } });
    REFLECT_QS.forEach(qd => {
      const txt = String(refl[qd.key] || "").trim();
      const unchanged = txt === String(old[qd.key] || "").trim();
      if (txt && looksNonEnglish(txt)) {
        if (unchanged && (old[qd.key + "En"] || "").trim()) return;   // already translated
        translateToEnglish(txt).then(en => {
          if (en) savePrepPatch({ reflections: { ...(prep.reflections || {}), ...refl, [qd.key + "En"]: en } });
        }).catch(() => {});
      } else if ((old[qd.key + "En"] || "").trim()) {
        savePrepPatch({ reflections: { ...(prep.reflections || {}), ...refl, [qd.key + "En"]: "" } });
      }
    });
  };
  const deptLabel = (k) => (depts.find(d => d.key === k) || {}).label || k;

  const secTitle = { fontSize: 11, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: 2, marginBottom: 12 };
  const chip = (ok, text) => (
    <span style={{ fontSize: 11, fontWeight: 700, color: ok ? "#5C9A6D" : "#C08636",
      background: ok ? "#E9F1E9" : "#F7EEDC", border: `1px solid ${ok ? "#C7E0CB" : "#E8D5AE"}`,
      borderRadius: 20, padding: "3px 10px" }}>{text}</span>
  );

  return (
    <div id="prep-section" className="no-print" style={{ marginTop: 8 }}>
      <div style={{ background: "white", borderRadius: 16, padding: isMobile ? 18 : 32, border: "1px solid #ECE2D2",
        boxShadow: "0 2px 8px rgba(124,111,224,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 600, color: "#2C2621" }}>
            {edit ? tr("Prepare for your pulse meeting") : `${country} leader prep`}
          </div>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
            {chip(reacted >= depts.length && depts.length > 0, `${reacted}/${depts.length} departments`)}
            {chip(reflDone >= REFLECT_QS.length, `${reflDone}/${REFLECT_QS.length} reflections`)}
            {chip(agenda.length > 0, `${agenda.length} on agenda`)}
          </span>
        </div>
        <div style={{ fontSize: 13, color: "#7A6F63", lineHeight: 1.55, marginBottom: 22 }}>
          {edit
            ? tr("Work through each department above — say whether the survey matches what you're seeing or experiencing, jot your notes under What's working and Where attention is needed, answer the leadership questions, and add the departments you want to discuss to the agenda. Then finish the reflections below and click the finish button.")
            : "What the country leader prepared ahead of the pulse meeting."}
        </div>

        {/* Meeting agenda */}
        <div style={{ marginBottom: 26 }}>
          <div style={secTitle}>{tr("Meeting agenda — most important first")}{edit && agenda.length > 1 ? tr(" (drag to reorder)") : ""}</div>
          {agenda.length === 0 && (
            <div style={{ fontSize: 12.5, color: "#A89C8D", fontStyle: "italic" }}>
              {edit ? "Nothing yet — use the “+ Agenda” button next to a department's score to add it to your meeting list." : "No agenda items."}
            </div>
          )}
          {agenda.map((a, i) => {
            // Departments carry their status colour onto the agenda — the same
            // Concern / Watch / Healthy language used throughout the report.
            const st = a.deptKey ? ((depts.find(d => d.key === a.deptKey) || {}).status || null) : null;
            return (
            <div key={a.id || i}
              draggable={edit}
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { reorder(dragIdx, i); setDragIdx(null); }}
              onDragEnd={() => setDragIdx(null)}
              style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 12px", marginBottom: 6,
                background: dragIdx === i ? "#FBEFE4" : (st ? sb(st) : "#FDFAF4"),
                border: `1px solid ${st ? sbd(st) : "#ECE2D2"}`, borderRadius: 9,
                cursor: edit ? "grab" : "default" }}>
              {edit && <span style={{ color: "#A89C8D", fontSize: 14, lineHeight: "20px", flexShrink: 0 }}>≡</span>}
              <span style={{ background: st ? sc(st) : "#E0863C", color: "white", borderRadius: "50%", width: 20, height: 20,
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: st ? 600 : 400, color: "#2C2621", lineHeight: 1.5 }}>
                {a.label}
                {a.deptKey && deptLabel(a.deptKey) !== a.label && <span style={{ color: "#A89C8D", fontSize: 11, fontWeight: 400 }}> · {deptLabel(a.deptKey)}</span>}
              </span>
              {st && <span style={{ fontSize: 10, fontWeight: 700, color: sc(st), background: "#fff",
                border: `1px solid ${sbd(st)}`, borderRadius: 4, padding: "2px 7px", flexShrink: 0, marginTop: 1 }}>{st}</span>}
              {edit && (
                <button onClick={() => savePrepPatch({ agenda: agenda.filter(x => x !== a).map((x, xi) => ({ ...x, order: xi })) })}
                  title="Remove from agenda"
                  style={{ fontSize: 12, color: "#BE6650", background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}>✕</button>
              )}
            </div>
            );
          })}
        </div>

        {/* Reactions summary — P&C view only (the leader edits these inside each department) */}
        {!edit && Object.keys(prep.reactions || {}).length > 0 && (
          <div style={{ marginBottom: 26 }}>
            <div style={secTitle}>Department reactions</div>
            {Object.entries(prep.reactions || {}).map(([k, r]) => (
              <div key={k} style={{ padding: "8px 12px", marginBottom: 6, background: "#FDFAF4", border: "1px solid #ECE2D2", borderRadius: 9 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "#2C2621" }}>{deptLabel(k)}</span>
                <span style={{ fontSize: 12, color: "#B96524", marginLeft: 8, fontWeight: 600 }}>{r.choice}</span>
                {r.note && <div style={{ fontSize: 12.5, color: "#5A4A3B", marginTop: 4, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{r.note}</div>}
                {r.noteWorking && <div style={{ fontSize: 12.5, color: "#5A4A3B", marginTop: 4, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                  <span style={{ fontWeight: 700, color: "#5C9A6D" }}>What's working: </span>{r.noteWorking}</div>}
                {r.noteWorkingEn && <div style={{ fontSize: 12, color: "#7A6F63", marginTop: 2, lineHeight: 1.5, whiteSpace: "pre-wrap", borderLeft: "2px solid #E2D3C2", paddingLeft: 8 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: .5, marginRight: 6 }}>English (AI)</span>{r.noteWorkingEn}</div>}
                {r.noteAttention && <div style={{ fontSize: 12.5, color: "#5A4A3B", marginTop: 4, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                  <span style={{ fontWeight: 700, color: "#C08636" }}>Where attention is needed: </span>{r.noteAttention}</div>}
                {r.noteAttentionEn && <div style={{ fontSize: 12, color: "#7A6F63", marginTop: 2, lineHeight: 1.5, whiteSpace: "pre-wrap", borderLeft: "2px solid #E2D3C2", paddingLeft: 8 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: .5, marginRight: 6 }}>English (AI)</span>{r.noteAttentionEn}</div>}
              </div>
            ))}
          </div>
        )}

        {/* Reflect — five standing questions */}
        <div style={{ marginBottom: 26 }}>
          <div style={secTitle}>{tr("Reflect")}</div>
          {REFLECT_QS.map(qd => (
            <div key={qd.key} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#B96524", marginBottom: 2 }}>{tr(qd.label)}</div>
              <div style={{ fontSize: 12.5, color: "#5A4A3B", lineHeight: 1.5, marginBottom: 6 }}>{tr(qd.prompt)}</div>
              {edit ? (
                <textarea rows={2} value={refl[qd.key] || ""}
                  onChange={e => setRefl(prev => ({ ...prev, [qd.key]: e.target.value }))}
                  onBlur={saveRefl}
                  placeholder={tr("Write your answer — it saves when you click away.")}
                  style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: 9,
                    border: "1px solid #E2D3C2", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }} />
              ) : (
                <>
                  <div style={{ fontSize: 13, color: (prep.reflections || {})[qd.key] ? "#2C2621" : "#A89C8D",
                    fontStyle: (prep.reflections || {})[qd.key] ? "normal" : "italic",
                    background: "#FDFAF4", border: "1px solid #ECE2D2", borderRadius: 8, padding: "8px 11px",
                    whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
                    {(prep.reflections || {})[qd.key] || "No answer yet."}
                  </div>
                  {((prep.reflections || {})[qd.key + "En"] || "").trim() && (
                    <div style={{ marginTop: 4, fontSize: 12, color: "#7A6F63", borderLeft: "2px solid #E2D3C2",
                      paddingLeft: 8, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                      <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: .5, marginRight: 6 }}>English (AI)</span>
                      {(prep.reflections || {})[qd.key + "En"]}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>

        {/* Ready gate */}
        <div style={{ borderTop: "2px solid #FBEFE4", paddingTop: 18, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {prep.ready ? (
            <>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#5C9A6D" }}>
                ✓ Prep is ready — People &amp; Culture has your agenda, answers, and reflections.
              </span>
              {edit && (
                <button onClick={() => savePrepPatch({ ready: false })}
                  style={{ ...navBtn, background: "transparent", border: "1px solid #ECE2D2" }}>Reopen prep</button>
              )}
            </>
          ) : edit ? (
            <>
              <button onClick={() => { saveRefl(); savePrepPatch({ ready: true }); }}
                style={{ ...navBtn, background: "#5C9A6D", color: "white", fontSize: 14, padding: "10px 18px" }}>
                {tr("✓ I've finished my part of the Pulse report")}
              </button>
              <span style={{ fontSize: 12, color: "#7A6F63", lineHeight: 1.5 }}>
                {tr("Required before your pulse meeting — this sends your agenda, notes, question answers, and reflections to People & Culture.")}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 13, color: "#C08636", fontWeight: 600 }}>Prep hasn't been marked ready yet.</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── REPORT VIEW ──────────────────────────────────────────────────────────────
function ReportView({ country, year, surveyData, getApproved, setView, sbOverrides, sbMaster, runRespondents, me, saveMe, isPCLead, leaderName, prepMode = false, prepAuthor = "" }) {
  const leaderFirst = leaderName ? String(leaderName).trim().split(/\s+/)[0] : null;

  // ── Country Leader Prep (Priority 4) ──
  // For the country-leader role this report is a prep workflow layered on top of
  // the real report; P&C leadership sees the same prep read-only once it exists.
  const prepEnabled = prepMode || isPCLead;
  const [prep, setPrepState] = useState(null);   // null = loading / not enabled
  useEffect(() => {
    if (!prepEnabled || !country || !year) return;
    let alive = true;
    loadPrep(country, year)
      .then(p => { if (alive) setPrepState(p); })
      .catch(() => { if (alive) setPrepState({ reactions: {}, reflections: {}, agenda: [], ready: false }); });
    return () => { alive = false; };
  }, [country, year, prepEnabled]);
  const savePrepPatch = (patch) => {
    setPrepState(p => ({ ...(p || {}), ...patch }));
    savePrep(country, year, patch, prepAuthor).catch(e => console.warn("Prep save failed:", e.message));
  };
  // Freshest prep for async callbacks — translations land after state has moved on.
  const prepRef = useRef(null);
  prepRef.current = prep;
  // The leader's prep opens as a window over the report (from the header button).
  const [prepOpen, setPrepOpen] = useState(false);
  // The leader's own meeting-notes window: the full agenda + their notes per
  // department. Their notes go to them + P&C; department leaders' notes never
  // appear here.
  const [mnOpen, setMnOpen] = useState(false);
  const [mnDept, setMnDept] = useState(null);
  // The Concern & Watch questions open the same way — a window over the report.
  const [flaggedOpen, setFlaggedOpen] = useState(false);
  // "How scoring works" for the country leader, right on their report.
  const [showScoringHelp, setShowScoringHelp] = useState(false);
  // The API DeptReportPage uses to render the prep layer on each department.
  const prepApi = (prepMode && prep) ? {
    author: prepAuthor,
    reactionFor: (k) => (prep.reactions || {})[k] || null,
    // Merge a partial patch ({choice} | {noteWorking} | {noteAttention}) into the
    // department's reaction record, so each control saves independently. Notes
    // written in another language get a best-effort English copy ("<field>En")
    // so P&C and the directors can read them; English text clears any stale copy.
    saveReaction: (k, patch) => {
      const cur = ((prepRef.current || {}).reactions) || {};
      const rec = { ...(cur[k] || {}), ...patch };
      const pending = [];
      for (const f of ["noteWorking", "noteAttention"]) {
        if (patch[f] === undefined) continue;
        const txt = String(patch[f] || "").trim();
        if (txt && looksNonEnglish(txt)) pending.push([f, txt]);
        else rec[f + "En"] = "";
      }
      savePrepPatch({ reactions: { ...cur, [k]: rec } });
      pending.forEach(([f, txt]) => translateToEnglish(txt).then(en => {
        if (!en) return;
        const c2 = ((prepRef.current || {}).reactions) || {};
        savePrepPatch({ reactions: { ...c2, [k]: { ...(c2[k] || {}), [f + "En"]: en } } });
      }).catch(() => {}));
    },
    agendaHas: (label) => (prep.agenda || []).some(a => a.label === label),
    agendaToggle: (label, deptKey) => {
      const list = prep.agenda || [];
      const next = list.some(a => a.label === label)
        ? list.filter(a => a.label !== label)
        : [...list, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label, deptKey, order: list.length }];
      savePrepPatch({ agenda: next.map((a, i) => ({ ...a, order: i })) });
    },
  } : null;
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

  // Every department stands on its own at its own score — JVK 1st/2nd Culture and
  // Language & Culture 1st/2nd Culture are NOT merged, because they land differently
  // and people need to see where each one actually falls.
  const summaryDepts = [...depts].sort((a,b) => {
    const sa = STATUS_ORDER[a.status] ?? 3, sb = STATUS_ORDER[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return (parseFloat(a.avg)||0) - (parseFloat(b.avg)||0);
  });

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

  // Clicking a Concern / Watch / Healthy box filters the chart to just that group.
  const [statusFilter, setStatusFilter] = useState(null);
  // For the header's Concern & Watch jump button.
  const flaggedCount = depts.reduce((a, d) =>
    a + (d.questions || []).filter(q => q.status === "Concern" || q.status === "Watch").length, 0);

  const activeDeptData = activeDept ? depts.find(d=>d.key===activeDept) : null;

  // ── REPORT LANGUAGE FLIP ──────────────────────────────────────────────────
  // One button turns the report into the country's language — AI-translated and
  // clearly labelled as such. Content is translated lazily (the open department
  // plus the fixed UI strings) and cached in localStorage, so each string is
  // only ever translated once per language.
  const reportLang = languageForCountry(country);
  const [langOn, setLangOn] = useState(false);
  const [trBusy, setTrBusy] = useState(false);
  const [trNotice, setTrNotice] = useState(false); // "takes about a minute" heads-up
  const [trMap, setTrMap] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`pulse:tr:${languageForCountry(country)}`) || "{}"); } catch { return {}; }
  });
  const tr = (s) => (langOn && s && trMap[s]) || s;
  useEffect(() => {
    if (!langOn || !reportLang) return;
    const wanted = new Set(TR_UI_STRINGS());
    // The Concern & Watch panel shows questions from every department, so those
    // (plus all department labels) are translated up front.
    for (const dd of depts) {
      wanted.add(dd.label);
      for (const qq of (dd.questions || []))
        if (qq.status === "Concern" || qq.status === "Watch") wanted.add(qq.en);
    }
    const d = activeDept ? depts.find(x => x.key === activeDept) : null;
    if (d) {
      wanted.add(d.label);
      for (const s of getApproved(d.key, "strengths")) wanted.add(s);
      for (const s of getApproved(d.key, "growth")) wanted.add(s);
      for (const s of getApproved(d.key, "leadershipQs")) wanted.add(s);
      for (const qq of (d.questions || [])) wanted.add(qq.en);
    }
    const missing = [...wanted].filter(s => s && typeof s === "string" && !trMap[s]);
    if (!missing.length) return;
    let alive = true;
    setTrBusy(true);
    (async () => {
      try {
        const out = {};
        for (let i = 0; i < missing.length; i += 35) {
          const chunk = missing.slice(i, i + 35);
          const trs = await translateBatch(chunk, reportLang);
          if (!alive) return;
          chunk.forEach((s, j) => { if (trs[j]) out[s] = trs[j]; });
        }
        if (!alive) return;
        setTrMap(prev => {
          const next = { ...prev, ...out };
          try { localStorage.setItem(`pulse:tr:${reportLang}`, JSON.stringify(next)); } catch {}
          return next;
        });
      } catch (e) { console.warn("Report translation failed:", e.message); }
      finally { if (alive) setTrBusy(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [langOn, activeDept, reportLang]);

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
      {/* Toolbar — sticky, two rows: navigation, then the greeting + the report's
          action buttons, so Prepare / Concern & Watch / How scoring works / the
          language flip ride along on every scroll (deep in a department too). */}
      <div className="no-print" style={{ position:"sticky", top:0, zIndex:30, background:"white", borderBottom:"1px solid #ECE2D2" }}>
        <div style={{ padding: isMobile ? "10px 14px" : "12px 24px", display:"flex", gap:12, alignItems:"center", flexWrap: isMobile ? "wrap" : "nowrap" }}>
          <button onClick={()=>setView("__back__")} style={{ ...navBtn, background:"transparent", border:"1px solid #ECE2D2" }}>← Back</button>
          <div style={{ flex:1, order: isMobile ? 3 : 0, color:"#E0863C", fontWeight:700, fontSize: isMobile ? 11 : 13, letterSpacing:1, whiteSpace: isMobile ? "normal" : "nowrap" }}>
            JOSIAH VENTURE · {country.toUpperCase()} {year}
          </div>
          <button onClick={()=>window.print()} style={{ ...navBtn, background:"#E0863C", color:"white" }}>Download PDF</button>
        </div>
        <div style={{ padding: isMobile ? "8px 14px 10px" : "8px 24px 10px", display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", borderTop:"1px solid #F6F1E8" }}>
          <span style={{ fontFamily:FONT_DISPLAY, fontSize: isMobile ? 14 : 16, fontWeight:600, color:"#2C2621", marginRight:4 }}>
            {leaderFirst ? `${leaderFirst}, here's your ${country} Pulse report` : `${country} Staff Pulse Report`}
          </span>
          <span style={{ marginLeft:"auto", display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
            {prepMode && prep && (
              <button onClick={() => setPrepOpen(true)}
                style={{ fontSize:12, fontWeight:700, cursor:"pointer", borderRadius:16, padding:"6px 13px",
                  color: prep.ready ? "#5C9A6D" : "white",
                  background: prep.ready ? "#E9F1E9" : "#E0863C",
                  border: `1px solid ${prep.ready ? "#C7E0CB" : "#E0863C"}` }}>
                {prep.ready ? tr("✓ You've finished your part — thank you!") : tr("Prepare for your Pulse meeting")}
              </button>
            )}
            {prepMode && prep && (
              <button onClick={() => setMnOpen(true)}
                style={{ fontSize:12, fontWeight:700, cursor:"pointer", borderRadius:16, padding:"6px 13px",
                  color:"#5C9A6D", background:"#E9F1E9", border:"1px solid #C7E0CB" }}>
                📝 {tr("Meeting notes")}
              </button>
            )}
            {prepMode && (
              <HowToVideosButton audience="Country leaders"
                style={{ fontSize:12, padding:"6px 13px", borderRadius:16, border:"1px solid #E2D3C2", background:"#FDFAF4", color:"#5A4A3B" }} />
            )}
            {flaggedCount > 0 && (
              <button onClick={() => setFlaggedOpen(true)}
                style={{ fontSize:12, fontWeight:700, cursor:"pointer", borderRadius:16, padding:"6px 13px",
                  color:"#BE6650", background:"#F6E5DE", border:"1px solid #E2B3A8" }}>
                ⚠ {tr("Concern & Watch questions")} · {flaggedCount}
              </button>
            )}
            <button onClick={() => setShowScoringHelp(true)}
              style={{ fontSize:12, fontWeight:700, cursor:"pointer", borderRadius:16, padding:"6px 13px",
                color:"#5A4A3B", background:"#FDFAF4", border:"1px solid #E2D3C2" }}>
              ❔ {tr("How scoring works")}
            </button>
            {reportLang && (
              <button onClick={() => setLangOn(v => { if (!v) setTrNotice(true); return !v; })}
                style={{ fontSize:12, fontWeight:700, cursor:"pointer", borderRadius:16, padding:"6px 13px",
                  color: langOn ? "white" : "#5A4A3B",
                  background: langOn ? "#B96524" : "#FDFAF4",
                  border: `1px solid ${langOn ? "#B96524" : "#E2D3C2"}`, whiteSpace:"nowrap" }}>
                {langOn ? "🌐 English" : `🌐 ${nativeLanguageLabel(reportLang)}`}
              </button>
            )}
          </span>
        </div>
      </div>
      {showScoringHelp && <ScoringHelpPanel onClose={() => setShowScoringHelp(false)} audience={prepMode ? "Country leaders" : "Department leaders"} />}
      {trNotice && trBusy && langOn && <TranslationPatienceModal onClose={() => setTrNotice(false)} />}

      <div style={{ maxWidth:960, margin:"0 auto", padding: isMobile ? "24px 16px" : "40px 24px" }}>

        {/* AI-translation notice — always visible while the flip is on */}
        {langOn && reportLang && (
          <div className="no-print" style={{ background:"#F7EEDC", border:"1px solid #E8D5AE", borderRadius:10,
            padding:"11px 14px", marginBottom:18, fontSize:12.5, color:"#5A4A3B", lineHeight:1.55 }}>
            <b>🌐 {tr(TR_DISCLAIMER)}</b>
            {trMap[TR_DISCLAIMER] && <span style={{ display:"block", marginTop:3, opacity:.8 }}>{TR_DISCLAIMER}</span>}
            {trBusy && <span style={{ display:"block", marginTop:3, fontWeight:600 }}>Translating…</span>}
          </div>
        )}

        {/* ── SUMMARY PAGE ── */}
        <div style={{ background:"white", borderRadius:16, padding: isMobile ? 18 : 40, marginBottom:32, border:"1px solid #ECE2D2", boxShadow:"0 2px 8px rgba(124,111,224,0.08)" }}>

          {/* Header */}
          <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:32, paddingBottom:24, borderBottom:"2px solid #FBEFE4" }}>
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:"#E0863C", letterSpacing:3, textTransform:"uppercase", marginBottom:8 }}>Josiah Venture</div>
              {leaderFirst ? (
                <>
                  <div style={{ fontFamily:FONT_DISPLAY, fontSize:34, fontWeight:600, color:"#2C2621", marginBottom:4, letterSpacing:-.4 }}>
                    {leaderFirst}, here's your {country} Pulse report
                  </div>
                  <div style={{ fontSize:15, color:"#7A6F63" }}>Staff Pulse · {year}{totalN ? ` · ${totalN} respondents` : ""} across {depts.length} departments</div>
                </>
              ) : (
                <>
                  <div style={{ fontFamily:FONT_DISPLAY, fontSize:34, fontWeight:600, color:"#2C2621", marginBottom:4, letterSpacing:-.4 }}>{country} Staff Pulse Report</div>
                  <div style={{ fontSize:15, color:"#7A6F63" }}>{year}{totalN ? ` · ${totalN} respondents` : ""} across {depts.length} departments</div>
                </>
              )}
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:42, fontWeight:800, color:sc(overallAvg>=3.5?"Healthy":overallAvg>=2.5?"Watch":"Concern") }}>{overallAvg}</div>
              <div style={{ fontSize:11, color:"#7A6F63", marginTop:2 }}>Overall avg</div>
            </div>
          </div>

          {/* Status group summary — up top, so the read on the country comes
              first. Clicking a box filters the chart below to just that group;
              clicking it again shows everything. */}
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap:12, marginBottom:32 }}>
            {[["Concern","#F6E5DE","#BE6650",concerns],["Watch","#F7EEDC","#C08636",watches],["Healthy","#E9F1E9","#5C9A6D",healthys]].map(([label,bg,color,group])=>(
              <div key={label} onClick={()=>setStatusFilter(f => f === label ? null : label)}
                title={statusFilter === label ? "Show all departments" : `Show only ${label} departments below`}
                style={{ background:bg, borderRadius:10, padding:"14px 16px", cursor:"pointer",
                  border: statusFilter === label ? `2px solid ${color}` : "2px solid transparent",
                  opacity: statusFilter && statusFilter !== label ? 0.55 : 1, transition:"all 0.15s" }}>
                <div style={{ fontSize:11, fontWeight:700, color, textTransform:"uppercase", letterSpacing:1.5, marginBottom:8 }}>{label} · {group.length}</div>
                {group.map(d=>(
                  <div key={d.key} style={{ fontSize:12, color:"#2C2621", padding:"3px 0", borderBottom:"1px solid rgba(0,0,0,0.05)" }}>{d.label}</div>
                ))}
                {!group.length && <div style={{ fontSize:12, color, opacity:0.5 }}>None</div>}
              </div>
            ))}
          </div>

          {/* Score bar chart — all departments (or just the clicked status group) */}
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>
              {tr("Department Scores")} <span style={{ fontWeight:600, textTransform:"none", letterSpacing:0, color:"#A89C8D" }}>{tr("(Click on a department to see more details.)")}</span>
              {statusFilter && (
                <button className="no-print" onClick={()=>setStatusFilter(null)}
                  style={{ marginLeft:10, fontSize:11, fontWeight:700, cursor:"pointer", borderRadius:12,
                    padding:"2px 10px", color:"#5A4A3B", background:"#FDFAF4", border:"1px solid #E2D3C2",
                    textTransform:"none", letterSpacing:0 }}>
                  {statusFilter} only · ✕ show all
                </button>
              )}
            </div>
            {summaryDepts.filter(d => !statusFilter || d.status === statusFilter).map(d => (
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

        </div>

        {/* No department button row for anyone — the chart is the way in. The
            Concern & Watch questions open as a window from the header button. */}

        {/* ── DEPT DETAIL PAGES ── */}
        {/* No Meeting Notes tab here — the report is just the report. The team's
            meeting-notes page lives in the Director's Review section. */}
        <div id="dept-detail-section" />
        {activeDept ? (
          // Single dept selected — show just that one
          <DeptReportPage dept={activeDeptData} getApproved={getApproved} country={country} year={year} sbOverrides={sbOverrides} sbMaster={sbMaster} me={me} isPCLead={isPCLead} prep={prepApi} tr={tr} />
        ) : (
          // No tab selected — show all for print
          <div>
            <div className="no-print" style={{ textAlign:"center", color:"#7A6F63", fontSize:13, padding:"16px 0 32px" }}>
              Select a department above to focus, or download PDF to get the full report.
            </div>
            <div className="print-only">
              {depts.map(dept => <DeptReportPage key={dept.key} dept={dept} getApproved={getApproved} country={country} year={year} sbOverrides={sbOverrides} sbMaster={sbMaster} me={me} isPCLead={isPCLead} prep={prepApi} tr={tr} />)}
            </div>
          </div>
        )}

        {/* ── COUNTRY LEADER PREP — agenda, reflections, ready gate (bottom) ── */}
        {/* P&C reads the leader's prep at the foot of the report. The leader
            edits it in the pop-up window instead (opened from the header). */}
        {prepEnabled && prep && !prepMode && prep._recordId && (
          <PrepFooter mode="view" prep={prep} savePrepPatch={savePrepPatch}
            depts={depts} country={country} isMobile={isMobile} tr={tr} />
        )}
      </div>

      {/* Floating close — an open department can be closed from anywhere on the
          page, no scrolling back to the top. */}
      {activeDept && (
        <button className="no-print"
          onClick={() => { setActiveDept(null); try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch {} }}
          style={{ position:"fixed", right: isMobile ? 14 : 24, bottom: isMobile ? 14 : 24, zIndex:40,
            display:"flex", alignItems:"center", gap:7, padding:"11px 18px", borderRadius:24,
            background:"#2C2621", color:"white", border:"none", cursor:"pointer", fontSize:13, fontWeight:700,
            boxShadow:"0 4px 14px rgba(44,38,33,0.35)" }}>
          ✕ {tr("Close department")}
        </button>
      )}

      {/* Concern & Watch questions — a window floating over the report, same
          pattern as the prep window. Jumping to a department closes it first. */}
      {flaggedOpen && (
        <div className="no-print" onClick={() => setFlaggedOpen(false)}
          style={{ position:"fixed", inset:0, background:"rgba(44,38,33,0.45)", zIndex:60,
            overflowY:"auto", padding: isMobile ? "14px 10px 40px" : "40px 20px 60px" }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth:860, margin:"0 auto", position:"relative" }}>
            <button onClick={() => setFlaggedOpen(false)} title="Close"
              style={{ position:"absolute", top:10, right:10, zIndex:2, width:34, height:34, borderRadius:"50%",
                background:"#fff", border:"1px solid #ECE2D2", cursor:"pointer", fontSize:15, color:"#7A6F63",
                boxShadow:"0 2px 8px rgba(44,38,33,0.15)", lineHeight:1 }}>✕</button>
            <FlaggedQuestionsPanel depts={depts} tr={tr} isMobile={isMobile}
              onOpenDept={(k) => { setFlaggedOpen(false); openDept(k); }} />
          </div>
        </div>
      )}

      {/* Country leader prep — a window floating over the report */}
      {prepMode && prep && prepOpen && (
        <div className="no-print" onClick={() => setPrepOpen(false)}
          style={{ position:"fixed", inset:0, background:"rgba(44,38,33,0.45)", zIndex:60,
            overflowY:"auto", padding: isMobile ? "14px 10px 40px" : "40px 20px 60px" }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth:860, margin:"0 auto", position:"relative" }}>
            <button onClick={() => setPrepOpen(false)} title="Close"
              style={{ position:"absolute", top:16, right:10, zIndex:2, width:34, height:34, borderRadius:"50%",
                background:"#fff", border:"1px solid #ECE2D2", cursor:"pointer", fontSize:15, color:"#7A6F63",
                boxShadow:"0 2px 8px rgba(44,38,33,0.15)", lineHeight:1 }}>✕</button>
            <PrepFooter mode="edit" prep={prep} savePrepPatch={savePrepPatch}
              depts={depts} country={country} isMobile={isMobile} tr={tr} />
          </div>
        </div>
      )}

      {/* The country leader's meeting-notes window — full agenda + their own
          notes per department (shared with P&C; department leaders' notes are
          never shown here). */}
      {prepMode && prep && mnOpen && (() => {
        const agendaSorted = [...(prep.agenda || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
        const effDept = mnDept || (agendaSorted.find(a => a.deptKey) || {}).deptKey || (depts[0] || {}).key;
        const deptObj = depts.find(d => d.key === effDept);
        return (
          <div className="no-print" onClick={() => setMnOpen(false)}
            style={{ position:"fixed", inset:0, background:"rgba(44,38,33,0.45)", zIndex:60,
              overflowY:"auto", padding: isMobile ? "14px 10px 40px" : "40px 20px 60px" }}>
            <div onClick={e => e.stopPropagation()} style={{ maxWidth:720, margin:"0 auto", background:"#fff",
              borderRadius:14, padding:"20px 22px", boxShadow:"0 24px 60px rgba(44,38,33,.35)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
                <span style={{ fontFamily:FONT_DISPLAY, fontSize:19, fontWeight:600, color:"#2C2621" }}>{tr("Meeting notes")}</span>
                <button onClick={() => setMnOpen(false)} style={{ marginLeft:"auto", background:"none", border:"none",
                  cursor:"pointer", fontSize:19, color:"#7A6F63", lineHeight:1 }}>✕</button>
              </div>
              <div style={{ fontSize:12.5, color:"#7A6F63", lineHeight:1.55, marginBottom:12 }}>
                {tr("The full agenda for your Pulse meeting — tap an item to take notes for that department. Your notes here are shared with People & Culture only.")}
              </div>
              {agendaSorted.length > 0 && (
                <div style={{ marginBottom:14 }}>
                  {agendaSorted.map((a, i) => {
                    const active = a.deptKey && a.deptKey === effDept;
                    return (
                      <button key={a.id || i} onClick={() => a.deptKey && setMnDept(a.deptKey)}
                        style={{ display:"flex", gap:8, alignItems:"flex-start", width:"100%", textAlign:"left",
                          padding:"6px 8px", borderRadius:8, marginBottom:3, cursor: a.deptKey ? "pointer" : "default",
                          background: active ? "#FBEFE4" : "transparent",
                          border: active ? "1px solid #E0A56F" : "1px solid transparent" }}>
                        <span style={{ background:"#E0863C", color:"white", borderRadius:"50%", width:18, height:18,
                          display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, flexShrink:0 }}>{i + 1}</span>
                        <span style={{ flex:1, fontSize:12.5, color:"#2C2621", fontWeight: active ? 700 : 500, lineHeight:1.45 }}>{a.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:4 }}>
                {depts.map(d => (
                  <button key={d.key} onClick={() => setMnDept(d.key)}
                    style={{ fontSize:11.5, fontWeight:700, cursor:"pointer", borderRadius:14, padding:"4px 11px",
                      color: d.key === effDept ? "#B96524" : "#7A6F63",
                      background: d.key === effDept ? "#FBEFE4" : "#FDFAF4",
                      border: `1px solid ${d.key === effDept ? "#E0A56F" : "#ECE2D2"}` }}>
                    {d.label}
                  </button>
                ))}
              </div>
              {deptObj && (
                <NotesPanel country={country} year={year} deptKey={deptObj.key} deptLabel={deptObj.label}
                  me={me || prepAuthor || leaderName} saveMe={saveMe} isPCLead={false} meetingMode />
              )}
            </div>
          </div>
        );
      })()}

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

function DeptReportPage({ dept, getApproved, country, year, sbOverrides, sbMaster, me, isPCLead, startCollapsed = false, prep = null, tr = (s) => s }) {
  const isMobile = useIsMobile();
  // Which questions/areas the viewer has already noted (so the button shows a ✓).
  const [noted, setNoted] = useState({});
  const reloadNoted = async () => {
    if (!dept) return;
    try {
      const all = await loadQuestionNotes(country, year, dept.key);
      const m = {}; (all || []).forEach(n => { if ((n.body || "").trim() && n.author === me) m[n.question] = true; });
      setNoted(m);
    } catch { /* offline */ }
  };
  useEffect(() => { reloadNoted(); /* eslint-disable-next-line */ }, [country, year, dept && dept.key, me]);

  // ── Country Leader Prep layer (only when `prep` is passed) ──
  // Reaction ("As you read over this department's survey information, do you feel like it matches what you're seeing or experiencing?") — one per department, up by
  // the department name. The leader's notes live under the What's working and
  // Where attention is needed sections; each control saves independently.
  const r0 = prep && dept ? prep.reactionFor(dept.key) : null;
  const [reactChoice, setReactChoice] = useState(r0 ? r0.choice : null);
  const [noteWorking, setNoteWorking] = useState(r0 ? (r0.noteWorking || "") : "");
  const [noteAttention, setNoteAttention] = useState(r0 ? (r0.noteAttention || "") : "");
  useEffect(() => {
    const r = prep && dept ? prep.reactionFor(dept.key) : null;
    setReactChoice(r ? r.choice : null);
    setNoteWorking(r ? (r.noteWorking || "") : "");
    setNoteAttention(r ? (r.noteAttention || "") : "");
    // eslint-disable-next-line
  }, [dept && dept.key, !!prep]);
  // Leadership-question answers — stored as PUBLIC question notes "LQA: <q>" so
  // they flow into that department's Meeting Notes for the team to read.
  const [lqa, setLqa] = useState({});
  useEffect(() => {
    if (!prep || !dept) return;
    let alive = true;
    loadQuestionNotes(country, year, dept.key).then(all => {
      if (!alive) return;
      const m = {};
      (all || []).forEach(n => {
        if (String(n.question || "").startsWith("LQA: ")) {
          m[String(n.question).slice(5)] = { id: n.id, body: n.body || "", translation: n.translation || "" };
        }
      });
      setLqa(m);
    }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [country, year, dept && dept.key, !!prep]);
  const saveAnswer = async (qText) => {
    const cur = { ...(lqa[qText] || {}) };
    const body = (cur.body || "").trim();
    if (!body && !cur.id) return;
    setLqa(p => ({ ...p, [qText]: { ...cur, saving: true, err: null } }));
    try {
      if (cur.id) {
        await updateQuestionNote(cur.id, { body });
      } else {
        cur.id = await addQuestionNote({ country, year, deptKey: dept.key, question: "LQA: " + qText,
          author: (prep && prep.author) || "Country leader", title: body.slice(0, 80), body, visibility: "Public" });
      }
      // Best-effort English copy for the team + P&C when the answer isn't in
      // English (stored in the note's "Notes" column; never blocks the save).
      if (cur.id) {
        if (body && looksNonEnglish(body)) {
          const noteId = cur.id;
          translateToEnglish(body).then(en => { if (en) updateQuestionNote(noteId, { translation: en }).catch(() => {}); });
        } else if (cur.translation) {
          cur.translation = "";
          updateQuestionNote(cur.id, { translation: "" }).catch(() => {});
        }
      }
      setLqa(p => ({ ...p, [qText]: { ...cur, saving: false, savedAt: new Date().toISOString() } }));
    } catch (e) {
      setLqa(p => ({ ...p, [qText]: { ...cur, saving: false, err: e.message } }));
    }
  };
  // "+ Agenda" — flips to "On agenda"; the list itself lives at the report's foot.
  const AgendaBtn = ({ label }) => {
    if (!prep) return null;
    const on = prep.agendaHas(label);
    return (
      <button className="no-print" onClick={(e) => { e.preventDefault(); prep.agendaToggle(label, dept.key); }}
        style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, cursor: "pointer",
          color: on ? "#5C9A6D" : "#fff", background: on ? "#E9F1E9" : "#7C6FE0",
          border: `1px solid ${on ? "#C7E0CB" : "#7C6FE0"}`, borderRadius: 20, padding: "6px 12px", whiteSpace: "nowrap" }}>
        {on ? tr("✓ On agenda") : tr("+ Agenda")}
      </button>
    );
  };

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
          <div style={{ fontFamily:FONT_DISPLAY, fontSize:24, fontWeight:600, color:"#2C2621", marginBottom:2 }}>{tr(dept.label)}</div>
          <div style={{ fontSize:13, color:"#7A6F63" }}>n = {dept.n} respondents</div>
          {!prep && (
            <div className="no-print" style={{ marginTop:8 }}>
              <DirectorNoteButton country={country} year={year} deptKey={dept.key} question={"§ Area"} label={"Your notes on " + dept.label} me={me} hasNote={!!noted["§ Area"]} onSaved={reloadNoted} btnLabel="Notes on this area" />
            </div>
          )}
        </div>
        {/* Top right: just the score. */}
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
        <Disclosure title={tr("What's working")} count={`${strengths.length}`} dot="#5C9A6D" defaultOpen={!startCollapsed}>
          {strengths.map((s,i) => (
            <div key={i} style={{ display:"flex", gap:10, marginBottom:8, alignItems:"flex-start" }}>
              <span style={{ color:"#5C9A6D", fontWeight:700, fontSize:14, marginTop:1, flexShrink:0 }}>✓</span>
              <span style={{ fontSize:13, color:"#2C2621", lineHeight:1.6, flex:1 }}>{tr(s)}</span>
            </div>
          ))}
          {/* Country leader prep: notes belong right under what they're about. */}
          {prep && (
            <div className="no-print" style={{ marginTop:10 }}>
              <textarea rows={2} value={noteWorking}
                onChange={e => setNoteWorking(e.target.value)}
                onBlur={() => prep.saveReaction(dept.key, { noteWorking })}
                placeholder={tr("Your notes on what's working — saves when you click away, and goes to People & Culture with your prep.")}
                style={{ width:"100%", boxSizing:"border-box", fontSize:13, padding:9,
                  border:"1px solid #E2D3C2", borderRadius:8, resize:"vertical", fontFamily:"inherit" }} />
            </div>
          )}
        </Disclosure>
      )}

      {growth.length > 0 && (
        <Disclosure title={tr("Where attention is needed")} count={`${growth.length}`} dot={statusColor} defaultOpen={!startCollapsed}>
          {growth.map((g,i) => (
            <div key={i} style={{ display:"flex", gap:10, marginBottom:8, alignItems:"flex-start" }}>
              <span style={{ color:statusColor, fontWeight:700, fontSize:14, marginTop:1, flexShrink:0 }}>→</span>
              <span style={{ fontSize:13, color:"#2C2621", lineHeight:1.6, flex:1 }}>{tr(g)}</span>
            </div>
          ))}
          {prep && (
            <div className="no-print" style={{ marginTop:10 }}>
              <textarea rows={2} value={noteAttention}
                onChange={e => setNoteAttention(e.target.value)}
                onBlur={() => prep.saveReaction(dept.key, { noteAttention })}
                placeholder={tr("Your notes on where attention is needed — saves when you click away, and goes to People & Culture with your prep.")}
                style={{ width:"100%", boxSizing:"border-box", fontSize:13, padding:9,
                  border:"1px solid #E2D3C2", borderRadius:8, resize:"vertical", fontFamily:"inherit" }} />
            </div>
          )}
        </Disclosure>
      )}

      {/* Question scores — each row a collapsed <details>; expanding shows that
          question's heatmap inline (the same shared renderer the Director's
          Review uses, burden flip included). One report component everywhere. */}
      <Disclosure title={tr("Question scores")} count={`${(dept.questions||[]).length} questions`} dot="#E0863C" defaultOpen={!startCollapsed} flush>
        <style>{`
          details.pulse-qrow > summary { list-style: none; }
          details.pulse-qrow > summary::-webkit-details-marker { display: none; }
          details.pulse-qrow > summary .pulse-qrow-caret { transition: transform .15s; }
          details.pulse-qrow[open] > summary .pulse-qrow-caret { transform: rotate(90deg); }
        `}</style>
        {/* Header strip */}
        {!isMobile && (
          <div style={{ display:"grid", gridTemplateColumns:"52px 1fr 66px 46px 84px", gap:0,
            background:"#FBEFE4", padding:"8px 10px", fontSize:11, fontWeight:600, color:"#7A6F63" }}>
            <span>Score</span><span>Question</span>
            <span style={{ textAlign:"center" }}>Status</span>
            <span style={{ textAlign:"center" }}>Scale</span>
            <span style={{ textAlign:"center" }}>Heatmap</span>
          </div>
        )}
        {[...dept.questions].sort((a,b)=>{
          const o={Concern:0,Watch:1,Healthy:2};
          return (o[a.status]??1)-(o[b.status]??1) || a.score-b.score;
        }).map((q,i)=>(
          <details key={i} className="pulse-qrow" style={{ borderBottom:"1px solid #FBEFE4" }}>
            <summary style={{ cursor:"pointer", display:"grid",
              gridTemplateColumns: isMobile ? "44px 1fr 84px" : "52px 1fr 66px 46px 84px",
              gap:0, alignItems:"start", padding:"8px 10px", fontSize:12 }}>
              <span style={{ fontWeight:700, color:sc(q.status), paddingTop:1 }}>{q.score?.toFixed(2)}</span>
              <span style={{ color:"#2C2621", lineHeight:1.5, paddingRight:10 }}>
                {tr(q.en)}{q.burden ? <span style={{ color:"#7A6F63", fontSize:10 }}> [Burden]</span> : ""}
                {isMobile && (
                  <span style={{ marginLeft:6, fontSize:10, fontWeight:700, color:sc(q.status), background:sb(q.status),
                    border:`1px solid ${sbd(q.status)}`, borderRadius:4, padding:"1px 5px", whiteSpace:"nowrap" }}>{q.status}</span>
                )}
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
                    <span style={{ display:"block", fontSize:11, color:"#7A6F63", fontStyle:"italic",
                      lineHeight:1.4, marginTop:4 }}>
                      {text}
                    </span>
                  );
                })()}
                {/* Interactive bits must not toggle the row — preventDefault stops the <details> toggle only. */}
                <span className="no-print" style={{ display:"block", marginTop:6 }} onClick={e => e.preventDefault()}>
                  <DirectorNoteButton country={country} year={year} deptKey={dept.key} question={q.en} label={q.en} me={me} hasNote={!!noted[q.en]} onSaved={reloadNoted} compact btnLabel="My note" forcePublic={!!prep} />
                </span>
              </span>
              {!isMobile && (
                <span style={{ textAlign:"center", paddingTop:1 }}>
                  <span style={{ fontSize:10, fontWeight:700, color:sc(q.status), background:sb(q.status),
                    border:`1px solid ${sbd(q.status)}`, borderRadius:4, padding:"2px 6px" }}>{q.status}</span>
                </span>
              )}
              {!isMobile && (
                <span style={{ textAlign:"center", color:"#7A6F63", fontSize:10, paddingTop:3 }}>
                  <span style={{ background:"#FBEFE4", borderRadius:4, padding:"2px 6px", fontWeight:700 }}>{q.scale.toUpperCase()}</span>
                </span>
              )}
              <span className="no-print" style={{ textAlign:"center" }}>
                <span style={{ display:"inline-flex", alignItems:"center", gap:4, fontSize:11, fontWeight:600,
                  color:"#E0863C", background:"#F7E7D5", border:"0.5px solid #E0A56F", borderRadius:5, padding:"3px 9px" }}>
                  <svg className="pulse-qrow-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#B96524"
                    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                  Heatmap
                </span>
              </span>
            </summary>
            <div style={{ padding:"2px 10px 12px", maxWidth:520 }}>
              <QuestionHeatmap q={q} />
            </div>
          </details>
        ))}
      </Disclosure>

      {/* Leadership Questions */}
      {leadershipQs.length > 0 && (
        <Disclosure title={tr("Questions for leadership")} count={`${leadershipQs.length}`} dot="#B96524" defaultOpen={!startCollapsed}>
          {leadershipQs.map((q,i) => (
            <div key={i} style={{ marginBottom: prep ? 16 : 10 }}>
              <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
                <span style={{ background:"#E0863C", color:"white", borderRadius:"50%", width:20, height:20,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:11, fontWeight:700, flexShrink:0, marginTop:1 }}>{i+1}</span>
                <span style={{ fontSize:13, color:"#2C2621", lineHeight:1.6, flex:1 }}>{tr(q)}</span>
              </div>
              {/* Country leader prep: an answer box after EACH leadership question.
                  Saved as a PUBLIC question note ("LQA: …") so the team reads it in
                  this department's Meeting Notes. */}
              {prep && (
                <div className="no-print" style={{ margin:"8px 0 0 32px" }}>
                  <textarea rows={2} value={(lqa[q] && lqa[q].body) || ""}
                    onChange={e => setLqa(p => ({ ...p, [q]: { ...(p[q] || {}), body: e.target.value } }))}
                    onBlur={() => saveAnswer(q)}
                    placeholder={tr("Your answer for the team — saves when you click away, and appears in this department's Meeting Notes.")}
                    style={{ width:"100%", boxSizing:"border-box", fontSize:13, padding:9,
                      border:"1px solid #E2D3C2", borderRadius:8, resize:"vertical", fontFamily:"inherit" }} />
                  <div style={{ fontSize:11, marginTop:3, color: (lqa[q] && lqa[q].err) ? "#BE6650" : "#A89C8D" }}>
                    {lqa[q] && lqa[q].saving ? "Saving…"
                      : lqa[q] && lqa[q].err ? `Couldn't save: ${lqa[q].err}`
                      : lqa[q] && lqa[q].savedAt ? "✓ Saved — shared with the team"
                      : lqa[q] && lqa[q].id ? "On file — edit and click away to update" : ""}
                  </div>
                </div>
              )}
            </div>
          ))}
        </Disclosure>
      )}

      {/* Staff Quotes */}
      {quotes.length > 0 && (
        <Disclosure title={tr("What staff said")} count={`${quotes.length}`} dot="#5A4A3B" defaultOpen={!startCollapsed}>
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

      {/* Country leader prep: the reaction row at the BOTTOM of the department's
          window — question, the three answers, and the agenda button at the far
          right at the same height. */}
      {prep && (
        <div className="no-print" style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap",
          background:"#FDFAF4", border:"1px solid #ECE2D2", borderRadius:10, padding:"9px 12px", marginTop:10 }}>
          <span style={{ flex:1, minWidth:200, fontSize:12.5, fontWeight:650, color:"#2C2621", lineHeight:1.45 }}>
            {tr("As you read over this department's survey information, do you feel like it matches what you're seeing or experiencing?")}
          </span>
          {["Yes, this matches", "Partly", "This doesn't match"].map(c => (
            <button key={c} onClick={() => { setReactChoice(c); prep.saveReaction(dept.key, { choice: c }); }}
              style={{ fontSize:11.5, fontWeight:600, cursor:"pointer", borderRadius:16, padding:"5px 11px", whiteSpace:"nowrap",
                color: reactChoice === c ? "#fff" : "#5A4A3B",
                background: reactChoice === c ? "#E0863C" : "#fff",
                border: `1px solid ${reactChoice === c ? "#E0863C" : "#E2D3C2"}` }}>
              {tr(c)}
            </button>
          ))}
          {reactChoice && <span style={{ fontSize:11, color:"#5C9A6D", fontWeight:600 }}>✓</span>}
          <span title={tr("Adds this department to your Pulse meeting agenda.")} style={{ marginLeft:"auto" }}>
            <AgendaBtn label={dept.label} />
          </span>
        </div>
      )}

    </div>
  );
}

// ─── DASHBOARD PREVIEW ────────────────────────────────────────────────────────
// "What this page grows into" — a friendly example shown over a country's
// dashboard while it only holds one survey. Sample numbers, clearly labelled,
// so a leader can picture the over-time story and how Department Health fills
// in as yearly reports arrive. Auto-shows twice, then stays away (and there's
// a "Don't show this again" box); reopen any time from the banner.
const TRENDS_PREVIEW_KEY = "pulse:trendsPreviewSeen";
const SAMPLE_HEALTH = [
  { label: "Counseling",         years: [["Concern", 2.3], ["Watch", 2.8], ["Watch", 3.1], ["Healthy", 3.6]] },
  { label: "JV Women",           years: [["Watch", 3.2], ["Watch", 3.3], ["Healthy", 3.7], ["Healthy", 3.8]] },
  { label: "Language & Culture", years: [["Healthy", 3.8], ["Healthy", 3.9], ["Watch", 3.4], ["Watch", 3.4]] },
];
// Dated columns, not years — three pulses in one year, then another year:
// the quiet message is that a team can take the pulse whenever they want.
const SAMPLE_YEARS = ["Mar 2026", "Jun 2026", "Oct 2026", "Apr 2027"];
function TrendsExampleModal({ country, onClose, onNever }) {
  const [never, setNever] = useState(false);
  const close = () => { if (never && onNever) onNever(); onClose(); };
  return (
    <div onClick={close} style={{ position:"fixed", inset:0, background:"rgba(44,38,33,0.5)", zIndex:1000,
      overflowY:"auto", padding:"36px 14px 60px" }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth:640, margin:"0 auto", background:"#fff",
        borderRadius:16, padding:"22px 24px", boxShadow:"0 24px 60px rgba(44,38,33,.35)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
          <span style={{ fontFamily:FONT_DISPLAY, fontSize:20, fontWeight:600, color:"#2C2621" }}>What this page grows into</span>
          <button onClick={close} style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer",
            fontSize:19, color:"#7A6F63", lineHeight:1 }}>✕</button>
        </div>
        <div style={{ fontSize:13, color:"#5A4A3B", lineHeight:1.6, marginBottom:12 }}>
          Right now {country ? `${country}'s` : "your"} dashboard holds one survey — the 2026 baseline. That's the
          first chapter, not the whole story. Every new Pulse Report adds a column, whenever your team takes one —
          three in a busy year, or one — and this page starts showing movement: what's getting healthier, what's
          slipping, and where the care you're giving is landing.
        </div>
        <div style={{ display:"inline-block", fontSize:11, fontWeight:800, color:"#B96524", background:"#FBEFE4",
          border:"1px solid #E0A56F", borderRadius:6, padding:"4px 10px", marginBottom:16, letterSpacing:.5 }}>
          SAMPLE NUMBERS — not {country || "your"} data
        </div>

        <div style={{ fontSize:11, fontWeight:700, color:"#7A6F63", textTransform:"uppercase", letterSpacing:1.5, marginBottom:8 }}>
          How it fills in — report by report
        </div>
        <div style={{ border:"1px solid #F4ECDD", borderRadius:12, padding:"12px 14px", marginBottom:6 }}>
          <div style={{ display:"grid", gridTemplateColumns:"minmax(110px,1.2fr) repeat(4, 1fr)", gap:8, marginBottom:6 }}>
            <span />
            {SAMPLE_YEARS.map(yr => <span key={yr} style={{ fontSize:10.5, fontWeight:700, color:"#7A6F63", textAlign:"center" }}>{yr}</span>)}
          </div>
          {SAMPLE_HEALTH.map(row => (
            <div key={row.label} style={{ display:"grid", gridTemplateColumns:"minmax(110px,1.2fr) repeat(4, 1fr)", gap:8, alignItems:"center", marginBottom:6 }}>
              <span style={{ fontSize:12, fontWeight:650, color:"#2C2621" }}>{row.label}</span>
              {row.years.map(([st, v], i) => (
                <span key={i} style={{ fontSize:11, fontWeight:700, textAlign:"center", color:sc(st), background:sb(st),
                  border:`1px solid ${sbd(st)}`, borderRadius:6, padding:"4px 2px", fontVariantNumeric:"tabular-nums" }}>{v.toFixed(1)}</span>
              ))}
            </div>
          ))}
          <div style={{ fontSize:11.5, color:"#7A6F63", lineHeight:1.55, marginTop:8 }}>
            Watch Counseling in this sample: two hard seasons, steady attention, and by the fourth report it's genuinely
            healthy. That's the story this page is built to tell — and it starts with the baseline you have today.
          </div>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:12, marginTop:14, flexWrap:"wrap" }}>
          <label style={{ display:"flex", alignItems:"center", gap:7, fontSize:12.5, color:"#5A4A3B", cursor:"pointer" }}>
            <input type="checkbox" checked={never} onChange={e => setNever(e.target.checked)} /> Don't show this again
          </label>
          <button onClick={close} style={{ ...navBtn, marginLeft:"auto", background:"#E0863C", color:"#fff", border:"1px solid transparent", fontWeight:700 }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── DASHBOARD VIEW ───────────────────────────────────────────────────────────
function DashboardView({ allRuns, dashCountry, setDashCountry, setView, country, year, surveyData, refinements, setRefinements, openReport, lockCountry, isLeader = true, authUser, onSignOut }) {
  const isMobile = useIsMobile();
  // "How scoring works" — the same explainer the department leaders get, served
  // with country-leader-audience videos.
  const [showScoringHelp, setShowScoringHelp] = useState(false);
  // First-visit example of what the trends become — auto-shows twice per device
  // on a country page, then only by the banner button (or never, if they tick
  // "Don't show this again").
  const [showTrendsExample, setShowTrendsExample] = useState(false);
  const effDashCountryEarly = lockCountry || dashCountry;
  useEffect(() => {
    if (!effDashCountryEarly || effDashCountryEarly === "all") return;
    try {
      const st = JSON.parse(localStorage.getItem(TRENDS_PREVIEW_KEY) || "{}");
      if (st.never || (st.count || 0) >= 2) return;
      localStorage.setItem(TRENDS_PREVIEW_KEY, JSON.stringify({ ...st, count: (st.count || 0) + 1 }));
      setShowTrendsExample(true);
    } catch {}
    // eslint-disable-next-line
  }, [effDashCountryEarly]);
  const neverShowTrendsExample = () => {
    try {
      const st = JSON.parse(localStorage.getItem(TRENDS_PREVIEW_KEY) || "{}");
      localStorage.setItem(TRENDS_PREVIEW_KEY, JSON.stringify({ ...st, never: true }));
    } catch {}
  };
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
    if (!latestByCountry[run.country] || periodCmp(run.year, latestByCountry[run.country].year) > 0)
      latestByCountry[run.country] = run;
  }

  return (
    <div style={{ minHeight:"100vh", background:"#F6F1E8", fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #ECE2D2", padding: isMobile ? "12px 16px" : "14px 24px", display:"flex", alignItems:"center", gap: isMobile ? 10 : 16, flexWrap:"wrap" }}>
        <button onClick={()=>setView("__back__")} style={{ ...navBtn, background:"transparent", border:"1px solid #ECE2D2" }}>← Back</button>
        {/* One title for everyone: viewing a country reads exactly as the
            country's own leader sees it. */}
        <div style={{ flex:1, fontFamily:FONT_DISPLAY, fontSize:18, color:"#2C2621", fontWeight:600 }}>
          {effDashCountry !== "all" ? `${effDashCountry} Pulse Report Dashboard` : "Country Leader Pulse Report Dashboard"}
        </div>
        {effDashCountry !== "all" && (
          <button onClick={() => setShowTrendsExample(true)}
            style={{ ...navBtn, background:"white", border:"1px solid #ECE2D2", color:"#5C9A6D", fontWeight:700, fontSize:12, padding:"6px 12px" }}>
            📈 What this will become
          </button>
        )}
        <HowToVideosButton audience="Country leaders" style={{ fontSize:12, padding:"6px 12px" }} />
        <button onClick={() => setShowScoringHelp(true)}
          style={{ ...navBtn, background:"white", border:"1px solid #ECE2D2", color:"#E0863C", fontWeight:700, fontSize:12, padding:"6px 12px" }}>
          ❔ How scoring works
        </button>
        {showScoringHelp && <ScoringHelpPanel onClose={() => setShowScoringHelp(false)} audience="Country leaders" />}
        {showTrendsExample && (
          <TrendsExampleModal country={effDashCountry !== "all" ? effDashCountry : ""}
            onClose={() => setShowTrendsExample(false)} onNever={neverShowTrendsExample} />
        )}
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

        {/* A survey out in the field for this country shows its progress right
            on top — the country's leader can set how many staff should take it. */}
        {effDashCountry !== "all" && <PulseSurveyProgress country={effDashCountry} />}

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
      {/* Refinements manager — leaders only, and only on the all-countries
          view: a single country's page must read exactly as its own leader
          sees it, with no extra admin furniture. */}
      {isLeader && effDashCountry === "all" && (
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
            No refinements saved yet. When department leaders edit wording in the Department Leader Review, those edits are saved here and pre-filled in future country reports.
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


// ─── STAFF SURVEY — the page staff open from their country's link ────────────
// No login. Identity = the survey link's token + a personal resume code the
// person gets when they start (kept on this device too, so coming back on the
// same phone just resumes). Answers autosave as they move between sections.
// The survey is one gentle question at a time: a flat list of steps built from
// the routing answers — 4 demographic questions, then per section a breather
// card, its questions, and an optional open comment. Answering fades the next
// step up; a timeline shows how far along they are.
function surveyStepsFor(ans) {
  const secs = surveySectionsFor((ans && ans.d) || {});
  const steps = [
    { type: "demo", k: "culture" }, { type: "demo", k: "marital" },
    { type: "demo", k: "kids" }, { type: "demo", k: "woman" },
  ];
  secs.forEach((dept, si) => {
    steps.push({ type: "section", dept, si, count: secs.length });
    dept.questions.forEach(qq => steps.push({ type: "q", dept, qq, si }));
    steps.push({ type: "open", dept, si });
  });
  return steps;
}
// First step still waiting on an answer — null when every question is answered.
function surveyFirstUnanswered(steps, ans) {
  const d = (ans && ans.d) || {}, a = (ans && ans.a) || {};
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.type === "demo") {
      const done = st.k === "culture" ? d.culture != null : st.k === "woman" ? d.woman !== undefined : !!d[st.k];
      if (!done) return i;
    }
    if (st.type === "q" && a[st.qq.col] == null) return i;
  }
  return null;
}

// A gentle heads-up when someone flips to their language for the first time:
// the translation is made fresh and takes about a minute, arriving piece by
// piece. (Once made, it's remembered — so this only ever shows while work is
// actually happening.) Kept in English on purpose: it shows before any
// translation exists.
function TranslationPatienceModal({ onClose }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(44,38,33,0.45)", zIndex: 1200,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: 430, background: "#fff", borderRadius: 14,
        padding: "26px 26px 22px", boxShadow: "0 24px 60px rgba(44,38,33,.35)", textAlign: "center" }}>
        <div style={{ fontSize: 34, marginBottom: 8 }}>🌐</div>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 600, color: "#2C2621", marginBottom: 8 }}>
          Translating for you…
        </div>
        <div style={{ fontSize: 13.5, color: "#5A4A3B", lineHeight: 1.65 }}>
          The first time takes about a minute — the translation is being made fresh and appears piece by piece
          as it's ready. Thank you for your patience! After this it's remembered, so next time is instant.
        </div>
        <button onClick={onClose} style={{ marginTop: 16, fontSize: 13, fontWeight: 700, cursor: "pointer",
          borderRadius: 20, padding: "9px 18px", border: "1px solid transparent", background: "#E0863C", color: "#fff" }}>
          OK — I'll wait ☺
        </button>
      </div>
    </div>
  );
}

function StaffSurveyView({ token }) {
  const isMobile = useIsMobile();
  const [meta, setMeta] = useState(null);        // null loading | {run,country,period,status} | {error}
  const [stage, setStage] = useState("welcome"); // welcome | code | resume | flow | review | done | closed
  const [step, setStep] = useState(0);           // index into surveyStepsFor(answers) while stage === "flow"
  const [code, setCode] = useState("");
  const [codeInput, setCodeInput] = useState("");
  // Their sign-in email — kept in the separate check-off list, never with answers.
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState({ d: {}, a: {}, open: {} });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const answersRef = useRef(answers); answersRef.current = answers;
  const codeRef = useRef(code); codeRef.current = code;
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

  // Language — same cache the report's flip uses, so questions translate once.
  const lang = meta && meta.country ? languageForCountry(meta.country) : null;
  const [langOn, setLangOn] = useState(false);
  const [trMap, setTrMap] = useState({});
  useEffect(() => {
    if (!lang) return;
    try { setTrMap(JSON.parse(localStorage.getItem(`pulse:tr:${lang}`) || "{}")); } catch {}
  }, [lang]);
  const tr = (s) => (langOn && s && trMap[s]) || s;
  const SURVEY_UI = [
    "Staff Pulse Survey", "Your voice, in confidence",
    "Your answers are anonymous. You'll sign in with your email so your leader knows who has finished — but your email is never connected to what you say. You'll also get a short personal code so you can pause and come back later.",
    "Start the survey", "I already have a code", "Continue",
    "Here is your personal code", "Write it down or take a photo — it's the only way back into your answers if you switch devices. On this device we'll remember it for you.",
    "Welcome back", "Enter your code to pick up where you left off.", "Resume my survey",
    "A few quick questions first", "These only decide which sections you'll see — they're stored with your answers, never your name.",
    "Are you serving cross-culturally (living outside your home culture)?",
    "Yes — I serve outside my home culture", "No — I serve in my home culture",
    "What is your marital status?", "Single", "Married", "Prefer not to say",
    "Do you have children living in your household?", "Yes", "No",
    "Are you a woman?",
    "Section", "of", "Question", "Next", "Back",
    "short statements — tap the answer that fits.",
    "Anything else you'd like to share? (optional)",
    "Optional — share anything you'd like in your own words.",
    "Almost done", "Look over anything you'd like, then send it in. You can still come back with your code and change answers until the survey closes.",
    "Submit my survey", "answered",
    "still need an answer.", "Take me to the first one", "Please answer every question before sending it in.",
    "Translating for you…",
    "Sign in to begin",
    "Your email goes on the finished list so your leader knows who's still missing — it is never connected to your answers. Those stay anonymous, tied only to your personal code.",
    "Please enter a real email address.",
    "Your email — so your leader can tick you off the finished list",
    "Never connected to your answers — they stay anonymous.",
    "Please enter your email so your leader can tick you off the finished list — your answers stay anonymous.",
    "Thank you — your voice is in.", "Your answers are saved. If you'd like to revisit them before the survey closes, use your code:",
    "This survey is closed.", "Thanks for your willingness — this pulse has finished collecting answers. Watch for the next one!",
    "Saving…", "✓ Saved",
  ];
  // Translate in priority order (UI + answer labels first, then the sections
  // this person will actually see), run the chunks in PARALLEL, and merge each
  // chunk into the page the moment it lands — so the screen flips within
  // seconds instead of waiting a minute for everything.
  const [trBusy, setTrBusy] = useState(false);
  const [trNotice, setTrNotice] = useState(false); // "takes about a minute" heads-up
  const routedKey = surveySectionsFor(answers.d || {}).map(s => s.key).join(",");
  useEffect(() => {
    if (!langOn || !lang || !meta || !meta.country) return;
    const routed = surveySectionsFor(answersRef.current.d || {});
    const depts = routed.length ? routed : DEPARTMENTS;
    const wanted = [...SURVEY_UI, ...LIKERT];
    for (const dept of depts) {
      wanted.push(dept.label, dept.openQLabel);
      for (const qq of dept.questions) wanted.push(qq.en);
    }
    const missing = [...new Set(wanted)].filter(x => x && !trMap[x]);
    if (!missing.length) return;
    let alive = true;
    setTrBusy(true);
    const chunks = [];
    for (let i = 0; i < missing.length; i += 35) chunks.push(missing.slice(i, i + 35));
    let pending = chunks.length;
    chunks.forEach(chunk => {
      translateBatch(chunk, lang).then(trs => {
        if (!alive) return;
        const out = {};
        chunk.forEach((x, j) => { if (trs[j]) out[x] = trs[j]; });
        setTrMap(prev => {
          const next = { ...prev, ...out };
          try { localStorage.setItem(`pulse:tr:${lang}`, JSON.stringify(next)); } catch {}
          return next;
        });
      }).catch(e => console.warn("Survey translation failed:", e.message))
        .finally(() => { if (alive && --pending === 0) setTrBusy(false); });
    });
    return () => { alive = false; setTrBusy(false); };
    // eslint-disable-next-line
  }, [langOn, lang, meta && meta.country, routedKey]);

  // Load the survey's identity; auto-resume if this device already has a code.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await surveyApi({ action: "meta", token });
        if (!alive) return;
        setMeta(m);
        if (m.status !== "Open") { setStage("closed"); return; }
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(`pulse:survey:${token}`) || "null"); } catch {}
        if (saved && saved.email) setEmail(saved.email);
        if (saved && saved.code) {
          try {
            const r = await surveyApi({ action: "resume", token, code: saved.code });
            if (!alive) return;
            setCode(r.code);
            const a = { d: {}, a: {}, open: {}, ...(r.answers || {}) };
            setAnswers(a);
            if (r.language && r.language !== "English") setLangOn(true);
            if (r.status === "Completed") setStage("done");
            else {
              const steps = surveyStepsFor(a);
              const idx = surveyFirstUnanswered(steps, a);
              if (idx === null) setStage("review"); else { setStep(idx); setStage("flow"); }
            }
          } catch { /* stale device code — start fresh */ }
        }
      } catch (e) { if (alive) setMeta({ error: e.message }); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [token]);

  const save = async (status) => {
    if (!codeRef.current) return;
    try {
      setSaveNote("saving");
      await surveyApi({ action: "save", token, code: codeRef.current, answers: answersRef.current,
        status, language: langOn && lang ? lang : "English" });
      setSaveNote("saved");
      setTimeout(() => setSaveNote(""), 2000);
    } catch (e) { setSaveNote(""); setErr(e.message); }
  };

  // Sign in first (check-off list), then start — the code and the email live in
  // different tables with nothing joining them.
  const beginWithEmail = async () => {
    const em = String(email).trim().toLowerCase();
    if (!emailOk(em)) { setErr(tr("Please enter a real email address.")); return; }
    setBusy(true); setErr("");
    try {
      await surveyApi({ action: "checkin", token, email: em });
      const r = await surveyApi({ action: "start", token });
      setCode(r.code);
      try { localStorage.setItem(`pulse:survey:${token}`, JSON.stringify({ code: r.code, email: em })); } catch {}
      setStage("code");
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const resume = async () => {
    setBusy(true); setErr("");
    try {
      const r = await surveyApi({ action: "resume", token, code: codeInput });
      setCode(r.code);
      try { localStorage.setItem(`pulse:survey:${token}`, JSON.stringify({ code: r.code, email: String(email).trim().toLowerCase() || undefined })); } catch {}
      const a = { d: {}, a: {}, open: {}, ...(r.answers || {}) };
      setAnswers(a);
      if (r.language && r.language !== "English") setLangOn(true);
      if (r.status === "Completed") setStage("done");
      else {
        const steps = surveyStepsFor(a);
        const idx = surveyFirstUnanswered(steps, a);
        if (idx === null) setStage("review"); else { setStep(idx); setStage("flow"); }
      }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const sections = surveySectionsFor(answers.d);
  const totalQs = sections.reduce((a, dept) => a + dept.questions.length, 0);
  const answeredQs = sections.reduce((a, dept) => a + dept.questions.filter(qq => (answers.a || {})[qq.col] != null).length, 0);

  const setD = (k, v) => setAnswers(prev => ({ ...prev, d: { ...prev.d, [k]: v } }));
  const setA = (col, v) => setAnswers(prev => ({ ...prev, a: { ...prev.a, [col]: v } }));
  const setOpen = (col, v) => setAnswers(prev => ({ ...prev, open: { ...prev.open, [col]: v } }));

  // One step at a time. Answering auto-advances after a beat (the tap needs a
  // moment to show), through refs so the timer always sees fresh state — the
  // step list itself GROWS when a routing answer adds sections.
  const steps = surveyStepsFor(answers);
  const stepsRef = useRef(steps); stepsRef.current = steps;
  const stepRef = useRef(step); stepRef.current = step;
  const advTimer = useRef(null);
  useEffect(() => () => clearTimeout(advTimer.current), []);
  const advance = () => {
    const s = stepRef.current, len = stepsRef.current.length;
    if (s + 1 >= len) setStage("review"); else setStep(s + 1);
    save();
    try { window.scrollTo({ top: 0 }); } catch {}
  };
  const answerThenAdvance = (apply) => {
    apply();
    clearTimeout(advTimer.current);
    advTimer.current = setTimeout(advance, 320);
  };
  const back = () => {
    const s = stepRef.current;
    if (s > 0) setStep(s - 1);
    try { window.scrollTo({ top: 0 }); } catch {}
  };
  const jumpToSection = (si) => {
    const idx = stepsRef.current.findIndex(st => st.type === "section" && st.si === si);
    if (idx >= 0) { setStep(idx); setStage("flow"); }
  };
  const jumpToFirstUnanswered = () => {
    const idx = surveyFirstUnanswered(stepsRef.current, answersRef.current);
    if (idx !== null) { setStep(idx); setStage("flow"); }
  };

  const goTo = (next) => { setStage(next); save(); try { window.scrollTo({ top: 0 }); } catch {} };
  const submit = async () => {
    const em = String(email).trim().toLowerCase();
    if (!emailOk(em)) { setErr(tr("Please enter your email so your leader can tick you off the finished list — your answers stay anonymous.")); return; }
    setBusy(true); setErr("");
    try {
      await surveyApi({ action: "save", token, code, answers, status: "Completed",
        language: langOn && lang ? lang : "English" });
      // Tick their name on the finished list — a separate table, never joined
      // to the answers. If it hiccups, the answers are still safely in.
      try {
        await surveyApi({ action: "checkin", token, email: em, done: true });
        localStorage.setItem(`pulse:survey:${token}`, JSON.stringify({ code, email: em }));
      } catch {}
      setStage("done");
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // ── styling ──
  const page = { minHeight: "100vh", background: "#F6F1E8", fontFamily: "'Inter',system-ui,sans-serif", color: "#2C2621" };
  // Phones get a snug column; computers get a wide, unhurried window with the
  // answers laid out side by side.
  const shell = { maxWidth: isMobile ? 640 : 900, margin: "0 auto", padding: isMobile ? "22px 16px 60px" : "36px 24px 80px" };
  const cardS = { background: "#fff", border: "1px solid #ECE2D2", borderRadius: 16, padding: isMobile ? "20px 18px" : "26px 26px", boxShadow: "0 2px 8px rgba(124,111,224,0.08)" };
  const big = { fontFamily: FONT_DISPLAY, fontSize: isMobile ? 24 : 28, fontWeight: 600, letterSpacing: -0.3 };
  const btn = { fontSize: 14.5, fontWeight: 700, cursor: "pointer", borderRadius: 24, padding: "12px 22px", border: "1px solid transparent", background: "#E0863C", color: "#fff" };
  const btnGhost = { ...btn, background: "#fff", color: "#5A4A3B", border: "1px solid #E2D3C2" };
  const choice = (on) => ({ fontSize: 13.5, fontWeight: 600, cursor: "pointer", borderRadius: 20, padding: "10px 16px", textAlign: "left",
    color: on ? "#fff" : "#5A4A3B", background: on ? "#E0863C" : "#FDFAF4", border: `1px solid ${on ? "#E0863C" : "#E2D3C2"}` });

  const Header = () => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#E0863C", letterSpacing: 3, textTransform: "uppercase" }}>Josiah Venture</div>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 600 }}>{meta && meta.country ? `${meta.country} · ` : ""}{tr("Staff Pulse Survey")}</div>
      </div>
      <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
        {trBusy && <span style={{ fontSize: 11.5, color: "#7A6F63" }}>{tr("Translating for you…")}</span>}
        {saveNote === "saving" && <span style={{ fontSize: 11.5, color: "#7A6F63" }}>{tr("Saving…")}</span>}
        {saveNote === "saved" && <span style={{ fontSize: 11.5, color: "#5C9A6D", fontWeight: 700 }}>{tr("✓ Saved")}</span>}
        {code && <span style={{ fontSize: 11.5, fontWeight: 800, color: "#B96524", background: "#FBEFE4", border: "1px solid #E0A56F", borderRadius: 6, padding: "3px 9px", letterSpacing: 1 }}>{code}</span>}
        {lang && (
          <button onClick={() => setLangOn(v => { if (!v) setTrNotice(true); return !v; })}
            style={{ fontSize: 12, fontWeight: 700, cursor: "pointer", borderRadius: 16, padding: "5px 12px",
              color: langOn ? "#fff" : "#5A4A3B", background: langOn ? "#B96524" : "#FDFAF4",
              border: `1px solid ${langOn ? "#B96524" : "#E2D3C2"}` }}>
            {langOn ? "🌐 English" : `🌐 ${nativeLanguageLabel(lang)}`}
          </button>
        )}
      </span>
    </div>
  );

  if (meta === null) return (
    <div style={page}><div style={shell}><div style={{ ...cardS, textAlign: "center", color: "#7A6F63" }}>Loading…</div></div></div>
  );
  if (meta.error) return (
    <div style={page}><div style={shell}><div style={{ ...cardS, textAlign: "center" }}>
      <div style={big}>Hmm.</div>
      <div style={{ fontSize: 13.5, color: "#7A6F63", marginTop: 8 }}>{meta.error}</div>
    </div></div></div>
  );

  return (
    <div style={page}>
      <style>{"@keyframes svFadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}"}</style>
      <div style={shell}>
        <Header />
        {trNotice && trBusy && langOn && <TranslationPatienceModal onClose={() => setTrNotice(false)} />}
        {(stage === "flow" || stage === "review") && (() => {
          // The timeline: a filling bar, one dot per section, and a running count.
          const pos = stage === "review" ? 100 : (steps.length ? Math.round((step / steps.length) * 100) : 0);
          const cur = steps[Math.min(step, steps.length - 1)] || {};
          return (
            <div style={{ marginBottom: 18 }}>
              <div style={{ height: 6, background: "#EBDECB", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${pos}%`, height: "100%", background: "#5C9A6D", transition: "width .45s ease" }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  {sections.map((dept, i) => {
                    const done = dept.questions.every(qq => (answers.a || {})[qq.col] != null);
                    const here = stage === "flow" && cur.si === i;
                    return <span key={dept.key} title={tr(dept.label)}
                      style={{ width: here ? 11 : 8, height: here ? 11 : 8, borderRadius: "50%",
                        background: here ? "#E0863C" : done ? "#5C9A6D" : "#EBDECB",
                        border: here ? "2px solid #F3C9A2" : "none", transition: "all .3s" }} />;
                  })}
                </span>
                <span style={{ fontSize: 11.5, color: "#7A6F63", marginLeft: "auto", fontWeight: 600 }}>
                  {answeredQs} {tr("of")} {totalQs} {tr("answered")}
                </span>
              </div>
            </div>
          );
        })()}

        {stage === "closed" && (
          <div style={{ ...cardS, textAlign: "center" }}>
            <div style={big}>{tr("This survey is closed.")}</div>
            <div style={{ fontSize: 14, color: "#5A4A3B", marginTop: 10, lineHeight: 1.6 }}>{tr("Thanks for your willingness — this pulse has finished collecting answers. Watch for the next one!")}</div>
          </div>
        )}

        {stage === "welcome" && (
          <div style={cardS}>
            <div style={big}>{tr("Your voice, in confidence")}</div>
            <div style={{ fontSize: 14.5, color: "#5A4A3B", margin: "12px 0 20px", lineHeight: 1.65 }}>
              {tr("Your answers are anonymous. You'll sign in with your email so your leader knows who has finished — but your email is never connected to what you say. You'll also get a short personal code so you can pause and come back later.")}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => { setErr(""); setStage("email"); }} style={btn}>{tr("Start the survey")}</button>
              <button onClick={() => { setErr(""); setStage("resume"); }} style={btnGhost}>{tr("I already have a code")}</button>
            </div>
            {err && <div style={{ color: "#BE6650", fontSize: 13, marginTop: 12 }}>{err}</div>}
          </div>
        )}

        {stage === "email" && (
          <div style={cardS}>
            <div style={big}>{tr("Sign in to begin")}</div>
            <div style={{ fontSize: 13.5, color: "#5A4A3B", margin: "10px 0 16px", lineHeight: 1.65, maxWidth: 520 }}>
              {tr("Your email goes on the finished list so your leader knows who's still missing — it is never connected to your answers. Those stay anonymous, tied only to your personal code.")}
            </div>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") beginWithEmail(); }}
              placeholder="you@josiahventure.com" autoFocus
              style={{ fontSize: 15, width: "100%", maxWidth: 360, boxSizing: "border-box", padding: "11px 13px",
                border: "2px solid #E2D3C2", borderRadius: 10, fontFamily: "inherit", marginBottom: 14, display: "block" }} />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={beginWithEmail} disabled={busy} style={btn}>{busy ? "…" : tr("Continue")}</button>
              <button onClick={() => { setErr(""); setStage("welcome"); }} style={btnGhost}>{tr("Back")}</button>
            </div>
            {err && <div style={{ color: "#BE6650", fontSize: 13, marginTop: 12 }}>{err}</div>}
          </div>
        )}

        {stage === "resume" && (
          <div style={cardS}>
            <div style={big}>{tr("Welcome back")}</div>
            <div style={{ fontSize: 14, color: "#5A4A3B", margin: "10px 0 16px" }}>{tr("Enter your code to pick up where you left off.")}</div>
            <input value={codeInput} onChange={e => setCodeInput(e.target.value.toUpperCase())}
              placeholder="ABC-234" autoFocus
              style={{ fontSize: 22, fontWeight: 800, letterSpacing: 3, textAlign: "center", width: "100%", boxSizing: "border-box",
                padding: "12px 14px", border: "2px solid #E2D3C2", borderRadius: 12, fontFamily: "inherit", marginBottom: 14 }} />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={resume} disabled={busy || !codeInput.trim()} style={btn}>{busy ? "…" : tr("Resume my survey")}</button>
              <button onClick={() => { setErr(""); setStage("welcome"); }} style={btnGhost}>{tr("Back")}</button>
            </div>
            {err && <div style={{ color: "#BE6650", fontSize: 13, marginTop: 12 }}>{err}</div>}
          </div>
        )}

        {stage === "code" && (
          <div style={{ ...cardS, textAlign: "center" }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: 1.5 }}>{tr("Here is your personal code")}</div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 46, fontWeight: 700, letterSpacing: 6, color: "#B96524", margin: "14px 0" }}>{code}</div>
            <div style={{ fontSize: 13.5, color: "#5A4A3B", lineHeight: 1.65, maxWidth: 440, margin: "0 auto 20px" }}>
              {tr("Write it down or take a photo — it's the only way back into your answers if you switch devices. On this device we'll remember it for you.")}
            </div>
            <button onClick={() => { setStep(0); goTo("flow"); }} style={btn}>{tr("Continue")}</button>
          </div>
        )}

        {stage === "flow" && (() => {
          const cur = steps[Math.min(step, steps.length - 1)];
          if (!cur) return null;
          const fade = { animation: "svFadeUp .45s ease both" };
          const kicker = { fontSize: 11.5, fontWeight: 700, color: "#7A6F63", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 };
          const qTitle = { fontFamily: FONT_DISPLAY, fontSize: isMobile ? 20 : 23, fontWeight: 600, lineHeight: 1.4, marginBottom: 18 };
          // Answers stack on a phone; on a wide screen they sit in one row,
          // side by side, which reads gentler across a big window.
          const stack = { display: "flex", flexDirection: isMobile ? "column" : "row", gap: 8, flexWrap: "wrap" };
          const bigChoice = (on) => ({ fontSize: 14.5, fontWeight: 650, cursor: "pointer", borderRadius: 12, padding: "13px 16px",
            textAlign: isMobile ? "left" : "center", flex: isMobile ? undefined : "1 1 0", minWidth: isMobile ? undefined : 120,
            color: on ? "#fff" : "#5A4A3B", background: on ? "#E0863C" : "#FDFAF4",
            border: `1.5px solid ${on ? "#E0863C" : "#E2D3C2"}`, transition: "background .15s,color .15s,border .15s", fontFamily: "inherit", lineHeight: 1.3 });
          const BackBtn = ({ mt = 18 }) => step > 0 ? (
            <button onClick={back} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89C8D",
              fontSize: 12.5, fontWeight: 700, padding: 0, marginTop: mt }}>← {tr("Back")}</button>
          ) : null;

          if (cur.type === "demo") {
            const DEMO_DEFS = {
              culture: { label: "Are you serving cross-culturally (living outside your home culture)?",
                opts: [["Yes — I serve outside my home culture", () => setD("culture", 1), answers.d.culture === 1],
                       ["No — I serve in my home culture", () => setD("culture", 2), answers.d.culture === 2]] },
              marital: { label: "What is your marital status?",
                opts: [["Single", () => setD("marital", "Single"), answers.d.marital === "Single"],
                       ["Married", () => setD("marital", "Married"), answers.d.marital === "Married"],
                       ["Prefer not to say", () => setD("marital", "None"), answers.d.marital === "None"]] },
              kids: { label: "Do you have children living in your household?",
                opts: [["Yes", () => setD("kids", "Yes"), answers.d.kids === "Yes"],
                       ["No", () => setD("kids", "No"), answers.d.kids === "No"]] },
              woman: { label: "Are you a woman?",
                opts: [["Yes", () => setD("woman", true), answers.d.woman === true],
                       ["No", () => setD("woman", false), answers.d.woman === false]] },
            };
            const qd = DEMO_DEFS[cur.k];
            return (
              <div key={`d-${cur.k}`} style={{ ...cardS, ...fade }}>
                <div style={kicker}>{tr("A few quick questions first")}</div>
                <div style={qTitle}>{tr(qd.label)}</div>
                <div style={stack}>
                  {qd.opts.map(([label, apply, on], oi) => (
                    <button key={oi} onClick={() => answerThenAdvance(apply)} style={bigChoice(on)}>{tr(label)}</button>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "#A89C8D", marginTop: 14, lineHeight: 1.55 }}>
                  {tr("These only decide which sections you'll see — they're stored with your answers, never your name.")}
                </div>
                <BackBtn />
              </div>
            );
          }

          if (cur.type === "section") {
            return (
              <div key={`s-${cur.si}`} style={{ ...cardS, ...fade, textAlign: "center" }}>
                <div style={{ ...kicker, marginBottom: 4 }}>{tr("Section")} {cur.si + 1} {tr("of")} {cur.count}</div>
                <div style={{ ...big, margin: "6px 0 8px" }}>{tr(cur.dept.label)}</div>
                <div style={{ fontSize: 13.5, color: "#7A6F63", marginBottom: 20 }}>
                  {cur.dept.questions.length} {tr("short statements — tap the answer that fits.")}
                </div>
                <button onClick={advance} style={btn}>{tr("Continue")}</button>
                <div><BackBtn /></div>
              </div>
            );
          }

          if (cur.type === "q") {
            const qNum = steps.slice(0, step + 1).filter(t => t.type === "q").length;
            const on = (answers.a || {})[cur.qq.col];
            return (
              <div key={`q-${cur.qq.col}`} style={{ ...cardS, ...fade }}>
                <div style={kicker}>{tr(cur.dept.label)} · {tr("Question")} {qNum} {tr("of")} {totalQs}</div>
                <div style={qTitle}>{tr(cur.qq.en)}</div>
                <div style={stack}>
                  {[1, 2, 3, 4, 5].map(v => (
                    <button key={v} onClick={() => answerThenAdvance(() => setA(cur.qq.col, v))} style={bigChoice(on === v)}>
                      {tr(LIKERT[v - 1])}
                    </button>
                  ))}
                </div>
                <BackBtn />
              </div>
            );
          }

          // Open comment — the one step with a Next button, because typing can't auto-advance.
          return (
            <div key={`o-${cur.si}`} style={{ ...cardS, ...fade }}>
              <div style={kicker}>{tr(cur.dept.label)}</div>
              <div style={{ ...qTitle, marginBottom: 8 }}>{tr(cur.dept.openQLabel)}</div>
              <div style={{ fontSize: 12.5, color: "#A89C8D", marginBottom: 12 }}>{tr("Optional — share anything you'd like in your own words.")}</div>
              <textarea rows={4} value={(answers.open || {})[cur.dept.openQ] || ""}
                onChange={e => setOpen(cur.dept.openQ, e.target.value)}
                onBlur={() => save()}
                style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: 12, border: "1px solid #E2D3C2",
                  borderRadius: 10, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} />
              <div style={{ display: "flex", alignItems: "center", marginTop: 14 }}>
                <BackBtn mt={0} />
                <button onClick={advance} style={{ ...btn, marginLeft: "auto" }}>{tr("Next")}</button>
              </div>
            </div>
          );
        })()}

        {stage === "review" && (
          <div style={cardS}>
            <div style={big}>{tr("Almost done")}</div>
            <div style={{ fontSize: 14, color: "#5A4A3B", margin: "10px 0 16px", lineHeight: 1.6 }}>
              {tr("Look over anything you'd like, then send it in. You can still come back with your code and change answers until the survey closes.")}
            </div>
            <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
              {sections.map((dept, i) => {
                const done = dept.questions.filter(qq => (answers.a || {})[qq.col] != null).length;
                const all = dept.questions.length;
                return (
                  <button key={dept.key} onClick={() => jumpToSection(i)}
                    style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left", background: "#FDFAF4",
                      border: "1px solid #ECE2D2", borderRadius: 10, padding: "10px 14px", cursor: "pointer" }}>
                    <span style={{ flex: 1, fontSize: 13.5, fontWeight: 650, color: "#2C2621" }}>{tr(dept.label)}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: done === all ? "#5C9A6D" : "#C08636" }}>
                      {done}/{all} {tr("answered")}
                    </span>
                  </button>
                );
              })}
            </div>
            {!emailOk(email) && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#7A6F63", marginBottom: 5 }}>
                  {tr("Your email — so your leader can tick you off the finished list")}
                </label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@josiahventure.com"
                  style={{ fontSize: 14, width: "100%", maxWidth: 340, boxSizing: "border-box", padding: "10px 12px",
                    border: "1px solid #E2D3C2", borderRadius: 10, fontFamily: "inherit" }} />
                <div style={{ fontSize: 11.5, color: "#A89C8D", marginTop: 4 }}>
                  {tr("Never connected to your answers — they stay anonymous.")}
                </div>
              </div>
            )}
            {answeredQs < totalQs && (
              <div style={{ background: "#FBF3E4", border: "1px solid #E0C48F", borderRadius: 10, padding: "11px 14px", marginBottom: 14,
                fontSize: 13, color: "#8A6A2F", lineHeight: 1.55 }}>
                <b>{totalQs - answeredQs}</b> {tr("still need an answer.")} {tr("Please answer every question before sending it in.")}{" "}
                <button onClick={jumpToFirstUnanswered}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#B96524",
                    fontWeight: 700, fontSize: 13, textDecoration: "underline" }}>
                  {tr("Take me to the first one")}
                </button>
              </div>
            )}
            <button onClick={submit} disabled={busy || answeredQs < totalQs}
              style={{ ...btn, background: "#5C9A6D", opacity: answeredQs < totalQs ? 0.45 : 1, cursor: answeredQs < totalQs ? "default" : "pointer" }}>
              {busy ? "…" : `✓ ${tr("Submit my survey")}`}
            </button>
            {err && <div style={{ color: "#BE6650", fontSize: 13, marginTop: 12 }}>{err}</div>}
          </div>
        )}

        {stage === "done" && (
          <div style={{ ...cardS, textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🌿</div>
            <div style={big}>{tr("Thank you — your voice is in.")}</div>
            <div style={{ fontSize: 13.5, color: "#5A4A3B", margin: "12px auto 8px", lineHeight: 1.6, maxWidth: 440 }}>
              {tr("Your answers are saved. If you'd like to revisit them before the survey closes, use your code:")}
            </div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 30, fontWeight: 700, letterSpacing: 4, color: "#B96524", marginBottom: 6 }}>{code}</div>
            {meta.status === "Open" && (
              <button onClick={() => setStage("review")} style={{ ...btnGhost, marginTop: 10 }}>{tr("Back")}</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
