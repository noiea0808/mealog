const fs = require('fs');
const path = require('path');

const geminiKey = process.env.GEMINI_API_KEY || '';
const googleWebClientId = process.env.GOOGLE_WEB_CLIENT_ID || '';
const outPath = path.join(__dirname, '..', 'js', 'config.js');

const content = `// API 설정 - 빌드 시 환경 변수에서 주입 (Vercel 등)
export const GEMINI_API_KEY = '${geminiKey.replace(/'/g, "\\'")}';
export const GOOGLE_WEB_CLIENT_ID = '${googleWebClientId.replace(/'/g, "\\'")}';
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, content);
console.log('✅ js/config.js created (GEMINI_API_KEY, GOOGLE_WEB_CLIENT_ID)');
