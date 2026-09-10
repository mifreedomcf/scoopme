import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { revealRideDetails, transitionRide, type AppConfig } from "@/lib/api";
import { RouteStrip } from "@/components/RouteStrip";
import { Emergency } from "@/components/Chrome";
import { windowLabel } from "@/lib/ride-display";

interface RevealResponse {
  viewer: string;
  ride: Record<string, unknown>;
  driver_card: { display_name: string; photo_url: string | null; vehicle: Record<string, string> | null } | null;
  reveal_window_open: boolean;
}

export default function RideDetail({ config }: { config: AppConfig | null }) {
  const { rideId = "" } = useParams();
  const [data, setData] = useState<RevealResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    revealRideDetails(rideId)
      .then((r) => setData(r as unknown as RevealResponse))
      .catch((e) => setError((e as Error).message));

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rideId]);

  async function cancel() {
    setBusy(true);
    try {
      await transitionRide(rideId, "canceled", "rider_canceled");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <main id="main" className="pad"><h1>We could not open that ride</h1><p>{error}</p></main>;
  if (!data) return <main id="main" className="pad"><p>Loading…</p></main>;

  const ride = data.ride as Record<string, string | number | undefined>;
  const status = String(ride.status ?? "");
  const cancellable = ["eligibility_review", "awaiting_consent", "approved", "offered", "confirmed", "waitlisted"].includes(status);

  return (
    <main id="main" className="pad">
      <h1>Your ride</h1>
      <RouteStrip status={status} />

      <article className="record">
        <h3>{String(ride.destination_area_label ?? "Community resource")}</h3>
        <p className="meta">
          {windowLabel(ride.requested_pickup_at as string, Number(ride.flexible_window_minutes ?? 30))}
        </p>
        {ride.pickup_address && <p>Pickup: {String(ride.pickup_address)}</p>}
        <p><strong>You pay nothing for this ride.</strong></p>
      </article>

      {data.driver_card && (
        <article className="record">
          <h3>Check before you get in</h3>
          <p>Driver: {data.driver_card.display_name}</p>
          {data.driver_card.photo_url && (
            <img src={data.driver_card.photo_url} alt={data.driver_card.display_name} width={120} />
          )}
          {data.driver_card.vehicle && (
            <p>
              {data.driver_card.vehicle.color} {data.driver_card.vehicle.year} {data.driver_card.vehicle.make}{" "}
              {data.driver_card.vehicle.model}, plate {data.driver_card.vehicle.plate}
            </p>
          )}
          {ride.verification_code && (
            <p>
              Your code: <strong style={{ fontSize: "1.6875rem", letterSpacing: "0.12em" }}>{String(ride.verification_code)}</strong>
              <br />
              <span className="meta">Say it to the driver. Do not share it with anyone else.</span>
            </p>
          )}
        </article>
      )}

      <Emergency config={config} />

      {cancellable && (
        <div className="actions">
          <button className="btn btn--secondary" onClick={cancel} disabled={busy}>
            {busy ? "Canceling…" : "Cancel this ride"}
          </button>
        </div>
      )}
      <p className="footnote">Canceling costs nothing and never affects future rides.</p>
    </main>
  );
}
