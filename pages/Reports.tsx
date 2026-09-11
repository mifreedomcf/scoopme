import { useState } from "react";
import { buildReport, type ApiError } from "@/lib/api";

type Cell = number | "suppressed";

interface Report {
  scope: { audience: string; organizationId?: string; partnerId?: string };
  totals: Record<string, Cell | number | null>;
  by_resource_category: Record<string, Cell>;
  by_pickup_zip: Record<string, Cell>;
  accommodations: { requested: Record<string, Cell>; fulfilled: Record<string, Cell> };
  suppressed_cells: string[];
  notes: string[];
  contributions?: Record<string, number | string>;
}

const TOTAL_LABELS: Record<string, string> = {
  requests: "Rides requested",
  completed: "Rides completed",
  waitlisted: "On the waitlist",
  unfilled: "Nobody could take it",
  canceled: "Cancelled",
  no_shows: "Rider not found at pickup",
  unique_riders: "People served",
  passengers: "Seats used",
  miles: "Miles driven",
  volunteer_hours: "Volunteer hours",
  on_time_rate: "Arrived on time",
};

function show(value: Cell | number | null, key: string): string {
  if (value === null) return "—";
  if (value === "suppressed") return "too few to show";
  if (key === "on_time_rate") return `${Math.round(Number(value) * 100)}%`;
  return String(value);
}

export default function Reports() {
  const [range, setRange] = useState({ from: "", to: "" });
  const [purpose, setPurpose] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(format: "json" | "csv") {
    setNote(null);
    setCsv(null);
    try {
      const r = await buildReport({
        from: new Date(range.from).toISOString(),
        to: new Date(range.to).toISOString(),
        format,
        purpose: format === "csv" ? purpose : undefined,
      });
      if (format === "csv") {
        const res = r as { csv: string; handling_notice: string };
        setCsv(res.csv);
        setNote(res.handling_notice);
      } else {
        setReport(r as unknown as Report);
      }
    } catch (err) {
      const e = err as ApiError;
      setNote(e.fields?.map((f) => f.message).join(" ") ?? e.message);
    }
  }

  return (
    <main id="main" className="pad">
      <h1>Numbers</h1>
      <p>
        What this shows depends on who you are. An organization sees only its own participants; a partner
        sees only activity at its own locations.
      </p>

      <div className="field">
        <label htmlFor="r-from">From</label>
        <input id="r-from" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="r-to">Until</label>
        <input id="r-to" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
      </div>
      <div className="actions">
        <button className="btn btn--primary" onClick={() => run("json")} disabled={!range.from || !range.to}>
          Show the numbers
        </button>
      </div>

      {note && <p role="status" className="field-error">{note}</p>}

      {report && (
        <>
          <section aria-labelledby="totals">
            <h2 id="totals">Overall</h2>
            <table>
              <caption className="meta">
                A cell reading &quot;too few to show&quot; is withheld to protect people&apos;s privacy. It is
                not a zero.
              </caption>
              <tbody>
                {Object.entries(report.totals).map(([k, v]) => (
                  <tr key={k}>
                    <th scope="row" style={{ textAlign: "left", paddingRight: "1rem" }}>{TOTAL_LABELS[k] ?? k}</th>
                    <td>{show(v, k)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-labelledby="cats">
            <h2 id="cats">Where people went</h2>
            {Object.keys(report.by_resource_category).length === 0 && <p className="meta">Nothing in this range.</p>}
            <ul>
              {Object.entries(report.by_resource_category).map(([k, v]) => (
                <li key={k}>{k.replace(/_/g, " ")}: {show(v, k)}</li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="access">
            <h2 id="access">Access needs</h2>
            <h3>Asked for</h3>
            <ul>
              {Object.entries(report.accommodations.requested).map(([k, v]) => (
                <li key={k}>{k.replace(/_/g, " ")}: {show(v, k)}</li>
              ))}
            </ul>
            <h3>Provided</h3>
            <ul>
              {Object.entries(report.accommodations.fulfilled).map(([k, v]) => (
                <li key={k}>{k.replace(/_/g, " ")}: {show(v, k)}</li>
              ))}
            </ul>
          </section>

          {report.contributions && (
            <section aria-labelledby="contrib">
              <h2 id="contrib">Hours and supplies</h2>
              <ul>
                {Object.entries(report.contributions).map(([k, v]) => (
                  <li key={k}>{k.replace(/_/g, " ")}: {String(v)}</li>
                ))}
              </ul>
              <p className="meta">
                None of this affected anyone&apos;s access to a ride.
              </p>
            </section>
          )}

          {report.suppressed_cells.length > 0 && (
            <p className="meta">
              {report.suppressed_cells.length} cell(s) withheld because too few people sit behind them.
            </p>
          )}
          {report.notes.map((n) => <p className="meta" key={n}>{n}</p>)}

          <section aria-labelledby="export">
            <h2 id="export">Export as CSV</h2>
            <div className="field">
              <label htmlFor="r-purpose">Why do you need the file?</label>
              <span className="hint">At least 15 characters. Your name, the time, and this reason are recorded.</span>
              <input id="r-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
            </div>
            <button className="btn btn--secondary" onClick={() => run("csv")} disabled={purpose.trim().length < 15}>
              Build the CSV
            </button>
            {csv && (
              <>
                <label htmlFor="csv-out" className="hint">Copy this into a file:</label>
                <textarea id="csv-out" readOnly value={csv} rows={12} />
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
