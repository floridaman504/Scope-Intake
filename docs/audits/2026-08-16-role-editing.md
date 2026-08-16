# In-place role editing (follow-on from the audit-trail item)

## The problem, in plain terms

While building the audit trail (Tier 2 #9.5), it came up that this app has
never actually had a way to fix a mis-assigned employee role. A role only
ever gets set once, at sign-up, when someone redeems an invite code. If you
picked the wrong role for someone, the only fix was having them redo the
whole invite process. Small gap, but a real one -- worth closing rather
than just noting it and moving on.

## The fix

A dropdown next to each employee's role on the Team page (owner-only,
same as everything else there). Changing it prompts for confirmation
first, since it immediately changes what that person can see and do. You
can't change your own role from this screen -- same reasoning as not being
able to deactivate yourself, so an owner can't accidentally lock themselves
out.

No database migration was needed for this one. The database already let an
owner update any field on their own company's employees (added back when
deactivation shipped), and the audit-trail migration that just went up in
PR #34 already logs a role change the moment one happens -- this was
purely a matter of building the screen to use a capability that already
existed underneath.

## Verification

Full test suite (140 tests, 6 new) and a production build both run clean.
The new tests cover: the dropdown appearing (and not appearing on your own
row), the confirmation prompt firing with the correct before/after wording,
a decline canceling the change, a failed update showing a safe generic
message rather than the raw database error, and the existing deactivate/
reactivate controls still working exactly as before.
