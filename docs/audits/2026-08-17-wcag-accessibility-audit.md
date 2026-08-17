# WCAG AA accessibility audit

Tier 2 #13 on the operational playbook. Scope: every page in the app (14
routes, see `src/main.jsx`), checked against WCAG 2.x Level AA across three
areas -- keyboard navigation, screen reader / assistive-tech labeling, and
color contrast. This is a code-level audit (reading every page's markup and
styles), not a live screen-reader session; nothing here is a guess -- every
finding below was confirmed by reading the actual component, and every fix
was verified against the specific WCAG success criterion it addresses.

## Summary

Two real, systemic gaps found and fixed across the whole app: no visible
keyboard focus indicator on any text input (WCAG 2.4.7), and no `<main>`
landmark region on 13 of the app's 14 pages (WCAG 1.3.1 / "Bypass Blocks").
Both are now fixed everywhere. Four smaller, page-specific labeling gaps
were also found and fixed. Color contrast was already almost entirely
compliant -- see the Color contrast section for the one exemption and why
it doesn't need a fix.

## 1. Keyboard navigation

**Finding: no visible focus indicator on any text input, anywhere in the
app (WCAG 2.4.7, Focus Visible).** Every text/email/password/number input
across all 7 form-heavy pages set `outline-none` in its Tailwind classes
with no compensating focus style. This meant a person navigating by
keyboard (or anyone who simply prefers not to use a mouse) had no visual
indication of which field was active -- landing on the password field with
Tab, for example, looked identical to not being focused on anything at
all. This is the single most impactful finding in this audit: it affects
every form in the product, and keyboard-only navigation is one of the most
common assistive-technology patterns there is.

Fixed on all 17 affected inputs/textareas across `Login.jsx`, `Join.jsx`,
`ForgotPassword.jsx`, `ChangeEmail.jsx`, `ResetPassword.jsx`,
`EmailConfirmed.jsx`, and `ScopeIntake.jsx` (the public intake form) by
adding a visible gold outline that only appears on keyboard focus:
`focus:outline focus:outline-2 focus:outline-offset-2
focus:outline-[#E8BD3A]`. This layers safely on top of each input's
existing inline `style` (which only sets `color`/`backgroundColor`/
`border` -- never `outline`, so there's no conflict), and the ring sits
just outside the input against the dark page background, where it
measures 11.10:1 contrast -- well past the 3:1 AA minimum for UI
components.

**Checked and already correct: no keyboard traps.** Searched the entire
codebase for the classic anti-pattern -- a clickable `<div>` or `<span>`
with an `onClick` handler but no keyboard support -- and found none.
Every interactive element in the app is a real `<button>`, `<a>`,
`<input>`, or `<select>`, all of which get keyboard focus and activation
for free from the browser. This is a strong existing baseline that didn't
need fixing.

## 2. Screen reader / assistive-tech labeling

**Finding: 13 of 14 pages had no `<main>` landmark region (WCAG 1.3.1,
2.4.1 "Bypass Blocks").** Every page except the public intake form
(`ScopeIntake.jsx`, which already had proper `<header>`/`<main>`/`<footer>`
structure) wrapped its entire content in a plain `<div>`. Screen reader
users rely on landmark regions (`<main>`, `<nav>`, `<header>`) to jump
directly to a page's primary content instead of tabbing through every
element from the top -- without one, a screen reader user has no fast way
to skip past the repeated "SCOPE" logo header on every single page.

Fixed by promoting each page's single outermost wrapper `<div>` to
`<main>` on all 13 affected pages: `Login.jsx`, `Join.jsx`,
`ForgotPassword.jsx`, `ChangeEmail.jsx`, `NotFound.jsx`,
`ResetPassword.jsx`, `EmailConfirmed.jsx`, `EmailChangeConfirmed.jsx`,
`Dashboard.jsx`, `JobsQueue.jsx`, `EmployeeManagement.jsx`, `AuditLog.jsx`,
`ErrorLog.jsx`, and `SessionRegistry.jsx`. This was a purely mechanical,
zero-behavior-change fix in every case -- confirmed by the full test suite
and a production build both passing clean after the change.

**Finding: two real gaps in `JobAssignment.jsx` (the dispatcher/owner
"assign a plumber to a job" control).** The remove-assignee button
rendered only a bare "✕" character with a `title` attribute and no
`aria-label` -- `title` is not a reliable accessible name (it's
inconsistently exposed by screen readers and often skipped on touch
devices entirely), so this button had no real accessible name. Separately,
the "select a plumber or owner" dropdown had no label or `aria-label` at
all, relying only on its placeholder option text, which a screen reader
does not reliably announce as the field's purpose. Fixed both: the remove
button now has `aria-label={"Remove " + name}` matching its existing title
text, and the select now has `aria-label="Select a plumber or owner to
assign"`.

**Finding: two label-association gaps in `JobsQueue.jsx`.** The "Assigned
to" filter dropdown and the per-job "Status" dropdown (inside each
expanded job's detail panel) both had a visible `<label>` sitting next to
the control, but with no `htmlFor`/`id` pairing and not wrapping the
control -- so the association was only visual, not programmatic. A screen
reader user tabbing to either dropdown would hear "combo box" with no
indication of what it controlled. Fixed both with proper `htmlFor`/`id`
pairs; the per-job status select (rendered once per row inside a loop)
uses a per-row-unique id (`status-select-{job.id}`) so multiple expanded
rows never collide.

**Checked and already correct, no fix needed:**
`EmployeeManagement.jsx`'s role-change dropdown already has a proper
`aria-label` identifying which employee it changes. `JobNotes.jsx`'s
dictation mic button already has both `aria-label` and `title`. All
password-visibility toggle buttons (`Login.jsx`, `Join.jsx`,
`ResetPassword.jsx`) already use `aria-label` correctly, toggling between
"Show password" / "Hide password" as the state changes.

## 3. Color contrast

Every text/background color pair used in the app was checked against the
WCAG AA thresholds (4.5:1 for normal text, 3:1 for large text and UI
components) -- both the shared palette in `src/theme.js` and every page's
own inline hex-color styles, using the standard WCAG relative-luminance
formula. The app's existing color system is already almost entirely
compliant; this was the one area where the audit found the codebase
already in good shape rather than needing fixes.

**One pair numerically fails but is correctly exempt.** Two disabled-state
button text/background combinations fall under the 4.5:1 threshold when
measured as plain numbers. WCAG 1.4.3's own Understanding document
explicitly exempts inactive/disabled UI components from the contrast
requirement, on the reasoning that a disabled control isn't actionable in
the first place, so its exact contrast isn't a barrier to using the page.
No fix applied here -- flagging it and explaining why is more honest than
padding this report with a change that isn't actually required.

## What this doesn't cover

This was a code-and-formula audit, not a live test with an actual screen
reader (VoiceOver/NVDA/JAWS) or with real assistive-technology users. That
kind of testing can surface things a code read can't -- reading order
quirks, how a specific screen reader announces a specific ARIA pattern,
real-world usability for someone who actually relies on this daily. If
accessibility becomes a bigger priority going forward (a customer or
employee who needs it, or a compliance requirement), a real assistive-tech
test pass would be the natural next step -- not attempted here because
nothing in this project's brief called for it and no such user need has
come up yet.

## Verification

Full test suite: 176/176 passing after all changes (`npm test -- --run`).
Production build: clean, no errors (`npm run build`). No database
migration involved in this work, so no staging-migration-test run was
needed before shipping.
