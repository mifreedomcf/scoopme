import { describe, expect, it } from "vitest";
import { PLACEHOLDER_BOUNDARY, distanceMiles, pointInRing, validateServiceArea } from "@shared/geo";
import { mockGeocoder } from "@shared/mock-geocoder";

const base = {
  boundary: PLACEHOLDER_BOUNDARY,
  allowedDestinationZips: ["48205"],
  allowedPickupZips: [] as string[],
  serviceAreaCity: "Detroit",
  serviceAreaState: "MI",
};

describe("service area validation", () => {
  it("rejects a destination outside the pilot ZIP list", async () => {
    const geocode = await mockGeocoder.geocode("100 Example St, Detroit, MI 48226");
    const verdict = validateServiceArea({ ...base, geocode, kind: "destination" });
    expect(verdict.status).toBe("outside_service_area");
    expect(verdict.reasons).toContain("destination_zip_not_in_pilot");
  });

  it("rejects a pickup in another city", async () => {
    const geocode = await mockGeocoder.geocode("5 Example Rd, Birmingham, MI 48009");
    const verdict = validateServiceArea({ ...base, geocode, kind: "pickup" });
    expect(verdict.status).toBe("outside_service_area");
    expect(verdict.reasons).toContain("city_outside_service_area");
  });

  it("never approves a point while the geocoder is a mock and the boundary is a placeholder", async () => {
    const geocode = await mockGeocoder.geocode("1 Example Way, Detroit, MI 48205");
    const verdict = validateServiceArea({ ...base, geocode, kind: "destination" });
    expect(verdict.status).toBe("manual_review");
    expect(verdict.requiresHumanReview).toBe(true);
    expect(verdict.reasons).toContain("geocoder_not_live");
    expect(verdict.reasons).toContain("boundary_not_authoritative");
  });

  it("only reports in_service_area with a live geocoder and an authoritative boundary", () => {
    const verdict = validateServiceArea({
      ...base,
      boundary: { ...PLACEHOLDER_BOUNDARY, isAuthoritative: true },
      kind: "destination",
      geocode: {
        status: "ok", provider: "live_provider", zip: "48205", city: "Detroit", state: "MI",
        point: { lat: 42.4302, lng: -82.9812 },
      },
    });
    expect(verdict.status).toBe("in_service_area");
    expect(verdict.requiresHumanReview).toBe(false);
  });

  it("treats an unresolvable address as needing a human, not as a rejection", async () => {
    const geocode = await mockGeocoder.geocode("xyz");
    const verdict = validateServiceArea({ ...base, geocode, kind: "pickup" });
    expect(verdict.status).toBe("unresolvable");
    expect(verdict.requiresHumanReview).toBe(true);
  });

  it("computes point-in-polygon and distance", () => {
    expect(pointInRing({ lat: 42.35, lng: -83.05 }, PLACEHOLDER_BOUNDARY.ring)).toBe(true);
    expect(pointInRing({ lat: 41.0, lng: -83.05 }, PLACEHOLDER_BOUNDARY.ring)).toBe(false);
    const miles = distanceMiles({ lat: 42.3314, lng: -83.0458 }, { lat: 42.4302, lng: -82.9812 });
    expect(miles).toBeGreaterThan(5);
    expect(miles).toBeLessThan(12);
  });
});
