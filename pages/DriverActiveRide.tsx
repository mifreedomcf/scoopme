import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { revealRideDetails, transitionRide, verifyRideIdentity, type ApiError, type AppConfig } from "@/lib/api";
import { RouteStrip } from "@/components/RouteStrip";
import { Emergency } from "@/components/Chrome";
import { RESOURCE_CATEGORY_LABELS, windowLabel } from "@/lib/ride-display";

interface Reveal {
  viewer: string;
  ride: Record<string, string | number | undefined>;
  reveal_window_open: boolean;
}

/** What the driver does next, given where the ride is. One action at a time. */
const NEXT_STEP: Record<string, { to: string; label: string }> = {
  confirmed: { to: "en_route", label: "I'm heading to the pickup" },
  en_route: { to: "arrived_pickup", label: "I've arrived at the pickup" },
  rider_verified: { to: "in_progress", label: "We're on our way" },
  in_progress: { to: "arrived_dropoff", label: "We've arrived" },
  arrived_dropoff: { to: "handoff_verified", label: "Drop-off is done" },
  handoff_verified: { to: "completed", label: "Finish this ride" },
};

export default function DriverActiveRide({ config }: { config: AppConfig | null }) {
  const { rideId = "" } = useParams();
  const [data, setData] = useState<Reveal | null>(null);
  const [code, setCode] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    revealRideDetails(rideId)
      .then((r) => setData(r as unknown as Reveal))
      .catch((e) => setNote((e as Error).message));

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rideId]);

  async function advance(to: string, reason?: string) {
    setBusy(true);
    setNote(null);
    try {
      await transitionRide(rideId, to, reason);
      await load();
    } catch (e) {
      setNote((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setNote(null);
    try {
      const result = await verifyRideIdentity(rideId, code);
      setNote((result as { message: string }).message);
      setCode("");
      await load();
    } catch (e) {
      setNote((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <main id="main" className="pad"><h1>Your ride</h1><p>{note ?? "Loading…"}</p></main>;

  const ride = data.ride;
  const status = String(ride.status ?? "");
  const next = NEXT_STEP[status];

  return (
    <main id="main" className="pad">
      <h1>Your ride</h1>
      <RouteStrip status={status} />
      {note && <p role="status" className="field-error">{note}</p>}

      <article className="record">
        <h3>{String(ride.pickup_area_label ?? "Pickup")} → {String(ride.destination_area_label ?? "Destination")}</h3>
        <p className="meta">
          {RESOURCE_CATEGORY_LABELS[String(ride.resource_category)] ?? "Community resource"} ·{" "}
          {windowLabel(ride.requested_pickup_at as string, Number(ride.flexible_window_minutes ?? 30))} ·{" "}
          {ride.passenger_count ?? 1} passenger(s)
        </p>

        {data.reveal_window_open ? (
          <>
            <p><strong>Pick up at:</strong> {String(ride.pickup_address ?? "")}</p>
            <p><strong>Drop off at:</strong> {String(ride.destination_address ?? "")}</p>
            {ride.contact_phone && (
              <p><strong>Rider's phone:</strong> <a href={`tel:${ride.contact_phone}`}>{String(ride.contact_phone)}</a></p>
            )}
            {ride.operational_notes && <p>Note from the rider: {String(ride.operational_notes)}</p>}
          </>
        ) : (
          <p className="meta">
            The exact address and the rider&apos;s phone number unlock two hours before the pickup time.
          </p>
        )}
      </article>

      {status === "arrived_pickup" && (
        <section className="record" aria-labelledby="verify">
          <h3 id="verify">Check who you are picking up</h3>
          <p>
            Ask the rider to read out their six-character code. Do not start the ride without it. If it does
            not match, call the safety line rather than guessing.
          </p>
          <div className="field">
            <label htmlFor="code">The code the rider read to you</label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={6}
              inputMode="text"
              autoCapitalize="characters"
              style={{ fontSize: "1.6875rem", letterSpacing: "0.16em" }}
            />
          </div>
          <button className="btn btn--primary btn--block" onClick={verify} disabled={busy || code.length < 6}>
            {busy ? "Checking…" : "Check this code"}
          </button>
        </section>
      )}

      {next && status !== "arrived_pickup" && (
        <div className="actions">
          <button className="btn btn--primary btn--block" onClick={() => advance(next.to)} disabled={busy}>
            {next.label}
          </button>
        </div>
      )}

      {status === "arrived_dropoff" && (
        <div className="actions">
          <button
            className="btn btn--secondary btn--block"
            onClick={() => advance("failed_handoff", "no_authorized_adult")}
            disabled={busy}
          >
            I can&apos;t complete the drop-off
          </button>
          <p className="meta">
            If a drop-off cannot be completed, stop where you are, stay with the rider, and call the safety
            line. Do not drive somewhere else.
          </p>
        </div>
      )}

      {status === "arrived_pickup" && (
        <div className="actions">
          <button
            className="btn btn--secondary btn--block"
            onClick={() => advance("rider_no_show", "rider_not_present")}
            disabled={busy}
          >
            The rider isn&apos;t here
          </button>
        </div>
      )}

      <Emergency config={config} />

      <div className="actions">
        <a className="btn btn--secondary btn--block" href={`/incident/new?ride=${rideId}`}>
          Report a safety concern
        </a>
      </div>

      {["confirmed", "en_route"].includes(status) && (
        <div className="actions">
          <button className="btn btn--secondary" onClick={() => advance("driver_canceled", "driver_unavailable")} disabled={busy}>
            I can&apos;t do this ride
          </button>
        </div>
      )}
    </main>
  );
}
