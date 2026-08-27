import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function resolveDir() {
  const candidates = [
    process.env.DD_CODEC_DIR,
    join(__dirname, '../deps'),
    join(process.cwd(), 'deps'),
  ].filter(Boolean);
  for (const d of candidates) if (existsSync(join(d, 'codec.js')) && existsSync(join(d, 'recover.js'))) return resolve(d);
  throw new Error('codec.js/recover.js not found. Put them in ./deps or set DD_CODEC_DIR. Looked in:\n  ' + candidates.join('\n  '));
}

const DIR = resolveDir();
export const CODEC_DIR = DIR;
export const codec = require(join(DIR, 'codec.js'));
export const { recoverK } = require(join(DIR, 'recover.js'));
