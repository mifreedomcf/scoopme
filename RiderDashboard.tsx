import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { base44, type AppConfig } from "@/lib/api";
import { Empty, FreeStatement } from "@/components/Chrome";
import { statusLabel, statusTone, windowLabel } from "@/lib/ride-display";

interface RideRow {
  id: string;
  status: string;
  destination_area_label?: string;
  requested_pickup_at?: string;
  flexible_window_minutes?: number;
}

export default function RiderDashboard({ config }: { config: AppConfig | null }) {
  const [rides, setRides] = useState<RideRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Entity RLS scopes this read to the signed-in person's own rides.
    base44.entities.RideRequest.list("-created_date", 50)
      .then((rows) => setRides(rows as RideRow[]))
      .catch(() => setError("We could not load your rides. Try again in a moment."));
  }, []);

  return (
    <main id="main" className="pad">
      <h1>Your rides</h1>
      <FreeStatement />

      <div className="actions">
        <Link className="btn btn--primary btn--block" to="/rides/new">Ask for a ride</Link>
        <Link className="btn btn--secondary btn--block" to="/permissions">Who can book for you</Link>
      </div>

      {error && <p className="field-error">{error}</p>}

      {rides === null && !error && <p>Loading your rides…</p>}

      {rides?.length === 0 && (
        <Empty
          title="No rides yet"
          body={`Ask for one at least ${config?.pilot.minimum_request_lead_hours ?? 24} hours before you need to be somewhere.`}
          action={<Link className="btn btn--primary" to="/rides/new">Ask for a ride</Link>}
        />
      )}

      {rides?.map((ride) => (
        <article className="record" key={ride.id}>
          <span className={`status status--${statusTone(ride.status)}`}>{statusLabel(ride.status)}</span>
          <h3>{ride.destination_area_label ?? "Community resource"}</h3>
          <p className="meta">{windowLabel(ride.requested_pickup_at, ride.flexible_window_minutes ?? 30)}</p>
          <Link to={`/rides/${ride.id}`}>Open this ride</Link>
        </article>
      ))}
    </main>
  );
}
