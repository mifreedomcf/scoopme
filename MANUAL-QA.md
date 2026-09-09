# Manual QA — Milestone 1

Run against a freshly seeded app. Every step lists what you should see; anything
else is a bug.

## Setup

1. Deploy entities, functions, and auth. Sign in as a Base44 admin.
2. Call `seed-pilot-data` with `{"include_demo_data": true}`.
3. Expect: 1 config, 17 gates, 15 legal documents, 1 partner, 1 location, 7 demo
   rows, plus a `next_steps` list.

## A. Defaults are safe

1. Open `/`. Expect the pilot banner naming Detroit and 48205, a red band saying
   rides are not being driven yet, and the free statement.
2. Open `/support`. Expect donations disabled, the donate button disabled, and
   tipping described as switched off with the "tips may be taxable" wording. No
   dollar figure is described as tax free.
3. Open `/policies`. Expect fifteen documents, each with the DRAFT banner at the
   top when opened.
4. Open `/admin`. Expect the operator name to read "Pilot Operator — To Be
   Confirmed" and every risky flag unchecked.

## B. The launch gate actually blocks

1. In `/admin`, tick "Drive real rides". Expect a refusal naming the incomplete
   gate categories, and the box to revert.
2. Write a 45-character override justification and tick it again. Expect
   `gate_not_overridable` because insurance and background checks are on the
   non-overridable list.
3. Mark a gate complete with no evidence link. Expect a validation error asking
   for evidence and a reviewer.
4. Add an evidence link, then set the reviewer to your own email. Expect a
   separation-of-duties error.

## C. A free adult ride request

1. Publish the seeded partner and location (set a street address in 48205 first).
2. Sign in as a rider. `/rides` → "Ask for a ride".
3. Step through the wizard. Expect: no payment field anywhere; the destination
   list limited to published pilot destinations; a note that only the kind of
   place is recorded.
4. Choose a pickup time two hours from now. Expect a lead-time error naming 24
   hours, linked from the error summary at the top.
5. Change it to three days out and send. Expect a redirect to the ride page, the
   route strip at "Being reviewed", and "You pay nothing for this ride."

## D. Geography is rejected on the server

1. Submit with a pickup address in Birmingham, MI 48009. Expect rejection saying
   pickups are only inside Detroit.
2. Submit with a destination outside 48205. Expect rejection naming the pilot
   ZIP list.
3. Submit a valid 48205 pair. Open Dispatch and expect the request to carry the
   red note that addresses could not be confirmed automatically, because the
   geocoder is mocked.

## E. Driver application cannot self-approve

1. Sign in as a second user. `/driver/apply`.
2. Fill in some fields, reload the page. Expect your answers to still be there
   (autosave).
3. Send without ticking the acknowledgements. Expect an error summary listing
   each missing one.
4. Set a date of birth making you 19. Expect a minimum-age error.
5. Complete it and send. Expect the message that approval is on hold because no
   screening vendor is configured.
6. Sign in as the same user and try `driver-application-review` on your own
   application. Expect `403` and a self-review audit row.
7. As safety staff, approve it. Expect `credentials_incomplete` naming the
   unverified checks.

## F. Minimization

1. Approve a ride as dispatcher and note the offer count.
2. As a driver, open `/driver`. Expect an area label, a category, a window, a
   passenger count, and "why you match" — and no address, phone, or code.
3. Inspect the network response. Confirm no `pickup_address`, `contact_phone`, or
   `verification_code` field exists in the payload.

## G. Object reference tampering

1. As a rider, note your ride id.
2. Sign in as an unrelated user and call `reveal-ride-details` with that id.
   Expect `404`, not `403`.
3. Check AuditLog. Expect a `ride.read` row with `outcome: denied`.

## H. Two drivers, one ride

1. With two eligible drivers, open `/driver` in two sessions.
2. Claim the same ride in both within a second.
3. Expect one success and one "Another driver took this ride a moment ago." Only
   one `RideAssignment` has `is_active: true`.

## I. Expired credentials

1. Set a driver credential's expiry to yesterday.
2. Reload `/driver`. Expect no offers and the message about credentials.
3. Attempt a claim by id. Expect refusal.

## J. Audit and holds

1. Move a ride to `incident_hold` as safety staff with a reason code.
2. Try to close it administratively. Expect `retention_hold_active`.
3. Confirm AuditLog holds a row for every transition, decision, config change,
   and gate change you made in this run, and that none can be edited.

## Accessibility pass

- Tab through the request wizard with no mouse. Every control reachable, focus
  visible on all of them.
- Submit an invalid form. Focus lands on the error summary; each entry links to
  its field.
- Zoom to 200%. No horizontal scroll, no clipped controls.
- Turn on reduced motion. The route strip fills without animating.
- Screen reader: navigate by heading. Every page has one `h1` and a logical
  heading order. Status changes announce via the `role="status"` regions.
- Contrast: check the marigold band, the disabled button, and the status pills.
