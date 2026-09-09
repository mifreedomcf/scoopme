import { Link } from "react-router-dom";
import { FreeStatement } from "@/components/Chrome";
import type { AppConfig } from "@/lib/api";

export default function Landing({ config }: { config: AppConfig | null }) {
  const zips = config?.pilot.allowed_destination_zip_codes.join(", ") ?? "the approved pilot area";
  const lead = config?.pilot.minimum_request_lead_hours ?? 24;

  return (
    <main id="main" className="pad">
      <h1>A ride to what you need, booked ahead.</h1>
      <p>
        Tell us where you are going and when you need to be there. A screened volunteer driver takes you.
        You pay nothing, ever.
      </p>

      <FreeStatement />

      <h2>How it works</h2>
      <ol>
        <li>Ask for a ride at least {lead} hours ahead.</li>
        <li>A coordinator checks it and finds a volunteer driver.</li>
        <li>You get the driver&apos;s name, photo, car, plate, and a code to check before you get in.</li>
      </ol>

      <h2>Where we drive</h2>
      <p>
        During this pilot we pick up inside {config?.pilot.service_area_label ?? "Detroit"} and drop off at
        approved community locations in {zips}. If you need to go somewhere else, we cannot take you yet.
      </p>

      <h2>What this is not</h2>
      <p>
        This is not an ambulance, a medical transport service, or a taxi. For a medical emergency or
        immediate danger, call 911.
      </p>

      <h2>Getting around</h2>
      <p>
        Wheelchair lifts, securement, door-to-door help, a language you speak, and service animals are all
        things you can ask for. We only match you with a driver whose ability to provide them has been
        checked.
      </p>

      <div className="actions">
        <Link className="btn btn--primary" to="/rides">Ask for a ride</Link>
        <Link className="btn btn--secondary" to="/driver/apply">Volunteer to drive</Link>
      </div>

      <p className="footnote">
        Operated by {config?.operator_legal_name ?? "Pilot Operator — To Be Confirmed"}.{" "}
        <Link to="/policies">Policies, privacy, accessibility and safety</Link>.
      </p>
    </main>
  );
}
