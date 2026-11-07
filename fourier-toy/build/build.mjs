#!/usr/bin/env node
// Turns source.html into ../index.html, a single file that runs with no network:
//  - the Tailwind Play CDN <script> is replaced by the same Tailwind v3 CSS,
//    pre-built for exactly the classes the page uses;
//  - the Google Fonts <link> is replaced by Inter (weights 300-700, Latin)
//    embedded as base64 WOFF2.
// Nothing else in the page changes.  Usage: npm install && npm run build
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'source.html'), 'utf8');

const CDN = [
  '    <!-- Tailwind CSS CDN -->\n',
  '    <script src="https://cdn.tailwindcss.com"></script>\n',
  '    <!-- Google Fonts Inter -->\n',
  '    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">\n',
].join('');
if (!src.includes(CDN)) throw new Error('source.html: CDN block not found');

// 1. Tailwind: same default v3 config the Play CDN uses, content = this page.
const tmp = mkdtempSync(join(tmpdir(), 'fourier-tw-'));
const input = join(tmp, 'in.css');
writeFileSync(input, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
const tailwind = execFileSync(
  join(here, 'node_modules', '.bin', 'tailwindcss'),
  ['-i', input, '--content', join(here, 'source.html'), '--minify'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
).trim();
rmSync(tmp, { recursive: true, force: true });

// 2. Inter, the five weights the Google Fonts URL asked for.
const fontDir = join(here, 'node_modules', '@fontsource', 'inter', 'files');
const fonts = [300, 400, 500, 600, 700].map((w) => {
  const b64 = readFileSync(join(fontDir, `inter-latin-${w}-normal.woff2`)).toString('base64');
  return `@font-face{font-family:'Inter';font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
}).join('\n');

const offline = [
  '    <!-- Tailwind CSS (pre-built and inlined for offline use) -->\n',
  `    <style>${tailwind}</style>\n`,
  '    <!-- Inter font (embedded for offline use) -->\n',
  `    <style>\n${fonts}\n    </style>\n`,
].join('');

const out = src.replace(CDN, offline);
const external = out.match(/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\/[^"'\s>]+/gi);
if (external) throw new Error('external resources left: ' + external.join(', '));
writeFileSync(join(here, '..', 'index.html'), out);
console.log(`wrote fourier-toy/index.html (${(out.length / 1024).toFixed(0)} KB, Tailwind ${(tailwind.length / 1024).toFixed(1)} KB)`);
