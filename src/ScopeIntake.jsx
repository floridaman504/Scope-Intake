import React, { useState, useRef } from 'react';
import { Camera, Video, MapPin, Lock, Wrench, Droplet, ChevronRight, ChevronLeft, Check, X, Upload, Phone } from 'lucide-react';
import { supabase } from './supabaseClient.js';

// The subdomain this deployment serves. Scope-Intake's schema is built
// for multi-tenant use (companies.subdomain, submit_public_job()),
// but only one company exists today ("Demo Company" / subdomain "demo").
// When real subdomain-based routing ships, replace this with something
// derived from window.location.hostname instead of a constant.
const COMPANY_SUBDOMAIN = 'demo';

// ---- Question data ----
const STEPS = [
{
id: 'context',
icon: Wrench,
title: "What's going on?",
sub: 'Give us the short version. What did you notice, and when?',
type: 'textarea',
placeholder: 'e.g. "Water pooling under the kitchen sink since this morning"',
},
{
id: 'contact',
icon: Phone,
title: 'How can we reach you?',
sub: "We'll text or call to confirm details and let you know when we're on the way.",
type: 'contact',
},
{
id: 'media',
icon: Camera,
title: 'Show us the issue',
sub: 'A photo or short video of the problem area -- and any damage it caused.',
type: 'media',
},
{
id: 'fixture',
icon: Droplet,
title: 'Fixture details',
sub: 'Brand and color, if visible or known. Skip if not applicable.',
type: 'text',
placeholder: 'e.g. "Moen, brushed nickel" or "Not sure / not applicable"',
},
{
id: 'pipe',
icon: Wrench,
title: 'What kind of pipe is it?',
sub: 'Look under the sink or at the exposed line if you can.',
type: 'choice',
options: ['Copper', 'PEX', 'PVC', 'CPVC', 'Galvanized', "Not sure"],
},
{
id: 'access',
icon: Lock,
title: 'How do we get to you?',
sub: 'Gate, door, elevator, or key codes -- and where we should park.',
type: 'textarea',
placeholder: 'e.g. "Gate code 4471, park in driveway, ring bell twice"',
},
{
id: 'cutting',
icon: Wrench,
title: 'Can we cut into walls or floors?',
sub: "If the fix requires it, do we have your OK in advance?",
type: 'choice',
options: ['Yes, go ahead if needed', 'No -- call me first', 'Not sure / depends'],
},
{
id: 'preference',
icon: Wrench,
title: 'Repair or replace?',
sub: 'If the fixture itself is the problem, what do you prefer?',
type: 'choice',
options: ['Repair if possible', 'Replace it', 'Whatever you recommend', 'Not applicable'],
},
{
id: 'leak_detection',
icon: Droplet,
title: 'Has a leak already been located?',
sub: 'Only relevant if this is a hidden leak -- e.g. a rising water meter with no visible water.',
type: 'choice',
options: ['Leak detection already done', 'Not done yet', 'Not applicable -- leak is visible'],
},
];

const TOTAL = STEPS.length;

// Mirrors the job-media storage bucket's server-side limits, applied in
// docs/migrations/2026-08-15-add-input-limits.sql (file_size_limit /
// allowed_mime_types) and the jobs_media_count DB constraint (max 8 per
// job). Checking here too isn't redundant -- without it, a customer who
// picks an oversized file or hits the 9th attachment doesn't find out
// until the upload silently fails deep inside saveJob after they've
// already submitted, instead of a clear message at the moment they pick
// the file.
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB, matches the bucket's file_size_limit
const MAX_FILES = 8;
const ALLOWED_MEDIA_TYPES = [
'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
];

export default function ScopeIntake() {
const [step, setStep] = useState(0);
const [answers, setAnswers] = useState({});
const [media, setMedia] = useState([]);
const [submitted, setSubmitted] = useState(false);
const [aiBrief, setAiBrief] = useState(null);
const [loading, setLoading] = useState(false);
// Count of attached files that didn't make it to storage (or didn't get
// linked to the job afterward) -- surfaced on ResultScreen so a customer
// is never told every attachment made it through when one silently didn't.
// The job save itself is never blocked by a media failure.
const [mediaUploadFailures, setMediaUploadFailures] = useState(0);
// True only when the job itself never reached the database (submit_public_job
// or attach_job_media threw). Distinct from mediaUploadFailures, which is a
// non-fatal partial failure the job save survives -- this one means the
// customer's request was never actually logged, so ResultScreen must not
// show the "ready for dispatch" brief when it's true. See handleSubmit's
// comment on why this used to fail silently.
const [submitFailed, setSubmitFailed] = useState(false);
// Friendly inline message when handleFile rejects one or more picked
// files (too big, wrong type, or over the 8-file cap) -- cleared on the
// next successful pick so it doesn't linger after the customer fixes it.
const [mediaError, setMediaError] = useState('');
const fileInputRef = useRef(null);

const current = STEPS[step];
const progress = ((step + 1) / TOTAL) * 100;

const setAnswer = (val) => setAnswers((a) => ({ ...a, [current.id]: val }));

const contactValue = answers.contact || { name: '', phone: '', email: '' };
const setContactField = (field, val) =>
setAnswers((a) => ({ ...a, contact: { ...(a.contact || {}), [field]: val } }));

const canAdvance = () => {
if (current.type === 'media') return true; // optional but encouraged
if (current.type === 'contact') {
// Name and a phone number are the minimum bar -- email is optional.
return Boolean(contactValue.name?.trim()) && Boolean(contactValue.phone?.trim());
}
const v = answers[current.id];
return v !== undefined && v !== '';
};

const next = () => {
if (step < TOTAL - 1) setStep(step + 1);
else handleSubmit();
};
const back = () => { if (step > 0) setStep(step - 1); };

const handleFile = (e) => {
const files = Array.from(e.target.files || []);
// Reset the file input's value so picking the exact same file again
// later (e.g. after removing it) still fires onChange -- browsers don't
// re-fire a change event for an unchanged file list otherwise.
e.target.value = '';

const accepted = [];
const rejections = [];
for (const f of files) {
if (!ALLOWED_MEDIA_TYPES.includes(f.type)) {
rejections.push(`${f.name} isn't a supported photo/video type`);
continue;
}
if (f.size > MAX_FILE_BYTES) {
rejections.push(`${f.name} is over the 25 MB limit`);
continue;
}
accepted.push(f);
}

// Cap total attachments at 8, matching the jobs_media_count DB
// constraint and the server-side check in api/v1/review-job.js -- applied
// after the per-file checks above so a customer sees the specific
// per-file reason first when both problems exist at once.
const room = Math.max(0, MAX_FILES - media.length);
const toAdd = accepted.slice(0, room);
if (accepted.length > toAdd.length) {
rejections.push(`only ${MAX_FILES} attachments are allowed per job -- ${accepted.length - toAdd.length} more skipped`);
}

if (rejections.length > 0) {
setMediaError(rejections.join('; '));
} else {
setMediaError('');
}

if (toAdd.length === 0) return;

// `url` is a browser-local blob URL, used only for the in-form preview
// below and on the immediate post-submit ResultScreen (it stays valid for
// the rest of this tab's life). `file` is the actual File object -- that's
// what gets uploaded to Supabase Storage in handleSubmit, once a job id
// exists to scope the storage path to. See
// docs/migrations/2026-08-12-job-media-storage-bucket.sql.
const mapped = toAdd.map((f) => ({
name: f.name,
type: f.type.startsWith('video') ? 'video' : 'image',
url: URL.createObjectURL(f),
file: f,
}));
setMedia((m) => [...m, ...mapped]);
};

const removeMedia = (idx) => setMedia((m) => m.filter((_, i) => i !== idx));

// Saves the job (+ uploads attachments) using an already-computed brief.
// Split out from handleSubmit so a retry after a failed save (see below)
// can re-run just this part -- retrying the whole handleSubmit would
// re-call /api/v1/review-job for a brief we already have, burning an extra
// AI call (and extra spend against the cost guardrail) for no reason.
const saveJob = async (brief) => {
// Reset here (not just in handleSubmit) so a retry after a failure
// clears the failed state as soon as a new attempt starts, regardless
// of which caller (handleSubmit or retrySave) invoked this.
setSubmitFailed(false);

// Save the full job (customer answers + whichever brief we ended up
// with) via the submit_public_job() RPC rather than a direct table
// insert. submit_public_job is SECURITY DEFINER and resolves
// company_id server-side from p_subdomain -- the client never
// supplies a company_id directly. That distinction matters: an
// earlier version of this form resolved company_id client-side (via
// get_company_by_subdomain) and then inserted into jobs directly,
// with RLS only checking that the supplied company_id existed
// *somewhere* -- not that it matched the subdomain this form was
// actually served from. That meant anyone who captured a company_id
// (trivially available -- get_company_by_subdomain returned it to
// every visitor) could insert jobs into ANY company's queue with the
// public anon key, bypassing this form and the AI cost guardrail
// entirely. See docs/audits/2026-08-11-public-job-insert-tenant-binding-fix.md.
// If this fails, we don't show a scary full-page error or make the
// customer retype anything -- but we do tell them, via submitFailed below,
// because the alternative (silently discarding a real customer's plumbing
// emergency while they believe help is on the way) is worse than a UX
// downgrade. See ResultScreen's submitFailed branch.
//
// p_media is [] here on purpose, not media metadata -- there's no job id
// yet to scope a storage path to. Real files are uploaded to Supabase
// Storage AFTER this call returns the new job row (see below), then
// linked onto the job via attach_job_media(). Previously this sent
// {name, type} pairs straight into jobs.media with no actual file behind
// them -- URL.createObjectURL() only ever produced a browser-local blob
// URL that died the moment this tab closed, so nothing a plumber or
// dispatcher could ever see reached the database. See
// docs/migrations/2026-08-12-job-media-storage-bucket.sql.
let failedUploads = 0;
try {
const { data: job, error: submitErr } = await supabase.rpc('submit_public_job', {
p_subdomain: COMPANY_SUBDOMAIN,
p_customer_name: contactValue.name || null,
p_customer_phone: contactValue.phone || null,
p_customer_email: contactValue.email || null,
p_context: answers.context || null,
p_fixture: answers.fixture || null,
p_pipe: answers.pipe || null,
p_access: answers.access || null,
p_cutting: answers.cutting || null,
p_preference: answers.preference || null,
p_leak_detection: answers.leak_detection || null,
p_media: [],
p_ai_job_type: brief.jobType || null,
p_ai_urgency: brief.urgency || null,
p_ai_materials: brief.likelyMaterials || [],
p_ai_summary: brief.briefSummary || null,
p_ai_watch_out: brief.watchOutFor || null,
});
if (submitErr) throw submitErr;

// Upload attachments now that we have job.id and job.company_id --
// both come straight from submit_public_job's trusted server-side
// response, never guessed or client-supplied. This is safe to do with
// the anon key directly: job.id is an unguessable gen_random_uuid(),
// and the job-media bucket's INSERT policy only allows a write under
// {company_id}/{job_id}/... when a job with exactly that id and
// company_id actually exists -- so this can never be used to write
// into another company's, or another job's, folder.
//
// Failures are per-file and non-fatal: one bad upload (network blip,
// oversized file) doesn't lose the rest, and never loses the job
// itself -- the count just gets surfaced on ResultScreen below instead
// of silently pretending everything attached.
if (job && media.length > 0) {
const uploaded = [];
await Promise.all(media.map(async (m) => {
const safeName = `${Date.now()}-${m.name}`.replace(/[^a-zA-Z0-9._-]/g, '_');
const path = `${job.company_id}/${job.id}/${safeName}`;
const { error: uploadErr } = await supabase.storage
.from('job-media')
.upload(path, m.file, { contentType: m.file?.type || undefined });
if (uploadErr) {
failedUploads += 1;
console.error('Media upload failed for', m.name, uploadErr);
} else {
uploaded.push({ name: m.name, type: m.type, path });
}
}));

if (uploaded.length > 0) {
const { error: attachErr } = await supabase.rpc('attach_job_media', {
p_job_id: job.id,
p_subdomain: COMPANY_SUBDOMAIN,
p_media: uploaded,
});
if (attachErr) {
// Files reached storage but never got linked onto the job row --
// from the dispatcher's side that's indistinguishable from "no
// attachments," so it counts as a failure here too.
console.error('Could not attach uploaded media to job:', attachErr);
failedUploads = media.length;
}
}
}
} catch (dbErr) {
// The job never reached the database -- this is a lost lead, not a
// cosmetic failure, so it has to reach the customer somehow.
// setSubmitFailed(true) is that "somehow": ResultScreen shows a plain
// "we couldn't save your request, try again" state instead of the AI
// brief, which would otherwise be actively misleading (a fully-formed
// "ready for dispatch" screen for a job nobody at the company can see).
console.error('Could not save job to database:', dbErr);
setSubmitFailed(true);
} finally {
setMediaUploadFailures(failedUploads);
setLoading(false);
}
};

const handleSubmit = async () => {
setSubmitted(true);
setLoading(true);

// AI brief generation and job persistence are deliberately decoupled:
// the AI call can fail for reasons that have nothing to do with this
// customer (Anthropic outage, or -- now that the cost guardrail is
// wired in -- a rate limit tripped by someone else entirely). None of
// that should cost this customer their submission. A worse AI brief is
// a UX downgrade; a lost job is a lost lead. So: always try to save the
// job, using the real brief if we got one and a clearly-labeled
// fallback if we didn't.
let brief;
try {
const summary = STEPS.map((s) => {
if (s.id === 'contact') return null; // contact info isn't part of the job-type summary
return `${s.title}: ${answers[s.id] || 'Not provided'}`;
}).filter(Boolean).join('\n');

const response = await fetch('/api/v1/review-job', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
summary,
mediaCount: media.length,
mediaTypes: media.map((m) => m.type).join(', ') || 'none',
subdomain: COMPANY_SUBDOMAIN,
}),
});
const parsed = await response.json();
if (parsed.error) throw new Error(parsed.error);
brief = parsed;
} catch (err) {
brief = {
jobType: 'Unable to generate brief',
urgency: 'Unknown',
likelyMaterials: [],
briefSummary: 'Something went wrong generating the AI summary. The raw answers below are still complete and usable.',
watchOutFor: '--',
};
}
setAiBrief(brief);
await saveJob(brief);
};

// Retry after a failed save, reusing the brief already computed on the
// first attempt (aiBrief) instead of calling /api/v1/review-job again --
// see saveJob's header comment for why.
const retrySave = async () => {
setLoading(true);
await saveJob(aiBrief);
};

if (submitted) {
return <ResultScreen
loading={loading}
brief={aiBrief}
answers={answers}
media={media}
mediaUploadFailures={mediaUploadFailures}
submitFailed={submitFailed}
onRetry={retrySave}
onReset={() => {
setSubmitted(false); setStep(0); setAnswers({}); setMedia([]); setAiBrief(null); setMediaUploadFailures(0); setSubmitFailed(false); setMediaError('');
}} />;
}

return (
<div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3' }} className="min-h-screen flex flex-col font-sans">
{/* Header */}
<header style={{ borderBottom: '1px solid #2A2A2A' }} className="flex items-center justify-between px-6 py-5">
<div className="flex items-center gap-2">
<div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
<span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-lg font-bold tracking-[0.15em]">SCOPE</span>
</div>
<span style={{ color: '#7A7A7A' }} className="text-xs tracking-wide">CLARITY BEFORE THE CALL</span>
</header>

{/* Progress conduit */}
<div style={{ height: 2, backgroundColor: '#1E1E1E', position: 'relative' }}>
<div
style={{
height: 2,
width: `${progress}%`,
background: 'linear-gradient(to right, #8A6D1A, #C9A227)',
transition: 'width 0.5s ease-out',
}}
/>
</div>

{/* Spotlight stage */}
<main style={{ position: 'relative' }} className="flex-1 flex items-center justify-center px-6 py-10 overflow-hidden">
{/* Ambient spotlight glow */}
<div
className="absolute inset-0 pointer-events-none transition-opacity duration-700"
style={{
background: 'radial-gradient(circle at 50% 35%, rgba(201,162,39,0.10), transparent 55%)',
}}
/>

<div key={step} style={{ position: 'relative' }} className="w-full max-w-md animate-fadein">
<div style={{ color: '#E8BD3A' }} className="text-sm tracking-[0.2em] mb-3 font-semibold">
STEP {step + 1} OF {TOTAL}
</div>

<div className="flex items-start gap-3 mb-1">
<current.icon size={24} style={{ color: '#E8BD3A' }} className="mt-1 shrink-0" strokeWidth={2} />
<h1 style={{ color: '#FFFFFF', fontFamily: 'Oswald, sans-serif' }} className="text-[28px] leading-tight font-bold">
{current.title}
</h1>
</div>
<p style={{ color: '#C4C4C4' }} className="text-[15px] mb-6 ml-[36px]">{current.sub}</p>

<div className="ml-[36px]">
{current.type === 'textarea' && (
<textarea
autoFocus
value={answers[current.id] || ''}
onChange={(e) => setAnswer(e.target.value)}
placeholder={current.placeholder}
rows={4}
// Matches the jobs_context_length / jobs_access_length DB constraints
// (docs/migrations/2026-08-15-add-input-limits.sql) and the 6000-char
// server-side summary cap in api/v1/review-job.js -- this is the friendly
// front line, not the only line: a customer just can't type past 2000
// characters in the first place, rather than typing more and getting
// rejected later at submit time.
maxLength={2000}
style={{ color: '#111111', backgroundColor: '#F4F1E8', caretColor: '#111111', border: '2px solid #454545' }}
className="w-full rounded-lg px-4 py-3.5 placeholder-[#9A9A9A] outline-none transition-colors resize-none text-base shadow-inner"
/>
)}

{current.type === 'text' && (
<input
autoFocus
type="text"
value={answers[current.id] || ''}
onChange={(e) => setAnswer(e.target.value)}
placeholder={current.placeholder}
// Matches jobs_fixture_length in docs/migrations/2026-08-15-add-input-limits.sql.
maxLength={500}
style={{ color: '#111111', backgroundColor: '#F4F1E8', caretColor: '#111111', border: '2px solid #454545' }}
className="w-full rounded-lg px-4 py-3.5 placeholder-[#9A9A9A] outline-none transition-colors text-base shadow-inner"
/>
)}

{current.type === 'contact' && (
<div className="flex flex-col gap-3">
<input
autoFocus
type="text"
value={contactValue.name}
onChange={(e) => setContactField('name', e.target.value)}
placeholder="Full name"
// Matches jobs_customer_name_length / _phone_length / _email_length
// in docs/migrations/2026-08-15-add-input-limits.sql.
maxLength={200}
style={{ color: '#111111', backgroundColor: '#F4F1E8', caretColor: '#111111', border: '2px solid #454545' }}
className="w-full rounded-lg px-4 py-3.5 placeholder-[#9A9A9A] outline-none transition-colors text-base shadow-inner"
/>
<input
type="tel"
value={contactValue.phone}
onChange={(e) => setContactField('phone', e.target.value)}
placeholder="Phone number"
maxLength={30}
style={{ color: '#111111', backgroundColor: '#F4F1E8', caretColor: '#111111', border: '2px solid #454545' }}
className="w-full rounded-lg px-4 py-3.5 placeholder-[#9A9A9A] outline-none transition-colors text-base shadow-inner"
/>
<input
type="email"
value={contactValue.email}
onChange={(e) => setContactField('email', e.target.value)}
placeholder="Email (optional)"
maxLength={320}
style={{ color: '#111111', backgroundColor: '#F4F1E8', caretColor: '#111111', border: '2px solid #454545' }}
className="w-full rounded-lg px-4 py-3.5 placeholder-[#9A9A9A] outline-none transition-colors text-base shadow-inner"
/>
</div>
)}

{current.type === 'choice' && (
<div className="flex flex-col gap-2">
{current.options.map((opt) => {
const isSelected = answers[current.id] === opt;
return (
<button
key={opt}
onClick={() => setAnswer(opt)}
style={{
backgroundColor: isSelected ? '#26200A' : '#1C1C1C',
border: `2px solid ${isSelected ? '#E8BD3A' : '#454545'}`,
color: isSelected ? '#FFFFFF' : '#E0E0E0',
}}
className="text-left px-4 py-3.5 rounded-lg transition-all text-base"
>
<span className="flex items-center justify-between">
{opt}
{isSelected && <Check size={18} style={{ color: '#E8BD3A' }} />}
</span>
</button>
);
})}
</div>
)}

{current.type === 'media' && (
<div>
<input
ref={fileInputRef}
type="file"
accept="image/*,video/*"
multiple
capture="environment"
onChange={handleFile}
className="hidden"
/>
<button
onClick={() => fileInputRef.current?.click()}
style={{ backgroundColor: '#161616', border: '2px dashed #5A5A5A' }}
className="w-full rounded-lg py-8 flex flex-col items-center gap-2 transition-colors group"
>
<div style={{ color: '#E8BD3A' }} className="flex gap-3">
<Camera size={26} strokeWidth={1.75} />
<Video size={26} strokeWidth={1.75} />
</div>
<span style={{ color: '#D0D0D0' }} className="text-[15px] font-medium">
Tap to add photos or video
</span>
</button>

{media.length > 0 && (
<div className="grid grid-cols-3 gap-2 mt-4">
{media.map((m, i) => (
<div key={i} style={{ backgroundColor: '#1A1A1A', border: '1px solid #2E2E2E', position: 'relative' }} className="aspect-square rounded-md overflow-hidden">
{m.type === 'image' ? (
<img src={m.url} alt={`Uploaded photo ${i + 1} of the issue`} className="w-full h-full object-cover" />
) : (
<div className="w-full h-full flex items-center justify-center">
<Video size={20} style={{ color: '#C9A227' }} />
</div>
)}
<button
onClick={() => removeMedia(i)}
aria-label={`Remove ${m.type === 'video' ? 'video' : 'photo'} ${i + 1}`}
style={{ position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.7)' }}
className="rounded-full p-1"
>
<X size={12} style={{ color: '#FFFFFF' }} />
</button>
</div>
))}
</div>
)}
{mediaError && (
<p style={{ color: '#E0A840', backgroundColor: '#241C0A', border: '1px solid #3A2F0E' }}
className="text-xs rounded-md px-3 py-2.5 mt-3">
{mediaError}
</p>
)}
<p style={{ color: '#9A9A9A' }} className="text-xs mt-3">Optional, but the plumber will thank you.</p>
</div>
)}
</div>
</div>
</main>

{/* Nav */}
<footer style={{ borderTop: '1px solid #1E1E1E' }} className="px-6 py-5 flex items-center justify-between">
<button
onClick={back}
disabled={step === 0}
style={{ color: step === 0 ? '#4A4A4A' : '#D0D0D0', cursor: step === 0 ? 'not-allowed' : 'pointer' }}
className="flex items-center gap-1 text-[15px] font-medium px-4 py-2 rounded-md transition-colors"
>
<ChevronLeft size={18} /> Back
</button>

<button
onClick={next}
disabled={!canAdvance()}
style={{
backgroundColor: canAdvance() ? '#E8BD3A' : '#222222',
color: canAdvance() ? '#0A0A0A' : '#5A5A5A',
cursor: canAdvance() ? 'pointer' : 'not-allowed',
}}
className="flex items-center gap-1.5 text-[15px] font-semibold px-5 py-3 rounded-md transition-all"
>
{step === TOTAL - 1 ? 'Submit job request' : 'Next'}
<ChevronRight size={18} />
</button>
</footer>

<style>{`
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
.font-sans { font-family: 'Inter', sans-serif; }
.animate-fadein { animation: fadein 0.35s ease-out; }
@keyframes fadein {
from { opacity: 0; transform: translateY(6px); }
to { opacity: 1; transform: translateY(0); }
}
`}</style>
</div>
);
}

function ResultScreen({ loading, brief, answers, media, mediaUploadFailures, submitFailed, onRetry, onReset }) {
return (
<div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }} className="font-sans">
<header style={{ borderBottom: '1px solid #2A2A2A' }} className="flex items-center justify-between px-6 py-5">
<div className="flex items-center gap-2">
<div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
<span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-lg font-bold tracking-[0.15em]">SCOPE</span>
</div>
</header>

<main className="max-w-md mx-auto px-6 py-10">
{loading ? (
<div className="flex flex-col items-center gap-4 py-20">
<div style={{ border: '2px solid #2E2E2E', borderTopColor: '#C9A227' }} className="w-10 h-10 rounded-full animate-spin" />
<p style={{ color: '#C4C4C4' }} className="text-sm">Reviewing the job submission...</p>
</div>
) : submitFailed ? (
// The job never reached the database -- showing the "ready for
// dispatch" brief here would tell the customer their emergency is
// being handled when nobody at the company can see it. Keep this
// screen honest instead: say plainly that it didn't go through, and
// give them a one-click retry that reuses the brief already computed
// (no retyping, no second AI call) plus the RESULT of a real fix,
// not just an apology.
<div className="py-10">
<div style={{ color: '#E07A6E' }} className="text-xs tracking-[0.2em] mb-2 font-medium">REQUEST NOT SAVED</div>
<h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-4">
We couldn't save your request
</h1>
<p style={{ color: '#D8D8D8' }} className="text-[15px] leading-relaxed mb-6">
Something went wrong on our end and your job request wasn't sent to us --
it hasn't been lost, but it also hasn't reached anyone yet. Nothing you
typed is gone; tap below to try again.
</p>
<button
onClick={onRetry}
style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
className="w-full py-3 rounded-md text-sm font-semibold transition-colors mb-3"
>
Try again
</button>
<button
onClick={onReset}
style={{ border: '1px solid #2E2E2E', color: '#C8C8C8', backgroundColor: 'transparent' }}
className="w-full py-3 rounded-md text-sm transition-colors"
>
Start over instead
</button>
</div>
) : (
<>
<div style={{ color: '#C9A227' }} className="text-xs tracking-[0.2em] mb-2 font-medium">JOB BRIEF -- READY FOR DISPATCH</div>
<h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-6">{brief?.jobType}</h1>

<div className="flex items-center gap-2 mb-6">
<UrgencyBadge level={brief?.urgency} />
<span style={{ color: '#9A9A9A' }} className="text-xs">{media.length} attachment{media.length !== 1 ? 's' : ''}</span>
</div>

<Section label="Summary">
<p style={{ color: '#D8D8D8' }} className="text-[15px] leading-relaxed">{brief?.briefSummary}</p>
</Section>

{brief?.likelyMaterials?.length > 0 && (
<Section label="Likely materials needed">
<div className="flex flex-wrap gap-2">
{brief.likelyMaterials.map((m, i) => (
<span key={i} style={{ backgroundColor: '#1C1708', border: '1px solid #3A2F0E', color: '#D9B84A' }} className="text-xs px-3 py-1.5 rounded-full">
{m}
</span>
))}
</div>
</Section>
)}

<Section label="Watch out for">
<p style={{ color: '#D8D8D8' }} className="text-[15px] leading-relaxed">{brief?.watchOutFor}</p>
</Section>

{mediaUploadFailures > 0 && (
<p style={{ color: '#E0A840', backgroundColor: '#241C0A', border: '1px solid #3A2F0E' }}
className="text-xs rounded-md px-3 py-2.5 mb-6">
{mediaUploadFailures === media.length
? "Your job request was saved, but the attachment(s) didn't upload. The plumber will still see everything you typed -- just not the photo/video."
: `${mediaUploadFailures} of ${media.length} attachment${media.length !== 1 ? 's' : ''} didn't upload, but the rest of your job request was saved.`}
</p>
)}

{media.length > 0 && (
<Section label="Attachments">
<div className="grid grid-cols-3 gap-2">
{media.map((m, i) => (
<div key={i} style={{ backgroundColor: '#1A1A1A', border: '1px solid #2E2E2E' }} className="aspect-square rounded-md overflow-hidden">
{m.type === 'image' ? (
<img src={m.url} alt={`Uploaded photo ${i + 1} of the issue`} className="w-full h-full object-cover" />
) : (
<div className="w-full h-full flex items-center justify-center">
<Video size={20} style={{ color: '#C9A227' }} />
</div>
)}
</div>
))}
</div>
</Section>
)}

<Section label="Raw customer answers">
<div className="space-y-2">
{Object.entries(answers).map(([k, v]) => {
if (k === 'contact') return null;
return (
<div key={k} style={{ color: '#7A7A7A', borderBottom: '1px solid #1A1A1A' }} className="text-xs flex justify-between gap-3 pb-2">
<span className="capitalize">{k.replace('_', ' ')}</span>
<span style={{ color: '#B8B8B8' }} className="text-right">{v}</span>
</div>
);
})}
</div>
</Section>

<button
onClick={onReset}
style={{ border: '1px solid #2E2E2E', color: '#C8C8C8', backgroundColor: 'transparent' }}
className="w-full mt-4 py-3 rounded-md text-sm transition-colors"
>
Submit another job request
</button>
</>
)}
</main>

<style>{`
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
.font-sans { font-family: 'Inter', sans-serif; }
`}</style>
</div>
);
}

function Section({ label, children }) {
return (
<div className="mb-6">
<div style={{ color: '#9A9A9A' }} className="text-[11px] tracking-[0.15em] mb-2 font-medium">{label.toUpperCase()}</div>
{children}
</div>
);
}

function UrgencyBadge({ level }) {
const styles = {
High: { backgroundColor: '#2A1212', color: '#E07A6E', border: '1px solid #4A1F1A' },
Medium: { backgroundColor: '#241C0A', color: '#D9B84A', border: '1px solid #3A2F0E' },
Low: { backgroundColor: '#142018', color: '#7DA888', border: '1px solid #1F3026' },
};
return (
<span style={styles[level] || styles.Medium} className="text-xs px-3 py-1 rounded-full font-medium">
{level || 'Medium'} urgency
</span>
);
}
