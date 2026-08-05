import React, { useState, useRef, useEffect } from 'react';
import { Camera, Video, MapPin, Lock, Wrench, Droplet, PawPrint, ChevronRight, ChevronLeft, Check, X, Upload } from 'lucide-react';
import { supabase } from './supabaseClient.js';

// Resolves which company this intake form belongs to from the subdomain,
// e.g. acme-plumbing.scopwell.com -> "acme-plumbing". Falls back to the
// shared "demo" company for local dev and the bare apex domain, where
// there's no real subdomain to read.
function getCompanySubdomain() {
  const host = window.location.hostname;
  // Only *.scopwell.com hosts carry a real tenant subdomain. Everything
  // else -- localhost, the bare/www apex, and Vercel preview URLs like
  // scope-intake-git-scopwell-preview-floridaman504.vercel.app (which
  // also happen to have 3 dot-separated parts, so a plain "parts.length"
  // check misreads them as a tenant subdomain and 400s on submit) --
  // falls back to the shared "demo" company.
  if (!host.endsWith('.scopwell.com')) return 'demo';
  const parts = host.split('.');
  // www.scopwell.com or scopwell.com itself: still no real tenant.
  if (parts.length <= 2 || parts[0] === 'www') return 'demo';
  return parts[0];
}

// Client-side media limits. The Storage bucket also hard-enforces a
// 50MB-per-file cap and an allowed-mime-type list server-side (see
// supabase_add_media_storage.sql) -- these just give the customer a fast,
// friendly error instead of a failed upload after they've already filled
// out the whole form.
const MAX_MEDIA_FILES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB

// Storage object paths can't safely contain arbitrary filename characters
// (spaces, unicode, etc. cause issues with some clients/CDNs), so strip
// down to a safe subset before using the name in a path.
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(-80);
}

// Which language the intake form renders in. Persisted so a customer who
// switches to Spanish and then reloads (or submits and starts a second job)
// doesn't have to switch again. This is a customer-facing preference only --
// it never touches how data is stored (see canonical option values below)
// or what language the AI job brief comes back in (always English, since
// that's read by the company's dispatcher/plumber, not the customer).
const LANG_STORAGE_KEY = 'scopewell_intake_lang';

// ---- Question structure (language-independent) ----
// Grouped into a handful of pages (2-3 related fields each) instead of one
// full-screen question per field. A lot of customers filling this out are
// elderly, and clicking "Next" 8+ times for one question at a time was a
// real usability complaint. Grouping related questions together means
// fewer taps to get through the whole thing, without turning it into one
// giant overwhelming form either.
//
// Every field except the very first (context) is optional -- you can leave
// any of them blank and still hit Next. That's intentional: it does the
// same job a "Skip" button on every page would, without needing a visible
// skip control cluttering each screen.
//
// Field/page COPY (titles, labels, placeholders, option text) lives in
// STRINGS below, keyed by language -- this structure only defines shape:
// which fields exist, their type, and (for choice fields) the canonical
// English option VALUES that actually get stored in the database. Storing
// canonical English values regardless of display language means a
// dispatcher looking at raw job data always sees consistent values (e.g.
// "Yes, go ahead if needed"), never a value that varies by which language
// the customer happened to submit in.
const PAGES = [
  {
    icon: Wrench,
    fields: [
      { id: 'customer_name', type: 'text', inputType: 'text', autoComplete: 'name', required: true, excludeFromAiSummary: true },
      { id: 'customer_phone', type: 'text', inputType: 'tel', autoComplete: 'tel', required: true, excludeFromAiSummary: true },
      { id: 'customer_email', type: 'text', inputType: 'email', autoComplete: 'email', excludeFromAiSummary: true },
    ],
  },
  {
    icon: Wrench,
    fields: [
      { id: 'context', type: 'textarea', required: true },
      { id: 'media', type: 'media' },
    ],
  },
  {
    icon: Droplet,
    fields: [
      { id: 'fixture', type: 'text' },
      { id: 'pipe', type: 'choice', optionValues: ['Copper', 'PEX', 'PVC', 'CPVC', 'Galvanized', 'Not sure'] },
    ],
  },
  {
    icon: Lock,
    fields: [
      { id: 'access', type: 'textarea' },
      { id: 'cutting', type: 'choice', optionValues: ['Yes, go ahead if needed', 'No — call me first', 'Not sure / depends'] },
      {
        id: 'pets',
        type: 'choice',
        icon: PawPrint,
        optionValues: [
          'No pets',
          'Yes — will be secured before you arrive',
          'Yes — friendly, may be loose',
          'Yes — not friendly, please use caution',
        ],
      },
    ],
  },
  {
    icon: Wrench,
    fields: [
      { id: 'preference', type: 'choice', optionValues: ['Repair if possible', 'Replace it', 'Whatever you recommend', 'Not applicable'] },
      { id: 'leak_detection', type: 'choice', optionValues: ['Leak detection already done', 'Not done yet', 'Not applicable — leak is visible'] },
    ],
  },
];

const TOTAL = PAGES.length;

// Flat lookup of field metadata by id, used by ResultScreen to know how to
// render a raw answer back (e.g. whether to translate it as a choice value).
const FIELD_META = Object.fromEntries(PAGES.flatMap((p) => p.fields).map((f) => [f.id, f]));

// ---- Copy, per language ----
const STRINGS = {
  en: {
    tagline: 'CLARITY BEFORE THE CALL',
    langToggleLabel: 'Español',
    langToggleAria: 'Switch to Spanish',
    pageLabel: (n, total) => `PAGE ${n} OF ${total}`,
    progressAria: (n, total) => `Page ${n} of ${total}`,
    back: 'Back',
    next: 'Next',
    submit: 'Submit job request',
    backAria: 'Back to previous page',
    nextAria: 'Next page',
    submitAria: 'Submit job request',
    pages: [
      { title: 'Who are we helping?', sub: 'So we know who to call and where to send someone.' },
      { title: "What's going on?", sub: 'Give us the short version, and a photo or video if you can.' },
      { title: 'The fixture & pipe', sub: "Only fill in what you know -- skip anything you're not sure of." },
      { title: 'Getting to you', sub: 'Access, permission to cut into walls if needed, and any pets on site.' },
      { title: 'A couple last things', sub: 'Your preference on the fix, and whether a leak has already been found.' },
    ],
    fields: {
      customer_name: { label: 'Your name', placeholder: 'e.g. "Jamie Rodriguez"' },
      customer_phone: { label: 'Best phone number', placeholder: 'e.g. "(555) 123-4567"' },
      customer_email: { label: 'Email (optional)', placeholder: 'e.g. "jamie@email.com"' },
      context: { label: "What's going on?", placeholder: 'e.g. "Water pooling under the kitchen sink since this morning"' },
      media: { label: 'Photo or video (optional)' },
      fixture: { label: 'Fixture details', placeholder: 'e.g. "Moen, brushed nickel" or leave blank' },
      pipe: { label: 'What kind of pipe is it?' },
      access: { label: 'How do we get to you?', placeholder: 'e.g. "Gate code 4471, park in driveway, ring bell twice"' },
      cutting: { label: 'Can we cut into walls or floors if the fix needs it?' },
      pets: { label: 'Any pets we should know about?' },
      preference: { label: 'Repair or replace?' },
      leak_detection: { label: 'Has a leak already been located?' },
    },
    options: {
      pipe: { Copper: 'Copper', PEX: 'PEX', PVC: 'PVC', CPVC: 'CPVC', Galvanized: 'Galvanized', 'Not sure': 'Not sure' },
      cutting: {
        'Yes, go ahead if needed': 'Yes, go ahead if needed',
        'No — call me first': 'No — call me first',
        'Not sure / depends': 'Not sure / depends',
      },
      pets: {
        'No pets': 'No pets',
        'Yes — will be secured before you arrive': 'Yes — will be secured before you arrive',
        'Yes — friendly, may be loose': 'Yes — friendly, may be loose',
        'Yes — not friendly, please use caution': 'Yes — not friendly, please use caution',
      },
      preference: {
        'Repair if possible': 'Repair if possible',
        'Replace it': 'Replace it',
        'Whatever you recommend': 'Whatever you recommend',
        'Not applicable': 'Not applicable',
      },
      leak_detection: {
        'Leak detection already done': 'Leak detection already done',
        'Not done yet': 'Not done yet',
        'Not applicable — leak is visible': 'Not applicable — leak is visible',
      },
    },
    media: {
      tapToAdd: 'Tap to add photos or video',
      maxFiles: (n) => `Max ${n} files attached`,
      remove: (name) => `Remove ${name}`,
      errorMaxFiles: (n) => `You can attach up to ${n} files.`,
      errorTooLarge: (name, size) => `${name} is too large (max ${size})`,
      errorOnlyNMore: (n, max) => `Only ${n} more file${n === 1 ? '' : 's'} can be added (max ${max} total)`,
    },
    result: {
      readyForDispatch: 'JOB BRIEF — READY FOR DISPATCH',
      willReachOutPrefix: "We'll reach out to",
      you: 'you',
      at: 'at',
      attachments: (n) => `${n} attachment${n !== 1 ? 's' : ''}`,
      summary: 'Summary',
      likelyMaterials: 'Likely materials needed',
      watchOut: 'Watch out for',
      attachmentsLabel: 'Attachments',
      rawAnswers: 'Raw customer answers',
      submitAnother: 'Submit another job request',
      loadingDefault: 'Reviewing the job submission...',
      loadingUploading: 'Uploading photos...',
      urgencyLabel: (level) => `${level || 'Medium'} urgency`,
      urgencyLevels: { High: 'High', Medium: 'Medium', Low: 'Low' },
    },
  },
  es: {
    tagline: 'CLARIDAD ANTES DE LA LLAMADA',
    langToggleLabel: 'English',
    langToggleAria: 'Switch to English',
    pageLabel: (n, total) => `PÁGINA ${n} DE ${total}`,
    progressAria: (n, total) => `Página ${n} de ${total}`,
    back: 'Atrás',
    next: 'Siguiente',
    submit: 'Enviar solicitud',
    backAria: 'Volver a la página anterior',
    nextAria: 'Página siguiente',
    submitAria: 'Enviar solicitud de trabajo',
    pages: [
      { title: '¿A quién ayudamos?', sub: 'Para saber a quién llamar y adónde enviar a alguien.' },
      { title: '¿Qué está pasando?', sub: 'Cuéntenos brevemente qué pasa, y si puede, envíe una foto o video.' },
      { title: 'El accesorio y la tubería', sub: 'Complete solo lo que sepa; omita lo que no esté seguro.' },
      { title: 'Cómo llegar hasta usted', sub: 'Acceso, permiso para abrir paredes si es necesario, y mascotas en el lugar.' },
      { title: 'Un par de cosas más', sub: 'Su preferencia sobre la reparación, y si ya se localizó una fuga.' },
    ],
    fields: {
      customer_name: { label: 'Su nombre', placeholder: 'ej. "Jamie Rodríguez"' },
      customer_phone: { label: 'Mejor número de teléfono', placeholder: 'ej. "(555) 123-4567"' },
      customer_email: { label: 'Correo electrónico (opcional)', placeholder: 'ej. "jamie@email.com"' },
      context: { label: '¿Qué está pasando?', placeholder: 'ej. "Se está acumulando agua debajo del fregadero desde esta mañana"' },
      media: { label: 'Foto o video (opcional)' },
      fixture: { label: 'Detalles del accesorio', placeholder: 'ej. "Moen, níquel cepillado" o déjelo en blanco' },
      pipe: { label: '¿Qué tipo de tubería es?' },
      access: { label: '¿Cómo llegamos hasta usted?', placeholder: 'ej. "Código del portón 4471, estacionar en la entrada, tocar el timbre dos veces"' },
      cutting: { label: '¿Podemos abrir paredes o pisos si la reparación lo requiere?' },
      pets: { label: '¿Hay mascotas que debamos saber?' },
      preference: { label: '¿Reparar o reemplazar?' },
      leak_detection: { label: '¿Ya se localizó la fuga?' },
    },
    options: {
      pipe: { Copper: 'Cobre', PEX: 'PEX', PVC: 'PVC', CPVC: 'CPVC', Galvanized: 'Galvanizada', 'Not sure': 'No estoy seguro' },
      cutting: {
        'Yes, go ahead if needed': 'Sí, adelante si es necesario',
        'No — call me first': 'No — llámeme primero',
        'Not sure / depends': 'No estoy seguro / depende',
      },
      pets: {
        'No pets': 'No hay mascotas',
        'Yes — will be secured before you arrive': 'Sí — estará asegurada antes de que lleguen',
        'Yes — friendly, may be loose': 'Sí — es amigable, puede estar suelta',
        'Yes — not friendly, please use caution': 'Sí — no es amigable, tenga precaución',
      },
      preference: {
        'Repair if possible': 'Reparar si es posible',
        'Replace it': 'Reemplazarlo',
        'Whatever you recommend': 'Lo que usted recomiende',
        'Not applicable': 'No aplica',
      },
      leak_detection: {
        'Leak detection already done': 'Detección de fuga ya realizada',
        'Not done yet': 'Aún no se ha hecho',
        'Not applicable — leak is visible': 'No aplica — la fuga es visible',
      },
    },
    media: {
      tapToAdd: 'Toque para agregar fotos o video',
      maxFiles: (n) => `Máximo ${n} archivos adjuntos`,
      remove: (name) => `Eliminar ${name}`,
      errorMaxFiles: (n) => `Puede adjuntar hasta ${n} archivos.`,
      errorTooLarge: (name, size) => `${name} es demasiado grande (máx. ${size})`,
      errorOnlyNMore: (n, max) => `Solo se puede${n === 1 ? '' : 'n'} agregar ${n} archivo${n === 1 ? '' : 's'} más (máx. ${max} en total)`,
    },
    result: {
      readyForDispatch: 'RESUMEN DEL TRABAJO — LISTO PARA DESPACHO',
      willReachOutPrefix: 'Nos pondremos en contacto con',
      you: 'usted',
      at: 'al',
      attachments: (n) => `${n} archivo${n !== 1 ? 's' : ''} adjunto${n !== 1 ? 's' : ''}`,
      summary: 'Resumen',
      likelyMaterials: 'Materiales probablemente necesarios',
      watchOut: 'Tener en cuenta',
      attachmentsLabel: 'Archivos adjuntos',
      rawAnswers: 'Respuestas del cliente',
      submitAnother: 'Enviar otra solicitud',
      loadingDefault: 'Revisando la solicitud...',
      loadingUploading: 'Subiendo fotos...',
      urgencyLabel: (level) => {
        const map = { High: 'alta', Medium: 'media', Low: 'baja' };
        return `Urgencia ${map[level] || map.Medium}`;
      },
      urgencyLevels: { High: 'Alta', Medium: 'Media', Low: 'Baja' },
    },
  },
};

export default function ScopeIntake() {
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem(LANG_STORAGE_KEY) === 'es' ? 'es' : 'en';
    } catch {
      return 'en';
    }
  });
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [media, setMedia] = useState([]);
  const [mediaError, setMediaError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [aiBrief, setAiBrief] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(null);
  const fileInputRef = useRef(null);
  const headingRef = useRef(null);

  const t = STRINGS[lang];
  const page = PAGES[step];
  const pageCopy = t.pages[step];
  const progress = ((step + 1) / TOTAL) * 100;

  useEffect(() => {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      // Storage can be unavailable (private browsing, etc.) -- not worth
      // failing the form over, the toggle still works for the session.
    }
    document.documentElement.lang = lang;
  }, [lang]);

  // Move focus to the new page's heading whenever the step changes. Sighted
  // users see the page swap via the fade-in animation, but screen reader
  // users get no equivalent signal unless focus actually moves -- without
  // this, someone using a screen reader would hit "Next" and hear nothing
  // change, with no idea the form advanced.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const setAnswer = (fieldId, val) => setAnswers((a) => ({ ...a, [fieldId]: val }));

  // Only fields explicitly marked `required` block progress. Right now
  // that's just the first question (context) -- everything else can be
  // left blank.
  const canAdvance = () => page.fields.every((f) => {
    if (!f.required) return true;
    const v = answers[f.id];
    return v !== undefined && v !== '';
  });

  const next = () => {
    if (step < TOTAL - 1) setStep(step + 1);
    else handleSubmit();
  };
  const back = () => { if (step > 0) setStep(step - 1); };

  const handleFile = (e) => {
    const files = Array.from(e.target.files || []);
    // Reset the input value so picking the exact same file again later
    // (e.g. after removing it) still fires onChange.
    e.target.value = '';
    if (files.length === 0) return;

    setMediaError('');
    setMedia((m) => {
      const room = MAX_MEDIA_FILES - m.length;
      if (room <= 0) {
        setMediaError(t.media.errorMaxFiles(MAX_MEDIA_FILES));
        return m;
      }
      const accepted = [];
      const rejected = [];
      for (const f of files.slice(0, room)) {
        const isVideo = f.type.startsWith('video');
        const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (f.size > limit) {
          rejected.push(t.media.errorTooLarge(f.name, isVideo ? '50MB' : '10MB'));
          continue;
        }
        accepted.push({
          name: f.name,
          type: isVideo ? 'video' : 'image',
          url: URL.createObjectURL(f),
          file: f, // kept so handleSubmit can upload the actual bytes
        });
      }
      if (files.length > room) {
        rejected.push(t.media.errorOnlyNMore(room, MAX_MEDIA_FILES));
      }
      if (rejected.length > 0) setMediaError(rejected.join('. '));
      return [...m, ...accepted];
    });
  };

  const removeMedia = (idx) => setMedia((m) => {
    const target = m[idx];
    if (target?.url) URL.revokeObjectURL(target.url);
    return m.filter((_, i) => i !== idx);
  });

  const handleSubmit = async () => {
    setSubmitted(true);
    setLoading(true);
    setLoadingMessage(t.result.loadingDefault);
    try {
      const subdomain = getCompanySubdomain();
      // Contact fields (name/phone/email) are excluded here on purpose --
      // the AI's job is to summarize the plumbing problem, not to handle
      // customer PII. They're stored directly via submit_public_job()
      // below and never sent to Anthropic.
      //
      // Field labels here are always English (STRINGS.en), regardless of
      // which language the customer used to fill out the form -- this text
      // is only ever read by the AI model / logged for us, never shown to
      // the customer, and choice-field VALUES are already canonical
      // English (see PAGES optionValues above). Free-text answers (context,
      // access, fixture) may still be in Spanish, which the model handles
      // natively -- the job brief it returns is instructed to always come
      // back in English regardless.
      const summary = PAGES.flatMap((p) => p.fields)
        .filter((f) => f.type !== 'media' && !f.excludeFromAiSummary)
        .map((f) => `${STRINGS.en.fields[f.id]?.label || f.id}: ${answers[f.id] || 'Not provided'}`)
        .join('\n');

      const response = await fetch('/api/review-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary,
          mediaCount: media.length,
          mediaTypes: media.map((m) => m.type).join(', ') || 'none',
          subdomain,
        }),
      });
      const parsed = await response.json();
      if (parsed.error) throw new Error(parsed.error);
      setAiBrief(parsed);

      // Save the full job (customer answers + AI brief) to the database.
      // If this fails, we don't block the customer — they've done their part.
      //
      // This goes through the submit_public_job() RPC instead of a raw
      // insert. The RPC resolves the company from the subdomain on the
      // SERVER, so the browser can never spoof a different company's id
      // by tampering with the request — it only ever sends the subdomain
      // string, which is public info anyway (it's already in the URL).
      try {
        const { data: job, error: rpcError } = await supabase.rpc('submit_public_job', {
          p_subdomain: subdomain,
          p_customer_name: answers.customer_name || null,
          p_customer_phone: answers.customer_phone || null,
          p_customer_email: answers.customer_email || null,
          p_context: answers.context || null,
          p_fixture: answers.fixture || null,
          p_pipe: answers.pipe || null,
          p_access: answers.access || null,
          p_cutting: answers.cutting || null,
          p_preference: answers.preference || null,
          p_leak_detection: answers.leak_detection || null,
          p_pets: answers.pets || null,
          p_ai_job_type: parsed.jobType || null,
          p_ai_urgency: parsed.urgency || null,
          p_ai_materials: parsed.likelyMaterials || [],
          p_ai_summary: parsed.briefSummary || null,
          p_ai_watch_out: parsed.watchOutFor || null,
        });
        if (rpcError) throw rpcError;

        // Upload attached photos/video now that we have a real job id to
        // scope the Storage path to. This happens AFTER the job row
        // exists (not before) because the Storage upload policy only
        // allows writes into a path prefixed with an id that's already
        // in the jobs table -- see supabase_add_media_storage.sql.
        if (job?.id && media.length > 0) {
          setLoadingMessage(t.result.loadingUploading);
          const uploaded = [];
          for (const m of media) {
            if (!m.file) continue;
            const path = `${job.id}/${crypto.randomUUID()}-${sanitizeFilename(m.name)}`;
            const { error: uploadErr } = await supabase.storage
              .from('job-media')
              .upload(path, m.file, { contentType: m.file.type, upsert: false });
            if (uploadErr) {
              console.error('Could not upload media file:', m.name, uploadErr);
              continue;
            }
            uploaded.push({ path, type: m.type, name: m.name, size: m.file.size });
          }
          if (uploaded.length > 0) {
            const { error: attachErr } = await supabase.rpc('attach_job_media', {
              p_job_id: job.id,
              p_subdomain: subdomain,
              p_media: uploaded,
            });
            if (attachErr) console.error('Could not attach media to job:', attachErr);
          }
        }
      } catch (dbErr) {
        // Saving failed silently for the customer; logged for us.
        console.error('Could not save job to database:', dbErr);
      }
    } catch (err) {
      setAiBrief({
        jobType: 'Unable to generate brief',
        urgency: 'Unknown',
        likelyMaterials: [],
        briefSummary: 'Something went wrong generating the AI summary. The raw answers below are still complete and usable.',
        watchOutFor: '—',
      });
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <ResultScreen
        lang={lang}
        setLang={setLang}
        loading={loading}
        loadingMessage={loadingMessage || t.result.loadingDefault}
        brief={aiBrief}
        answers={answers}
        media={media}
        onReset={() => {
          setSubmitted(false); setStep(0); setAnswers({}); setMedia([]); setMediaError(''); setAiBrief(null);
          setLoadingMessage(null);
        }}
      />
    );
  }

  return (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3' }} className="min-h-screen flex flex-col font-sans">
      {/* Header */}
      <header style={{ borderBottom: '1px solid #2A2A2A' }} className="flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-lg font-bold tracking-[0.15em]">SCOPWELL</span>
        </div>
        <div className="flex items-center gap-3">
          <span style={{ color: '#7A7A7A' }} className="text-xs tracking-wide hidden sm:inline">{t.tagline}</span>
          <button
            type="button"
            onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
            aria-label={t.langToggleAria}
            style={{ border: '1px solid #454545', color: '#D8D8D8', backgroundColor: '#161616' }}
            className="text-xs font-semibold px-3 py-1.5 rounded-full transition-colors focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
          >
            {t.langToggleLabel}
          </button>
        </div>
      </header>

      {/* Progress conduit */}
      <div
        role="progressbar"
        aria-label="Form progress"
        aria-valuenow={step + 1}
        aria-valuemin={1}
        aria-valuemax={TOTAL}
        aria-valuetext={t.progressAria(step + 1, TOTAL)}
        style={{ height: 2, backgroundColor: '#1E1E1E', position: 'relative' }}
      >
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
            {t.pageLabel(step + 1, TOTAL)}
          </div>

          <div className="flex items-start gap-3 mb-1">
            <page.icon size={24} style={{ color: '#E8BD3A' }} className="mt-1 shrink-0" aria-hidden="true" strokeWidth={2} />
            <h1
              ref={headingRef}
              tabIndex={-1}
              style={{ color: '#FFFFFF', fontFamily: 'Oswald, sans-serif' }}
              className="text-[28px] leading-tight font-bold outline-none"
            >
              {pageCopy.title}
            </h1>
          </div>
          <p style={{ color: '#C4C4C4' }} className="text-[15px] mb-6 ml-[36px]">{pageCopy.sub}</p>

          <div className="ml-[36px] space-y-7">
            {page.fields.map((field) => {
              const fieldCopy = t.fields[field.id] || {};
              return (
              <div key={field.id}>
                <div className="flex items-center gap-2 mb-2.5">
                  {field.icon && <field.icon size={16} style={{ color: '#9A9A9A' }} aria-hidden="true" />}
                  <label
                    id={`${field.id}-label`}
                    htmlFor={field.type === 'textarea' || field.type === 'text' ? field.id : undefined}
                    style={{ color: '#D8D8D8' }}
                    className="text-[15px] font-semibold"
                  >
                    {fieldCopy.label}
                    {field.required && <span aria-hidden="true"> *</span>}
                  </label>
                </div>

                {field.type === 'textarea' && (
                  <textarea
                    id={field.id}
                    name={field.id}
                    value={answers[field.id] || ''}
                    onChange={(e) => setAnswer(field.id, e.target.value)}
                    placeholder={fieldCopy.placeholder}
                    rows={3}
                    required={!!field.required}
                    aria-required={!!field.required}
                    style={{ color: '#111111', backgroundColor: '#F4F1E8', caretColor: '#111111', border: '2px solid #454545' }}
                    className="w-full rounded-lg px-4 py-3.5 placeholder-[#6A6A6A] outline-none transition-colors resize-none text-base shadow-inner focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
                  />
                )}

                {field.type === 'text' && (
                  <input
                    id={field.id}
                    name={field.id}
                    type={field.inputType || 'text'}
                    autoComplete={field.autoComplete}
                    required={!!field.required}
                    aria-required={!!field.required}
                    value={answers[field.id] || ''}
                    onChange={(e) => setAnswer(field.id, e.target.value)}
                    placeholder={fieldCopy.placeholder}
                    style={{ color: '#111111', backgroundColor: '#F4F1E8', caretColor: '#111111', border: '2px solid #454545' }}
                    className="w-full rounded-lg px-4 py-3.5 placeholder-[#6A6A6A] outline-none transition-colors text-base shadow-inner focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
                  />
                )}

                {field.type === 'choice' && (
                  <div role="radiogroup" aria-labelledby={`${field.id}-label`} className="flex flex-col gap-2">
                    {field.optionValues.map((value) => {
                      const isSelected = answers[field.id] === value;
                      const optionLabel = t.options[field.id]?.[value] || value;
                      return (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          onClick={() => setAnswer(field.id, value)}
                          style={{
                            backgroundColor: isSelected ? '#26200A' : '#1C1C1C',
                            border: `2px solid ${isSelected ? '#E8BD3A' : '#454545'}`,
                            color: isSelected ? '#FFFFFF' : '#E0E0E0',
                          }}
                          className="text-left px-4 py-3.5 rounded-lg transition-all text-base focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
                        >
                          <span className="flex items-center justify-between">
                            {optionLabel}
                            {isSelected && <Check size={18} style={{ color: '#E8BD3A' }} aria-hidden="true" />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {field.type === 'media' && (
                  <div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*,video/*"
                      multiple
                      capture="environment"
                      onChange={handleFile}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={media.length >= MAX_MEDIA_FILES}
                      style={{
                        backgroundColor: '#161616',
                        border: '2px dashed #5A5A5A',
                        opacity: media.length >= MAX_MEDIA_FILES ? 0.5 : 1,
                        cursor: media.length >= MAX_MEDIA_FILES ? 'not-allowed' : 'pointer',
                      }}
                      className="w-full rounded-lg py-6 flex flex-col items-center gap-2 transition-colors group focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
                    >
                      <div style={{ color: '#E8BD3A' }} className="flex gap-3" aria-hidden="true">
                        <Camera size={24} strokeWidth={1.75} />
                        <Video size={24} strokeWidth={1.75} />
                      </div>
                      <span style={{ color: '#D0D0D0' }} className="text-[15px] font-medium">
                        {media.length >= MAX_MEDIA_FILES ? t.media.maxFiles(MAX_MEDIA_FILES) : t.media.tapToAdd}
                      </span>
                    </button>

                    {mediaError && (
                      <p role="alert" style={{ color: '#E27878' }} className="text-sm mt-2">
                        {mediaError}
                      </p>
                    )}

                    {media.length > 0 && (
                      <div className="grid grid-cols-3 gap-2 mt-4">
                        {media.map((m, i) => (
                          <div key={i} style={{ backgroundColor: '#1A1A1A', border: '1px solid #2E2E2E', position: 'relative' }} className="aspect-square rounded-md overflow-hidden">
                            {m.type === 'image' ? (
                              <img src={m.url} alt={`${i + 1}: ${m.name}`} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Video size={20} style={{ color: '#C9A227' }} aria-hidden="true" />
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => removeMedia(i)}
                              aria-label={t.media.remove(m.name)}
                              style={{ position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.7)' }}
                              className="rounded-full p-1 focus:ring-2 focus:ring-[#E8BD3A]"
                            >
                              <X size={12} style={{ color: '#FFFFFF' }} aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </div>
      </main>

      {/* Nav */}
      <footer style={{ borderTop: '1px solid #1E1E1E' }} className="px-6 py-5 flex items-center justify-between">
        <button
          type="button"
          onClick={back}
          disabled={step === 0}
          aria-label={t.backAria}
          style={{ color: step === 0 ? '#4A4A4A' : '#D0D0D0', cursor: step === 0 ? 'not-allowed' : 'pointer' }}
          className="flex items-center gap-1 text-[15px] font-medium px-4 py-2 rounded-md transition-colors focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
        >
          <ChevronLeft size={18} aria-hidden="true" /> {t.back}
        </button>

        <button
          type="button"
          onClick={next}
          disabled={!canAdvance()}
          aria-label={step === TOTAL - 1 ? t.submitAria : t.nextAria}
          style={{
            backgroundColor: canAdvance() ? '#E8BD3A' : '#222222',
            color: canAdvance() ? '#0A0A0A' : '#5A5A5A',
            cursor: canAdvance() ? 'pointer' : 'not-allowed',
          }}
          className="flex items-center gap-1.5 text-[15px] font-semibold px-5 py-3 rounded-md transition-all focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
        >
          {step === TOTAL - 1 ? t.submit : t.next}
          <ChevronRight size={18} aria-hidden="true" />
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

function ResultScreen({ lang, setLang, loading, loadingMessage, brief, answers, media, onReset }) {
  const resultHeadingRef = useRef(null);
  const t = STRINGS[lang];

  // Same reasoning as the intake pages: once the AI brief finishes loading,
  // the whole screen swaps from a spinner to the result. Move focus to the
  // result heading so screen reader users hear that it's ready instead of
  // silence.
  useEffect(() => {
    if (!loading) resultHeadingRef.current?.focus();
  }, [loading]);

  return (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }} className="font-sans">
      <header style={{ borderBottom: '1px solid #2A2A2A' }} className="flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-lg font-bold tracking-[0.15em]">SCOPWELL</span>
        </div>
        {setLang && (
          <button
            type="button"
            onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
            aria-label={t.langToggleAria}
            style={{ border: '1px solid #454545', color: '#D8D8D8', backgroundColor: '#161616' }}
            className="text-xs font-semibold px-3 py-1.5 rounded-full transition-colors focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
          >
            {t.langToggleLabel}
          </button>
        )}
      </header>

      <main className="max-w-md mx-auto px-6 py-10">
        {loading ? (
          <div role="status" className="flex flex-col items-center gap-4 py-20">
            <div style={{ border: '2px solid #2E2E2E', borderTopColor: '#C9A227' }} className="w-10 h-10 rounded-full animate-spin" aria-hidden="true" />
            <p style={{ color: '#9A9A9A' }} className="text-sm">{loadingMessage || t.result.loadingDefault}</p>
          </div>
        ) : (
          <>
            <div style={{ color: '#C9A227' }} className="text-xs tracking-[0.2em] mb-2 font-medium">{t.result.readyForDispatch}</div>
            <h1
              ref={resultHeadingRef}
              tabIndex={-1}
              style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }}
              className="text-2xl font-bold mb-2 outline-none"
            >
              {brief?.jobType}
            </h1>

            {(answers.customer_name || answers.customer_phone) && (
              <p style={{ color: '#9A9A9A' }} className="text-sm mb-6">
                {t.result.willReachOutPrefix} <span style={{ color: '#D8D8D8' }}>{answers.customer_name || t.result.you}</span>
                {answers.customer_phone ? <> {t.result.at} <span style={{ color: '#D8D8D8' }}>{answers.customer_phone}</span></> : null}.
              </p>
            )}

            <div className="flex items-center gap-2 mb-6">
              <UrgencyBadge level={brief?.urgency} t={t} />
              <span style={{ color: '#8A8A8A' }} className="text-xs">{t.result.attachments(media.length)}</span>
            </div>

            <Section label={t.result.summary}>
              <p style={{ color: '#D8D8D8' }} className="text-[15px] leading-relaxed">{brief?.briefSummary}</p>
            </Section>

            {brief?.likelyMaterials?.length > 0 && (
              <Section label={t.result.likelyMaterials}>
                <div className="flex flex-wrap gap-2">
                  {brief.likelyMaterials.map((m, i) => (
                    <span key={i} style={{ backgroundColor: '#1C1708', border: '1px solid #3A2F0E', color: '#D9B84A' }} className="text-xs px-3 py-1.5 rounded-full">
                      {m}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            <Section label={t.result.watchOut}>
              <p style={{ color: '#D8D8D8' }} className="text-[15px] leading-relaxed">{brief?.watchOutFor}</p>
            </Section>

            {media.length > 0 && (
              <Section label={t.result.attachmentsLabel}>
                <div className="grid grid-cols-3 gap-2">
                  {media.map((m, i) => (
                    <div key={i} style={{ backgroundColor: '#1A1A1A', border: '1px solid #2E2E2E' }} className="aspect-square rounded-md overflow-hidden">
                      {m.type === 'image' ? (
                        <img src={m.url} alt={`${i + 1}: ${m.name}`} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Video size={20} style={{ color: '#C9A227' }} aria-hidden="true" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section label={t.result.rawAnswers}>
              <div className="space-y-2">
                {Object.entries(answers).map(([k, v]) => {
                  const meta = FIELD_META[k];
                  const label = t.fields[k]?.label || k.replace('_', ' ');
                  const displayValue = meta?.type === 'choice' ? (t.options[k]?.[v] || v) : v;
                  return (
                    <div key={k} style={{ color: '#7A7A7A', borderBottom: '1px solid #1A1A1A' }} className="text-xs flex justify-between gap-3 pb-2">
                      <span>{label}</span>
                      <span style={{ color: '#B8B8B8' }} className="text-right">{displayValue}</span>
                    </div>
                  );
                })}
              </div>
            </Section>

            <button
              type="button"
              onClick={onReset}
              style={{ border: '1px solid #2E2E2E', color: '#C8C8C8', backgroundColor: 'transparent' }}
              className="w-full mt-4 py-3 rounded-md text-sm transition-colors focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
            >
              {t.result.submitAnother}
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
      <div style={{ color: '#8A8A8A' }} className="text-[11px] tracking-[0.15em] mb-2 font-medium">{label.toUpperCase()}</div>
      {children}
    </div>
  );
}

function UrgencyBadge({ level, t }) {
  const styles = {
    High: { backgroundColor: '#2A1212', color: '#E07A6E', border: '1px solid #4A1F1A' },
    Medium: { backgroundColor: '#241C0A', color: '#D9B84A', border: '1px solid #3A2F0E' },
    Low: { backgroundColor: '#142018', color: '#7DA888', border: '1px solid #1F3026' },
  };
  return (
    <span style={styles[level] || styles.Medium} className="text-xs px-3 py-1 rounded-full font-medium">
      {t.result.urgencyLabel(level)}
    </span>
  );
}
