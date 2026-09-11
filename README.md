# Scoop Me

Free, scheduled community rides. Residents who lack reliable transportation are
matched with screened volunteer drivers so they can reach food, supplies, social
services, education programs, and non-emergency appointments.

**Riders are never charged.** No fare, booking fee, subscription, surge price, or
required contribution. Whether someone donates, volunteers, or brings supplies has
no effect on eligibility, priority, matching, service quality, or access. That is
enforced in the data model (`RideRequest.fare_charged_cents` has `maximum: 0`) and
in the request allowlist, not only in copy.

This repository covers **Milestone 1 (closed adult pilot foundation)**,
**Milestone 2 (driver operations and safety)**, **Milestone 3 (organization
scheduling and community support)** and **Milestone 4 (guardian and minor
architecture, built and deliberately switched off)** and **Milestone 5
(location and communication integrations)**. Ride fulfilment is switched off
and cannot be switched on until the compliance launch gate is complete. See
`LEGAL-INSURANCE-LAUNCH-GATES.md`.

---

## Status and honest limits

- Nothing here is legally reviewed. Every policy document ships as
  `draft_requires_review` and renders a visible DRAFT banner.
- The operator is `Pilot Operator — To Be Confirmed` until an administrator types
  a real name in admin settings. No partner is represented as operator, carrier,
  insurer, employer, agent, or guarantor.
- The geocoder runs in mock mode. The Detroit boundary shipped in `geo.ts` is a
  **coarse placeholder** used only to reject obviously-outside points. It can
  never mark a point as inside the service area. Until a real boundary and a live
  geocoder are configured, every request is flagged for a dispatcher.
- Background checks run in `mock_pending_review`. The mock never returns a
  passing result, so no driver can be approved through it.
- No malware scanner is configured, so every uploaded document and every piece
  of incident evidence stays `pending` and is never served. A credential with an
  unscanned document cannot be verified. That is the intended behaviour.
- No notification provider is configured, so messages are marked
  `suppressed_provider_missing` rather than `sent`. Nothing reports a delivery
  that did not happen.
- The pilot partner listing has a name and a ZIP and nothing else. Address,
  hours, contact, pickup instructions, inventory notes, and public description
  are deliberately blank for an administrator to fill in from the partner.

## Architecture

```
base44/
  config.jsonc              project config (entities, functions, site)
  auth/config.jsonc         login methods
  entities/*.jsonc          43 entity schemas with row- and field-level security
  shared/*.ts               pure decision logic + one SDK seam (runtime.ts)
  functions/<name>/entry.ts 49 Deno serverless functions
  functions/*/function.jsonc  4 scheduled automations
src/                        React + Vite frontend, 24 screens
tests/                      386 Vitest tests over the decision logic and schemas
```

**Base44 services used:** managed entity database with RLS/FLS, Deno backend
functions, auth (password + Google), project secrets, site hosting.

**The design rule that shapes everything:** entity RLS denies client writes on
every entity a backend function owns. The frontend cannot set a ride status, a
role, a credential, an eligibility flag, or a config value — those writes are
refused at the database, so routing through a function is the only path, and the
function re-checks authorization, role, record ownership, ride state, geography,
and input on every call.

`base44/shared/` holds the decisions and imports nothing from npm, so the same
code that runs in production is what the test suite exercises. `runtime.ts` is
the single module that touches the SDK.

## Backend functions

| Function | What it decides |
|---|---|
| `get-app-config` | Public projection of branding and effective flags. No secrets, no gate evidence. |
| `submit-ride-request` | Allowlists input, re-derives geography server-side, rate limits, writes the request. |
| `transition-ride` | The only path that changes `RideRequest.status`. Runs the state machine. |
| `dispatcher-review-ride` | Human approval, then deterministic matching and minimized offers. |
| `claim-ride` | Driver claim under a lock. Re-checks live credential state. |
| `assign-ride` | Dispatcher assignment, same lock, same eligibility filters. |
| `reveal-ride-details` | The only ride read path. Time-boxed reveal, audited. |
| `driver-application-submit` | Age gates, acknowledgements, creates pending checks. |
| `driver-application-review` | Reviewer decision. Blocks self-review and incomplete credentials. |
| `admin-update-config` | Gate-checked, floor-checked flag writes with override audit. |
| `admin-update-launch-gate` | Gate updates with evidence, reviewer, and separation of duties. |
| `accept-legal-document` | Records acceptance of a specific published version. |
| `list-driver-offers` | Minimized open offers. Returns nothing to an ineligible driver. |
| `seed-pilot-data` | Idempotent seeding. Leaves unknown partner details blank. |

### Milestone 2

| Function | What it decides |
|---|---|
| `submit-driver-credential` | Driver uploads a document. Validates it, clears any prior verification, recomputes eligibility. |
| `review-driver-credential` | Reviewer verifies or rejects. Blocks self-review and unscanned documents. |
| `manage-vehicle` | Vehicle details and declared accommodations, recorded as unverified. |
| `review-vehicle` | Staff verify the vehicle and each accommodation separately. |
| `manage-availability` | Availability windows, with overlap and committed-ride checks. |
| `decline-ride-offer` | Driver declines; returns the ride to the coordinator when the last offer goes. |
| `verify-ride-identity` | Driver types the rider's spoken code. Rate limited, audited, never echoes the code. |
| `report-safety-incident` | Opens an incident, sets a retention hold, freezes the ride, alerts safety staff. |
| `manage-safety-incident` | Staff work an incident. Releasing a hold is separate, justified, admin-only. |
| `attach-incident-evidence` | Private evidence reference, held `pending` until scanned. |
| `credential-expiry-sweep` | Daily: expires lapsed documents, recomputes eligibility, withdraws offers, warns ahead. |
| `ride-checkin-sweep` | Every 5 min: overdue and silence timers. Raises flags for people; decides nothing. |
| `dispatch-notifications` | Delivery worker: dedupe, backoff, per-recipient limits, redaction check on every body. |
| `export-ride-manifest` | The outage fallback. Staff only, written purpose, bounded range, audited. |

### Milestone 3

| Function | What it decides |
|---|---|
| `request-participant-authorization` | An organization asks a participant. Creates a pending record and nothing more. Closed outright for under-18s. |
| `confirm-participant-authorization` | Only the participant confirms, declines, or withdraws. No staff override exists. |
| `manage-organization-member` | An org admin proposes a scheduler; only a platform admin approves one. |
| `manage-contribution-catalog` | The operator's list of things that would actually help. |
| `submit-contribution-pledge` | An organization offers hours or goods. Refuses wording tied to anyone's ride. |
| `review-contribution-pledge` | Accept or decline. Says out loud that access is unaffected either way. |
| `record-contribution-fulfillment` | What actually arrived, and staff verification. Outstanding is floored at zero. |
| `build-report` | The one reporting endpoint. Scope from role, suppression for everyone but staff, CSV audited. |

### Milestone 4 — built, not enabled

Every function below refuses while `minor_rides_enabled` is false, which is its
default and which cannot be turned on until the safeguarding and child-restraint
launch gates are complete.

| Function | What it decides |
|---|---|
| `manage-dependent-profile` | A guardian maintains a child's profile and the adults allowed to collect them. No child account exists. |
| `verify-guardian-authority` | Staff verify legal authority against a document. Nobody self-verifies. |
| `request-minor-consent` | Puts the ride in `awaiting_consent` and asks the verified guardian. No driver can see it. |
| `sign-minor-consent` | Only the verified guardian can sign, on the current wording version. |
| `revoke-consent` | Withdrawal is immediate, needs no reason, and stops any trip not yet started. |
| `verify-minor-handoff` | Named adult plus rotating PIN. Every failure ends in stop-and-call. |
| `post-message` | Supervised threads. A driver and a child can never be in one. |

### Milestone 5

| Function | What it decides |
|---|---|
| `start-location-sharing` | Only the rider or a child's verified guardian can turn it on, and they pick the audiences. |
| `record-location-ping` | Re-checks flag, gates, ride state and live consent on every point. Assigned driver only. |
| `read-tracking` | The token is the authorization. Expiring, rate-limited, audited, coarse once the ride ends. |
| `stop-location-sharing` | Immediate, never refused. Revokes every token minted from the session. |
| `open-relay-session` | Masked calling when configured; an honest in-app fallback when not. Never for a child's ride. |
| `retention-sweep` | Nightly deletion and anonymization. Off by default, and holds beat it. |

### Scheduled automations

Configured in `function.jsonc` next to each function and deployed atomically
with it.

| Automation | Schedule |
|---|---|
| `daily_credential_sweep` | cron `0 5 * * *` |
| `ride_checkin_watch` | simple, every 5 minutes |
| `notification_delivery` | simple, every 5 minutes |
| `nightly_retention_sweep` | cron `0 6 * * *` |

## Getting started

```bash
npm install
npx base44@latest login
npx base44@latest link            # or `create` for a new app
cp base44/.app.jsonc.example base44/.app.jsonc   # then paste your app id
cp .env.example .env              # set VITE_BASE44_APP_ID

npx base44@latest entities push
npx base44@latest functions deploy
npx base44@latest auth push

npm run dev
```

Then sign in as a Base44 admin and call `seed-pilot-data`.

The Base44 CLI is invoked with `npx` rather than installed as a devDependency,
because it resolves part of its dependency tree from the JSR registry, which some
networks block.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type check, then production build |
| `npm test` | Vitest suite |
| `npm run lint` | ESLint, including `jsx-a11y` |
| `npm run b44:deploy` | Deploy entities, functions, auth, and site |

## Environment

Names only; values live in Base44 project secrets. See `.env.example`.

`VITE_BASE44_APP_ID` (frontend), `GEOCODER_PROVIDER`, `GEOCODER_API_KEY`,
`NOTIFY_EMAIL_PROVIDER`, `NOTIFY_SMS_PROVIDER`, `NOTIFY_SMS_ACCOUNT_SID`,
`NOTIFY_SMS_AUTH_TOKEN`, `NOTIFY_SMS_FROM`, `BACKGROUND_CHECK_PROVIDER`,
`BACKGROUND_CHECK_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

Every one of these has a disabled state that fails safe. Nothing fakes a
successful check or payment when a credential is missing.

## Design

The interface borrows from municipal transit signage: high-contrast wayfinding,
wide colour bands that carry status rather than decorate, and one bold element —
the route strip that shows where a ride is along its journey. The type stack is
system UI on purpose, so there is no webfont payload on an old phone on a weak
connection. Touch targets are 52px, focus is always visible, motion respects
`prefers-reduced-motion`, and forms have error summaries that link to the field.

## The minor workflow is off

Milestone 4 is complete as architecture and unreachable as a feature. Five
things must all hold before a child is ever carried, and `checkMinorRide`
reports every unmet one rather than the first:

1. `minor_rides_enabled` is on **and** its launch gates are complete and unexpired
2. a verified parent or legal guardian is recorded for that child
3. current, correctly scoped consent covers that exact trip, on the published wording
4. the driver holds the `minor_transport_approved` tier and its extra screening
5. the legally required restraint is **verified** as present in the assigned vehicle

It is re-checked on approval and again on every operational move, so consent
withdrawn an hour ago stops a ride that was legitimately offered this morning.
If any check cannot be run, it fails closed.

The child-restraint table encodes Michigan's requirements as amended 2 April
2025 (MCL 257.710d). **It has not been checked by counsel.** Every threshold is
admin-configurable, `restraint_policy_reviewed` defaults to false, and while it
is false no minor ride can be approved at all.

## Location, and why it is off

`live_location_enabled` defaults to false and is blocked behind the privacy and
legal-document gates. While it is off, no coordinate is collected at all.

When it is on, precise location is collected only during an active ride, only
after the rider — or a child's verified guardian — has agreed, and only from the
assigned driver's device. Every ping re-checks the flag, the gates, the ride
state and live consent, so a withdrawal thirty seconds ago stops the next one.

Reading is through a 256-bit token scoped to one ride and one audience, expiring
with the trip, rate-limited per minute, and written to `AuditLog` on every read,
allowed or denied. A bad token and a revoked token give the same answer. Once
the ride ends the link keeps working briefly but returns a coarsened
last-known point with no trail — nobody is handed the route.

`observeTrail` feeds the existing check-in sweep with two observations: a car
well off the expected line, and one that has not moved. Both describe what was
seen and never why. Neither can move, cancel, or complete a ride.

Geocoding, routing and relay all sit behind provider interfaces with an honest
unconfigured state. Without a routing provider, distances are straight-line
estimates labelled as such. Without a relay provider, a child's ride stays
in-app unconditionally and an adult ride says out loud that masked calling is
not set up rather than quietly exposing a real number.

## Retention

`retention-sweep` runs nightly and does nothing until an administrator enables
it, after someone has actually read the schedule. It fails closed in every
direction: an unreadable hold table, a missing rule, a missing date, or a
protected entity all mean keep. Precise location expires first, at seven days.
Rides are anonymized rather than deleted so counting survives identity removal.
`AuditLog`, `SafetyIncident`, `ConsentRecord`, `LegalAcceptance` and
`DataRetentionHold` are never swept, and an admin override cannot change that.

## What is not built yet

Milestones 6–7: donations and the tip ledger, and production hardening.

## Related documents

`SECURITY.md` · `PRIVACY-DATA-MAP.md` · `THREAT-MODEL.md` · `PILOT-RUNBOOK.md` ·
`LEGAL-INSURANCE-LAUNCH-GATES.md`
