# Manual QA — Milestones 1 to 4

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


---

# Milestone 2 scenarios

## K. Credential centre and expiry

1. As an approved-application driver, open `/driver/credentials`. Expect two
   groups: documents you upload, and checks a coordinator runs. Expect no upload
   control on the vendor checks.
2. Add an insurance document with a filename of `policy.pdf.exe`. Expect a
   rejection about extra dots.
3. Add `policy.pdf` with a private reference and a future expiry. Expect
   "Uploaded. A coordinator reviews it once the file has been scanned."
4. As safety staff, call `review-driver-credential` to verify it. Expect
   `document_not_scanned` — no scanner is configured, so nothing can be verified
   yet. This is the correct result.
5. Verify a credential that has no document. Then set its expiry to yesterday and
   run `credential-expiry-sweep`. Expect the credential to become `expired`, the
   driver's eligibility to become `suspended_expired_credential`, and their open
   offers to become `withdrawn`.
6. Reload `/driver` as that driver. Expect no offers and a pointer to the
   documents page. Reload `/driver/credentials`. Expect the missing item named
   in plain words.

## L. Self-review is blocked everywhere

1. As a safety-staff user who is also a driver, try to verify your own
   credential, your own vehicle, and your own application. Expect `403` on all
   three and a `self_review_blocked` audit row.

## M. Vehicles and accommodations

1. As a driver, open `/driver/car` and add a car built six or more years ago.
   Expect the confirmation to mention the annual mechanic inspection.
2. Tick "Wheelchair lift". Save. Expect the capability to show "not checked yet".
3. As staff, call `review-vehicle` with `vehicle_status: "active"` and no
   inspection. Expect `inspection_required`.
4. Add a passed inspection with a future expiry, then set active. Expect success.
5. Approve a ride needing a wheelchair lift while the capability is still
   self-reported. Expect zero offers published. Verify the capability, re-approve,
   expect the driver to appear.

## N. Availability

1. Add a window. Add an overlapping one. Expect `overlapping_window`.
2. Add a 20-hour window. Expect a refusal naming the 14-hour limit.
3. Take a ride inside a window, then try to remove that window. Expect
   `window_has_committed_ride` telling you to release the ride first.

## O. Identity verification at pickup

1. Take a ride to `arrived_pickup` as the driver. Open `/driver/rides/<id>`.
   Expect a code box and no code anywhere on the page.
2. Inspect the network response for `reveal-ride-details` as the driver. Confirm
   there is no `verification_code` field at all.
3. Type a wrong code five times. Expect the remaining-tries count to fall, then
   `too_many_attempts` telling you not to start the ride and to call the safety
   line. Check `RideEvent` for five `identity_code_mismatch` rows.
4. As the rider, read the code off `/rides/<id>`. Enter it as the driver. Expect
   the ride to move to `rider_verified`.

## P. Check-in timers

1. Put a ride in `confirmed` with a pickup time 20 minutes ago. Run
   `ride-checkin-sweep`. Expect an `overdue_departure` escalation at level 1, an
   in-app alert to dispatch only, and a `RideEvent` of type `escalation`.
2. Run it again immediately. Expect no second alert.
3. Move the pickup time to 40 minutes ago and run again. Expect level 2, alerts
   to dispatch and safety staff, and a new SafetyIncident with source
   `escalation_timer` whose narrative says no assessment has been made.
4. Confirm the ride is still in `confirmed` — the sweep never moves or cancels a
   ride.
5. As the driver, move the ride to `en_route`. Confirm the escalation level
   resets to 0.

## Q. Incidents and holds

1. As a rider on a live ride, open "Report a safety concern". Expect the 911
   block above the form and the note that the form does not contact emergency
   services.
2. Submit a `suspected_abuse_neglect` report. Expect the ride to move to
   `incident_hold`, a `DataRetentionHold` to open, and safety staff to be
   notified with a message containing no address and no narrative.
3. As safety staff, open `/safety`. Try to resolve it without ticking the
   mandated report. Expect `mandated_report_required`.
4. Tick it, resolve, then try to release the hold as safety staff. Expect a
   refusal — platform admin only. As platform admin with a 10-character
   justification, expect a refusal. With 40+ characters, expect success and an
   `override` audit row.
5. Attach evidence to the incident. Expect `scan_status: "pending"` and
   `viewable: false`.

## R. Offers and declining

1. As a driver with an open offer, choose "Not this one". Expect it to disappear
   and the copy confirming that declining is not held against you.
2. Decline the last open offer on a ride. Expect the ride to return to
   `waitlisted` with `all_offers_declined`, visible on the dispatch board.

## S. Notifications

1. Run `dispatch-notifications`. With no provider configured, expect email and
   SMS rows to become `suppressed_provider_missing`, never `sent`, and in-app
   rows to send.
2. Hand-edit a queued notification body to contain a ride's pickup address, then
   run the dispatcher. Expect `failed` with `redaction_check_failed` and a
   `notification.blocked` audit row.
3. As platform admin, resend one notification. Expect a `notification.resend`
   audit row naming you.

## T. Outage manifest

1. On the Dispatch board, pull a manifest with a 5-character purpose. Expect a
   refusal.
2. Pull one with a 5-day range. Expect `range_too_wide`.
3. Pull a valid one. Expect a row count, the handling notice about shredding,
   and an `export.sensitive` audit row carrying your purpose and the range.
4. As a rider or driver, call the same function. Expect `403`.


---

# Milestone 3 scenarios

## U. Organization membership

1. As an org admin, propose a scheduler by email for someone with no account.
   Expect `user_not_found` telling you they must sign up first.
2. Propose someone who does have an account. Expect status `requested` and a
   message that a platform administrator must approve them.
3. As that proposed person, open `/org`. Expect the "waiting on approval" empty
   state and no ability to request rides for anyone.
4. As platform admin, approve them. Confirm a `RoleAssignment` row appears with
   `org_scheduler` and status `approved`.
5. As the org admin, try to approve someone yourself. Expect `403`.

## V. Participant authorization is the participant's decision

1. As the approved scheduler, ask a rider for permission from `/org`. Expect
   "They decide, not you" and the request listed under "Waiting on them".
2. Try to request a ride for that person before they answer. Expect
   `participant_authorization_invalid`.
3. As the rider, open `/permissions`. Expect the request, with wording that
   saying no does not affect their own rides.
4. Confirm it. Expect it to move to "Currently allowed" with a renewal date about
   a year out.
5. As the scheduler, request a ride for them. Expect it to succeed.
6. As the rider, choose "Stop letting them book for me" while that ride is still
   open. Expect the authorization revoked, the ride NOT cancelled, and a
   dispatcher notification saying to check with the rider directly.
7. As a third user, call `confirm-participant-authorization` with someone else's
   authorization id. Expect `404`, and a `not_the_participant` audit row.
8. Give a rider account a date of birth under 18, then ask for authorization for
   them. Expect a refusal saying a verified parent or legal guardian must do it
   separately.

## W. Reports and suppression

1. Seed four completed rides across four distinct riders at one partner.
2. As an org or partner user, run a report. Expect the totals to read "too few
   to show", not numbers.
3. Add a fifth distinct rider. Re-run. Expect real numbers.
4. Keep a single ride in a distinct resource category. Expect that one line
   suppressed while the rest show.
5. As staff, run the same report. Expect real numbers everywhere and an empty
   suppressed list.
6. As an org user, pass a `partner_id`. Expect `403`.
7. As an org user, pass another organization's id. Expect the report to come back
   scoped to your own organization anyway.
8. Request CSV with a 5-character purpose. Expect `purpose_required`. With a
   valid purpose, expect the CSV to contain `suppressed`, never `,0` in its
   place, and an `export.sensitive` audit row carrying your reason.
9. As a rider or driver, call `build-report`. Expect `403`.

## X. Contributions never buy anything

1. As platform admin, add a catalogue item: volunteer hours, target 40.
2. As an org member, pledge 10 hours with the note "10 hours in exchange for
   rides for our clients". Expect rejection explaining that rides are free and
   unconditional and asking you to reword.
3. Reword it plainly. Expect acceptance plus the notice that this does not affect
   any participant's eligibility, priority, or access.
4. Check the response for any tax claim. Expect only "We cannot tell you whether
   this is tax deductible."
5. As admin, decline a different pledge. Expect the organization's message to say
   nothing about anyone's rides changes.
6. Accept the 10-hour pledge, log 3 hours, then set the end date in the past and
   re-run. Expect status `lapsed`, outstanding 7, and the line stating there is
   no debt, penalty, or restriction.
7. Log 25 hours against the same pledge. Expect outstanding to read 0, never a
   negative number.
8. Attach evidence with an `https://` link. Expect `public_url_rejected`. Attach
   a private reference. Expect `scan_status` pending.
9. As an org member, try to verify your own fulfillment. Expect `403`.
10. Turn `organization_in_kind_contributions_enabled` off. Try to pledge. Expect
    a refusal that explicitly says this has no effect on anyone's rides.
11. Request a ride for an authorized participant of an organization that has
    pledged nothing, and one that has fulfilled a large pledge. Confirm the two
    requests are handled identically: same validation, same matcher output, same
    offer set.


---

# Milestone 4 scenarios

Most of these confirm a refusal. That is the point of the milestone.

## Y. Everything is off

1. As any user, open `/guardian`. Expect the red "Not available" band and an
   explanation of what has to happen first. Expect no form to add a child.
2. Call `manage-dependent-profile`, `request-minor-consent`,
   `sign-minor-consent`, and `verify-minor-handoff` directly. Expect
   `minor_rides_disabled` from every one.
3. Submit a ride with `rider_kind: "minor"`. Expect `minor_rides_disabled` at
   validation.
4. As platform admin, try to enable `minor_rides_enabled`. Expect
   `gate_not_overridable` — safeguarding, restraints, background checks and
   insurance are all on the non-overridable list.

## Z. With the flag on in a test environment only

Enable `minor_rides_enabled` and complete its gates in a scratch app. Never in
production.

1. Add a child aged 6 with no height. Expect the restraint answer to be a booster
   with `needs_more_information: true`, plus the DRAFT legal-review banner.
2. Try to add a child with `school`, `diagnosis`, or `custody_details` in the
   payload. Expect `field_not_collected`.
3. Try to add someone aged 19. Expect `not_a_minor` pointing them at their own
   account.
4. Request a ride for that child and approve it as dispatcher. Expect
   `minor_ride_blocked` listing every unmet requirement at once — unverified
   authority, no consent, no driver, unreviewed restraint policy.

## AA. Authority and consent

1. As the guardian, try to verify your own authority. Expect `403` and a
   `self_verification_blocked` audit row.
2. As safety staff, verify with no document. Expect `document_required` saying a
   stated relationship is not proof.
3. Attach a document. Expect `document_not_scanned` — no scanner is configured.
4. Verify with no expiry date. Expect `expiry_required`.
5. Request consent. Confirm the ride moves to `awaiting_consent` and that no
   driver can see it, claim it, or be assigned to it.
6. As an org scheduler, try to sign. Expect `scheduler_cannot_consent`.
7. As a dispatcher, try to sign. Expect a refusal naming the guardian.
8. As the guardian, sign. Then publish a new version of the guardian document and
   try to move the ride. Expect `consent_version_superseded`.
9. Withdraw consent while the ride is `confirmed`. Expect the ride canceled, the
   assignment released, offers withdrawn, and dispatch notified with nothing
   about the child in the message.

## BB. The driver tier and the car seat

1. Assign a driver approved for adults only. Expect `missing_minor_transport_tier`.
2. Give them the minor tier without fingerprinting or the registry check. Expect
   eligibility to stay blocked on those credentials.
3. With a fully credentialed minor-tier driver whose booster is only
   self-reported, expect `restraint_not_verified`.
4. Verify the booster. Expect the gate to pass.
5. Change the child to age 1. Expect `restraint_not_available` — the wrong seat
   for the age is no seat at all.
6. Set `restraint_policy_reviewed` back to false. Expect every minor ride to
   block again on `restraint_policy_unreviewed`.

## CC. Handoff

1. Take the ride to `arrived_dropoff`. Open the driver screen. Expect the list of
   authorized adults and a code box — and confirm the code appears nowhere on the
   page or in the network response.
2. Pick someone not on the list. Expect a refusal telling you not to hand the
   child over and to call.
3. Enter a wrong code three times. Expect the tries to count down, then the ride
   to move to `failed_handoff`, a safeguarding incident to open with a retention
   hold, and the "Do this now" list to appear with 911 above it.
4. Confirm the failure messages never hint at the real code and never suggest an
   alternative destination.
5. On a fresh handoff, enter the right code. Expect verification, and confirm the
   PIN is marked used and cannot work twice.

## DD. Messaging

1. Create a thread with a driver and a guardian. Post as each. Expect success.
2. Remove the guardian from the thread and post as the driver. Expect
   `guardian_required`.
3. Add a participant with role `minor`. Expect `forbidden_participant_pair` or
   `minor_not_a_participant`.
4. Post "call me on 313-555-0199" to a child's thread. Expect
   `off_platform_contact_blocked` and a flag to staff.
5. Post the same to an adult thread. Expect it to go through, masked, and flagged.
6. Read a child's thread. Confirm an `access.minor_record` audit row appears.
