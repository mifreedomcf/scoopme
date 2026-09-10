import { useEffect, useState } from "react";
import { base44, decideParticipantAuthorization, type ApiError } from "@/lib/api";
import { Empty } from "@/components/Chrome";

interface Authorization {
  id: string;
  organization_id: string;
  participant_user_id: string;
  scope: string;
  status: string;
  expires_at?: string;
}

interface Org { id: string; name: string }

/** The participant's own view: who has asked, and what they decided. */
export default function MyAuthorizations() {
  const [authorizations, setAuthorizations] = useState<Authorization[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setAuthorizations((await base44.entities.OrganizationParticipantAuthorization.list("-created_date", 50)) as Authorization[]);
    try {
      setOrgs((await base44.entities.Organization.list("name", 100)) as Org[]);
    } catch {
      setOrgs([]);
    }
  };

  useEffect(() => { load().catch(() => setNote("We could not load your permissions.")); }, []);

  async function decide(id: string, decision: "confirm" | "decline" | "withdraw") {
    setBusy(id);
    setNote(null);
    try {
      const r = await decideParticipantAuthorization(id, decision);
      setNote((r as { message: string }).message);
      await load();
    } catch (err) {
      setNote((err as ApiError).message);
    } finally {
      setBusy(null);
    }
  }

  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? "An organization";
  const pending = authorizations.filter((a) => a.status === "pending");
  const active = authorizations.filter((a) => a.status === "active");
  const past = authorizations.filter((a) => !["pending", "active"].includes(a.status));

  return (
    <main id="main" className="pad">
      <h1>Who can book for you</h1>
      <p>
        You can let an organization request rides on your behalf. You decide, and you can change your mind
        whenever you like. Saying no, or changing your mind later, does not affect your own rides at all.
      </p>
      {note && <p role="status" className="field-error">{note}</p>}

      {pending.length > 0 && (
        <section aria-labelledby="asked">
          <h2 id="asked">Waiting on you</h2>
          {pending.map((a) => (
            <article className="record" key={a.id}>
              <h3>{orgName(a.organization_id)} would like to book rides for you</h3>
              <p className="meta">
                {a.scope === "request_and_receive_status"
                  ? "They would be able to request rides and see their status."
                  : "They would be able to request rides only."}
              </p>
              <div className="actions">
                <button className="btn btn--primary" onClick={() => decide(a.id, "confirm")} disabled={busy === a.id}>
                  Yes, they can
                </button>
                <button className="btn btn--secondary" onClick={() => decide(a.id, "decline")} disabled={busy === a.id}>
                  No thank you
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      <section aria-labelledby="current">
        <h2 id="current">Currently allowed</h2>
        {active.length === 0 && (
          <Empty title="Nobody" body="No organization can book rides for you. You can still book for yourself any time." />
        )}
        {active.map((a) => (
          <article className="record" key={a.id}>
            <span className="status status--go">allowed by you</span>
            <h3>{orgName(a.organization_id)}</h3>
            {a.expires_at && <p className="meta">You will be asked again after {new Date(a.expires_at).toLocaleDateString()}.</p>}
            <button className="btn btn--secondary" onClick={() => decide(a.id, "withdraw")} disabled={busy === a.id}>
              Stop letting them book for me
            </button>
          </article>
        ))}
      </section>

      {past.length > 0 && (
        <section aria-labelledby="past">
          <h2 id="past">Past</h2>
          {past.map((a) => (
            <article className="record" key={a.id}>
              <span className="status status--wait">{a.status}</span>
              <h3>{orgName(a.organization_id)}</h3>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
