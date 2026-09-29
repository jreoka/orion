#!/usr/bin/env node
'use strict';
// orion-browser — tiny headless-Chromium helper for the Orion agent VM.
//
//   orion-browser text <url>                 print readable page text to stdout
//   orion-browser shot <url> <out.png> [--full]   save a screenshot
//   orion-browser interact <script.json>      run a JSON action script, print results
//
// interact script: [{action, ...}] — actions:
//   {action:"goto", url}  {action:"click", selector}  {action:"fill", selector, text}
//   {action:"press", key}  {action:"wait", ms|selector}  {action:"scroll", y}
//   {action:"text"} → page text  {action:"shot", path} → screenshot
// Prints a JSON array of step results to stdout.
//
// Exit codes: 0 ok, 1 error, 3 blocked by the site's bot protection.
//
// Dependency-free: uses the `playwright` package baked into the sandbox image
// (NODE_PATH points at the global install).
const { chromium } = require('playwright');

// Present as an ordinary desktop Chrome. Stock headless Chromium advertises
// itself (HeadlessChrome UA, navigator.webdriver) and eats bot-protection
// blocks on a large share of the web. This is not challenge-solving: when a
// site still refuses, we detect it and exit 3 so the agent moves on to a
// different source instead of hammering a wall.
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Strong bot-wall markers. Title matches are near-certain; body matches are
// checked against the first 2k chars of rendered text (challenge pages are
// short and front-load this phrasing).
const BLOCKED_TITLE_RE = /just a moment|attention required|access denied|verify you are human|are you a robot/i;
const BLOCKED_BODY_RE =
  /verify you are (a )?human|prove you are (a )?human|are you a robot|confirm you are (a )?human|press (&|and) hold|access denied|request (has been )?blocked|reference #[0-9a-f-]{8,}/i;

// Thrown when a site's bot protection refuses us. Carries exit code 3 so
// the agent knows to try a different source instead of retrying.
class BlockedError extends Error {
  constructor(why) {
    super(`orion-browser: BLOCKED — ${why}`);
    this.exitCode = 3;
  }
}

// Interactive mode: run a JSON action script against a live page.
// Each step returns {ok, ...} — text/shot steps include their output.
async function interact(scriptPath) {
  const fs = require('fs');
  let steps;
  try {
    steps = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  } catch (e) {
    console.error('orion-browser: bad script JSON: ' + e.message);
    process.exit(2);
  }
  if (!Array.isArray(steps)) { console.error('orion-browser: script must be a JSON array'); process.exit(2); }

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  const results = [];
  try {
    const context = await browser.newContext({
      userAgent: DESKTOP_UA,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
    });
    const page = await context.newPage();
    const checkBlocked = async () => {
      let title = '';
      try { title = await page.title(); } catch {}
      if (BLOCKED_TITLE_RE.test(title)) throw new BlockedError(`challenge page: "${title.slice(0, 80)}"`);
    };

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {};
      try {
        switch (s.action) {
          case 'goto':
            await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1200);
            await checkBlocked();
            results.push({ ok: true, url: page.url(), title: await page.title() });
            break;
          case 'click':
            await page.click(s.selector, { timeout: 10000 });
            await page.waitForTimeout(800);
            results.push({ ok: true });
            break;
          case 'fill':
            await page.fill(s.selector, String(s.text ?? ''), { timeout: 10000 });
            results.push({ ok: true });
            break;
          case 'press':
            await page.keyboard.press(String(s.key || 'Enter'));
            await page.waitForTimeout(800);
            results.push({ ok: true });
            break;
          case 'wait':
            if (typeof s.ms === 'number') await page.waitForTimeout(Math.min(s.ms, 15000));
            else if (s.selector) await page.waitForSelector(s.selector, { timeout: 15000 });
            results.push({ ok: true });
            break;
          case 'scroll':
            await page.evaluate((y) => window.scrollBy(0, y || 600), s.y);
            await page.waitForTimeout(500);
            results.push({ ok: true });
            break;
          case 'text': {
            const t = await page.evaluate(() => (document.body ? document.body.innerText : ''));
            results.push({ ok: true, text: String(t || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 15000) });
            break;
          }
          case 'shot':
            await page.screenshot({ path: s.path, fullPage: !!s.full });
            results.push({ ok: true, path: s.path });
            break;
          case 'url':
            results.push({ ok: true, url: page.url(), title: await page.title() });
            break;
          default:
            results.push({ ok: false, error: `unknown action: ${s.action}` });
        }
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        results.push({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
      }
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(JSON.stringify(results, null, 1));
}

async function main() {
  const [, , cmd, url, outPath] = process.argv;
  if (cmd === 'interact') return interact(url); // url = script.json path
  if (!cmd || !url || !['text', 'shot'].includes(cmd) || (cmd === 'shot' && !outPath)) {
    console.error('usage: orion-browser text <url> | orion-browser shot <url> <out.png> [--full] | orion-browser interact <script.json>');
    process.exit(2);
  }

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const blocked = (why) => {
    throw new BlockedError(`${host} refused automated access (${why})`);
  };

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({
      userAgent: DESKTOP_UA,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
    });
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give client-rendered pages a moment to settle.
    await page.waitForTimeout(1500);

    // Bot-protection block? Say so plainly instead of screenshotting an
    // "Access Denied" page the agent can't use.
    const status = resp ? resp.status() : 0;
    if (status === 403 || status === 429) blocked(`HTTP ${status}`);
    let title = '';
    let bodyStart = '';
    try {
      title = await page.title();
      bodyStart = String(await page.evaluate(() => (document.body ? document.body.innerText : ''))).slice(0, 2000);
    } catch {
      /* page navigated away mid-probe */
    }
    if (BLOCKED_TITLE_RE.test(title)) blocked(`challenge page: "${title.slice(0, 80)}"`);
    if (BLOCKED_BODY_RE.test(bodyStart)) blocked('bot-protection challenge');

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
  process.exit(e && e.exitCode === 3 ? 3 : 1);
});
