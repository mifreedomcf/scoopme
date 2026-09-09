import { NavLink } from "react-router-dom";
import type { AppConfig } from "@/lib/api";

export function Masthead({ config }: { config: AppConfig | null }) {
  return (
    <header className="masthead">
      <span className="wordmark">{config?.brand.name ?? "Scoop Me"}</span>
      <span className="place">{config?.pilot.service_area_label ?? "Detroit, Michigan"}</span>
    </header>
  );
}

export function PilotBanner({ config }: { config: AppConfig | null }) {
  if (!config?.pilot.pilot_mode) return null;
  const zips = config.pilot.allowed_destination_zip_codes.join(", ");
  return (
    <div className="band band--pilot" role="status">
      <strong>Closed pilot.</strong> Pickups inside {config.pilot.service_area_label}, drop-offs at approved
      locations in {zips || "the approved pilot area"}. Not an emergency service.
    </div>
  );
}

export function FulfillmentBanner({ config }: { config: AppConfig | null }) {
  if (!config || config.fulfillment_status.allowed) return null;
  return (
    <div className="band band--stop" role="status">
      Rides are not being driven yet. {config.fulfillment_status.message}
    </div>
  );
}

export function DraftLegalBanner({ config }: { config: AppConfig | null }) {
  if (config?.legal_content_approved) return null;
  return (
    <div className="band band--draft" role="note">
      DRAFT — REQUIRES LEGAL/INSURANCE APPROVAL. Policy text on this screen has not been reviewed by an
      attorney or an insurer.
    </div>
  );
}

export function FreeStatement() {
  return (
    <div className="free-rule">
      <strong>Rides cost nothing.</strong>
      <span>
        No fare, no booking fee, no subscription, no expected tip. Giving, volunteering, or bringing
        supplies never changes who gets a ride or how quickly.
      </span>
    </div>
  );
}

export function TabBar({ roles }: { roles: string[] }) {
  const has = (r: string) => roles.includes(r);
  return (
    <nav className="tabbar" aria-label="Main">
      <NavLink to="/rides">My rides</NavLink>
      <NavLink to="/resources">Resources</NavLink>
      {has("volunteer_driver") && <NavLink to="/driver">Driving</NavLink>}
      {(has("dispatcher") || has("platform_admin")) && <NavLink to="/dispatch">Dispatch</NavLink>}
      {has("platform_admin") && <NavLink to="/admin">Admin</NavLink>}
      <NavLink to="/policies">Policies</NavLink>
    </nav>
  );
}

export function Emergency({ config }: { config: AppConfig | null }) {
  return (
    <section className="emergency" aria-labelledby="emergency-heading">
      <h3 id="emergency-heading">In an emergency</h3>
      <a className="btn btn--danger" href="tel:911">Call 911</a>
      {config?.support.safety_phone ? (
        <a className="btn btn--secondary btn--block" href={`tel:${config.support.safety_phone}`}>
          Contact the safety team
        </a>
      ) : (
        <p className="meta">
          A safety team number has not been set yet. Set it in admin settings before the pilot runs.
        </p>
      )}
      <p className="meta">This app does not replace emergency services.</p>
    </section>
  );
}

export function ErrorSummary({ errors }: { errors: { field: string; message: string }[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="error-summary" role="alert" tabIndex={-1} id="error-summary">
      <h3>{errors.length === 1 ? "One answer needs fixing" : `${errors.length} answers need fixing`}</h3>
      <ul>
        {errors.map((e) => (
          <li key={e.field}>
            <a href={`#field-${e.field}`}>{e.message}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
