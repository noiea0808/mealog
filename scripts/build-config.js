const fs = require('fs');
const path = require('path');

const key = process.env.GEMINI_API_KEY || '';
const outPath = path.join(__dirname, '..', 'js', 'config.js');

const content = `// Gemini API 설정 - Vercel 빌드 시 주입
// API 키는 Vercel Environment Variables에서 가져옵니다.
export const GEMINI_API_KEY = '${key.replace(/'/g, "\\'")}';
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, content);
console.log('✅ js/config.js created from GEMINI_API_KEY');
