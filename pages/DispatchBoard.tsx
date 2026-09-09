import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { base44, exportRideManifest, reviewRide, type ApiError } from "@/lib/api";
import { Empty } from "@/components/Chrome";
import { statusLabel, statusTone, windowLabel } from "@/lib/ride-display";

interface Ride {
  id: string;
  status: string;
  pickup_area_label?: string;
  destination_area_label?: string;
  requested_pickup_at?: string;
  passenger_count?: number;
  eligibility_flags?: string[];
  pickup_geo_status?: string;
  destination_geo_status?: string;
}

interface Credential {
  id: string;
  driver_profile_id: string;
  credential_type: string;
  status: string;
  expiration_date?: string;
}

const REVIEW_QUEUE = ["eligibility_review", "awaiting_consent", "waitlisted"];

export default function DispatchBoard() {
  const [rides, setRides] = useState<Ride[] | null>(null);
  const [expiring, setExpiring] = useState<Credential[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manifest, setManifest] = useState({ from: "", to: "", purpose: "" });
  const [manifestRows, setManifestRows] = useState<number | null>(null);

  const load = async () => {
    const rows = (await base44.entities.RideRequest.list("-created_date", 200)) as Ride[];
    setRides(rows);
    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const creds = (await base44.entities.DriverCredential.filter(
      { expiration_date: { $lte: soon } }, "expiration_date", 50,
    )) as Credential[];
    setExpiring(creds);
  };

  useEffect(() => { load().catch((e) => setNote((e as Error).message)); }, []);

  async function decide(rideId: string, decision: "approve" | "waitlist" | "decline") {
    setBusy(rideId);
    try {
      const result = await reviewRide({
        ride_request_id: rideId,
        decision,
        reason_code: decision === "approve" ? undefined : `dispatcher_${decision}`,
      });
      const published = (result as { offers_published?: number }).offers_published ?? 0;
      setNote(decision === "approve" ? `Approved. ${published} driver offer(s) published.` : `Marked ${decision}.`);
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function pullManifest() {
    setNote(null);
    setManifestRows(null);
    try {
      const r = await exportRideManifest(
        new Date(manifest.from).toISOString(),
        new Date(manifest.to).toISOString(),
        manifest.purpose,
      );
      const res = r as { row_count: number; handling_notice: string };
      setManifestRows(res.row_count);
      setNote(res.handling_notice);
    } catch (e) {
      const err = e as ApiError;
      setNote(err.fields?.map((f) => f.message).join(" ") ?? err.message);
    }
  }

  const queue = rides?.filter((r) => REVIEW_QUEUE.includes(r.status)) ?? [];
  const live = rides?.filter((r) =>
    ["offered", "claimed", "confirmed", "en_route", "arrived_pickup", "rider_verified", "in_progress", "arrived_dropoff"].includes(r.status),
  ) ?? [];
  const alerts = rides?.filter((r) => ["failed_handoff", "incident_hold"].includes(r.status)) ?? [];

  return (
    <main id="main" className="pad">
      <h1>Dispatch</h1>
      {note && <p role="status" className="field-error">{note}</p>}

      {alerts.length > 0 && (
        <section aria-labelledby="alerts">
          <h2 id="alerts">Safety alerts</h2>
          {alerts.map((r) => (
            <article className="record" key={r.id}>
              <span className="status status--stop">{statusLabel(r.status)}</span>
              <h3>{r.pickup_area_label} → {r.destination_area_label}</h3>
              <Link to={`/rides/${r.id}`}>Open</Link>
            </article>
          ))}
        </section>
      )}

      <section aria-labelledby="queue">
        <h2 id="queue">Waiting for review ({queue.length})</h2>
        {queue.length === 0 && <Empty title="Nothing waiting" body="New requests land here as soon as someone sends one." />}
        {queue.map((r) => (
          <article className="record" key={r.id}>
            <span className={`status status--${statusTone(r.status)}`}>{statusLabel(r.status)}</span>
            <h3>{r.pickup_area_label ?? "Pickup area unknown"} → {r.destination_area_label ?? "Destination"}</h3>
            <p className="meta">
              {windowLabel(r.requested_pickup_at)} · {r.passenger_count ?? 1} passenger(s)
            </p>
            {(r.pickup_geo_status === "manual_review" || r.destination_geo_status === "manual_review") && (
              <p className="field-error">
                Addresses could not be confirmed automatically. Check both against the service area before approving.
              </p>
            )}
            {r.eligibility_flags && r.eligibility_flags.length > 0 && (
              <details>
                <summary>Review flags ({r.eligibility_flags.length})</summary>
                <ul>{r.eligibility_flags.map((f) => <li key={f}>{f.replace(/_/g, " ")}</li>)}</ul>
              </details>
            )}
            <div className="actions">
              <button className="btn btn--primary" onClick={() => decide(r.id, "approve")} disabled={busy === r.id}>Approve</button>
              <button className="btn btn--secondary" onClick={() => decide(r.id, "waitlist")} disabled={busy === r.id}>Waitlist</button>
              <button className="btn btn--secondary" onClick={() => decide(r.id, "decline")} disabled={busy === r.id}>Decline</button>
            </div>
          </article>
        ))}
      </section>

      <section aria-labelledby="live">
        <h2 id="live">In progress ({live.length})</h2>
        {live.length === 0 && <Empty title="No rides underway" body="Approved rides appear here once a driver takes them." />}
        {live.map((r) => (
          <article className="record" key={r.id}>
            <span className={`status status--${statusTone(r.status)}`}>{statusLabel(r.status)}</span>
            <h3>{r.pickup_area_label} → {r.destination_area_label}</h3>
            <p className="meta">{windowLabel(r.requested_pickup_at)}</p>
            <Link to={`/rides/${r.id}`}>Open</Link>
          </article>
        ))}
      </section>

      <section aria-labelledby="manifest">
        <h2 id="manifest">Printable manifest, for when the app is down</h2>
        <p className="meta">
          This pulls home addresses, phone numbers, and ride verification codes for confirmed rides. Print
          it before service, keep it locked, and shred it at the end of the day. Your name, the time, and
          your reason are recorded.
        </p>
        <div className="field">
          <label htmlFor="m-from">From</label>
          <input id="m-from" type="datetime-local" value={manifest.from} onChange={(e) => setManifest({ ...manifest, from: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="m-to">Until</label>
          <span className="hint">Up to 48 hours at a time.</span>
          <input id="m-to" type="datetime-local" value={manifest.to} onChange={(e) => setManifest({ ...manifest, to: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="m-purpose">Why do you need it?</label>
          <input id="m-purpose" value={manifest.purpose} onChange={(e) => setManifest({ ...manifest, purpose: e.target.value })} />
        </div>
        <button className="btn btn--secondary" onClick={pullManifest}>Pull the manifest</button>
        {manifestRows !== null && <p role="status">{manifestRows} ride(s) in that range.</p>}
      </section>

      <section aria-labelledby="creds">
        <h2 id="creds">Credentials expiring within 30 days ({expiring.length})</h2>
        {expiring.length === 0 && <Empty title="Nothing expiring" body="Drivers are notified before a document runs out, and eligibility pauses automatically on the expiry date." />}
        {expiring.map((c) => (
          <article className="record" key={c.id}>
            <h3>{c.credential_type.replace(/_/g, " ")}</h3>
            <p className="meta">Expires {c.expiration_date} · status {c.status}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
