import fs from 'fs/promises';
import path from 'path';

const dir = path.join(process.cwd(), 'baileys_auth');
await fs.rm(dir, { recursive: true, force: true });
console.log('✅ Sessão local removida. Rode npm start para gerar um novo QR Code.');
