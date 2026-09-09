import { describe, expect, it } from "vitest";
import { assertNotificationSafe, minimizeRide, redactForLog, type RideRecord } from "@shared/minimize";
import { renderTemplate, channelAllowed } from "@shared/notifications";

const ride: RideRecord = {
  id: "ride-1",
  status: "offered",
  rider_kind: "adult",
  pickup_address: "1 Example Way, Detroit, MI 48205",
  pickup_area_label: "Northeast Detroit (48205)",
  pickup_zip: "48205",
  pickup_latitude: 42.4302,
  pickup_longitude: -82.9812,
  destination_address: "9 Example Blvd, Detroit, MI 48205",
  destination_area_label: "Free fridge site (48205)",
  destination_latitude: 42.4310,
  destination_longitude: -82.9800,
  resource_category: "free_fridge",
  requested_pickup_at: "2026-09-10T10:00:00Z",
  passenger_count: 1,
  contact_phone: "555-0111",
  operational_notes: "Buzzer is broken",
  verification_code: "K7Q2MP",
};

const SENSITIVE = [
  "pickup_address", "destination_address", "pickup_latitude", "pickup_longitude",
  "destination_latitude", "destination_longitude", "contact_phone", "verification_code", "operational_notes",
];

describe("data minimization", () => {
  it("gives an unassigned driver an area, a category, a window and a count — nothing else", () => {
    const payload = minimizeRide(ride, { viewer: "unassigned_driver" });
    for (const field of SENSITIVE) expect(payload).not.toHaveProperty(field);
    expect(payload.pickup_area_label).toBe("Northeast Detroit (48205)");
    expect(payload.resource_category).toBe("free_fridge");
    expect(payload.passenger_count).toBe(1);
  });

  it("still withholds exact details from an assigned driver before the reveal window", () => {
    const payload = minimizeRide(ride, { viewer: "assigned_driver", revealWindowOpen: false });
    for (const field of SENSITIVE) expect(payload).not.toHaveProperty(field);
  });

  it("releases addresses to an assigned driver once the window opens, but never the rider's code", () => {
    const payload = minimizeRide(ride, { viewer: "assigned_driver", revealWindowOpen: true });
    expect(payload.pickup_address).toBe(ride.pickup_address);
    expect(payload.pickup_latitude).toBe(ride.pickup_latitude);
    expect(payload).not.toHaveProperty("verification_code");
  });

  it("stops sharing exact coordinates once the ride is finished", () => {
    const payload = minimizeRide(
      { ...ride, status: "completed" },
      { viewer: "assigned_driver", revealWindowOpen: true, rideCompleted: true },
    );
    expect(payload).not.toHaveProperty("pickup_latitude");
    expect(payload).not.toHaveProperty("destination_longitude");
  });

  it("gives the rider their own code and withholds it from an organization scheduler", () => {
    expect(minimizeRide(ride, { viewer: "rider" }).verification_code).toBe("K7Q2MP");
    expect(minimizeRide(ride, { viewer: "org_scheduler" })).not.toHaveProperty("verification_code");
  });

  it("tells the public nothing beyond an id and a status", () => {
    expect(Object.keys(minimizeRide(ride, { viewer: "public" })).sort()).toEqual(["id", "status"]);
  });
});

describe("notification safety", () => {
  it("flags a body that leaks an address or a code", () => {
    const leaky = assertNotificationSafe(`Head to ${ride.pickup_address} with code ${ride.verification_code}`, ride);
    expect(leaky.safe).toBe(false);
    expect(leaky.leaked).toContain("pickup_address");
    expect(leaky.leaked).toContain("verification_code");
  });

  it("passes every shipped template against a real ride record", () => {
    const keys = [
      "request_received", "consent_needed", "request_approved", "request_waitlisted", "driver_assigned",
      "driver_en_route", "driver_arrived", "ride_started", "dropoff_pending", "ride_completed",
      "ride_canceled", "rider_no_show", "failed_handoff", "incident_update", "credential_expiring",
      "contribution_acknowledged",
    ] as const;
    for (const key of keys) {
      const rendered = renderTemplate(key, { brandName: "Scoop Me", genericDestinationLabel: "your scheduled ride" });
      const check = assertNotificationSafe(`${rendered.subject} ${rendered.body}`, ride);
      expect(check.safe, `${key} leaked ${check.leaked.join(",")}`).toBe(true);
    }
  });

  it("keeps sensitive-context templates off SMS lock screens", () => {
    expect(channelAllowed("consent_needed", "sms")).toBe(false);
    expect(channelAllowed("incident_update", "sms")).toBe(false);
    expect(channelAllowed("ride_started", "sms")).toBe(false);
    expect(channelAllowed("driver_arrived", "sms")).toBe(true);
  });

  it("never says a tip amount is tax free", () => {
    const body = renderTemplate("contribution_acknowledged", { brandName: "Scoop Me", genericDestinationLabel: "" }).body;
    expect(body.toLowerCase()).not.toContain("tax free");
    expect(body.toLowerCase()).not.toContain("tax-free");
  });
});

describe("log redaction", () => {
  it("redacts sensitive fields, tokens, and secrets before anything is logged", () => {
    const out = redactForLog({
      ride_id: "ride-1",
      pickup_address: "1 Example Way",
      verification_code: "K7Q2MP",
      claim_token: "abc123",
      STRIPE_API_KEY: "sk_live_x",
      passenger_count: 2,
    });
    expect(out.pickup_address).toBe("[redacted]");
    expect(out.verification_code).toBe("[redacted]");
    expect(out.claim_token).toBe("[redacted]");
    expect(out.STRIPE_API_KEY).toBe("[redacted]");
    expect(out.ride_id).toBe("ride-1");
    expect(out.passenger_count).toBe(2);
  });
});
