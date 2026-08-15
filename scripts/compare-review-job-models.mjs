#!/usr/bin/env node
// One-off comparison tool: is Claude Sonnet overkill for api/review-job.js?
//
// api/review-job.js takes a customer's plain-English job description and
// turns it into a structured plumber brief (job type, urgency, likely
// materials, a short summary, one risk to watch for). That's a bounded
// classification/summarization task, not deep multi-step reasoning -- the
// kind of thing a cheaper model tier often handles just as well. This
// script sends the SAME set of realistic customer descriptions through
// both the current model (Sonnet) and a cheaper candidate (Haiku), using
// the exact same prompt api/review-job.js sends, so the two can be
// eyeballed side by side before anything in production changes.
//
// This is NOT wired into CI and never touches Supabase or any real
// customer data -- it's a manual, run-it-when-you-want-it diagnostic, not
// a gate. Nothing here changes production; api/review-job.js is untouched
// unless someone decides, after actually looking at this output, to edit
// its `model:` line by hand.
//
// Usage: ANTHROPIC_API_KEY=sk-ant-... node scripts/compare-review-job-models.mjs
//
// Cost note: this makes ~24 real API calls (12 cases x 2 models). At
// current pricing (Sonnet $2/$10 per million input/output tokens, Haiku
// $1/$5 -- see docs.claude.com/en/docs/about-claude/pricing) and this
// endpoint's typical prompt size, the whole run costs a few cents, not
// dollars. Well under the app's own $10/day guardrail.

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Missing ANTHROPIC_API_KEY. Get one at https://platform.claude.com/settings/keys and re-run:');
  console.error('  ANTHROPIC_API_KEY=sk-ant-... node scripts/compare-review-job-models.mjs');
  process.exit(1);
}

const MODELS = [
  { key: 'sonnet', id: 'claude-sonnet-5', inputPricePerM: 2.0, outputPricePerM: 10.0 },
  { key: 'haiku', id: 'claude-haiku-4-5', inputPricePerM: 1.0, outputPricePerM: 5.0 },
];

// Deliberately varied: a couple of easy/obvious cases, a couple of vague
// ones, a safety-critical one (gas smell), a health-hazard one (sewage),
// one with typos, one that's borderline not-a-plumbing-job -- the point is
// to see where a cheaper model might actually differ, not just confirm it
// agrees on the easy cases.
const TEST_CASES = [
  {
    label: 'Obvious emergency: burst pipe flooding',
    summary: "There's water shooting out from under my kitchen sink, the cabinet is flooding onto the floor, I already shut off the water but there's like an inch of water everywhere. Please help ASAP.",
    mediaCount: 2,
    mediaTypes: 'image/jpeg, image/jpeg',
  },
  {
    label: 'Low urgency: slow drip',
    summary: 'My bathroom faucet has a small drip, maybe once every few seconds. Not urgent, just annoying and wastes water. Whenever someone can come by is fine.',
    mediaCount: 0,
    mediaTypes: '',
  },
  {
    label: 'Medium urgency: water heater noise + reduced hot water',
    summary: "Our water heater has started making a popping/rumbling noise over the last week and we're not getting as much hot water as usual. It's a gas unit, about 8 years old.",
    mediaCount: 0,
    mediaTypes: '',
  },
  {
    label: 'Vague, minimal detail',
    summary: 'something is wrong with my sink it wont drain right',
    mediaCount: 0,
    mediaTypes: '',
  },
  {
    label: 'Multiple combined issues',
    summary: 'Our upstairs toilet runs constantly and keeps refilling on its own, and the bathroom sink drain is really slow too, been getting worse for like two weeks.',
    mediaCount: 1,
    mediaTypes: 'video/mp4',
  },
  {
    label: 'Safety-critical: gas smell',
    summary: 'I smell gas near my water heater in the garage, kind of a faint rotten egg smell. Not sure if its bad. House otherwise seems fine.',
    mediaCount: 0,
    mediaTypes: '',
  },
  {
    label: 'Health hazard: sewage backup',
    summary: 'Sewage is backing up into our downstairs bathtub every time we run the washing machine. Smells terrible, black water coming up. We have two small kids in the house.',
    mediaCount: 3,
    mediaTypes: 'image/jpeg, image/jpeg, image/png',
  },
  {
    label: 'Poor grammar / typos, otherwise simple',
    summary: 'my toilit wont stop running all day n night pls fix its costing me alot on water bill',
    mediaCount: 0,
    mediaTypes: '',
  },
  {
    label: 'Commercial context',
    summary: "I run a small restaurant and our grease trap is overflowing into the kitchen floor drain. We're closed until this is fixed and losing business. Health inspector visit is Friday.",
    mediaCount: 1,
    mediaTypes: 'image/jpeg',
  },
  {
    label: 'Photos-only, thin text description',
    summary: 'see photos, pipe under the house',
    mediaCount: 4,
    mediaTypes: 'image/jpeg, image/jpeg, image/jpeg, image/heic',
  },
  {
    label: 'Borderline: might not even be a plumbing job',
    summary: 'My garbage disposal makes a weird humming sound but nothing spins, and also my kitchen light has been flickering, wondering if those are related somehow.',
    mediaCount: 0,
    mediaTypes: '',
  },
  {
    label: 'Long, rambling, low signal-to-noise',
    summary: "So this has been going on for a while now, maybe like a month, and it's not super bad but it's definitely getting worse, my wife noticed it before I did honestly. Basically there's a spot under our kitchen sink where the cabinet floor feels a little soft/damp when I press on it, no standing water that I can see, but it smells a little musty under there. We haven't had any obvious leaks that we've noticed. Just wanted to get it looked at before it turns into a bigger problem I guess.",
    mediaCount: 0,
    mediaTypes: '',
  },
];

// Exact same prompt shape as api/review-job.js -- the whole point is an
// apples-to-apples comparison, not a differently-tuned prompt per model.
function buildPrompt({ summary, mediaCount, mediaTypes }) {
  return `You are an experienced plumbing dispatcher reviewing a customer's job intake submission. Based on the following information, produce a CONCISE job brief for the plumber who will be dispatched. Respond ONLY in JSON, no markdown, no preamble, with this exact shape:
{
  "jobType": "short label for the type of job",
  "urgency": "Low | Medium | High",
  "likelyMaterials": ["item1", "item2"],
  "briefSummary": "2-3 sentence summary a plumber can read in 10 seconds before a job",
  "watchOutFor": "one sentence on the biggest risk or thing to double check on site"
}

Customer submission:
${summary}
Media attached: ${mediaCount} file(s) (${mediaTypes})`;
}

async function callModel(modelId, prompt) {
  const started = Date.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const elapsedMs = Date.now() - started;
  const data = await response.json();

  if (data.error) {
    return { ok: false, error: data.error.message, elapsedMs };
  }

  const usage = data.usage || {};
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  const clean = text.replace(/```json|```/g, '').trim();

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    parseError = err.message;
  }

  return {
    ok: true,
    parsed,
    parseError,
    rawText: text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    elapsedMs,
  };
}

function cost(model, inputTokens, outputTokens) {
  return (inputTokens / 1_000_000) * model.inputPricePerM + (outputTokens / 1_000_000) * model.outputPricePerM;
}

async function main() {
  const totals = { sonnet: { cost: 0, parseFailures: 0 }, haiku: { cost: 0, parseFailures: 0 } };

  for (const testCase of TEST_CASES) {
    console.log('\n' + '='.repeat(80));
    console.log(testCase.label);
    console.log('-'.repeat(80));
    console.log(`Customer text: "${testCase.summary}"`);
    console.log(`Media: ${testCase.mediaCount} file(s) (${testCase.mediaTypes || 'none'})`);
    console.log('');

    const prompt = buildPrompt(testCase);

    for (const model of MODELS) {
      const result = await callModel(model.id, prompt);
      console.log(`--- ${model.key.toUpperCase()} (${model.id}) ---`);

      if (!result.ok) {
        console.log(`  ERROR: ${result.error}`);
        continue;
      }

      const c = cost(model, result.inputTokens, result.outputTokens);
      totals[model.key].cost += c;

      if (result.parseError) {
        totals[model.key].parseFailures += 1;
        console.log(`  JSON PARSE FAILED: ${result.parseError}`);
        console.log(`  Raw response: ${result.rawText}`);
      } else {
        console.log(`  jobType:        ${result.parsed.jobType}`);
        console.log(`  urgency:        ${result.parsed.urgency}`);
        console.log(`  likelyMaterials: ${JSON.stringify(result.parsed.likelyMaterials)}`);
        console.log(`  briefSummary:   ${result.parsed.briefSummary}`);
        console.log(`  watchOutFor:    ${result.parsed.watchOutFor}`);
      }
      console.log(`  (${result.inputTokens} in / ${result.outputTokens} out tokens, $${c.toFixed(5)}, ${result.elapsedMs}ms)`);
      console.log('');
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Sonnet: $${totals.sonnet.cost.toFixed(4)} total, ${totals.sonnet.parseFailures} JSON parse failure(s) out of ${TEST_CASES.length}`);
  console.log(`Haiku:  $${totals.haiku.cost.toFixed(4)} total, ${totals.haiku.parseFailures} JSON parse failure(s) out of ${TEST_CASES.length}`);
  console.log('');
  console.log('Now read back through the pairs above and judge by hand: does Haiku ever');
  console.log('get urgency wrong on something that matters (gas smell, sewage backup)?');
  console.log('Does it produce a noticeably worse briefSummary or miss obvious materials?');
  console.log('If the two look equivalent on the cases that matter, Haiku is a reasonable');
  console.log("swap. If Haiku is visibly worse on even one safety-relevant case (gas smell,");
  console.log('sewage), that alone is reason enough to stay on Sonnet regardless of cost.');
}

main().catch((err) => {
  console.error('Comparison script crashed:', err);
  process.exit(1);
});
