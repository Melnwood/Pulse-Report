import { useIsMobile, C, sc, sb, sbd, FONT_DISPLAY } from "../theme";
import { periodCmp } from "../airtable";

// Over-time trends for one country, anchored on the baseline pulse. One row per
// department, one status-coloured score chip per PULSE REPORT — eleven
// departments read as a calm grid, not eleven tangled lines. Teams can pulse
// once a year or several times ("2026", "2026·2", …); every report gets its own
// chip. Graceful with a single report: the baseline chip is the anchor and the
// row fills in as new pulses are added.
export default function CountryTrends({ country, runs = [], deptsOrder = [], baselineYear = 2026 }) {
  const isMobile = useIsMobile();
  const sorted = [...runs].sort((a, b) => periodCmp(a.year, b.year));
  if (!sorted.length) return null;
  const periods = sorted.map(r => String(r.year));
  const multiYear = periods.length > 1;

  // Per-department series across the reports present.
  const deptSeries = deptsOrder.map(dk => {
    const pts = sorted.map(r => {
      const d = (r.depts || []).find(x => x.key === dk || x.group === dk);
      return (d && d.avg != null) ? { period: String(r.year), avg: Number(d.avg), status: d.status, label: d.label } : null;
    });
    const present = pts.filter(Boolean);
    if (!present.length) return null;
    return { key: dk, label: present[present.length - 1].label || dk, present };
  }).filter(Boolean);

  // Overall average per report (mean of that run's department averages).
  const overall = sorted.map(r => {
    const ds = (r.depts || []).filter(d => d.avg != null);
    const avg = ds.length ? ds.reduce((a, d) => a + Number(d.avg), 0) / ds.length
      : (r.overallAvg != null ? Number(r.overallAvg) : null);
    return { period: String(r.year), avg: avg != null ? +avg.toFixed(2) : null };
  }).filter(p => p.avg != null);

  const delta = (series) => {
    if (series.length < 2) return null;
    const base = series[0];
    const last = series[series.length - 1];
    return +(last.avg - base.avg).toFixed(2);
  };
  const DeltaChip = ({ d }) => {
    if (d == null) return <span style={{ fontSize: 10, fontWeight: 700, color: C.faint }}>baseline</span>;
    const up = d > 0, flat = d === 0;
    const col = flat ? C.muted : up ? "#5C9A6D" : "#BE6650";
    return <span style={{ fontSize: 11, fontWeight: 700, color: col }}>{flat ? "±0.00" : `${up ? "▲" : "▼"} ${up ? "+" : ""}${d.toFixed(2)}`}</span>;
  };

  const statusOrder = { Concern: 0, Watch: 1, Healthy: 2 };
  const rows = deptSeries.sort((a, b) => {
    const la = a.present[a.present.length - 1], lb = b.present[b.present.length - 1];
    return (parseFloat(la.avg) || 9) - (parseFloat(lb.avg) || 9);
  });

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, boxShadow: C.shadow, borderRadius: 12, padding: isMobile ? 16 : 20, marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 1.5 }}>Over time</span>
        <span style={{ fontSize: 12, color: C.faint }}>· {country} · since {baselineYear} baseline</span>
      </div>

      {/* Overall average */}
      {overall.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 0", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 650, color: C.ink }}>Overall average</div>
            <div style={{ fontSize: 11, color: C.muted }}>{overall.map(p => p.period).join(" → ")}</div>
          </div>
          <Sparkline series={overall} width={isMobile ? 90 : 140} accent />
          <div style={{ textAlign: "right", minWidth: 58 }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 600, color: C.ink }}>{overall[overall.length - 1].avg.toFixed(2)}</div>
            <DeltaChip d={delta(overall)} />
          </div>
        </div>
      )}

      {/* Per department — one status-coloured chip per pulse report */}
      {rows.map(r => {
        const byPeriod = new Map(r.present.map(p => [p.period, p]));
        return (
          <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0",
            borderBottom: `1px solid ${C.line}`, flexWrap: isMobile ? "wrap" : "nowrap" }}>
            <div style={{ flex: 1, minWidth: isMobile ? "100%" : 130 }}>
              <div style={{ fontSize: 13, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {periods.map(pd => {
                const p = byPeriod.get(pd);
                return p ? (
                  <span key={pd} title={`${pd} · ${p.status}`}
                    style={{ minWidth: 50, textAlign: "center", borderRadius: 8, padding: "3px 7px",
                      background: sb(p.status), border: `1px solid ${sbd(p.status)}` }}>
                    <span style={{ display: "block", fontSize: 9, fontWeight: 700, color: C.muted }}>{pd}</span>
                    <span style={{ display: "block", fontSize: 12.5, fontWeight: 800, color: sc(p.status), fontVariantNumeric: "tabular-nums" }}>{Number(p.avg).toFixed(2)}</span>
                  </span>
                ) : (
                  <span key={pd} title={`No ${pd} data for this department`}
                    style={{ minWidth: 50, textAlign: "center", borderRadius: 8, padding: "3px 7px",
                      background: "#FDFAF4", border: "1px dashed #ECE2D2", color: C.faint, fontSize: 12, lineHeight: "28px" }}>—</span>
                );
              })}
            </div>
            <div style={{ textAlign: "right", minWidth: 58 }}>
              <DeltaChip d={delta(r.present)} />
            </div>
          </div>
        );
      })}

      {!multiYear && (
        <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic", marginTop: 12 }}>
          This is the {baselineYear} baseline. A new chip appears beside it with every pulse report — yearly, or more often if your team runs one.
        </div>
      )}
    </div>
  );
}

// Minimal inline SVG sparkline. Points are spaced evenly by index; a single
// point renders as a dot. Domain is a tight band around the data (clamped 1–5).
function Sparkline({ series, width = 140, height = 30, color = "#B96524", accent }) {
  const stroke = accent ? "#E0863C" : color;
  const vals = series.map(p => p.avg);
  const n = vals.length;
  const pad = 4;
  const lo = Math.max(1, Math.min(...vals) - 0.25);
  const hi = Math.min(5, Math.max(...vals) + 0.25);
  const span = hi - lo || 1;
  const x = (i) => n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - pad * 2);
  const y = (v) => height - pad - ((v - lo) / span) * (height - pad * 2);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  return (
    <svg width={width} height={height} style={{ flexShrink: 0, display: "block" }} aria-hidden="true">
      {n > 1 && <polyline points={pts.join(" ")} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      {vals.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={i === n - 1 ? 3 : 2}
          fill={i === n - 1 ? stroke : "#fff"} stroke={stroke} strokeWidth="1.5" />
      ))}
    </svg>
  );
}
