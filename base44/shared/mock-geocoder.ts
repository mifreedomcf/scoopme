/**
 * Mock geocoder. Used when GEOCODER_PROVIDER is unset or "mock".
 *
 * It NEVER returns a result that can be treated as a confirmed in-service-area
 * point: validateServiceArea sees provider "mock" and downgrades to manual
 * review. It exists so the pilot can be exercised end to end without
 * credentials, not to fake a successful check.
 */
import type { GeocodeResult, GeocoderProvider } from "./geo.ts";

const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;

/** Coarse fixtures for the pilot area, for local development only. */
const FIXTURES: Record<string, { lat: number; lng: number; city: string; state: string; areaLabel: string }> = {
  "48205": { lat: 42.4302, lng: -82.9812, city: "Detroit", state: "MI", areaLabel: "Northeast Detroit (48205)" },
  "48207": { lat: 42.3506, lng: -83.0295, city: "Detroit", state: "MI", areaLabel: "Near East Side (48207)" },
  "48202": { lat: 42.3760, lng: -83.0760, city: "Detroit", state: "MI", areaLabel: "New Center (48202)" },
  "48226": { lat: 42.3314, lng: -83.0458, city: "Detroit", state: "MI", areaLabel: "Downtown (48226)" },
  "48174": { lat: 42.2223, lng: -83.3963, city: "Romulus", state: "MI", areaLabel: "Romulus (48174)" },
  "48009": { lat: 42.5467, lng: -83.2113, city: "Birmingham", state: "MI", areaLabel: "Birmingham (48009)" },
};

export const mockGeocoder: GeocoderProvider = {
  name: "mock",
  isLive: false,
  async geocode(address: string): Promise<GeocodeResult> {
    const trimmed = (address ?? "").trim();
    if (trimmed.length < 6) {
      return { status: "not_found", provider: "mock" };
    }
    const zip = ZIP_RE.exec(trimmed)?.[1];
    if (!zip) {
      return { status: "ambiguous", provider: "mock", normalizedAddress: trimmed };
    }
    const fixture = FIXTURES[zip];
    if (!fixture) {
      return { status: "ambiguous", provider: "mock", normalizedAddress: trimmed, zip };
    }
    return {
      status: "ok",
      provider: "mock",
      normalizedAddress: trimmed,
      zip,
      city: fixture.city,
      state: fixture.state,
      areaLabel: fixture.areaLabel,
      point: { lat: fixture.lat, lng: fixture.lng },
    };
  },
};

/**
 * Live adapter stub. Wired to a real provider in Milestone 5 once
 * GEOCODER_API_KEY exists. Until then it reports unavailable rather than
 * pretending to resolve an address.
 */
export function createLiveGeocoder(providerName: string, apiKey: string | undefined): GeocoderProvider {
  return {
    name: providerName,
    isLive: Boolean(apiKey),
    async geocode(): Promise<GeocodeResult> {
      if (!apiKey) {
        return { status: "provider_unavailable", provider: providerName };
      }
      // Milestone 5: issue the provider request here. Deliberately not
      // implemented rather than stubbed with a fake success.
      return { status: "provider_unavailable", provider: providerName };
    },
  };
}
