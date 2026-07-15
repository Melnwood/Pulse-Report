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
const STATUS_COLOR = { Concern:"#B91C1C", Watch:"#B45309", Healthy:"#166534", null:"#64748B" };
const STATUS_BG    = { Concern:"#FEF2F2", Watch:"#FFFBEB", Healthy:"#F0FDF4", null:"#F8FAFC" };
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
        if (r) setAllRuns(JSON.parse(r.value));
      } catch {}
    })();
  }, []);

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
      for (let i=0; i<depts.length; i++) {
        const d = depts[i];
        setGenProgress({ step: `Generating content for ${d.label} (${i+1}/${depts.length})…` });
        const gen = await generateDeptContent(d, country);
        sels[d.key] = {
          strengths:     (gen.strengths    || []).map(t => ({ text:t, include:true,  rewrite:"" })),
          growth:        (gen.growth       || []).map(t => ({ text:t, include:true,  rewrite:"" })),
          leadershipQs:  (gen.leadershipQs || []).map(t => ({ text:t, include:true,  rewrite:"" })),
          quotes:        (gen.quotes       || []).map(t => ({ text:t, include:true,  rewrite:"" })),
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
      allRuns={allRuns} setView={setView}
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
    />
  );
}

// ─── HOME VIEW ────────────────────────────────────────────────────────────────
function HomeView({ country, setCountry, year, setYear, fileRef, handleFile,
  generating, genProgress, allRuns, setView, setSurveyData, setSelections,
  setCountry2, setYear2 }) {

  const countries = [...new Set(allRuns.map(r=>r.country))].sort();

  return (
    <div style={{ minHeight:"100vh", background:"#0F172A", fontFamily:"'Inter',system-ui,sans-serif" }}>
      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#1E293B 0%,#0F172A 100%)", borderBottom:"1px solid #1E3A5F", padding:"24px 40px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:11, letterSpacing:3, color:"#3B82F6", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>Josiah Venture</div>
          <div style={{ fontSize:22, fontWeight:700, color:"white" }}>Pulse Report Platform</div>
        </div>
        <button onClick={() => setView("dashboard")} style={navBtn}>
          P&C Dashboard
        </button>
      </div>

      <div style={{ maxWidth:900, margin:"0 auto", padding:"48px 24px" }}>

        {/* Upload card */}
        <div style={card}>
          <div style={{ fontSize:13, fontWeight:700, color:"#3B82F6", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>New Survey Run</div>
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
            <div style={{ background:"#1E293B", borderRadius:12, padding:24, textAlign:"center" }}>
              <div style={{ width:40, height:40, border:"3px solid #3B82F6", borderTopColor:"transparent", borderRadius:"50%", margin:"0 auto 16px", animation:"spin 1s linear infinite" }} />
              <div style={{ color:"white", fontWeight:600 }}>{genProgress.step || "Processing…"}</div>
              <div style={{ color:"#64748B", fontSize:12, marginTop:8 }}>This may take a minute while AI generates draft content</div>
            </div>
          ) : (
            <div
              onClick={() => country && year && fileRef.current?.click()}
              style={{
                border:"2px dashed #334155", borderRadius:12, padding:48,
                textAlign:"center", cursor: country&&year ? "pointer":"not-allowed",
                opacity: country&&year ? 1 : 0.5,
                transition:"border-color 0.2s",
              }}
              onMouseEnter={e => { if(country&&year) e.currentTarget.style.borderColor="#3B82F6"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor="#334155"; }}
            >
              <div style={{ fontSize:32, marginBottom:12 }}>📊</div>
              <div style={{ color:"white", fontWeight:600, marginBottom:4 }}>Drop SurveyPro export here</div>
              <div style={{ color:"#64748B", fontSize:13 }}>or click to browse — .xlsx or .csv</div>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" style={{ display:"none" }}
                onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
            </div>
          )}
        </div>

        {/* Previous runs */}
        {allRuns.length > 0 && (
          <div style={{ marginTop:32 }}>
            <div style={{ fontSize:13, fontWeight:700, color:"#64748B", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Previous Runs</div>
            <div style={{ display:"grid", gap:12 }}>
              {allRuns.slice().reverse().map(run => (
                <div key={run.id} style={{ ...card, display:"flex", justifyContent:"space-between", alignItems:"center", padding:"16px 20px" }}>
                  <div>
                    <div style={{ color:"white", fontWeight:600 }}>{run.country} — {run.year}</div>
                    <div style={{ color:"#64748B", fontSize:12, marginTop:2 }}>{run.depts?.length} departments · {new Date(run.savedAt).toLocaleDateString()}</div>
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    {run.depts?.slice(0,5).map(d => (
                      <span key={d.key} style={{ fontSize:11, fontWeight:700, color:sc(d.status), background:sb(d.status), border:`1px solid ${sbd(d.status)}`, borderRadius:4, padding:"2px 6px" }}>
                        {d.label?.split(" ")[0]}
                      </span>
                    ))}
                  </div>
                  <button style={navBtn} onClick={async () => {
                    setCountry2(run.country); setYear2(run.year);
                    try {
                      let r = null; try { const _v = localStorage.getItem(`pulse:data:${run.country}:${run.year}`); r = _v ? {value:_v} : null; } catch(e) {}
                      let s = null; try { const _v = localStorage.getItem(`pulse:sel:${run.country}:${run.year}`); s = _v ? {value:_v} : null; } catch(e) {}
                      if (r) setSurveyData(JSON.parse(r.value));
                      if (s) setSelections(JSON.parse(s.value));
                      setView("review");
                    } catch {}
                  }}>Open</button>
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
function ReviewView({ country, year, surveyData, selections, toggleItem, setRewrite, saveSelections, saved, setView }) {
  const [activeDept, setActiveDept] = useState(null);
  const depts = surveyData ? Object.values(surveyData.depts).filter(d=>d.n>0) : [];

  useEffect(() => { if (depts.length && !activeDept) setActiveDept(depts[0].key); }, [depts.length]);

  const dept = depts.find(d=>d.key===activeDept);

  return (
    <div style={{ minHeight:"100vh", background:"#0F172A", fontFamily:"'Inter',system-ui,sans-serif", display:"flex", flexDirection:"column" }}>
      {/* Top bar */}
      <div style={{ background:"#1E293B", borderBottom:"1px solid #334155", padding:"14px 24px", display:"flex", alignItems:"center", gap:16, flexShrink:0 }}>
        <button onClick={()=>setView("home")} style={{ ...navBtn, background:"transparent", border:"1px solid #334155" }}>← Home</button>
        <div style={{ flex:1 }}>
          <span style={{ color:"#3B82F6", fontWeight:700, fontSize:13 }}>{country} {year}</span>
          <span style={{ color:"#64748B", marginLeft:8, fontSize:13 }}>Director Review</span>
        </div>
        <button onClick={saveSelections} style={{ ...navBtn, background: saved?"#166534":"#3B82F6" }}>
          {saved ? "✓ Saved" : "Save Progress"}
        </button>
        <button onClick={()=>setView("report")} style={{ ...navBtn, background:"#7C3AED" }}>
          Generate Report →
        </button>
      </div>

      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>
        {/* Sidebar */}
        <div style={{ width:220, background:"#1E293B", borderRight:"1px solid #334155", overflowY:"auto", flexShrink:0 }}>
          {depts.map(d => (
            <button key={d.key} onClick={()=>setActiveDept(d.key)}
              style={{
                display:"block", width:"100%", textAlign:"left",
                padding:"12px 16px", background: activeDept===d.key ? "#0F172A" : "transparent",
                border:"none", borderLeft: activeDept===d.key ? "3px solid #3B82F6" : "3px solid transparent",
                cursor:"pointer",
              }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ width:8, height:8, borderRadius:"50%", background:sc(d.status), flexShrink:0 }} />
                <span style={{ color: activeDept===d.key ? "white":"#94A3B8", fontSize:13, fontWeight: activeDept===d.key?600:400 }}>{d.label}</span>
              </div>
              <div style={{ color:"#475569", fontSize:11, marginLeft:16, marginTop:2 }}>{d.avg} · {d.n} respondents</div>
            </button>
          ))}
        </div>

        {/* Main panel */}
        <div style={{ flex:1, overflowY:"auto", padding:24 }}>
          {dept && selections[dept.key] && (
            <DeptReviewPanel
              dept={dept} sel={selections[dept.key]}
              toggleItem={toggleItem} setRewrite={setRewrite}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DeptReviewPanel({ dept, sel, toggleItem, setRewrite }) {
  const sections = [
    { key:"strengths",    label:"✓ Strengths",           color:"#166534", bg:"#F0FDF4", instruction:"Check items to include. Uncheck to exclude. Type a rewrite to change wording — it will appear exactly as written." },
    { key:"growth",       label:"→ Growth Areas",        color:"#B45309", bg:"#FFFBEB", instruction:"Check items to include." },
    { key:"leadershipQs", label:"? Leadership Questions",color:"#1E3A8A", bg:"#EFF6FF", instruction:"Select 1–2 questions to carry into the final report." },
    { key:"quotes",       label:"\" Staff Quotes",        color:"#4B5563", bg:"#F9FAFB", instruction:"Select up to 4 quotes. These appear verbatim — do not edit unless correcting a translation." },
  ];

  return (
    <div>
      {/* Dept header */}
      <div style={{ marginBottom:24 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8 }}>
          <div style={{ fontSize:20, fontWeight:700, color:"white" }}>{dept.label}</div>
          <span style={{ fontSize:12, fontWeight:700, color:sc(dept.status), background:sb(dept.status), border:`1px solid ${sbd(dept.status)}`, borderRadius:6, padding:"3px 10px" }}>{dept.status}</span>
          <span style={{ color:"#64748B", fontSize:13 }}>{dept.avg} avg · n={dept.n}</span>
        </div>

        {/* Question scores */}
        <div style={{ background:"#1E293B", borderRadius:8, padding:16, marginBottom:0 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#64748B", textTransform:"uppercase", letterSpacing:1.5, marginBottom:10 }}>Question Scores</div>
          {[...dept.questions].sort((a,b) => {
            const o = {Concern:0,Watch:1,Healthy:2};
            return (o[a.status]??1)-(o[b.status]??1) || a.score-b.score;
          }).map((q,i) => (
            <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"6px 0", borderBottom:"1px solid #334155" }}>
              <span style={{ fontSize:11, fontWeight:700, color:sc(q.status), minWidth:56, paddingTop:1 }}>{q.status}</span>
              <span style={{ color:"#94A3B8", fontSize:11, minWidth:36, paddingTop:1 }}>{q.score?.toFixed(2)}</span>
              <span style={{ color:"#CBD5E1", fontSize:12, flex:1 }}>{q.en}</span>
              <span style={{ color:"#475569", fontSize:10, minWidth:40, textAlign:"right", paddingTop:1 }}>{q.scale.toUpperCase()}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Sections */}
      {sections.map(sec => (
        <div key={sec.key} style={{ marginBottom:20, background:"#1E293B", borderRadius:10, overflow:"hidden" }}>
          <div style={{ padding:"12px 16px", borderBottom:"1px solid #334155" }}>
            <div style={{ color:sec.color, fontWeight:700, fontSize:13 }}>{sec.label}</div>
            <div style={{ color:"#64748B", fontSize:11, marginTop:2 }}>{sec.instruction}</div>
          </div>
          {(sel[sec.key] || []).map((item, idx) => (
            <div key={idx} style={{ padding:"12px 16px", borderBottom:"1px solid #1E293B", background: item.include ? "#0F172A" : "#1A1A2E", opacity: item.include ? 1 : 0.55 }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:12 }}>
                <input type="checkbox" checked={item.include}
                  onChange={() => toggleItem(dept.key, sec.key, idx)}
                  style={{ marginTop:3, cursor:"pointer", accentColor:"#3B82F6" }} />
                <div style={{ flex:1 }}>
                  <div style={{ color: item.include?"white":"#64748B", fontSize:13, lineHeight:1.5 }}>{item.text}</div>
                  {item.include && (
                    <textarea
                      value={item.rewrite}
                      onChange={e => setRewrite(dept.key, sec.key, idx, e.target.value)}
                      placeholder={sec.key==="quotes" ? "Leave blank to use as-is. Edit only if correcting a translation." : "Leave blank to use as-is. Type here to override wording exactly."}
                      style={{ marginTop:8, width:"100%", background:"#0B1220", border:"1px solid #334155", borderRadius:6, padding:"8px 10px", color:"#93C5FD", fontSize:12, resize:"vertical", minHeight:56, fontFamily:"inherit", boxSizing:"border-box" }}
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
          {(!sel[sec.key]?.length) && (
            <div style={{ padding:"16px", color:"#475569", fontSize:13, fontStyle:"italic" }}>No items generated for this section.</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── REPORT VIEW ──────────────────────────────────────────────────────────────
function ReportView({ country, year, surveyData, getApproved, setView }) {
  const depts = surveyData ? Object.values(surveyData.depts)
    .filter(d=>d.n>0)
    .sort((a,b) => a.avg-b.avg) : [];

  const concerns = depts.filter(d=>d.status==="Concern");
  const watches  = depts.filter(d=>d.status==="Watch");
  const healthys = depts.filter(d=>d.status==="Healthy");

  const printReport = () => window.print();

  return (
    <div style={{ minHeight:"100vh", background:"#F1F5F9", fontFamily:"'Inter',system-ui,sans-serif" }}>
      {/* Toolbar — hidden on print */}
      <div className="no-print" style={{ background:"#1E293B", padding:"12px 24px", display:"flex", gap:12, alignItems:"center" }}>
        <button onClick={()=>setView("review")} style={{ ...navBtn, background:"transparent", border:"1px solid #334155" }}>← Back to Review</button>
        <div style={{ flex:1, color:"#94A3B8", fontSize:13 }}>{country} {year} Pulse Report</div>
        <button onClick={printReport} style={{ ...navBtn, background:"#3B82F6" }}>⬇ Download PDF</button>
      </div>

      {/* Report content */}
      <div style={{ maxWidth:900, margin:"0 auto", padding:"40px 24px" }}>

        {/* Cover */}
        <div style={{ background:"#0F172A", borderRadius:16, padding:48, marginBottom:32, textAlign:"center" }}>
          <div style={{ fontSize:11, letterSpacing:4, color:"#3B82F6", fontWeight:700, textTransform:"uppercase", marginBottom:16 }}>Josiah Venture</div>
          <div style={{ fontSize:36, fontWeight:800, color:"white", marginBottom:8 }}>{country}</div>
          <div style={{ fontSize:20, color:"#94A3B8", marginBottom:32 }}>Staff Pulse Report · {year}</div>
          <div style={{ display:"flex", justifyContent:"center", gap:32 }}>
            {[["Departments", depts.length],["Respondents", depts.reduce((a,d)=>a+d.n,0)],["Overall Avg", (depts.reduce((a,d)=>a+d.avg,0)/depts.length).toFixed(2)]].map(([l,v])=>(
              <div key={l}>
                <div style={{ fontSize:28, fontWeight:800, color:"white" }}>{v}</div>
                <div style={{ fontSize:12, color:"#64748B" }}>{l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Summary table */}
        <div style={{ background:"white", borderRadius:12, padding:28, marginBottom:32, boxShadow:"0 1px 4px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize:13, fontWeight:700, color:"#1E293B", textTransform:"uppercase", letterSpacing:2, marginBottom:20 }}>Department Summary</div>
          {[["Concern", concerns],["Watch", watches],["Healthy", healthys]].map(([status,group]) =>
            group.length ? (
              <div key={status} style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, fontWeight:700, color:sc(status), textTransform:"uppercase", letterSpacing:1.5, marginBottom:6 }}>{status}</div>
                {group.map(d => (
                  <div key={d.key} style={{ display:"flex", alignItems:"center", gap:12, padding:"8px 0", borderBottom:"1px solid #F1F5F9" }}>
                    <div style={{ width:120, color:"#1E293B", fontWeight:600, fontSize:13 }}>{d.label}</div>
                    <div style={{ flex:1, background:"#F1F5F9", borderRadius:4, height:8, overflow:"hidden" }}>
                      <div style={{ width:`${((d.avg-1)/4)*100}%`, background:sc(d.status), height:"100%", borderRadius:4 }} />
                    </div>
                    <div style={{ fontWeight:700, color:sc(d.status), fontSize:14, width:36, textAlign:"right" }}>{d.avg}</div>
                    <div style={{ color:"#94A3B8", fontSize:11, width:24 }}>n={d.n}</div>
                  </div>
                ))}
              </div>
            ) : null
          )}
        </div>

        {/* Dept pages */}
        {depts.map(dept => (
          <DeptReportPage key={dept.key} dept={dept} getApproved={getApproved} />
        ))}
      </div>

      <style>{`
        @media print {
          .no-print { display:none !important; }
          body { background:white; }
          @page { margin:15mm; size:A4; }
        }
      `}</style>
    </div>
  );
}

function DeptReportPage({ dept, getApproved }) {
  const strengths    = getApproved(dept.key, "strengths");
  const growth       = getApproved(dept.key, "growth");
  const leadershipQs = getApproved(dept.key, "leadershipQs");
  const quotes       = getApproved(dept.key, "quotes").slice(0,4);

  return (
    <div style={{ background:"white", borderRadius:12, padding:32, marginBottom:24, boxShadow:"0 1px 4px rgba(0,0,0,0.08)", pageBreakInside:"avoid" }}>
      {/* Dept header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:24, paddingBottom:16, borderBottom:"2px solid #F1F5F9" }}>
        <div>
          <div style={{ fontSize:20, fontWeight:800, color:"#0F172A" }}>{dept.label}</div>
          <div style={{ color:"#64748B", fontSize:13, marginTop:4 }}>n = {dept.n} respondents</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:28, fontWeight:800, color:sc(dept.status) }}>{dept.avg}</div>
          <div style={{ fontSize:11, fontWeight:700, color:sc(dept.status), textTransform:"uppercase", letterSpacing:1 }}>{dept.status}</div>
        </div>
      </div>

      {/* Question scores */}
      <div style={{ marginBottom:24 }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#64748B", textTransform:"uppercase", letterSpacing:1.5, marginBottom:10 }}>Question Scores — Concern · Watch · Healthy</div>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
          <thead>
            <tr style={{ background:"#F8FAFC" }}>
              <th style={{ textAlign:"left", padding:"6px 10px", color:"#64748B", fontWeight:600 }}>Question</th>
              <th style={{ textAlign:"center", padding:"6px 10px", color:"#64748B", fontWeight:600, width:60 }}>Score</th>
              <th style={{ textAlign:"center", padding:"6px 10px", color:"#64748B", fontWeight:600, width:70 }}>Status</th>
              <th style={{ textAlign:"center", padding:"6px 10px", color:"#64748B", fontWeight:600, width:50 }}>Scale</th>
            </tr>
          </thead>
          <tbody>
            {[...dept.questions].sort((a,b)=>{
              const o={Concern:0,Watch:1,Healthy:2};
              return (o[a.status]??1)-(o[b.status]??1)||a.score-b.score;
            }).map((q,i)=>(
              <tr key={i} style={{ borderBottom:"1px solid #F1F5F9" }}>
                <td style={{ padding:"7px 10px", color:"#1E293B" }}>{q.en}{q.burden ? " [Burden]":""}</td>
                <td style={{ textAlign:"center", padding:"7px 10px", fontWeight:700, color:sc(q.status) }}>{q.score?.toFixed(2)}</td>
                <td style={{ textAlign:"center", padding:"7px 10px" }}>
                  <span style={{ fontSize:10, fontWeight:700, color:sc(q.status), background:sb(q.status), borderRadius:4, padding:"2px 6px" }}>{q.status}</span>
                </td>
                <td style={{ textAlign:"center", padding:"7px 10px", color:"#94A3B8", fontSize:10 }}>{q.scale.toUpperCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Strengths + Growth */}
      {(strengths.length || growth.length) && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20, marginBottom:24 }}>
          {strengths.length ? (
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:"#166534", textTransform:"uppercase", letterSpacing:1.5, marginBottom:10 }}>What is Working</div>
              {strengths.map((s,i) => (
                <div key={i} style={{ display:"flex", gap:8, marginBottom:6, fontSize:12, color:"#1E293B", lineHeight:1.5 }}>
                  <span style={{ color:"#166534", marginTop:1 }}>✓</span><span>{s}</span>
                </div>
              ))}
            </div>
          ) : null}
          {growth.length ? (
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:sc(dept.status), textTransform:"uppercase", letterSpacing:1.5, marginBottom:10 }}>Where Attention is Needed</div>
              {growth.map((g,i) => (
                <div key={i} style={{ display:"flex", gap:8, marginBottom:6, fontSize:12, color:"#1E293B", lineHeight:1.5 }}>
                  <span style={{ color:sc(dept.status), marginTop:1 }}>→</span><span>{g}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* Leadership Questions */}
      {leadershipQs.length ? (
        <div style={{ background:"#EFF6FF", borderRadius:8, padding:16, marginBottom:20 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#1E3A8A", textTransform:"uppercase", letterSpacing:1.5, marginBottom:10 }}>Questions for Leadership</div>
          {leadershipQs.map((q,i) => (
            <div key={i} style={{ display:"flex", gap:10, marginBottom:8, fontSize:12, color:"#1E3A8A" }}>
              <span style={{ fontWeight:700, minWidth:16 }}>{i+1}</span><span>{q}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Quotes */}
      {quotes.length ? (
        <div>
          <div style={{ fontSize:11, fontWeight:700, color:"#475569", textTransform:"uppercase", letterSpacing:1.5, marginBottom:10 }}>What Staff Said</div>
          <div style={{ display:"grid", gridTemplateColumns: quotes.length>1?"1fr 1fr":"1fr", gap:12 }}>
            {quotes.map((q,i) => (
              <div key={i} style={{ background:"#F8FAFC", borderLeft:"3px solid #CBD5E1", borderRadius:"0 8px 8px 0", padding:"12px 14px", fontSize:12, color:"#334155", lineHeight:1.6, fontStyle:"italic" }}>
                "{q}"
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── DASHBOARD VIEW ───────────────────────────────────────────────────────────
function DashboardView({ allRuns, dashCountry, setDashCountry, setView, country, year, surveyData }) {
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
    <div style={{ minHeight:"100vh", background:"#0F172A", fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ background:"#1E293B", borderBottom:"1px solid #334155", padding:"14px 24px", display:"flex", alignItems:"center", gap:16 }}>
        <button onClick={()=>setView("home")} style={{ ...navBtn, background:"transparent", border:"1px solid #334155" }}>← Home</button>
        <div style={{ flex:1, color:"white", fontWeight:700 }}>P&C Dashboard</div>
        <select value={dashCountry} onChange={e=>setDashCountry(e.target.value)}
          style={{ background:"#0F172A", border:"1px solid #334155", borderRadius:6, color:"white", padding:"6px 12px", fontSize:13 }}>
          <option value="all">All Countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"32px 24px" }}>

        {/* JV-wide overview grid */}
        {dashCountry === "all" && (
          <>
            <div style={{ fontSize:13, fontWeight:700, color:"#64748B", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Latest Results by Country</div>
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
                        <div style={{ color:"white", fontWeight:700, fontSize:16 }}>{run.country}</div>
                        <div style={{ color:"#64748B", fontSize:12 }}>{run.year}</div>
                      </div>
                      <span style={{ fontSize:11, fontWeight:700, color:sc(overallStatus), background:sb(overallStatus), border:`1px solid ${sbd(overallStatus)}`, borderRadius:6, padding:"3px 10px" }}>{overallStatus}</span>
                    </div>
                    <div style={{ display:"flex", gap:12 }}>
                      {[["Concern",concern,"#B91C1C"],["Watch",watch,"#B45309"],["Healthy",healthy,"#166534"]].map(([l,n,c])=>(
                        <div key={l} style={{ flex:1, textAlign:"center", background:"#1E293B", borderRadius:8, padding:"10px 4px" }}>
                          <div style={{ fontSize:22, fontWeight:800, color:c }}>{n}</div>
                          <div style={{ fontSize:10, color:"#64748B" }}>{l}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Cross-country dept heatmap */}
            <div style={{ fontSize:13, fontWeight:700, color:"#64748B", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>Department Health — All Countries</div>
            <div style={{ background:"#1E293B", borderRadius:12, overflow:"hidden", marginBottom:40 }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid #334155" }}>
                    <th style={{ textAlign:"left", padding:"12px 16px", color:"#64748B" }}>Department</th>
                    {Object.keys(latestByCountry).map(c => (
                      <th key={c} style={{ textAlign:"center", padding:"12px 10px", color:"#64748B", fontWeight:600 }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DEPTS_ORDER.map(dk => (
                    <tr key={dk} style={{ borderBottom:"1px solid #334155" }}>
                      <td style={{ padding:"10px 16px", color:"#94A3B8", fontWeight:500 }}>{dk}</td>
                      {Object.values(latestByCountry).map(run => {
                        const d = run.depts?.find(dep=>dep.key===dk||dep.group===dk);
                        return (
                          <td key={run.country} style={{ textAlign:"center", padding:"10px" }}>
                            {d ? (
                              <span style={{ fontSize:11, fontWeight:700, color:sc(d.status), background:sb(d.status), borderRadius:4, padding:"2px 8px" }}>{d.avg}</span>
                            ) : <span style={{ color:"#334155" }}>—</span>}
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
            <div style={{ fontSize:13, fontWeight:700, color:"#64748B", textTransform:"uppercase", letterSpacing:2, marginBottom:16 }}>{dashCountry} — Department Health</div>
            {(runsByCountry[dashCountry]||[]).map(run => (
              <div key={run.id} style={{ marginBottom:32 }}>
                <div style={{ color:"#3B82F6", fontWeight:700, fontSize:13, marginBottom:12 }}>{run.year}</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))", gap:12 }}>
                  {(run.depts||[]).sort((a,b)=>a.avg-b.avg).map(d => (
                    <div key={d.key} style={{ background:"#1E293B", borderRadius:10, padding:"14px 16px", border:`1px solid ${sbd(d.status)}` }}>
                      <div style={{ color:"#94A3B8", fontSize:11, marginBottom:6 }}>{d.label}</div>
                      <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                        <span style={{ fontSize:22, fontWeight:800, color:sc(d.status) }}>{d.avg}</span>
                        <span style={{ fontSize:10, fontWeight:700, color:sc(d.status) }}>{d.status}</span>
                      </div>
                      <div style={{ color:"#475569", fontSize:10, marginTop:4 }}>n={d.n}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Trend chart (text-based for now) */}
            {(runsByCountry[dashCountry]||[]).length > 1 && (
              <div style={{ background:"#1E293B", borderRadius:12, padding:20, marginTop:24 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#64748B", textTransform:"uppercase", letterSpacing:1.5, marginBottom:16 }}>Trend — Year over Year</div>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                  <thead>
                    <tr style={{ borderBottom:"1px solid #334155" }}>
                      <th style={{ textAlign:"left", padding:"8px 12px", color:"#64748B" }}>Department</th>
                      {[...(runsByCountry[dashCountry]||[])].sort((a,b)=>a.year-b.year).map(r=>(
                        <th key={r.year} style={{ textAlign:"center", padding:"8px 12px", color:"#64748B" }}>{r.year}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DEPTS_ORDER.map(dk => {
                      const rows = [...(runsByCountry[dashCountry]||[])].sort((a,b)=>a.year-b.year)
                        .map(r => r.depts?.find(d=>d.key===dk||d.group===dk));
                      if (rows.every(r=>!r)) return null;
                      return (
                        <tr key={dk} style={{ borderBottom:"1px solid #334155" }}>
                          <td style={{ padding:"8px 12px", color:"#94A3B8" }}>{dk}</td>
                          {rows.map((d,i)=>(
                            <td key={i} style={{ textAlign:"center", padding:"8px 12px" }}>
                              {d ? (
                                <span style={{ fontWeight:700, color:sc(d.status) }}>{d.avg}</span>
                              ) : <span style={{ color:"#334155" }}>—</span>}
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
            <div style={{ background:"#1E293B", borderRadius:12, padding:24, marginTop:24, border:"1px dashed #334155" }}>
              <div style={{ fontSize:11, fontWeight:700, color:"#64748B", textTransform:"uppercase", letterSpacing:1.5, marginBottom:8 }}>OKR Integration</div>
              <div style={{ color:"#475569", fontSize:13 }}>Key Results tied to staff health metrics will appear here once OKR system integration is connected.</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── SHARED STYLES ────────────────────────────────────────────────────────────
const card = {
  background:"#1E293B", borderRadius:12, padding:24,
  border:"1px solid #334155",
};
const navBtn = {
  background:"#1E3A5F", border:"none", borderRadius:8,
  color:"white", padding:"8px 16px", fontSize:13, fontWeight:600,
  cursor:"pointer",
};
const lbl = { display:"block", fontSize:11, fontWeight:700, color:"#64748B", textTransform:"uppercase", letterSpacing:1, marginBottom:6 };
const inp = { width:"100%", background:"#0F172A", border:"1px solid #334155", borderRadius:8, padding:"10px 14px", color:"white", fontSize:14, boxSizing:"border-box" };
