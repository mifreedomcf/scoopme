# Privacy data map

## Principle

Collect the minimum that makes a safe ride possible, show each person only what
their relationship to a ride requires, and stop showing it when the ride ends.

## What is collected, and why

| Data | Where | Why | Who can read it |
|---|---|---|---|
| Name, email, phone | UserProfile, RiderProfile | Contacting a rider on the day | The person, and safety staff. Phone is field-secured. |
| Legal name, date of birth | UserProfile, DriverApplication | Age gate and identity verification for drivers | The person and safety staff only |
| Exact pickup and destination address | RideRequest | Driving someone somewhere | The requester, staff, and the assigned driver inside the reveal window |
| Coordinates | RideRequest | Service-area validation and distance | Same as address; withheld once the ride ends |
| Approximate area label | RideRequest, RideOffer | What an unassigned driver sees instead | Eligible drivers |
| Resource category | RideRequest | Matching and reporting | Staff and the assigned driver |
| Accommodations needed | RideNeed, RiderProfile | Matching to verified capabilities | Staff and the assigned driver |
| Verification code | RideRequest | Rider verifies the driver at pickup | The rider and staff. Never the driver, never a notification. |
| Licence state, expiry, last four digits | DriverApplication | Credential currency | Safety staff |
| Background check vendor reference, status, category, dates | DriverCredential | Eligibility | Safety staff |
| Incident narrative | SafetyIncident | Safeguarding | Safety staff and platform admins only |
| Audit events | AuditLog | Accountability | Platform admins |
| Vehicle make, model, colour, plate | Vehicle | So a rider can recognise the car | The matched rider before pickup; plate is field-secured otherwise |
| Availability windows | DriverAvailability | Matching | The driver and staff |
| Upload metadata and scan status | DriverCredential, IncidentAttachment | Deciding whether a file may be opened | Safety staff |
| Check-in and escalation state | RideAssignment | Noticing a ride that has gone quiet | Dispatch and safety staff |
| Delivery outcome and provider reference | Notification | Tracing whether a message actually arrived | Platform admins |

## What is never collected

Diagnosis, treatment detail, or the medical purpose of a trip. Immigration
status. Social Security number. Full driver's licence number. Payment card data.
Background check report contents. Custody detail beyond the authority type and
its verification status.

`validateRideRequest()` rejects a payload containing `diagnosis`,
`medical_details`, `ssn`, `social_security_number`, or `immigration_status`, and
the schema-integrity test fails the build if any entity declares a field matching
those names.

## Who sees what about a ride

| Viewer | Sees |
|---|---|
| Public | Id and status |
| Unassigned driver | Approximate pickup and destination area, resource category, time window, passenger count, required verified capabilities, approximate distance |
| Assigned driver, before reveal | The same minimized view |
| Assigned driver, in reveal window | Adds exact addresses, coordinates, rider contact, assistance level, operational notes. Never the verification code. |
| Assigned driver, after completion | Addresses without live coordinates |
| Rider or guardian | Their own full record including their verification code |
| Organization scheduler | The record minus the verification code, for their own authorized participants only |
| Dispatcher, safety staff, platform admin | The full record, and the view is audited |

The reveal window opens two hours before the scheduled pickup and only while the
ride is in an active state. The first reveal per assignment writes a
`location.reveal` audit row.

## Notifications

Bodies are rendered from fixed templates that use generic labels — "your
scheduled ride" — never a resource name, an address, a code, or a trip purpose.
`assertNotificationSafe()` checks every rendered body against the actual ride
record and the test suite runs all sixteen templates through it. Templates whose
context is sensitive (consent needed, incident update, ride started) are
restricted to in-app and email; they never reach an SMS lock screen.

## Location

Live location is disabled for the pilot and gated behind `privacy_security` and
`legal_documents`. When it is enabled, precise location is collected only during
an active ride, shared only with the assigned driver, the rider, a verified
guardian, an authorized scheduler where consent permits, and safety staff, via
expiring unguessable tokens, and stops after completion.

## The outage manifest

`export-ride-manifest` deliberately assembles the most sensitive combination in
the product — exact addresses, phone numbers, and verification codes for the
day's confirmed rides — because a dispatcher working through an outage needs all
three on paper. It is staff-only, needs a written purpose, is capped at 48 hours
per pull, and writes an `export.sensitive` audit row. The response carries a
handling notice telling the operator to keep it locked and shred it at the end
of the day.

## Automated watching

`ride-checkin-sweep` reads ride timestamps every five minutes. It stores no new
personal data: it writes an escalation level and a kind onto the assignment, an
observation onto the ride timeline, and an alert to staff that names no address
and no code. At urgent level it opens an incident so a person owns it — stating
what was observed, explicitly not what happened.

## Retention and holds

Retention periods are configured in admin settings and enforced by a deletion and
anonymization job (Milestone 5). `DataRetentionHold` blocks that job and blocks
ordinary deletion for the records it covers. `hasActiveHold()` fails closed: if
the hold table cannot be read, the record is treated as held.

## Rights

Export, correction, consent withdrawal, and deletion requests are handled through
admin workflows, subject to lawful retention. Access to minor records, precise
location, credentials, incidents, and sensitive exports is logged.

## Minors

The workflow exists and is unreachable. `minor_rides_enabled` defaults to false
and is blocked by seven launch-gate categories. Validation rejects a minor
request, matching rejects a driver without the `minor_transport_approved` tier
plus fingerprinting and child-abuse-registry checks, and an organization
scheduler is rejected as a consenting party regardless of what else is on file.
For children under 13 there is no standalone child account and no data is
collected from a child; COPPA review and verifiable parental consent are
prerequisites for any child-facing functionality.
