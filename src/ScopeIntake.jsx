import React, { useState, useRef } from 'react';
import { Camera, Video, MapPin, Lock, Wrench, Droplet, ChevronRight, ChevronLeft, Check, X, Upload } from 'lucide-react';
import { supabase } from './supabaseClient.js';

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
    id: 'media',
    icon: Camera,
    title: 'Show us the issue',
    sub: 'A photo or short video of the problem area — and any damage it caused.',
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
    sub: 'Gate, door, elevator, or key codes — and where we should park.',
    type: 'textarea',
    placeholder: 'e.g. "Gate code 4471, park in driveway, ring bell twice"',
  },
  {
    id: 'cutting',
    icon: Wrench,
    title: 'Can we cut into walls or floors?',
    sub: "If the fix requires it, do we have your OK in advance?",
    type: 'choice',
    options: ['Yes, go ahead if needed', 'No — call me first', 'Not sure / depends'],
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
    sub: 'Only relevant if this is a hidden leak — e.g. a rising water meter with no visible water.',
    type: 'choice',
    options: ['Leak detection already done', 'Not done yet', 'Not applicable — leak is visible'],
  },
];

const TOTAL = STEPS.length;

export default function ScopeIntake() {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [media, setMedia] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const [aiBrief, setAiBrief] = useState(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);

  const current = STEPS[step];
  const progress = ((step + 1) / TOTAL) * 100;

  const setAnswer = (val) => setAnswers((a) => ({ ...a, [current.id]: val }));

  const canAdvance = () => {
    if (current.type === 'media') return true; // optional but encouraged
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
    const mapped = files.map((f) => ({
      name: f.name,
      type: f.type.startsWith('video') ? 'video' : 'image',
      url: URL.createObjectURL(f),
    }));
    setMedia((m) => [...m, ...mapped]);
  };

  const removeMedia = (idx) => setMedia((m) => m.filter((_, i) => i !== idx));

  const handleSubmit = async () => {
    setSubmitted(true);
    setLoading(true);
    try {
      const summary = STEPS.map((s) => `${s.title}: ${answers[s.id] || 'Not provided'}`).join('\n');

      const response = await fetch('/api/review-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary,
          mediaCount: media.length,
          mediaTypes: media.map((m) => m.type).join(', ') || 'none',
        }),
      });
      const parsed = await response.json();
      if (parsed.error) throw new Error(parsed.error);
      setAiBrief(parsed);

      // Save the full job (customer answers + AI brief) to the database.
      // If this fails, we don't block the customer — they've done their part.
      try {
        await supabase.from('jobs').insert({
          context: answers.context || null,
          fixture: answers.fixture || null,
          pipe: answers.pipe || null,
          access: answers.access || null,
          cutting: answers.cutting || null,
          preference: answers.preference || null,
          leak_detection: answers.leak_detection || null,
          ai_job_type: parsed.jobType || null,
          ai_urgency: parsed.urgency || null,
          ai_materials: parsed.likelyMaterials || [],
          ai_summary: parsed.briefSummary || null,
          ai_watch_out: parsed.watchOutFor || null,
          status: 'new',
        });
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
    return <ResultScreen loading={loading} brief={aiBrief} answers={answers} media={media} onReset={() => {
      setSubmitted(false); setStep(0); setAnswers({}); setMedia([]); setAiBrief(null);
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
                style={{ color: '#111111', backgroundColor: '#F4F1E8', caretColor: '#111111', border: '2px solid #454545' }}
                className="w-full rounded-lg px-4 py-3.5 placeholder-[#6A6A6A] outline-none transition-colors resize-none text-base shadow-inner"
              />
            )}

            {current.type === 'text' && (
              <input
                autoFocus
                type="text"
                value={answers[current.id] || ''}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={current.placeholder}
                style={{ color: '#111111', backgroundColor: '#F4F1E8', caretColor: '#111111', border: '2px solid #454545' }}
                className="w-full rounded-lg px-4 py-3.5 placeholder-[#6A6A6A] outline-none transition-colors text-base shadow-inner"
              />
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
                          <img src={m.url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Video size={20} style={{ color: '#C9A227' }} />
                          </div>
                        )}
                        <button
                          onClick={() => removeMedia(i)}
                          style={{ position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.7)' }}
                          className="rounded-full p-1"
                        >
                          <X size={12} style={{ color: '#FFFFFF' }} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <p style={{ color: '#6A6A6A' }} className="text-xs mt-3">Optional, but the plumber will thank you.</p>
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

function ResultScreen({ loading, brief, answers, media, onReset }) {
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
            <p style={{ color: '#9A9A9A' }} className="text-sm">Reviewing the job submission...</p>
          </div>
        ) : (
          <>
            <div style={{ color: '#C9A227' }} className="text-xs tracking-[0.2em] mb-2 font-medium">JOB BRIEF — READY FOR DISPATCH</div>
            <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-6">{brief?.jobType}</h1>

            <div className="flex items-center gap-2 mb-6">
              <UrgencyBadge level={brief?.urgency} />
              <span style={{ color: '#6A6A6A' }} className="text-xs">{media.length} attachment{media.length !== 1 ? 's' : ''}</span>
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

            {media.length > 0 && (
              <Section label="Attachments">
                <div className="grid grid-cols-3 gap-2">
                  {media.map((m, i) => (
                    <div key={i} style={{ backgroundColor: '#1A1A1A', border: '1px solid #2E2E2E' }} className="aspect-square rounded-md overflow-hidden">
                      {m.type === 'image' ? (
                        <img src={m.url} alt="" className="w-full h-full object-cover" />
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
                {Object.entries(answers).map(([k, v]) => (
                  <div key={k} style={{ color: '#7A7A7A', borderBottom: '1px solid #1A1A1A' }} className="text-xs flex justify-between gap-3 pb-2">
                    <span className="capitalize">{k.replace('_', ' ')}</span>
                    <span style={{ color: '#B8B8B8' }} className="text-right">{v}</span>
                  </div>
                ))}
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
      <div style={{ color: '#6A6A6A' }} className="text-[11px] tracking-[0.15em] mb-2 font-medium">{label.toUpperCase()}</div>
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
