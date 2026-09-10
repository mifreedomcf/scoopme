import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { claimRide, declineRideOffer, listDriverOffers } from "@/lib/api";
import { Empty } from "@/components/Chrome";
import { RESOURCE_CATEGORY_LABELS, windowLabel } from "@/lib/ride-display";

interface Offer {
  offer_id: string;
  ride_request_id: string;
  pickup_area_label: string;
  destination_area_label: string;
  resource_category: string;
  window_start: string;
  window_end: string;
  passenger_count: number;
  required_capabilities: string[];
  approx_distance_miles?: number;
  why_you_match: string[];
}

export default function DriverHome() {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    listDriverOffers()
      .then((r) => {
        const res = r as unknown as { offers: Offer[]; message?: string };
        setOffers(res.offers);
        setNote(res.message ?? null);
      })
      .catch((e) => setNote((e as Error).message));

  useEffect(() => { void load(); }, []);

  async function claim(rideId: string) {
    setBusy(rideId);
    try {
      await claimRide(rideId);
      setNote("You have this ride. Exact address and contact details unlock closer to pickup time.");
      await load();
    } catch (e) {
      setNote((e as Error).message);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function decline(offerId: string) {
    setBusy(offerId);
    try {
      await declineRideOffer(offerId);
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main id="main" className="pad">
      <h1>Rides you can take</h1>

      <nav aria-label="Driver pages" className="actions">
        <Link className="btn btn--secondary" to="/driver/credentials">My documents</Link>
        <Link className="btn btn--secondary" to="/driver/car">My car</Link>
        <Link className="btn btn--secondary" to="/driver/times">When I can drive</Link>
      </nav>
      <p className="meta">
        You see the neighbourhood, the kind of place, and the time window. The exact address and the
        rider&apos;s phone number unlock after you take the ride, close to the pickup time.
      </p>
      {note && <p className="field-error" role="status">{note}</p>}

      {offers === null && <p>Loading…</p>}
      {offers?.length === 0 && (
        <Empty title="Nothing open right now" body="New rides appear here when a coordinator approves them and your credentials cover what the rider needs." />
      )}

      {offers && offers.length > 0 && (
        <p className="meta">
          Declining costs you nothing and is not held against you. It just tells the coordinator to look
          elsewhere.
        </p>
      )}

      {offers?.map((o) => (
        <article className="record" key={o.offer_id}>
          <h3>{o.pickup_area_label} → {o.destination_area_label}</h3>
          <p className="meta">
            {RESOURCE_CATEGORY_LABELS[o.resource_category] ?? o.resource_category} · {windowLabel(o.window_start)} ·{" "}
            {o.passenger_count} {o.passenger_count === 1 ? "passenger" : "passengers"}
            {o.approx_distance_miles !== undefined && ` · about ${o.approx_distance_miles.toFixed(1)} mi away`}
          </p>
          {o.required_capabilities.length > 0 && <p>Needs: {o.required_capabilities.join(", ")}</p>}
          <details>
            <summary>Why you match</summary>
            <ul>{o.why_you_match.map((r) => <li key={r}>{r.replace(/_/g, " ")}</li>)}</ul>
          </details>
          <div className="actions">
            <button className="btn btn--primary" onClick={() => claim(o.ride_request_id)} disabled={busy === o.ride_request_id}>
              {busy === o.ride_request_id ? "Taking…" : "Take this ride"}
            </button>
            <button className="btn btn--secondary" onClick={() => decline(o.offer_id)} disabled={busy === o.offer_id}>
              Not this one
            </button>
          </div>
        </article>
      ))}
    </main>
  );
}
