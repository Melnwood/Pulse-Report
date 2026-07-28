// The inline response heatmap for ONE question — extracted from the Director's
// Review so the review, the finished report, and the meeting-notes page all
// render the exact same thing (colours, burden flip included). Do not fork this.
export default function QuestionHeatmap({ q, showMeta = true }) {
  // counts = [SD=1, D=2, U=3, A=4, SA=5]
  const counts = q.counts || [0, 0, 0, 0, 0];
  const n = counts.reduce((a, b) => a + b, 0) || 1;
  // Heatmap colours matching the Excel workbook.
  // For burden (inverted) questions: high SA = bad outcome, so colours flip.
  const CELL_COLORS = q.burden
    ? ["#5C9A6D", "#7FB894", "#EBD0C8", "#D89080", "#BE6650"] // SD=green, SA=red (burden inverted)
    : ["#BE6650", "#D89080", "#EBD0C8", "#7FB894", "#5C9A6D"]; // SD=red, SA=green
  const CELL_TEXT = q.burden
    ? ["white", "white", "#A34D3B", "white", "white"]
    : ["white", "white", "#A34D3B", "white", "white"];
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 5 }}>
        {counts.map((c, ci) => (
          <div key={ci} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            {/* Coloured cell — fixed height so zeros don't shift labels */}
            <div style={{
              width: "100%", height: 32,
              background: c > 0 ? CELL_COLORS[ci] : "#FBEFE4",
              borderRadius: 5, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 700,
              color: c > 0 ? CELL_TEXT[ci] : "#F0DFCE",
              border: c > 0 ? "none" : "1px solid #ECE2D2",
            }}>
              {c}
            </div>
            {/* Full label — fixed two-line height */}
            <div style={{ fontSize: 8, fontWeight: 600, color: "#7A6F63", textAlign: "center", lineHeight: 1.25, height: 22 }}>
              {ci === 0 && <><span>Strongly</span><br /><span>Disagree</span></>}
              {ci === 1 && <span>Disagree</span>}
              {ci === 2 && <span>Unsure</span>}
              {ci === 3 && <span>Agree</span>}
              {ci === 4 && <><span>Strongly</span><br /><span>Agree</span></>}
            </div>
            {/* Percentage — fixed height so the row stays aligned */}
            <div style={{ fontSize: 8, color: "#A89C8D", textAlign: "center", height: 12 }}>
              {c > 0 ? Math.round(c / n * 100) + "%" : ""}
            </div>
          </div>
        ))}
      </div>
      {showMeta && (
        <div style={{ fontSize: 10, color: "#7A6F63", marginTop: 6 }}>
          {n} respondents · mean {q.score != null ? Number(q.score).toFixed(2) : "—"}
          {q.burden ? " · burden question (colours inverted)" : ""}
        </div>
      )}
    </div>
  );
}
