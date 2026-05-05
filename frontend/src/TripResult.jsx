import React, { useCallback, useState } from "react";

function fmtDate(d) {
  if (!d) return "—";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [, m, day] = d.split("-");
  return `${months[+m - 1]} ${+day}`;
}

// ─── Trip Header ──────────────────────────────────────────────────────────────

function TripHeader({ trip }) {
  return (
    <div className="trip-header">
      <div className="trip-route">
        <span className="trip-origin">{trip.origin}</span>
        <span className="trip-arrow">→</span>
        <span className="trip-dest">{trip.destination}</span>
      </div>
      <div className="trip-meta-row">
        <span className="trip-meta-pill">{fmtDate(trip.depart_date)} – {fmtDate(trip.return_date)}</span>
        <span className="trip-meta-pill">{trip.nights} night{trip.nights !== 1 ? "s" : ""}</span>
        <span className="trip-meta-pill">{trip.travellers} traveller{trip.travellers !== 1 ? "s" : ""}</span>
        <span className="trip-meta-pill">{trip.currency}</span>
      </div>
    </div>
  );
}

// ─── Tab Bar ──────────────────────────────────────────────────────────────────

function TabBar({ tabs, active, onSelect }) {
  return (
    <div className="result-tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`tab-btn${active === t.id ? " tab-btn--active" : ""}`}
          onClick={() => onSelect(t.id)}
        >
          <span className="tab-icon">{t.icon}</span>
          <span>{t.label}</span>
          {t.badge > 0 && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

// ─── Transport Panel ──────────────────────────────────────────────────────────

function TransportRows({ rows }) {
  if (!rows || rows.length === 0) return null;
  return rows.map((r, i) => (
    <tr key={i}>
      <td className="cell-strong">{r.operator}</td>
      <td>{r.depart}</td>
      <td>{r.arrive}</td>
      <td>{r.duration}</td>
      <td className="cell-price">{r.price_per_person}</td>
      <td>
        {r.url
          ? <a href={r.url} className="book-link" target="_blank" rel="noopener noreferrer">Book →</a>
          : "—"}
      </td>
    </tr>
  ));
}

function TransportPanel({ transport, trip }) {
  if (!transport) return <p style={{ color: "var(--text-soft)" }}>No transport data.</p>;
  const headers = ["Operator", "Depart", "Arrive", "Duration", "Price/person", "Book"];
  return (
    <>
      {transport.outbound?.length > 0 && (
        <div className="panel-section">
          <div className="subtable-label">Outbound · {fmtDate(trip?.depart_date)}</div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody><TransportRows rows={transport.outbound} /></tbody>
            </table>
          </div>
        </div>
      )}
      {Array.isArray(transport.return_trips) && transport.return_trips.length > 0 && (
        <div className="panel-section">
          <div className="subtable-label">Return · {fmtDate(trip?.return_date)}</div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody><TransportRows rows={transport.return_trips} /></tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Stay Panel ───────────────────────────────────────────────────────────────

function Stars({ n }) {
  if (!n) return <span className="no-val">—</span>;
  return <span className="stars">{"★".repeat(n)}{"☆".repeat(Math.max(0, 5 - n))}</span>;
}

function StayPanel({ items }) {
  if (!items || items.length === 0) return <p style={{ color: "var(--text-soft)" }}>No accommodation data.</p>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Property</th><th>Type</th><th>Area</th><th>Stars</th>
            <th>Per night</th><th>Stay total</th><th>Book</th>
          </tr>
        </thead>
        <tbody>
          {items.map((h, i) => (
            <tr key={i}>
              <td className="cell-strong">{h.name}</td>
              <td>{h.type}</td>
              <td>{h.neighbourhood || "—"}</td>
              <td><Stars n={h.stars} /></td>
              <td className="cell-price">{h.price_per_night}</td>
              <td className="cell-price">{h.total_stay}</td>
              <td>
                {h.url
                  ? <a href={h.url} className="book-link" target="_blank" rel="noopener noreferrer">Book →</a>
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Budget Panel ─────────────────────────────────────────────────────────────

const TIER_CFG = [
  { key: "economy",   label: "Economy",   color: "#3b82f6", bg: "rgba(59,130,246,0.08)",  border: "rgba(59,130,246,0.22)" },
  { key: "mid_range", label: "Mid-Range", color: "#f59e0b", bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.22)" },
  { key: "comfort",   label: "Comfort",   color: "#8b5cf6", bg: "rgba(139,92,246,0.08)",  border: "rgba(139,92,246,0.22)" },
];

const BUDGET_ROWS = [
  { key: "transport",     label: "Transport" },
  { key: "accommodation", label: "Accommodation" },
  { key: "meals",         label: "Meals" },
  { key: "activities",    label: "Activities" },
];

function BudgetPanel({ budget, trip }) {
  if (!budget) return <p style={{ color: "var(--text-soft)" }}>No budget data.</p>;
  return (
    <>
      <div className="tier-grid">
        {TIER_CFG.map(({ key, label, color, bg, border }) => {
          const tier = budget[key];
          if (!tier) return null;
          return (
            <div key={key} className="tier-card" style={{ "--tc": color, "--tb": bg, "--tbr": border }}>
              <div className="tier-name">{label}</div>
              <div className="tier-total">{tier.total}</div>
              {tier.per_person && (
                <div className="tier-pp">{tier.per_person}<span> / person</span></div>
              )}
              <div className="tier-items">
                {BUDGET_ROWS.map(({ key: rk, label: rl }) => (
                  <div key={rk} className="tier-item">
                    <span className="tier-item-label">{rl}</span>
                    <span className="tier-item-val">{tier[rk] || "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {budget.notes && <div className="budget-note">{budget.notes}</div>}
    </>
  );
}

// ─── Itinerary Panel ──────────────────────────────────────────────────────────

function ItineraryPanel({ days, note }) {
  if (!days || days.length === 0) return <p style={{ color: "var(--text-soft)" }}>No itinerary data.</p>;
  return (
    <>
      {note && <p style={{ marginBottom: 14, fontSize: "0.8rem", color: "var(--text-soft)", fontStyle: "italic" }}>{note}</p>}
      <div className="day-list">
        {days.map((d, i) => (
          <div key={i} className="day-card">
            <div className="day-hdr">
              <span className="day-number">Day {d.day}</span>
              <span className="day-date">{d.date}</span>
              {d.label && <span className="day-label">{d.label}</span>}
            </div>
            <div className="day-body">
              {d.morning   && <div className="time-slot"><div className="time-label">🌅 Morning</div><div className="time-text">{d.morning}</div></div>}
              {d.afternoon && <div className="time-slot"><div className="time-label">☀️ Afternoon</div><div className="time-text">{d.afternoon}</div></div>}
              {d.evening   && <div className="time-slot"><div className="time-label">🌙 Evening</div><div className="time-text">{d.evening}</div></div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Getting Around Panel ─────────────────────────────────────────────────────

function AroundPanel({ items }) {
  if (!items || items.length === 0) return <p style={{ color: "var(--text-soft)" }}>No local transport data.</p>;
  return (
    <div className="around-grid">
      {items.map((r, i) => (
        <div key={i} className="around-item">
          <div className="around-option">{r.option}</div>
          <div className="around-cost">{r.cost}</div>
          <div className="around-notes">{r.notes}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Data Notes Panel ─────────────────────────────────────────────────────────

function NotesPanel({ notes }) {
  const items = [
    ...(notes.fetch_failed || []).map(s => ({ type: "failed",   text: s })),
    ...(notes.estimates    || []).map(s => ({ type: "estimate", text: s })),
    ...(notes.missing      || []).map(s => ({ type: "missing",  text: s })),
  ];
  if (items.length === 0) return <p style={{ color: "var(--text-soft)" }}>No data quality issues.</p>;
  return (
    <div className="notes-grid">
      {items.map((n, i) => (
        <div key={i} className={`note-item note-item--${n.type}`}>{n.text}</div>
      ))}
    </div>
  );
}

// ─── PDF Export Button ────────────────────────────────────────────────────────

function PdfIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
    </svg>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function TripResult({ data }) {
  const [activeTab, setActiveTab] = useState("transport");
  const [exporting, setExporting] = useState(false);

  const handleExportPDF = useCallback(async () => {
    setExporting(true);
    await new Promise(r => setTimeout(r, 80));
    window.print();
    setExporting(false);
  }, []);

  if (!data) return null;

  const { trip, transport, accommodation, budget, itinerary, itinerary_note, getting_around, data_notes } = data;

  const notesCount = data_notes
    ? (data_notes.fetch_failed?.length || 0) + (data_notes.missing?.length || 0)
    : 0;

  const TABS = [
    { id: "transport",  icon: transport?.emoji || "✈️", label: "Transport" },
    { id: "stay",       icon: "🏨",  label: "Stay" },
    { id: "budget",     icon: "💰",  label: "Budget" },
    { id: "itinerary",  icon: "📅",  label: "Itinerary" },
    { id: "around",     icon: "🚇",  label: "Getting Around" },
    { id: "notes",      icon: "⚠️",  label: "Notes", badge: notesCount },
  ];

  return (
    <div className="trip-result">
      {trip && <TripHeader trip={trip} />}
      <TabBar tabs={TABS} active={activeTab} onSelect={setActiveTab} />
      <div className="tab-panel">
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
          <button className="btn-export-pdf" onClick={handleExportPDF} disabled={exporting}>
            <PdfIcon />
            {exporting ? "Preparing…" : "Export PDF"}
          </button>
        </div>
        {activeTab === "transport"  && <TransportPanel transport={transport} trip={trip} />}
        {activeTab === "stay"       && <StayPanel items={accommodation} />}
        {activeTab === "budget"     && <BudgetPanel budget={budget} trip={trip} />}
        {activeTab === "itinerary"  && <ItineraryPanel days={itinerary} note={itinerary_note} />}
        {activeTab === "around"     && <AroundPanel items={getting_around} />}
        {activeTab === "notes"      && data_notes && <NotesPanel notes={data_notes} />}
      </div>

      {/* ── Full report rendered only when printing ── */}
      <div className="print-report">
        <div className="print-section">
          <div className="print-section-title">Transport</div>
          <TransportPanel transport={transport} trip={trip} />
        </div>
        <div className="print-section">
          <div className="print-section-title">Accommodation</div>
          <StayPanel items={accommodation} />
        </div>
        <div className="print-section">
          <div className="print-section-title">Budget</div>
          <BudgetPanel budget={budget} trip={trip} />
        </div>
        <div className="print-section">
          <div className="print-section-title">Itinerary</div>
          <ItineraryPanel days={itinerary} note={itinerary_note} />
        </div>
        {getting_around?.length > 0 && (
          <div className="print-section">
            <div className="print-section-title">Getting Around</div>
            <AroundPanel items={getting_around} />
          </div>
        )}
        {data_notes && notesCount > 0 && (
          <div className="print-section">
            <div className="print-section-title">Data Notes</div>
            <NotesPanel notes={data_notes} />
          </div>
        )}
      </div>
    </div>
  );
}
