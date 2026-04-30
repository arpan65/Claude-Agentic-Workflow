import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const LINK = ({ node, ...props }) => (
  <a {...props} target="_blank" rel="noopener noreferrer" />
);
const MD = { a: LINK };

// ─── Section metadata ────────────────────────────────────────────────────────

const SECTION_STYLES = {
  transport:     { color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe" },
  accommodation: { color: "#f97316", bg: "#fff7ed", border: "#fed7aa" },
  budget:        { color: "#10b981", bg: "#ecfdf5", border: "#a7f3d0" },
  itinerary:     { color: "#8b5cf6", bg: "#f5f3ff", border: "#ddd6fe" },
  around:        { color: "#0ea5e9", bg: "#f0f9ff", border: "#bae6fd" },
  quality:       { color: "#ef4444", bg: "#fef2f2", border: "#fecaca" },
  default:       { color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" },
};

function detectType(title) {
  const t = title.toLowerCase();
  if (/travel|flight|bus|train|outbound|return/.test(t)) return "transport";
  if (/accommodation|hotel|hostel|stay/.test(t)) return "accommodation";
  if (/budget|cost|summary/.test(t)) return "budget";
  if (/itinerary|day \d|schedule/.test(t)) return "itinerary";
  if (/getting around|local transport|transit/.test(t)) return "around";
  if (/data quality|notes|⚠/.test(t)) return "quality";
  return "default";
}

// ─── Markdown table parser ────────────────────────────────────────────────────

function findTableBlocks(content) {
  const lines = content.split("\n");
  const blocks = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isRow = i < lines.length && /^\s*\|/.test(lines[i]);
    if (isRow && start === -1) start = i;
    else if (!isRow && start !== -1) {
      blocks.push(lines.slice(start, i).join("\n"));
      start = -1;
    }
  }
  return blocks;
}

function parseTable(block) {
  const lines = block.trim().split("\n").filter(l => /^\s*\|/.test(l));
  if (lines.length < 3) return null;
  const row = l => l.replace(/^\s*\||\|\s*$/g, "").split("|").map(c => c.trim());
  return { headers: row(lines[0]), rows: lines.slice(2).map(row) };
}

// ─── Budget tier renderer ─────────────────────────────────────────────────────

const TIER_COLORS = [
  { color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe" },
  { color: "#f59e0b", bg: "#fffbeb", border: "#fde68a" },
  { color: "#8b5cf6", bg: "#f5f3ff", border: "#ddd6fe" },
];

function BudgetTiers({ content }) {
  const blocks = findTableBlocks(content);
  const table = blocks.map(parseTable).find(t => t && t.headers.length >= 4);

  if (!table) {
    return <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{content}</ReactMarkdown>;
  }

  const tierNames = table.headers.slice(1, 4);
  const totalRow = table.rows.find(r => /\bTOTAL\b/i.test(r[0]));
  const ppRow = table.rows.find(r => /per.?person/i.test(r[0]));
  const lineRows = table.rows.filter(r => r !== totalRow && r !== ppRow && r[0].trim());

  const tiers = tierNames.map((name, i) => ({
    name,
    total: totalRow?.[i + 1] || "—",
    pp: ppRow?.[i + 1] || null,
    items: lineRows.map(r => ({ label: r[0].replace(/^[^\w$€£¥]*/u, ""), value: r[i + 1] || "—" })),
    ...TIER_COLORS[i],
  }));

  const tableText = blocks.find(b => parseTable(b)?.headers.length >= 4) || "";
  const restContent = content.replace(tableText, "").replace(/^[\s\-*]+/, "").trim();

  return (
    <>
      <div className="tier-grid">
        {tiers.map(tier => (
          <div
            key={tier.name}
            className="tier-card"
            style={{ "--tc": tier.color, "--tb": tier.bg, "--tbr": tier.border }}
          >
            <div className="tier-name">{tier.name}</div>
            <div className="tier-total">{tier.total}</div>
            {tier.pp && <div className="tier-pp">{tier.pp}<span> / person</span></div>}
            <div className="tier-items">
              {tier.items.map((item, j) => (
                <div key={j} className="tier-item">
                  <span className="tier-item-label">{item.label}</span>
                  <span className="tier-item-val">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {restContent && (
        <div className="budget-notes">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{restContent}</ReactMarkdown>
        </div>
      )}
    </>
  );
}

// ─── Section parser ───────────────────────────────────────────────────────────

function parseSections(md) {
  if (!md) return [];
  const lines = md.split("\n");
  const sections = [];
  let introLines = [];
  let title = null;
  let bodyLines = [];
  let pastIntro = false;

  const flush = () => {
    if (!pastIntro) {
      const txt = introLines.join("\n").trim();
      if (txt) sections.push({ type: "intro", title: "", content: txt });
      pastIntro = true;
    } else if (title !== null) {
      const txt = bodyLines.join("\n").trim().replace(/^(-{3,})\s*/, "");
      if (txt) sections.push({ type: detectType(title), title, content: txt });
    }
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      title = line.slice(3).trim();
      bodyLines = [];
    } else if (!pastIntro) {
      introLines.push(line);
    } else {
      bodyLines.push(line);
    }
  }
  flush();
  return sections;
}

// ─── Section card ─────────────────────────────────────────────────────────────

function SectionCard({ section }) {
  const s = SECTION_STYLES[section.type] || SECTION_STYLES.default;
  return (
    <div
      className={`trip-section trip-section--${section.type}`}
      style={{ "--sc": s.color, "--sb": s.bg, "--sbr": s.border }}
    >
      {section.title && (
        <div className="section-hdr">
          <span className="section-hdr-title">{section.title}</span>
        </div>
      )}
      <div className="section-body">
        {section.type === "budget" ? (
          <BudgetTiers content={section.content} />
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{section.content}</ReactMarkdown>
        )}
      </div>
    </div>
  );
}

// ─── Intro card ───────────────────────────────────────────────────────────────

function IntroCard({ section }) {
  return (
    <div className="trip-intro">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{section.content}</ReactMarkdown>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function TripResult({ markdown }) {
  const sections = useMemo(() => parseSections(markdown), [markdown]);
  return (
    <div className="trip-result">
      {sections.map((section, i) =>
        section.type === "intro"
          ? <IntroCard key={i} section={section} />
          : <SectionCard key={i} section={section} />
      )}
    </div>
  );
}
