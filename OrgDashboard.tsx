import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { base44, requestParticipantAuthorization, type ApiError, type AppConfig } from "@/lib/api";
import { Empty } from "@/components/Chrome";
import { statusLabel, statusTone, windowLabel } from "@/lib/ride-display";

interface Authorization {
  id: string;
  organization_id: string;
  participant_user_id: string;
  scope: string;
  status: string;
  expires_at?: string;
  verified_at?: string;
}

interface Ride {
  id: string; status: string; destination_area_label?: string;
  requested_pickup_at?: string; flexible_window_minutes?: number;
}

interface Member { id: string; organization_id: string; org_role: string; status: string }

export default function OrgDashboard({ config }: { config: AppConfig | null }) {
  const [memberships, setMemberships] = useState<Member[]>([]);
  const [authorizations, setAuthorizations] = useState<Authorization[]>([]);
  const [rides, setRides] = useState<Ride[]>([]);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    setMemberships((await base44.entities.OrganizationMember.list("-created_date", 20)) as Member[]);
    setAuthorizations((await base44.entities.OrganizationParticipantAuthorization.list("-created_date", 100)) as Authorization[]);
    setRides((await base44.entities.RideRequest.list("-created_date", 100)) as Ride[]);
  };

  useEffect(() => { load().catch(() => setNote("We could not load your organization.")); }, []);

  const approved = memberships.find((m) => m.status === "approved");
  const orgId = approved?.organization_id ?? "";

  async function ask() {
    setNote(null);
    try {
      const r = await requestParticipantAuthorization(orgId, email);
      setNote((r as { message: string }).message);
      setEmail("");
      await load();
    } catch (err) {
      const e = err as ApiError;
      setNote(e.message);
    }
  }

  const active = authorizations.filter((a) => a.status === "active");
  const pending = authorizations.filter((a) => a.status === "pending");

  return (
    <main id="main" className="pad">
      <h1>Your organization</h1>

      {!approved && (
        <Empty
          title="Waiting on approval"
          body="A platform administrator has to approve you before you can request rides for anyone. Nothing you do here affects your participants' own rides in the meantime."
        />
      )}

      {approved && (
        <>
          <section aria-labelledby="ask">
            <h2 id="ask">Ask someone for permission</h2>
            <p>
              You can only book for people who have said yes themselves. Being their case worker, teacher,
              or coach is not permission, and it is never permission for anyone under 18 — a verified parent
              or legal guardian has to do that separately.
            </p>
            <div className="field">
              <label htmlFor="participant-email">Their email address</label>
              <span className="hint">They need an account already. We will ask them, not you.</span>
              <input id="participant-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <button className="btn btn--primary" onClick={ask} disabled={!email}>Send the request</button>
            {note && <p role="status" className="field-error">{note}</p>}
          </section>

          <section aria-labelledby="pending">
            <h2 id="pending">Waiting on them ({pending.length})</h2>
            {pending.length === 0 && <Empty title="Nothing waiting" body="Requests you send appear here until the person answers." />}
            {pending.map((a) => (
              <article className="record" key={a.id}>
                <span className="status status--wait">waiting on them</span>
                <h3>Permission request</h3>
                <p className="meta">
                  {a.expires_at && `Expires ${new Date(a.expires_at).toLocaleDateString()}`}
                </p>
                <p className="meta">You cannot request rides for this person until they confirm.</p>
              </article>
            ))}
          </section>

          <section aria-labelledby="active">
            <h2 id="active">People you can book for ({active.length})</h2>
            {active.length === 0 && (
              <Empty title="Nobody yet" body="Once someone confirms, they appear here and you can request a ride for them." />
            )}
            {active.map((a) => (
              <article className="record" key={a.id}>
                <span className="status status--go">confirmed by them</span>
                <h3>Authorized participant</h3>
                <p className="meta">
                  {a.scope === "request_and_receive_status" ? "You can book and see status" : "You can book only"}
                  {a.expires_at && ` · renews ${new Date(a.expires_at).toLocaleDateString()}`}
                </p>
                <Link to="/rides/new">Request a ride for them</Link>
              </article>
            ))}
          </section>

          <section aria-labelledby="org-rides">
            <h2 id="org-rides">Rides you have booked</h2>
            {rides.length === 0 && <Empty title="No rides yet" body="Rides you request for your participants show up here." />}
            {rides.map((r) => (
              <article className="record" key={r.id}>
                <span className={`status status--${statusTone(r.status)}`}>{statusLabel(r.status)}</span>
                <h3>{r.destination_area_label ?? "Community resource"}</h3>
                <p className="meta">{windowLabel(r.requested_pickup_at, r.flexible_window_minutes ?? 30)}</p>
                <Link to={`/rides/${r.id}`}>Open</Link>
              </article>
            ))}
          </section>

          <nav aria-label="Organization pages" className="actions">
            <Link className="btn btn--secondary" to="/org/contributions">Hours and supplies</Link>
            <Link className="btn btn--secondary" to="/reports">Our numbers</Link>
          </nav>

          <p className="footnote">
            Rides are free for your participants and always will be. Nothing your organization gives —
            money, hours, or supplies — changes who gets a ride, how quickly, or how well.{" "}
            {config?.operator_legal_name && `Operated by ${config.operator_legal_name}.`}
          </p>
        </>
      )}
    </main>
  );
}
