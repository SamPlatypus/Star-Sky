#!/usr/bin/env node
// Renders icons/icon.svg to the PNG sizes used by the manifest and iOS.
// Requires Playwright with Chromium: node tools/make-icons.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');

const targets = [
  { file: 'icon-192.png', size: 192, pad: 0 },
  { file: 'icon-512.png', size: 512, pad: 0 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0 },
  // Maskable icons need the artwork inside the central 80% safe zone.
  { file: 'maskable-512.png', size: 512, pad: 0.1 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  const inner = Math.round(t.size * (1 - 2 * t.pad));
  await page.setContent(`<html><body style="margin:0;background:#000;display:grid;place-items:center;width:${t.size}px;height:${t.size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  await page.screenshot({ path: join(dir, t.file), omitBackground: false });
  console.log(`wrote icons/${t.file}`);
}
await browser.close();
