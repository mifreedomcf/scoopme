/**
 * Notification templates and the redaction guard. Pure module.
 *
 * Rule: a notification body may never contain an exact address, a rider's phone
 * number, a verification code, a minor's location, or the sensitive purpose of
 * a trip. Bodies are built from generic labels only.
 */

export type TemplateKey =
  | "request_received"
  | "consent_needed"
  | "request_approved"
  | "request_waitlisted"
  | "driver_assigned"
  | "driver_en_route"
  | "driver_arrived"
  | "ride_started"
  | "dropoff_pending"
  | "ride_completed"
  | "ride_canceled"
  | "rider_no_show"
  | "failed_handoff"
  | "incident_update"
  | "credential_expiring"
  | "contribution_acknowledged";

export interface TemplateContext {
  brandName: string;
  riderFirstName?: string;
  /** Always a generic label such as "your scheduled ride" — never the resource name. */
  genericDestinationLabel: string;
  windowLabel?: string;
  driverFirstName?: string;
  vehicleDescription?: string;
  supportPhone?: string;
  credentialLabel?: string;
  expiresOn?: string;
}

export interface RenderedNotification {
  subject: string;
  body: string;
}

const GENERIC = "your scheduled ride";

export function renderTemplate(key: TemplateKey, ctx: TemplateContext): RenderedNotification {
  const name = ctx.riderFirstName ? `${ctx.riderFirstName}, ` : "";
  const dest = ctx.genericDestinationLabel || GENERIC;
  const brand = ctx.brandName;
  const window = ctx.windowLabel ? ` for ${ctx.windowLabel}` : "";

  switch (key) {
    case "request_received":
      return {
        subject: `${brand}: we have your ride request`,
        body: `${name}we received your request${window}. A coordinator will review it and let you know when it is confirmed.`,
      };
    case "consent_needed":
      return {
        subject: `${brand}: a guardian signature is needed`,
        body: `A ride request${window} is waiting for a verified guardian to review and sign. Nothing is scheduled until then.`,
      };
    case "request_approved":
      return {
        subject: `${brand}: your ride is approved`,
        body: `${name}${dest}${window} is approved. We will tell you as soon as a driver is matched.`,
      };
    case "request_waitlisted":
      return {
        subject: `${brand}: your ride is on the waitlist`,
        body: `${name}we do not have a driver for ${dest}${window} yet. You are on the waitlist and we will keep trying.`,
      };
    case "driver_assigned":
      return {
        subject: `${brand}: a driver is matched`,
        body: `${name}${ctx.driverFirstName ?? "A volunteer driver"} will take you${window}. Open the app to see the driver, the vehicle, and your verification code.`,
      };
    case "driver_en_route":
      return { subject: `${brand}: your driver is on the way`, body: `${name}your driver is heading to the pickup point now.` };
    case "driver_arrived":
      return {
        subject: `${brand}: your driver has arrived`,
        body: `${name}your driver is at the pickup point. Check the vehicle in the app before you get in, and share your code with the driver.`,
      };
    case "ride_started":
      return { subject: `${brand}: ride started`, body: `${name}you are on your way to ${dest}.` };
    case "dropoff_pending":
      return { subject: `${brand}: arriving soon`, body: `${name}your driver is arriving at ${dest}.` };
    case "ride_completed":
      return { subject: `${brand}: ride complete`, body: `${name}you have arrived. There is nothing to pay — rides are always free.` };
    case "ride_canceled":
      return {
        subject: `${brand}: ride canceled`,
        body: `${name}${dest}${window} was canceled. You can request another ride any time.`,
      };
    case "rider_no_show":
      return {
        subject: `${brand}: we could not find you`,
        body: `${name}your driver waited at the pickup point and could not reach you. Nothing is owed. Request again whenever you need to.`,
      };
    case "failed_handoff":
      return {
        subject: `${brand}: drop-off could not be completed`,
        body: `A drop-off could not be completed and our safety team has been alerted. Call ${ctx.supportPhone ?? "the support line"} now.`,
      };
    case "incident_update":
      return {
        subject: `${brand}: safety team update`,
        body: `Our safety team has an update about a recent ride. Sign in to read it, or call the support line.`,
      };
    case "credential_expiring":
      return {
        subject: `${brand}: a document is about to expire`,
        body: `Your ${ctx.credentialLabel ?? "driver document"} expires on ${ctx.expiresOn ?? "soon"}. Upload a current one to keep driving. Ride eligibility pauses automatically on the expiry date.`,
      };
    case "contribution_acknowledged":
      return {
        subject: `${brand}: thank you`,
        body: `Thank you for your contribution. It is voluntary and it has no effect on anyone's access to a ride.`,
      };
    default:
      return { subject: `${brand}`, body: `You have an update about ${GENERIC}.` };
  }
}

/** Channels a template may use. SMS previews land on lock screens, so the
 * sensitive-context templates stay in-app. */
export const TEMPLATE_CHANNELS: Record<TemplateKey, ("email" | "sms" | "in_app")[]> = {
  request_received: ["email", "sms", "in_app"],
  consent_needed: ["email", "in_app"],
  request_approved: ["email", "sms", "in_app"],
  request_waitlisted: ["email", "in_app"],
  driver_assigned: ["email", "sms", "in_app"],
  driver_en_route: ["sms", "in_app"],
  driver_arrived: ["sms", "in_app"],
  ride_started: ["in_app"],
  dropoff_pending: ["in_app"],
  ride_completed: ["email", "in_app"],
  ride_canceled: ["email", "sms", "in_app"],
  rider_no_show: ["email", "in_app"],
  failed_handoff: ["sms", "in_app"],
  incident_update: ["email", "in_app"],
  credential_expiring: ["email", "in_app"],
  contribution_acknowledged: ["email", "in_app"],
};

export function channelAllowed(key: TemplateKey, channel: "email" | "sms" | "in_app"): boolean {
  return (TEMPLATE_CHANNELS[key] ?? ["in_app"]).includes(channel);
}
