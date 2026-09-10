/**
 * The frontend's only route to the backend.
 *
 * Everything goes through a backend function. The client never writes a ride,
 * a role, a credential, or a config value directly — entity RLS refuses those
 * writes anyway, and routing through here keeps that fact obvious.
 */
import { createClient } from "@base44/sdk";

export const base44 = createClient({
  appId: import.meta.env.VITE_BASE44_APP_ID as string,
});

export interface ApiFieldError {
  field: string;
  code: string;
  message: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  fields: ApiFieldError[];
  constructor(code: string, message: string, status: number, fields: ApiFieldError[] = []) {
    super(message);
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export async function callFunction<T = Record<string, unknown>>(
  name: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  try {
    const response = await base44.functions.invoke(name, payload);
    return response.data as T;
  } catch (err) {
    const data = (err as { response?: { data?: Record<string, unknown>; status?: number } })?.response;
    const body = data?.data ?? {};
    throw new ApiError(
      String(body.code ?? "request_failed"),
      String(body.error ?? "Something went wrong. Try again, or call the support line."),
      Number(data?.status ?? 500),
      (body.fields as ApiFieldError[]) ?? [],
    );
  }
}

export interface AppConfig {
  brand: { name: string; tagline: string; logo_url: string | null; color_primary: string; color_accent: string };
  operator_legal_name: string;
  support: { email: string | null; phone: string | null; safety_phone: string | null };
  pilot: {
    pilot_mode: boolean;
    service_area_label: string;
    allowed_destination_zip_codes: string[];
    minimum_request_lead_hours: number;
  };
  flags: Record<string, boolean>;
  fulfillment_status: { allowed: boolean; code: string; message: string };
  legal_content_approved: boolean;
  pricing: { rider_fare_cents: number; booking_fee_cents: number; required_contribution: boolean };
  roles: { roles: string[]; suspended: boolean; email: string } | null;
}

export const getAppConfig = () => callFunction<AppConfig & { ok: boolean }>("get-app-config");

export const submitRideRequest = (payload: Record<string, unknown>) =>
  callFunction("submit-ride-request", payload);

export const revealRideDetails = (rideRequestId: string) =>
  callFunction("reveal-ride-details", { ride_request_id: rideRequestId });

export const transitionRide = (rideRequestId: string, toState: string, reasonCode?: string) =>
  callFunction("transition-ride", { ride_request_id: rideRequestId, to_state: toState, reason_code: reasonCode });

export const listDriverOffers = () => callFunction("list-driver-offers");

export const claimRide = (rideRequestId: string) => callFunction("claim-ride", { ride_request_id: rideRequestId });

export const reviewRide = (payload: Record<string, unknown>) => callFunction("dispatcher-review-ride", payload);

export const assignRide = (rideRequestId: string, driverProfileId: string) =>
  callFunction("assign-ride", { ride_request_id: rideRequestId, driver_profile_id: driverProfileId });

export const submitDriverApplication = (applicationId: string) =>
  callFunction("driver-application-submit", { application_id: applicationId });

export const updateConfig = (changes: Record<string, unknown>, override?: { justification: string; reauthenticated: boolean }) =>
  callFunction("admin-update-config", {
    changes,
    override_justification: override?.justification,
    reauthenticated: override?.reauthenticated,
  });

export const updateLaunchGate = (gateKey: string, changes: Record<string, unknown>) =>
  callFunction("admin-update-launch-gate", { gate_key: gateKey, changes });

export const acceptLegalDocument = (legalDocumentId: string, roleContext: string) =>
  callFunction("accept-legal-document", { legal_document_id: legalDocumentId, role_context: roleContext });

// ---- Milestone 2: driver operations and safety ----

export const submitDriverCredential = (payload: Record<string, unknown>) =>
  callFunction("submit-driver-credential", payload);

export const reviewDriverCredential = (payload: Record<string, unknown>) =>
  callFunction("review-driver-credential", payload);

export const manageVehicle = (payload: Record<string, unknown>) => callFunction("manage-vehicle", payload);

export const reviewVehicle = (payload: Record<string, unknown>) => callFunction("review-vehicle", payload);

export const addAvailability = (startsAt: string, endsAt: string, notes?: string) =>
  callFunction("manage-availability", { action: "add", starts_at: startsAt, ends_at: endsAt, notes });

export const cancelAvailability = (availabilityId: string) =>
  callFunction("manage-availability", { action: "cancel", availability_id: availabilityId });

export const declineRideOffer = (offerId: string, reasonCode?: string) =>
  callFunction("decline-ride-offer", { offer_id: offerId, reason_code: reasonCode });

export const verifyRideIdentity = (rideRequestId: string, code: string) =>
  callFunction("verify-ride-identity", { ride_request_id: rideRequestId, verification_code: code });

export const reportSafetyIncident = (payload: Record<string, unknown>) =>
  callFunction("report-safety-incident", payload);

export const manageSafetyIncident = (payload: Record<string, unknown>) =>
  callFunction("manage-safety-incident", payload);

export const exportRideManifest = (from: string, to: string, purpose: string) =>
  callFunction("export-ride-manifest", { from, to, purpose });

export const resendNotification = (notificationId: string) =>
  callFunction("dispatch-notifications", { notification_id: notificationId });

// ---- Milestone 3: organization scheduling and community support ----

export const requestParticipantAuthorization = (organizationId: string, participantEmail: string, scope?: string) =>
  callFunction("request-participant-authorization", {
    organization_id: organizationId, participant_email: participantEmail, scope,
  });

export const decideParticipantAuthorization = (authorizationId: string, decision: "confirm" | "decline" | "withdraw") =>
  callFunction("confirm-participant-authorization", { authorization_id: authorizationId, decision });

export const manageOrganizationMember = (payload: Record<string, unknown>) =>
  callFunction("manage-organization-member", payload);

export const manageContributionCatalog = (payload: Record<string, unknown>) =>
  callFunction("manage-contribution-catalog", payload);

export const submitContributionPledge = (payload: Record<string, unknown>) =>
  callFunction("submit-contribution-pledge", payload);

export const reviewContributionPledge = (pledgeId: string, decision: "accept" | "decline", declineReason?: string) =>
  callFunction("review-contribution-pledge", { pledge_id: pledgeId, decision, decline_reason: declineReason });

export const recordContributionFulfillment = (payload: Record<string, unknown>) =>
  callFunction("record-contribution-fulfillment", payload);

export const buildReport = (payload: Record<string, unknown>) => callFunction("build-report", payload);
