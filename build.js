// Generates config.js from environment variables (run by Vercel at build time).
const fs = require('fs');

const config = `const CONFIG = {
  GROQ_API_KEY:     '',
  GROQ_MODEL:       '${process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'}',
  STORAGE_KEY:      'vtm_tasks',
  SUPABASE_URL:     '${process.env.SUPABASE_URL || ''}',
  SUPABASE_ANON_KEY:'${process.env.SUPABASE_ANON_KEY || ''}',
  VAPID_PUBLIC_KEY: '${process.env.VAPID_PUBLIC_KEY || ''}',
  APP_URL: '${process.env.APP_URL || 'http://localhost:3000/'}'
};
`;

fs.writeFileSync('config.js', config);
console.log('config.js generated');
