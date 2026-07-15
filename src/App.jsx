import { useState, useEffect, useCallback, useRef } from "react";
import SURVEY_BASICS from "./surveyBasics.json";

// ─── AIRTABLE CONFIG ─────────────────────────────────────────────────────────
const AT_BASE = "appPulseReportBase"; // replace with real base ID
const AT_KEY = process.env.REACT_APP_ANTHROPIC_KEY || "";                    // injected via Netlify env — leave blank here

// ─── SURVEY STRUCTURE ────────────────────────────────────────────────────────
// Col indices from SurveyPro Raw Data sheet
const ROUTING = { marital: 18, kids: 19, crossCultural: 20, culture: 21 };

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
    route: (r) => r[ROUTING.culture] == 1,
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
    route: (r) => r[ROUTING.culture] == 2,
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
    route: (r) => r[ROUTING.marital] == 1 || r[ROUTING.marital] == 2, // all women — filtered by gender field if available
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
    route: (r) => r[ROUTING.marital] == 1,
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
    route: (r) => r[ROUTING.marital] == 2,
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
    route: (r) => r[ROUTING.kids] == 1 && r[ROUTING.culture] == 2,
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
    route: (r) => r[ROUTING.kids] == 1 && r[ROUTING.culture] == 1,
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
  const statuses = questions.map(q => q.status).filter(Boolean);
  const concerns = statuses.filter(s => s === "Concern").length;
  if (concerns >= 3) return "Concern";
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

  const dataRows = raw.slice(2).filter(r => r[1] === "Completed" || r[1] === "Complete");

  const results = {};

  for (const dept of DEPARTMENTS) {
    const eligible = dataRows.filter(r => {
      try { return dept.route(r); } catch { return true; }
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

    const openResponses = eligible
      .map(r => (r[dept.openQ] || "").toString().trim())
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

// ─── COLOR / STATUS UTILS ─────────────────────────────────────────────────────
const STATUS_COLOR = { Concern:"#C0392B", Watch:"#D68910", Healthy:"#1E8449", null:"#9391B0" };
const STATUS_BG    = { Concern:"#FDF2F2", Watch:"#FFFBEB", Healthy:"#F0FDF4", null:"#FAFAF8" };
const STATUS_BORDER= { Concern:"#FCA5A5", Watch:"#FCD34D", Healthy:"#86EFAC", null:"#E2E8F0" };
const sc = s => STATUS_COLOR[s] || STATUS_COLOR[null];
const sb = s => STATUS_BG[s]    || STATUS_BG[null];
const sbd= s => STATUS_BORDER[s]|| STATUS_BORDER[null];

// ─── CONTENT GENERATION ──────────────────────────────────────────────────────
// Strengths and growth come from Survey Basics (approved source of truth).
// Leadership questions and quote selection use AI since they require reading open responses.
async function generateDeptContent(dept) {
  const basics = SURVEY_BASICS[dept.key] || {};

  // Strengths and growth from Survey Basics file — fixed, consistent, approved
  const strengths = basics.strengths || [];
  const growth    = basics.growth    || [];

  // Leadership questions and quote selection via AI
  let leadershipQs = [];
  let quotes = dept.openResponses.slice(0, 6); // fallback: first 6 responses

  if (dept.openResponses.length > 0) {
    try {
      const prompt = `You are helping prepare a JV (Josiah Venture) Pulse Report for the ${dept.label} department.

Department status: ${dept.status} (avg: ${dept.avg}, n=${dept.n})

Concern questions:
${dept.questions.filter(q=>q.status==='Concern').map(q=>`- ${q.score?.toFixed(2)} "${q.en}"`).join('\n')||'None'}

Watch questions:
${dept.questions.filter(q=>q.status==='Watch').map(q=>`- ${q.score?.toFixed(2)} "${q.en}"`).join('\n')||'None'}

Open responses (verbatim):
${dept.openResponses.map((r,i)=>`${i+1}. "${r}"`).join('\n')}

Return ONLY valid JSON (no markdown):
{
  "leadershipQs": ["3 specific, practical questions for the director based on the data above"],
  "quotes": ["select the 4-6 most representative verbatim responses from the list above — copy exactly, do not paraphrase"]
}`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.REACT_APP_ANTHROPIC_KEY || "",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json();
      const text = data.content?.find(b => b.type === "text")?.text || "{}";
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (parsed.leadershipQs?.length) leadershipQs = parsed.leadershipQs;
      if (parsed.quotes?.length) quotes = parsed.quotes;
    } catch(e) {
      console.warn("AI generation failed for", dept.key, e.message);
    }
  }

  return { strengths, growth, leadershipQs, quotes };
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]           = useState("home");   // home | review | report | dashboard
  const [country, setCountry]     = useState("");
  const [year, setYear]           = useState(new Date().getFullYear().toString());
  const [surveyData, setSurveyData] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState({});
  const [selections, setSelections] = useState({});    // { deptKey: { strengths:[{text,include,rewrite}], ... } }
  const [saved, setSaved]         = useState(false);
  const [dashCountry, setDashCountry] = useState("all");
  const [allRuns, setAllRuns]     = useState([]);       // from storage
  const fileRef = useRef();

  // Load all historical runs from storage
  useEffect(() => {
    (async () => {
      try {
        let r = null; try { const _v = localStorage.getItem("pulse:runs"); r = _v ? {value:_v} : null; } catch(e) {}
        if (r) {
          const loaded = JSON.parse(r.value).map((run, i) => ({
            ...run,
            id: run.id || `${run.country}-${run.year}-${i}`
          }));
          setAllRuns(loaded);
        }
      } catch {}
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

  // Reload selections when country+year change (e.g. opening a previous run)
  useEffect(() => {
    if (!country || !year) return;
    try {
      const raw = localStorage.getItem(`pulse:sel:${country}:${year}`);
      if (raw) setSelections(JSON.parse(raw));
    } catch(e) {}
  }, [country, year]);

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
            return {
              text: t,
              include: true,
              // Pre-fill rewrite with refined version if it exists
              rewrite: refined ? refined.text : "",
              // Flag so UI can show "refined from previous country"
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
      .map(i => i.rewrite.trim() || i.text);

  // ── VIEWS ──────────────────────────────────────────────────────────────────

  if (view === "home") return (
    <HomeView
      country={country} setCountry={setCountry}
      year={year} setYear={setYear}
      fileRef={fileRef} handleFile={handleFile}
      generating={generating} genProgress={genProgress}
      allRuns={allRuns} setAllRuns={setAllRuns} setView={setView}
      setSurveyData={setSurveyData} setSelections={setSelections}
      setCountry2={setCountry} setYear2={setYear}
    />
  );

  if (view === "review") return (
    <ReviewView
      country={country} year={year}
      surveyData={surveyData} selections={selections}
      toggleItem={toggleItem} setRewrite={setRewrite}
      saveSelections={saveSelections} saved={saved}
      saveRefinement={saveRefinement} refinements={refinements}
      setView={setView}
    />
  );

  if (view === "report") return (
    <ReportView
      country={country} year={year}
      surveyData={surveyData} getApproved={getApproved}
      setView={setView}
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

// ─── HOME VIEW ────────────────────────────────────────────────────────────────
function HomeView({ country, setCountry, year, setYear, fileRef, handleFile,
  generating, genProgress, allRuns, setAllRuns, setView, setSurveyData, setSelections,
  setCountry2, setYear2 }) {

  const countries = [...new Set(allRuns.map(r=>r.country))].sort();

  return (
    <div style={{ minHeight:"100vh", background:"#F8F7F4", fontFamily:"'Inter',system-ui,sans-serif" }}>
      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#FFFFFF 0%,#F8F7F4 100%)", borderBottom:"1px solid #EDE9FF", padding:"24px 40px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:3, color:"#FF6600", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Josiah Venture</div>
          <div style={{ fontSize:22, fontWeight:700, color:"#1E1B3A" }}>Pulse Report Platform</div>
        </div>
        <button onClick={() => setView("dashboard")} style={navBtn}>
          P&C Dashboard
        </button>
      </div>

      <div style={{ maxWidth:900, margin:"0 auto", padding:"48px 24px" }}>

        {/* Upload card */}
        <div style={card}>
          <div style={{ fontSize:13, fontWeight:700, color:"#7C6FE0", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>New Survey Run</div>
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
              <div style={{ width:40, height:40, border:"3px solid #7C6FE0", borderTopColor:"transparent", borderRadius:"50%", margin:"0 auto 16px", animation:"spin 1s linear infinite" }} />
              <div style={{ color:"#1E1B3A", fontWeight:600 }}>{genProgress.step || "Processing…"}</div>
              <div style={{ color:"#9391B0", fontSize:12, marginTop:8 }}>This may take a minute while AI generates draft content</div>
            </div>
          ) : (
            <div
              onClick={() => country && year && fileRef.current?.click()}
              style={{
                border:"2px dashed #E2DFF5", borderRadius:12, padding:48,
                textAlign:"center", cursor: country&&year ? "pointer":"not-allowed",
                opacity: country&&year ? 1 : 0.5,
                transition:"border-color 0.2s",
              }}
              onMouseEnter={e => { if(country&&year) e.currentTarget.style.borderColor="#7C6FE0"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor="#E2DFF5"; }}
            >
              <div style={{ fontSize:32, marginBottom:12 }}>📊</div>
              <div style={{ color:"#1E1B3A", fontWeight:600, marginBottom:4 }}>Drop SurveyPro export here</div>
              <div style={{ color:"#9391B0", fontSize:13 }}>or click to browse — .xlsx or .csv</div>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" style={{ display:"none" }}
                onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
            </div>
          )}
        </div>

        {/* Previous runs */}
        {allRuns.length > 0 && (
          <div style={{ marginTop:32 }}>
            <div style={{ fontSize:13, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Previous Runs</div>
            <div style={{ display:"grid", gap:12 }}>
              {allRuns.slice().reverse().map(run => (
                <div key={run.id} style={{ ...card, display:"flex", justifyContent:"space-between", alignItems:"center", padding:"16px 20px" }}>
                  <div>
                    <div style={{ color:"#1E1B3A", fontWeight:600 }}>{run.country} — {run.year}</div>
                    <div style={{ color:"#9391B0", fontSize:12, marginTop:2 }}>{run.depts?.length} departments · {new Date(run.savedAt).toLocaleDateString()}</div>
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    {run.depts?.slice(0,5).map(d => (
                      <span key={d.key} style={{ fontSize:11, fontWeight:700, color:sc(d.status), background:sb(d.status), border:`1px solid ${sbd(d.status)}`, borderRadius:4, padding:"2px 6px" }}>
                        {d.label?.split(" ")[0]}
                      </span>
                    ))}
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button style={navBtn} onClick={() => {
                      setCountry2(run.country); setYear2(run.year);
                      try {
                        let r = null; try { const _v = localStorage.getItem(`pulse:data:${run.country}:${run.year}`); r = _v ? {value:_v} : null; } catch(e) {}
                        let s = null; try { const _v = localStorage.getItem(`pulse:sel:${run.country}:${run.year}`); s = _v ? {value:_v} : null; } catch(e) {}
                        if (r) setSurveyData(JSON.parse(r.value));
                        if (s) setSelections(JSON.parse(s.value));
                        setView("review");
                      } catch {}
                    }}>Open</button>
                    <button style={{ ...navBtn, background:"#C0392B", color:"white" }} onClick={() => {
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
                    }}>Delete</button>
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
function ReviewView({ country, year, surveyData, selections, toggleItem, setRewrite, saveSelections, saved, saveRefinement, refinements, setView }) {
  const [activeDept, setActiveDept] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const depts = surveyData ? Object.values(surveyData.depts).filter(d=>d.n>0) : [];

  useEffect(() => { if (depts.length && !activeDept) setActiveDept(depts[0].key); }, [depts.length]);

  const dept = depts.find(d=>d.key===activeDept);

  return (
    <div style={{ minHeight:"100vh", background:"#F8F7F4", fontFamily:"'Inter',system-ui,sans-serif", display:"flex", flexDirection:"column" }}>
      {/* Top bar */}
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #E2DFF5", padding:"14px 24px", display:"flex", alignItems:"center", gap:16, flexShrink:0 }}>
        <button onClick={()=>setView("home")} style={{ ...navBtn, background:"transparent", border:"1px solid #E2DFF5" }}>← Home</button>
        <div style={{ flex:1 }}>
          <span style={{ color:"#FF6600", fontWeight:700, fontSize:13 }}>{country} {year}</span>
          <span style={{ color:"#9391B0", marginLeft:8, fontSize:13 }}>Director Review</span>
        </div>
        <button onClick={()=>setShowHelp(true)} style={{ ...navBtn, background:"white",
          border:"1px solid #E2DFF5", color:"#7C6FE0", fontWeight:700 }}>
          ? How scoring works
        </button>
        <button onClick={saveSelections} style={{ ...navBtn, background: saved?"#1E8449":"#7C6FE0" }}>
          {saved ? "✓ Saved" : "Save Progress"}
        </button>
        <button onClick={()=>setView("report")} style={{ ...navBtn, background:"#9B8FE8" }}>
          Generate Report →
        </button>
      </div>

      {showHelp && <ScoringHelpPanel onClose={()=>setShowHelp(false)} />}
      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>
        {/* Sidebar */}
        <div style={{ width:220, background:"#FFFFFF", borderRight:"1px solid #E2DFF5", overflowY:"auto", flexShrink:0 }}>
          {depts.map(d => (
            <button key={d.key} onClick={()=>setActiveDept(d.key)}
              style={{
                display:"block", width:"100%", textAlign:"left",
                padding:"12px 16px", background: activeDept===d.key ? "#F8F7F4" : "transparent",
                border:"none", borderLeft: activeDept===d.key ? "3px solid #7C6FE0" : "3px solid transparent",
                cursor:"pointer",
              }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ width:8, height:8, borderRadius:"50%", background:sc(d.status), flexShrink:0 }} />
                <span style={{ color: activeDept===d.key ? "#1E1B3A":"#6B6894", fontSize:13, fontWeight: activeDept===d.key?600:400 }}>{d.label}</span>
              </div>
              <div style={{ color:"#7B78A0", fontSize:11, marginLeft:16, marginTop:2 }}>{d.avg} · {d.n} respondents</div>
            </button>
          ))}
        </div>

        {/* Main panel */}
        <div style={{ flex:1, overflowY:"auto", padding:24 }}>
          {dept && selections[dept.key] && (
            <DeptReviewPanel
              dept={dept} sel={selections[dept.key]}
              toggleItem={toggleItem} setRewrite={setRewrite}
              saveRefinement={saveRefinement} refinements={refinements}
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
            fontSize:20, color:"#9391B0", lineHeight:1, padding:"0 4px" }}>✕</button>
        </div>

        {/* MEAN vs DIST */}
        <div style={{ fontSize:11, fontWeight:700, color:"#9391B0", textTransform:"uppercase",
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
          <div style={{ fontSize:11, fontWeight:700, color:"#9391B0", textTransform:"uppercase",
            letterSpacing:1.5, marginBottom:10 }}>Why it matters — the same responses, two different answers</div>
          <div style={{ fontSize:12, color:"#1E1B3A", fontWeight:600, marginBottom:10 }}>
            9 single staff respond to: "My practical needs are adequately supported."
          </div>
          <div style={{ display:"flex", gap:6, marginBottom:12, alignItems:"flex-end", height:44 }}>
            {[[0,"#E5E7EB"],[1,"#E24B4A"],[5,"#D4A0B0"],[3,"#639922"],[0,"#E5E7EB"]].map(([c,col],i)=>(
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
        <div style={{ fontSize:11, fontWeight:700, color:"#9391B0", textTransform:"uppercase",
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
          <div style={{ fontSize:11, fontWeight:700, color:"#9391B0", textTransform:"uppercase",
            letterSpacing:1.5, marginBottom:10 }}>Status thresholds</div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr style={{ borderBottom:"1px solid #E5E7EB" }}>
                {["Status","Mean","Dist"].map(h=>(
                  <th key={h} style={{ textAlign:"left", padding:"4px 8px", fontSize:10,
                    fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:.5 }}>{h}</th>
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
          background:"#7C6FE0", color:"white", border:"none", borderRadius:8,
          fontSize:13, fontWeight:700, cursor:"pointer" }}>
          Got it — back to the review
        </button>
      </div>
    </div>
  );
}

function DeptReviewPanel({ dept, sel, toggleItem, setRewrite, saveRefinement, refinements }) {
  const sections = [
    { key:"strengths",    label:"✓ Strengths",            color:"#1E8449", instruction:"Check to include. Uncheck to exclude. Click Edit to revise wording — it will appear exactly as written in the report." },
    { key:"growth",       label:"→ Growth areas",         color:"#D68910", instruction:"Check to include. Click Edit to revise wording." },
    { key:"leadershipQs", label:"? Leadership questions", color:"#3B3882", instruction:"Check to include. Select 1–2 maximum. Click Edit to revise." },
    { key:"quotes",       label:"" Staff quotes",         color:"#4B5563", instruction:"Check to include. Up to 4 quotes appear verbatim. Edit only to correct a translation." },
  ];

  return (
    <div>
      {/* Dept header */}
      <div style={{ marginBottom:24 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8 }}>
          <div style={{ fontSize:20, fontWeight:700, color:"#1E1B3A" }}>{dept.label}</div>
          <span style={{ fontSize:12, fontWeight:700, color:sc(dept.status), background:sb(dept.status), border:`1px solid ${sbd(dept.status)}`, borderRadius:6, padding:"3px 10px" }}>{dept.status}</span>
          <span style={{ color:"#9391B0", fontSize:13 }}>{dept.avg} avg · n={dept.n}</span>
        </div>



        {/* Heatmap — Question Scores */}
        <div style={{ background:"#FFFFFF", border:"1px solid #E2DFF5", borderRadius:10, overflow:"hidden", marginBottom:0 }}>
          {/* Column headers */}
          <div style={{ display:"grid", gridTemplateColumns:"90px 52px 60px 1fr 52px 290px", gap:0,
            background:"#F5F3FF", borderBottom:"2px solid #E2DFF5", padding:"7px 12px",
            fontSize:10, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:1.5 }}>
            <span>Section</span>
            <span>Score</span>
            <span>Status</span>
            <span>Full Question Text</span>
            <span style={{textAlign:"center"}}>Scale</span>
            <span style={{textAlign:"center"}}>Heatmap — SD · D · U · A · SA</span>
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
              ? ["#1E8449","#5DBB8A","#BEBEBE","#E87F7F","#C0392B"] // SD=green, SA=red (burden inverted)
              : ["#C0392B","#E87F7F","#BEBEBE","#5DBB8A","#1E8449"]; // SD=red, SA=green
            const CELL_TEXT   = q.burden
              ? ["white","white","white","white","white"]
              : ["white","white","white","white","white"];
            const LABELS = ["SD","D","U","A","SA"];
            // Status row background
            const statusRowBg = {Concern:"#FDF2F2", Watch:"#FFFBEB", Healthy:"#F0FDF4"}[q.status] || "#F8F8F8";

            return (
              <div key={i} style={{ borderBottom:"1px solid #F0EEFF" }}>
                {/* Main row */}
                <div style={{ display:"grid", gridTemplateColumns:"90px 52px 60px 1fr 52px 290px",
                  gap:0, alignItems:"stretch", background: i%2===0?"#FFFFFF":"#FAFAF8" }}>
                  {/* Section type (Q or Burden) */}
                  <div style={{ padding:"10px 8px", display:"flex", alignItems:"center",
                    background: q.burden ? "#FFF8E1" : "#F5F3FF",
                    borderRight:"1px solid #E2DFF5" }}>
                    <span style={{ fontSize:10, fontWeight:700,
                      color: q.burden ? "#B45309" : "#7B78A0" }}>
                      {q.burden ? "Burden
[inv.]" : "Q"}
                    </span>
                  </div>
                  {/* Score */}
                  <div style={{ padding:"10px 8px", display:"flex", alignItems:"center",
                    background:statusRowBg, borderRight:"1px solid #E2DFF5" }}>
                    <span style={{ fontSize:13, fontWeight:800, color:sc(q.status) }}>{q.score?.toFixed(2)}</span>
                  </div>
                  {/* Status */}
                  <div style={{ padding:"10px 6px", display:"flex", alignItems:"center", justifyContent:"center",
                    background:statusRowBg, borderRight:"1px solid #E2DFF5" }}>
                    <span style={{ fontSize:9, fontWeight:700, color:sc(q.status),
                      background:sb(q.status), border:`1px solid ${sbd(q.status)}`,
                      borderRadius:4, padding:"2px 5px", textAlign:"center" }}>{q.status}</span>
                  </div>
                  {/* Question text + Survey Basics inline */}
                  <div style={{ padding:"10px 12px", verticalAlign:"top",
                    borderRight:"1px solid #E2DFF5" }}>
                    <div style={{ fontSize:12, color:"#1E1B3A", lineHeight:1.5, marginBottom:6 }}>
                      {q.en}{q.burden ? <span style={{ color:"#B45309", fontSize:10, marginLeft:4 }}>[Burden]</span> : ""}
                    </div>
                    {(() => {
                      const basics = SURVEY_BASICS[dept.key] || {};
                      const interps = basics.q_interpretations || {};
                      const match = Object.entries(interps).find(([k]) =>
                        q.en.toLowerCase().startsWith(k.toLowerCase().slice(0,40)));
                      if (!match) return null;
                      const editId = `sbedit-${dept.key}-${i}`;
                      return (
                        <div>
                          <div style={{ display:"flex", alignItems:"flex-start", gap:6,
                            background:"#F8F7F4", borderRadius:5, padding:"5px 8px" }}>
                            <span style={{ fontSize:9, fontWeight:700, color:"#9391B0",
                              textTransform:"uppercase", letterSpacing:.5,
                              whiteSpace:"nowrap", paddingTop:1, flexShrink:0 }}>Survey Basics</span>
                            <span style={{ fontSize:11, color:"#6B6894", fontStyle:"italic",
                              lineHeight:1.4, flex:1 }}>{match[1].interpretation}</span>
                            <button
                              onClick={() => {
                                const el = document.getElementById(editId);
                                if (el) el.style.display = el.style.display === "block" ? "none" : "block";
                              }}
                              style={{ fontSize:10, color:"#7C6FE0", background:"#EDE9FF",
                                border:"0.5px solid #AFA9EC", borderRadius:4, padding:"2px 8px",
                                cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>
                              Edit
                            </button>
                          </div>
                          <div id={editId} style={{ display:"none", marginTop:5 }}>
                            <textarea
                              placeholder="Type your own interpretation if this doesn't match what you see on your team."
                              style={{ width:"100%", border:"0.5px solid #D6D2EF", borderRadius:5,
                                padding:"6px 8px", fontSize:11, color:"#1E1B3A",
                                background:"white", resize:"vertical", minHeight:44,
                                fontFamily:"inherit", lineHeight:1.5 }}
                            />
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                  {/* Scale */}
                  <div style={{ padding:"10px 6px", display:"flex", alignItems:"center", justifyContent:"center",
                    borderRight:"1px solid #E2DFF5" }}>
                    <span style={{ fontSize:10, fontWeight:700, color:"#7B78A0",
                      background:"#F5F3FF", borderRadius:4, padding:"2px 6px" }}>
                      {q.scale.toUpperCase()}
                    </span>
                  </div>
                  {/* Heatmap cells — one per response option */}
                  <div style={{ display:"flex", alignItems:"center", padding:"8px 10px", gap:6 }}>
                    {counts.map((c, ci) => (
                      <div key={ci} style={{ flex:1, display:"flex", flexDirection:"column",
                        alignItems:"center", gap:2 }}>
                        {/* Coloured cell with count */}
                        <div style={{
                          width:"100%", minHeight:32,
                          background: c > 0 ? CELL_COLORS[ci] : "#F0EEFF",
                          borderRadius:5,
                          display:"flex", alignItems:"center", justifyContent:"center",
                          fontSize:14, fontWeight:800,
                          color: c > 0 ? "white" : "#D6D2EF",
                          border: c > 0 ? "none" : "1px solid #E2DFF5",
                          transition:"background 0.2s",
                        }}>
                          {c}
                        </div>
                        {/* Label */}
                        <div style={{ fontSize:9, fontWeight:700, color:"#9391B0", textAlign:"center" }}>
                          {LABELS[ci]}
                        </div>
                        {/* Percentage */}
                        <div style={{ fontSize:9, color:"#B0ADCC", textAlign:"center" }}>
                          {c > 0 ? Math.round(c/n*100)+"%" : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      </div>

      {/* Sections */}
      {sections.map(sec => (
        <div key={sec.key} style={{ marginBottom:20, background:"#FFFFFF", borderRadius:10, overflow:"hidden" }}>
          <div style={{ padding:"12px 16px", borderBottom:"1px solid #E2DFF5" }}>
            <div style={{ color:sec.color, fontWeight:700, fontSize:13 }}>{sec.label}</div>
            <div style={{ color:"#9391B0", fontSize:11, marginTop:2 }}>{sec.instruction}</div>
          </div>
          {(sel[sec.key] || []).map((item, idx) => {
            const editId = `item-edit-${dept.key}-${sec.key}-${idx}`;
            return (
              <div key={idx} style={{ borderBottom:"1px solid #F0EEFF",
                background: item.include ? "white" : "#FAF9FE",
                opacity: item.include ? 1 : 0.6 }}>
                {/* Main row — tight, single line */}
                <div style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 14px" }}>
                  <input type="checkbox" checked={item.include}
                    onChange={() => toggleItem(dept.key, sec.key, idx)}
                    style={{ flexShrink:0, cursor:"pointer", accentColor:"#7C6FE0",
                      width:15, height:15 }} />
                  <span style={{ flex:1, fontSize:12, lineHeight:1.5,
                    color: item.include ? "#1E1B3A" : "#9391B0",
                    textDecoration: item.include ? "none" : "line-through" }}>
                    {item.rewrite.trim() || item.text}
                    {item.isRefined && !item.rewrite && (
                      <span style={{ marginLeft:8, fontSize:9, color:"#8B85E8",
                        fontWeight:600, background:"#EDE9FF", borderRadius:4,
                        padding:"1px 5px" }}>✦ refined</span>
                    )}
                  </span>
                  {item.include && (
                    <button
                      onClick={() => {
                        const el = document.getElementById(editId);
                        if (!el) return;
                        const opening = el.style.display !== "block";
                        el.style.display = opening ? "block" : "none";
                      }}
                      style={{ fontSize:10, color:"#7C6FE0", background:"#EDE9FF",
                        border:"0.5px solid #AFA9EC", borderRadius:5, padding:"3px 9px",
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
                      style={{ width:"100%", background:"#F5F3FF", border:"0.5px solid #D6D2EF",
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
            <div style={{ padding:"16px", color:"#7B78A0", fontSize:13, fontStyle:"italic" }}>No items generated for this section.</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── REPORT VIEW ──────────────────────────────────────────────────────────────
function ReportView({ country, year, surveyData, getApproved, setView }) {
  const [activeDept, setActiveDept] = useState(null);
  const depts = surveyData ? Object.values(surveyData.depts)
    .filter(d=>d.n>0)
    .sort((a,b) => a.avg-b.avg) : [];

  const concerns = depts.filter(d=>d.status==="Concern");
  const watches  = depts.filter(d=>d.status==="Watch");
  const healthys = depts.filter(d=>d.status==="Healthy");
  const overallAvg = depts.length ? (depts.reduce((a,d)=>a+d.avg,0)/depts.length).toFixed(2) : "—";
  const totalN = depts.reduce((a,d)=>a+d.n,0);

  const activeDeptData = activeDept ? depts.find(d=>d.key===activeDept) : null;

  return (
    <div style={{ minHeight:"100vh", background:"#F8F7F4", fontFamily:"'Inter',system-ui,sans-serif" }}>
      {/* Toolbar */}
      <div className="no-print" style={{ background:"white", borderBottom:"1px solid #E2DFF5", padding:"12px 24px", display:"flex", gap:12, alignItems:"center", position:"sticky", top:0, zIndex:10 }}>
        <button onClick={()=>setView("review")} style={{ ...navBtn, background:"transparent", border:"1px solid #E2DFF5" }}>← Director Review</button>
        <div style={{ flex:1, color:"#FF6600", fontWeight:700, fontSize:13, letterSpacing:1 }}>
          JOSIAH VENTURE · {country.toUpperCase()} {year}
        </div>
        <button onClick={()=>window.print()} style={{ ...navBtn, background:"#FF6600", color:"white" }}>Download PDF</button>
      </div>

      <div style={{ maxWidth:960, margin:"0 auto", padding:"40px 24px" }}>

        {/* ── SUMMARY PAGE ── */}
        <div style={{ background:"white", borderRadius:16, padding:40, marginBottom:32, border:"1px solid #E2DFF5", boxShadow:"0 2px 8px rgba(124,111,224,0.08)" }}>

          {/* Header */}
          <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:32, paddingBottom:24, borderBottom:"2px solid #F5F3FF" }}>
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:"#FF6600", letterSpacing:3, textTransform:"uppercase", marginBottom:8 }}>Josiah Venture</div>
              <div style={{ fontSize:32, fontWeight:800, color:"#1E1B3A", marginBottom:4 }}>{country} Staff Pulse Report</div>
              <div style={{ fontSize:15, color:"#9391B0" }}>{year} · {totalN} respondents across {depts.length} departments</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:42, fontWeight:800, color:sc(overallAvg>=3.5?"Healthy":overallAvg>=2.5?"Watch":"Concern") }}>{overallAvg}</div>
              <div style={{ fontSize:11, color:"#9391B0", marginTop:2 }}>Overall avg</div>
            </div>
          </div>

          {/* Score bar chart — all departments */}
          <div style={{ marginBottom:32 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Department Scores</div>
            {depts.map(d => (
              <div key={d.key} onClick={()=>setActiveDept(d.key===activeDept?null:d.key)}
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
                <div style={{ color:"#9391B0", fontSize:11, width:40, textAlign:"right" }}>n={d.n}</div>
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
          {depts.map(d=>(
            <button key={d.key} onClick={()=>setActiveDept(d.key===activeDept?null:d.key)}
              style={{ padding:"8px 14px", borderRadius:8, fontSize:12, fontWeight:600,
                cursor:"pointer", border:`1px solid ${activeDept===d.key ? sbd(d.status) : "#E2DFF5"}`,
                background: activeDept===d.key ? sb(d.status) : "white",
                color: activeDept===d.key ? sc(d.status) : "#1E1B3A" }}>
              {d.label}
            </button>
          ))}
        </div>

        {/* ── DEPT DETAIL PAGES ── */}
        {activeDept ? (
          // Single dept selected — show just that one
          <DeptReportPage dept={activeDeptData} getApproved={getApproved} />
        ) : (
          // No tab selected — show all for print
          <div>
            <div className="no-print" style={{ textAlign:"center", color:"#9391B0", fontSize:13, padding:"16px 0 32px" }}>
              Select a department above to focus, or download PDF to get the full report.
            </div>
            <div className="print-only">
              {depts.map(dept => <DeptReportPage key={dept.key} dept={dept} getApproved={getApproved} />)}
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

function DeptReportPage({ dept, getApproved }) {
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
      border:"1px solid #E2DFF5", boxShadow:"0 2px 8px rgba(124,111,224,0.07)",
      pageBreakInside:"avoid" }}>

      {/* Dept header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between",
        paddingBottom:20, marginBottom:24, borderBottom:`2px solid ${statusBd}` }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:"#1E1B3A", marginBottom:4 }}>{dept.label}</div>
          <div style={{ fontSize:13, color:"#9391B0" }}>n = {dept.n} respondents</div>
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
        <div style={{ fontSize:10, fontWeight:700, color:"#9391B0", textTransform:"uppercase",
          letterSpacing:2, marginBottom:10 }}>Question Scores — Concern · Watch · Healthy</div>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
          <thead>
            <tr style={{ background:"#F5F3FF", borderRadius:6 }}>
              <th style={{ textAlign:"left", padding:"8px 10px", color:"#9391B0", fontWeight:600, borderRadius:"6px 0 0 6px" }}>Question</th>
              <th style={{ textAlign:"center", padding:"8px 10px", color:"#9391B0", fontWeight:600, width:55 }}>Score</th>
              <th style={{ textAlign:"center", padding:"8px 10px", color:"#9391B0", fontWeight:600, width:75 }}>Status</th>
              <th style={{ textAlign:"center", padding:"8px 10px", color:"#9391B0", fontWeight:600, width:45, borderRadius:"0 6px 6px 0" }}>Scale</th>
            </tr>
          </thead>
          <tbody>
            {[...dept.questions].sort((a,b)=>{
              const o={Concern:0,Watch:1,Healthy:2};
              return (o[a.status]??1)-(o[b.status]??1) || a.score-b.score;
            }).map((q,i)=>(
              <tr key={i} style={{ borderBottom:"1px solid #F5F3FF" }}>
                <td style={{ padding:"8px 10px", color:"#1E1B3A", lineHeight:1.5 }}>
                  {q.en}{q.burden ? <span style={{ color:"#9391B0", fontSize:10 }}> [Burden]</span> : ""}
                </td>
                <td style={{ textAlign:"center", padding:"8px 10px", fontWeight:700, color:sc(q.status) }}>{q.score?.toFixed(2)}</td>
                <td style={{ textAlign:"center", padding:"8px 10px" }}>
                  <span style={{ fontSize:10, fontWeight:700, color:sc(q.status), background:sb(q.status),
                    border:`1px solid ${sbd(q.status)}`, borderRadius:4, padding:"2px 6px" }}>{q.status}</span>
                </td>
                <td style={{ textAlign:"center", padding:"8px 10px", color:"#9391B0", fontSize:10 }}>{q.scale.toUpperCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Leadership Questions */}
      {leadershipQs.length > 0 && (
        <div style={{ background:"#F0EEFF", borderRadius:10, padding:20, marginBottom:24,
          border:"1px solid #D6D2EF" }}>
          <div style={{ fontSize:10, fontWeight:700, color:"#3B3882", textTransform:"uppercase",
            letterSpacing:2, marginBottom:12 }}>Questions for leadership</div>
          {leadershipQs.map((q,i) => (
            <div key={i} style={{ display:"flex", gap:12, marginBottom:10, alignItems:"flex-start" }}>
              <span style={{ background:"#7C6FE0", color:"white", borderRadius:"50%", width:20, height:20,
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
          <div style={{ fontSize:10, fontWeight:700, color:"#9391B0", textTransform:"uppercase",
            letterSpacing:2, marginBottom:12 }}>What staff said</div>
          <div style={{ display:"grid", gridTemplateColumns: quotes.length > 1 ? "1fr 1fr" : "1fr", gap:12 }}>
            {quotes.map((q,i) => (
              <div key={i} style={{ background:"#F8F7F4", borderLeft:"3px solid #D6D2EF",
                borderRadius:"0 8px 8px 0", padding:"12px 16px", fontSize:13,
                color:"#1E1B3A", lineHeight:1.7, fontStyle:"italic" }}>
                "{q}"
              </div>
            ))}
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
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #E2DFF5", padding:"14px 24px", display:"flex", alignItems:"center", gap:16 }}>
        <button onClick={()=>setView("home")} style={{ ...navBtn, background:"transparent", border:"1px solid #E2DFF5" }}>← Home</button>
        <div style={{ flex:1, color:"#1E1B3A", fontWeight:700 }}>P&C Dashboard</div>
        <select value={dashCountry} onChange={e=>setDashCountry(e.target.value)}
          style={{ background:"#F8F7F4", border:"1px solid #E2DFF5", borderRadius:6, color:"#1E1B3A", padding:"6px 12px", fontSize:13 }}>
          <option value="all">All Countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"32px 24px" }}>

        {/* JV-wide overview grid */}
        {dashCountry === "all" && (
          <>
            <div style={{ fontSize:13, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Latest Results by Country</div>
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
                        <div style={{ color:"#9391B0", fontSize:12 }}>{run.year}</div>
                      </div>
                      <span style={{ fontSize:11, fontWeight:700, color:sc(overallStatus), background:sb(overallStatus), border:`1px solid ${sbd(overallStatus)}`, borderRadius:6, padding:"3px 10px" }}>{overallStatus}</span>
                    </div>
                    <div style={{ display:"flex", gap:12 }}>
                      {[["Concern",concern,"#C0392B"],["Watch",watch,"#D68910"],["Healthy",healthy,"#1E8449"]].map(([l,n,c])=>(
                        <div key={l} style={{ flex:1, textAlign:"center", background:"#FFFFFF", borderRadius:8, padding:"10px 4px" }}>
                          <div style={{ fontSize:22, fontWeight:800, color:c }}>{n}</div>
                          <div style={{ fontSize:10, color:"#9391B0" }}>{l}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Cross-country dept heatmap */}
            <div style={{ fontSize:13, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Department Health — All Countries</div>
            <div style={{ background:"#FFFFFF", borderRadius:12, overflow:"hidden", marginBottom:40 }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid #E2DFF5" }}>
                    <th style={{ textAlign:"left", padding:"12px 16px", color:"#9391B0" }}>Department</th>
                    {Object.keys(latestByCountry).map(c => (
                      <th key={c} style={{ textAlign:"center", padding:"12px 10px", color:"#9391B0", fontWeight:600 }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DEPTS_ORDER.map(dk => (
                    <tr key={dk} style={{ borderBottom:"1px solid #E2DFF5" }}>
                      <td style={{ padding:"10px 16px", color:"#6B6894", fontWeight:500 }}>{dk}</td>
                      {Object.values(latestByCountry).map(run => {
                        const d = run.depts?.find(dep=>dep.key===dk||dep.group===dk);
                        return (
                          <td key={run.country} style={{ textAlign:"center", padding:"10px" }}>
                            {d ? (
                              <span style={{ fontSize:11, fontWeight:700, color:sc(d.status), background:sb(d.status), borderRadius:4, padding:"2px 8px" }}>{d.avg}</span>
                            ) : <span style={{ color:"#E2DFF5" }}>—</span>}
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
            <div style={{ fontSize:13, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>{dashCountry} — Department Health</div>
            {(runsByCountry[dashCountry]||[]).map(run => (
              <div key={run.id} style={{ marginBottom:32 }}>
                <div style={{ color:"#7C6FE0", fontWeight:700, fontSize:13, marginBottom:12 }}>{run.year}</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))", gap:12 }}>
                  {(run.depts||[]).sort((a,b)=>a.avg-b.avg).map(d => (
                    <div key={d.key} style={{ background:"#FFFFFF", borderRadius:10, padding:"14px 16px", border:`1px solid ${sbd(d.status)}` }}>
                      <div style={{ color:"#6B6894", fontSize:11, marginBottom:6 }}>{d.label}</div>
                      <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                        <span style={{ fontSize:22, fontWeight:800, color:sc(d.status) }}>{d.avg}</span>
                        <span style={{ fontSize:10, fontWeight:700, color:sc(d.status) }}>{d.status}</span>
                      </div>
                      <div style={{ color:"#7B78A0", fontSize:10, marginTop:4 }}>n={d.n}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Trend chart (text-based for now) */}
            {(runsByCountry[dashCountry]||[]).length > 1 && (
              <div style={{ background:"#FFFFFF", borderRadius:12, padding:20, marginTop:24 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:1.5, marginBottom:16 }}>Trend — Year over Year</div>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                  <thead>
                    <tr style={{ borderBottom:"1px solid #E2DFF5" }}>
                      <th style={{ textAlign:"left", padding:"8px 12px", color:"#9391B0" }}>Department</th>
                      {[...(runsByCountry[dashCountry]||[])].sort((a,b)=>a.year-b.year).map(r=>(
                        <th key={r.year} style={{ textAlign:"center", padding:"8px 12px", color:"#9391B0" }}>{r.year}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DEPTS_ORDER.map(dk => {
                      const rows = [...(runsByCountry[dashCountry]||[])].sort((a,b)=>a.year-b.year)
                        .map(r => r.depts?.find(d=>d.key===dk||d.group===dk));
                      if (rows.every(r=>!r)) return null;
                      return (
                        <tr key={dk} style={{ borderBottom:"1px solid #E2DFF5" }}>
                          <td style={{ padding:"8px 12px", color:"#6B6894" }}>{dk}</td>
                          {rows.map((d,i)=>(
                            <td key={i} style={{ textAlign:"center", padding:"8px 12px" }}>
                              {d ? (
                                <span style={{ fontWeight:700, color:sc(d.status) }}>{d.avg}</span>
                              ) : <span style={{ color:"#E2DFF5" }}>—</span>}
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
            <div style={{ background:"#FFFFFF", borderRadius:12, padding:24, marginTop:24, border:"1px dashed #E2DFF5" }}>
              <div style={{ fontSize:11, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:1.5, marginBottom:8 }}>OKR Integration</div>
              <div style={{ color:"#7B78A0", fontSize:13 }}>Key Results tied to staff health metrics will appear here once OKR system integration is connected.</div>
            </div>
          </>
        )}
      {/* Refinements manager — always visible in P&C view */}
      <div style={{ marginTop:32 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:2 }}>
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
          <div style={{ color:"#7B78A0", fontSize:13, fontStyle:"italic" }}>
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
                      <span style={{ fontSize:10, fontWeight:700, color:"#8B85E8", background:"#EDE9FF", borderRadius:4, padding:"2px 8px" }}>{deptKey}</span>
                      <span style={{ fontSize:10, fontWeight:700, color:"#9391B0", background:"#F8F7F4", borderRadius:4, padding:"2px 8px" }}>{section}</span>
                      <span style={{ fontSize:10, color:"#7B78A0" }}>#{parseInt(idx)+1}</span>
                    </div>
                    <div style={{ color:"#1E1B3A", fontSize:13, lineHeight:1.5 }}>{val.text}</div>
                    <div style={{ color:"#7B78A0", fontSize:10, marginTop:4 }}>Saved {new Date(val.savedAt).toLocaleDateString()}</div>
                  </div>
                  <button onClick={() => {
                    const updated = { ...refinements };
                    delete updated[key];
                    setRefinements(updated);
                    try { localStorage.setItem("pulse:refinements", JSON.stringify(updated)); } catch {}
                  }} style={{ color:"#9391B0", background:"none", border:"none", cursor:"pointer", fontSize:16, lineHeight:1 }}>×</button>
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
  border:"1px solid #E2DFF5",
  boxShadow:"0 1px 4px rgba(124,111,224,0.07)",
};
const navBtn = {
  background:"#EDE9FF", border:"none", borderRadius:8,
  color:"#1E1B3A", padding:"8px 16px", fontSize:13, fontWeight:600,
  cursor:"pointer",
};
const lbl = { display:"block", fontSize:11, fontWeight:700, color:"#9391B0", textTransform:"uppercase", letterSpacing:1, marginBottom:6 };
const inp = { width:"100%", background:"#F8F7F4", border:"1px solid #E2DFF5", borderRadius:8, padding:"10px 14px", color:"#1E1B3A", fontSize:14, boxSizing:"border-box" };
