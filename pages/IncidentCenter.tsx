import { useEffect, useState } from "react";
import { base44, manageSafetyIncident, type ApiError } from "@/lib/api";
import { Empty } from "@/components/Chrome";

interface Incident {
  id: string;
  ride_request_id?: string;
  incident_type: string;
  severity: string;
  status: string;
  occurred_at: string;
  narrative?: string;
  immediate_actions_taken?: string;
  mandated_report_filed?: boolean;
  source?: string;
  escalation_kind?: string;
  retention_hold_id?: string;
}

const SEVERITY_TONE: Record<string, string> = {
  critical: "stop", high: "stop", moderate: "live", low: "wait",
};

export default function IncidentCenter() {
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [actions, setActions] = useState("");
  const [justification, setJustification] = useState("");

  const load = () =>
    base44.entities.SafetyIncident.list("-occurred_at", 100)
      .then((rows) => setIncidents(rows as Incident[]))
      .catch(() => setNote("You do not have access to the incident centre."));

  useEffect(() => { void load(); }, []);

  async function update(incident: Incident, changes: Record<string, unknown>, releaseHold = false) {
    setNote(null);
    try {
      const r = await manageSafetyIncident({
        incident_id: incident.id,
        changes,
        release_hold: releaseHold || undefined,
        release_justification: releaseHold ? justification : undefined,
      });
      const res = r as { hold_released: boolean };
      setNote(res.hold_released ? "Updated, and the retention hold was released." : "Updated.");
      await load();
    } catch (err) {
      const e = err as ApiError;
      setNote(e.fields?.map((f) => f.message).join(" ") ?? e.message);
    }
  }

  return (
    <main id="main" className="pad">
      <h1>Safety incidents</h1>
      <p className="meta">
        Restricted to safety staff. Narratives on this page never appear in any report or export.
      </p>
      {note && <p role="status" className="field-error">{note}</p>}

      {incidents === null && !note && <p>Loading…</p>}
      {incidents?.length === 0 && <Empty title="Nothing open" body="Reports and automatic escalations land here." />}

      {incidents?.map((i) => (
        <article className="record" key={i.id}>
          <span className={`status status--${SEVERITY_TONE[i.severity] ?? "wait"}`}>
            {i.severity} · {i.status.replace(/_/g, " ")}
          </span>
          <h3>{i.incident_type.replace(/_/g, " ")}</h3>
          <p className="meta">
            {new Date(i.occurred_at).toLocaleString()}
            {i.source === "escalation_timer" && " · opened by a check-in timer"}
            {i.escalation_kind && ` · ${i.escalation_kind.replace(/_/g, " ")}`}
            {i.retention_hold_id && " · record locked from deletion"}
          </p>

          {open === i.id ? (
            <>
              {i.narrative && <p>{i.narrative}</p>}
              <div className="field">
                <label htmlFor={`actions-${i.id}`}>What has been done</label>
                <textarea
                  id={`actions-${i.id}`}
                  defaultValue={i.immediate_actions_taken ?? ""}
                  onChange={(e) => setActions(e.target.value)}
                />
              </div>

              {i.incident_type === "suspected_abuse_neglect" && (
                <div className="check">
                  <input
                    id={`mandated-${i.id}`}
                    type="checkbox"
                    defaultChecked={i.mandated_report_filed}
                    onChange={(e) => update(i, { mandated_report_filed: e.target.checked })}
                  />
                  <label htmlFor={`mandated-${i.id}`}>
                    The mandated report has been filed with the state authority
                  </label>
                </div>
              )}

              <div className="actions">
                <button className="btn btn--secondary" onClick={() => update(i, { status: "under_review", immediate_actions_taken: actions })}>
                  Mark under review
                </button>
                <button className="btn btn--secondary" onClick={() => update(i, { status: "escalated", immediate_actions_taken: actions })}>
                  Escalate
                </button>
                <button className="btn btn--primary" onClick={() => update(i, { status: "resolved", immediate_actions_taken: actions })}>
                  Resolve
                </button>
              </div>

              {["resolved", "closed"].includes(i.status) && i.retention_hold_id && (
                <>
                  <div className="field">
                    <label htmlFor={`just-${i.id}`}>Why can the record be unlocked?</label>
                    <span className="hint">
                      At least 40 characters. Platform administrators only. This is recorded permanently.
                    </span>
                    <textarea id={`just-${i.id}`} value={justification} onChange={(e) => setJustification(e.target.value)} />
                  </div>
                  <button className="btn btn--secondary" onClick={() => update(i, {}, true)}>
                    Release the retention hold
                  </button>
                </>
              )}

              <button className="btn btn--secondary" onClick={() => setOpen(null)}>Close</button>
            </>
          ) : (
            <button className="btn btn--secondary" onClick={() => { setOpen(i.id); setActions(i.immediate_actions_taken ?? ""); }}>
              Open this incident
            </button>
          )}
        </article>
      ))}
    </main>
  );
}
