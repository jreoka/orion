#!/usr/bin/env node
'use strict';
// orion-browser — tiny headless-Chromium helper for the Orion agent VM.
//
//   orion-browser text <url>                 print readable page text to stdout
//   orion-browser shot <url> <out.png> [--full]   save a screenshot
//
// Dependency-free: uses the `playwright` package baked into the sandbox image
// (NODE_PATH points at the global install).
const { chromium } = require('playwright');

async function main() {
  const [, , cmd, url, outPath] = process.argv;
  if (!cmd || !url || !['text', 'shot'].includes(cmd) || (cmd === 'shot' && !outPath)) {
    console.error('usage: orion-browser text <url> | orion-browser shot <url> <out.png> [--full]');
    process.exit(2);
  }

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give client-rendered pages a moment to settle.
    await page.waitForTimeout(1500);

    if (cmd === 'text') {
      const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      const cleaned = String(text || '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 60000); // server truncates further to 15k
      process.stdout.write(cleaned);
    } else {
      const full = process.argv.includes('--full');
      await page.screenshot({ path: outPath, fullPage: full });
      console.log('saved ' + outPath);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('orion-browser: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
