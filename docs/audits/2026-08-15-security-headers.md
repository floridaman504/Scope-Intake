# Security headers (Tier 2, item #9 of docs/scope-operational-playbook.md)

Added in `vercel.json`'s `headers` block, applied to every route (`/(.*)`)
-- static SPA pages, API routes, everything.

## What each header does, in plain terms

- **X-Frame-Options: DENY** -- stops any other site from embedding Scope
  inside an invisible `<iframe>` to trick a user into clicking something
  they didn't mean to (clickjacking).
- **X-Content-Type-Options: nosniff** -- stops the browser from guessing a
  file's type and running it as something more dangerous than what the
  server actually said it was.
- **Referrer-Policy: strict-origin-when-cross-origin** -- when a link from
  Scope is clicked, only send the destination site the origin
  (`https://scope-intake.vercel.app`), never the full URL with query
  params -- so a job ID or subdomain in a URL never leaks to a third
  party via the Referer header.
- **Strict-Transport-Security** -- tells the browser "always use HTTPS for
  this domain for the next 2 years, no exceptions," closing the window
  where a first HTTP request could be intercepted before redirecting to
  HTTPS. Not submitted to the browser preload list (that's a separate,
  harder-to-reverse manual step at hstspreload.org) -- this only sets the
  header.
- **Content-Security-Policy (CSP)** -- the real one, restricts what a page
  is even allowed to load or execute, so that even if an attacker found a
  way to inject a `<script>` tag somewhere, the browser would refuse to
  run it.

## Why the CSP looks the way it does (verified against the actual app, not guessed)

- `script-src 'self'` -- no `unsafe-inline`, no `unsafe-eval`. Confirmed by
  reading the actual production build output (`dist/index.html`): Vite
  emits only external `<script type="module" src="/assets/...">` tags,
  zero inline scripts. This is the strict, no-compromise line -- it's the
  one that actually stops injected-script attacks.
- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` -- every
  page component (Login.jsx, ScopeIntake.jsx, JobsQueue.jsx, etc.) renders
  its Google Fonts `@import` through an inline `<style>` block in JSX,
  which React injects into the DOM at runtime. That requires
  `unsafe-inline` for styles specifically -- inline *style* injection is a
  much lower-severity risk than inline *script* injection (it can't run
  code), which is why this tradeoff is reasonable here while
  `script-src` stays strict. Fixing this properly (moving fonts to a real
  `<link>` tag in `index.html` and dropping `unsafe-inline` entirely) is a
  clean follow-up but is a real refactor across ~14 files, not a header
  change -- flagged for later, not silently skipped.
- `font-src https://fonts.gstatic.com` -- the actual font *files* Google's
  CSS `@import` resolves to are served from `gstatic.com`, a different
  domain than `googleapis.com`.
- `img-src 'self' data: blob: https://*.supabase.co` -- covers three real
  cases, each confirmed by reading the code: local file-preview images use
  `URL.createObjectURL()` (`blob:` URLs, ScopeIntake.jsx), uploaded photos
  in the dispatcher view use Supabase Storage signed URLs
  (`https://<project>.supabase.co/...`, JobsQueue.jsx), `data:` is kept as
  a safe, common allowance for any inline-encoded image.
- `connect-src 'self' https://*.supabase.co wss://*.supabase.co` -- `'self'`
  covers the app's own same-origin `/api/review-job` call; the Supabase
  entries cover the JS client's REST calls (https) and Realtime
  subscriptions (wss).
- `https://*.supabase.co` (wildcard, not the literal project domain) is
  used deliberately -- `vercel.json` is static JSON with no access to the
  `VITE_SUPABASE_URL` env var at header-definition time, and the wildcard
  means this doesn't need editing if the project ref ever changes or a
  second environment is added.
- `frame-ancestors 'none'` -- the modern, CSP-native version of
  X-Frame-Options; kept both for older-browser fallback.
- `base-uri 'self'`, `form-action 'self'`, `object-src 'none'` -- standard
  hardening: stops a `<base>` tag hijack, stops forms from being
  redirected to submit somewhere else, blocks Flash/legacy plugin
  embeds entirely.

## Verification

Checked with a real production build (`npx vite build --mode production`)
before writing the CSP, not assumed. Also verified against the live
Vercel Preview deployment this PR generates (every PR in this repo gets
one automatically) before asking for merge -- see the PR for the preview
URL and confirmation that fonts, images, and the intake form's AI call all
still work with these headers active.
