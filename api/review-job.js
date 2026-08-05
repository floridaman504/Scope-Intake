// This file runs on Vercel's server, never in the customer's browser.
// Your API key stays private here and is never visible to anyone using the site.

import { createClient } from '@supabase/supabase-js';

// Vercel injects every configured env var into process.env regardless of
// the VITE_ prefix -- that prefix only controls what Vite inlines into
// the browser bundle. Reusing the same vars here avoids needing a
// second, redundant Supabase key just for this server function.
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

// The model sometimes returns hand tools/equipment alongside real
// materials even with the prompt instruction below (LLM output isn't
// 100% reliable), and a customer-facing brief telling a plumber to
// bring a "pipe cutter" reads as the dispatcher second-guessing their
// own toolkit. Filtered out defensively as a second layer, not just a
// prompt instruction.
const TOOL_DENYLIST = [
  'pipe cutter', 'wrench', 'pliers', 'torch', 'propane torch', 'screwdriver',
  'drill', 'saw', 'hacksaw', 'plunger', 'snake', 'auger', 'tape measure',
  'level', 'flashlight', 'headlamp', 'ladder', 'multimeter', 'soldering iron',
  'press tool', 'crimper', 'deburring tool', 'reamer', 'channel locks',
  'basin wrench', 'pipe wrench', 'adjustable wrench', 'hammer', 'chisel',
  'utility knife', 'shop vac', 'wet vac', 'inspection camera', 'sewer camera',
];

function filterTools(materials) {
  if (!Array.isArray(materials)) return [];
  return materials.filter((m) => {
    const lower = String(m).toLowerCase();
    return !TOOL_DENYLIST.some((tool) => lower.includes(tool));
  });
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { summary, mediaCount, mediaTypes, subdomain } = req.body;
    const ip = getClientIp(req);
    const resolvedSubdomain = subdomain || 'demo';

    // Guardrail check happens BEFORE the paid API call. If this request
    // would exceed a per-IP, per-company, or global daily spend limit,
    // we return 429 and never spend a cent on it.
    const { data: blockReason, error: guardErr } = await supabase.rpc('check_rate_limit', {
      p_subdomain: resolvedSubdomain,
      p_ip: ip,
    });
    if (guardErr) {
      // Don't let an infra hiccup in the guardrail check itself block
      // real customers -- log it and fail open.
      console.error('Rate limit check failed:', guardErr);
    } else if (blockReason) {
      return res.status(429).json({
        error: 'Too many requests right now. Please try again in a few minutes.',
      });
    }

    const prompt = `You are an experienced plumbing dispatcher reviewing a customer's job intake submission. Based on the following information, produce a CONCISE job brief for the plumber who will be dispatched. The customer's own answers below may be written in English or Spanish (the intake form supports both) -- regardless of which language they used, ALWAYS write your JSON response in English, since it's read by the dispatcher/plumber, not the customer. Respond ONLY in JSON, no markdown, no preamble, with this exact shape:
{
  "jobType": "short label for the type of job",
  "urgency": "Low | Medium | High",
  "likelyMaterials": ["item1", "item2"],
  "briefSummary": "2-3 sentence summary a plumber can read in 10 seconds before a job",
  "watchOutFor": "one sentence on the biggest risk or thing to double check on site"
}

IMPORTANT for "likelyMaterials": list ONLY physical parts, fixtures, or supplies the plumber would need to bring or install for this specific job (e.g. wax ring, PEX fitting, shut-off valve, supply line, P-trap, flange). Do NOT list hand tools or equipment (e.g. pipe cutter, wrench, torch, plunger, snake, tape measure) -- every plumber already owns their own tools and chooses which ones to bring themselves. If you're unsure whether something is a tool or a material, leave it out.

Customer submission:
${summary}
Media attached: ${mediaCount} file(s) (${mediaTypes})`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    // Log actual token usage for cost tracking. Awaited (not
    // fire-and-forget) so it can't get dropped if the function
    // terminates right after the response is sent.
    if (data.usage) {
      const { error: logErr } = await supabase.rpc('log_ai_usage', {
        p_subdomain: resolvedSubdomain,
        p_ip: ip,
        p_input_tokens: data.usage.input_tokens || 0,
        p_output_tokens: data.usage.output_tokens || 0,
      });
      if (logErr) console.error('Failed to log AI usage:', logErr);
    }

    const text = data.content.map((b) => b.text || '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    parsed.likelyMaterials = filterTools(parsed.likelyMaterials);

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
