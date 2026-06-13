// Netlify Functions version of the Groq proxy. Keeps GROQ_API_KEY off the
// client; only authenticated Supabase users may call it. Mirrors api/groq.js.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers:    { 'Content-Type': 'application/json' },
      body:       JSON.stringify({ error: { message: 'Method not allowed' } })
    };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token      = authHeader.replace(/^Bearer\s+/i, '');
  if (!token || token === process.env.SUPABASE_ANON_KEY) {
    return {
      statusCode: 401,
      headers:    { 'Content-Type': 'application/json' },
      body:       JSON.stringify({ error: { message: 'Not authenticated' } })
    };
  }

  const verify = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey:        process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  if (!verify.ok) {
    return {
      statusCode: 401,
      headers:    { 'Content-Type': 'application/json' },
      body:       JSON.stringify({ error: { message: 'Not authenticated' } })
    };
  }

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      Authorization:   `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: event.body
  });

  const data = await groqRes.json().catch(() => ({}));
  return {
    statusCode: groqRes.status,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify(data)
  };
};
