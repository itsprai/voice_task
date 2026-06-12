// Server-side Groq proxy — keeps GROQ_API_KEY out of the browser.
// Only authenticated Supabase users may call it.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || token === process.env.SUPABASE_ANON_KEY) {
    return res.status(401).json({ error: { message: 'Not authenticated' } });
  }

  const verify = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  if (!verify.ok) {
    return res.status(401).json({ error: { message: 'Not authenticated' } });
  }

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify(req.body)
  });

  const data = await groqRes.json().catch(() => ({}));
  return res.status(groqRes.status).json(data);
}
