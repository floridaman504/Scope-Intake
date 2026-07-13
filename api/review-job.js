// This file runs on Vercel's server, never in the customer's browser.
// Your API key stays private here and is never visible to anyone using the site.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { summary, mediaCount, mediaTypes } = req.body;

    const prompt = `You are an experienced plumbing dispatcher reviewing a customer's job intake submission. Based on the following information, produce a CONCISE job brief for the plumber who will be dispatched. Respond ONLY in JSON, no markdown, no preamble, with this exact shape:
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

    const text = data.content.map((b) => b.text || '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
