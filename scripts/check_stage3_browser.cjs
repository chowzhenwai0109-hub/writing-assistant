// Real browser + real local API, an isolated temporary SQLite DB, always fake.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.join(root, '.tools/browser-check/node_modules/playwright'));
const origin = 'http://127.0.0.1:5173';
const children = [];
let browser;
let temporary;
let stopPromise;

async function freePort(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}
function start(command, arguments_, cwd) {
  const child = spawn(command, arguments_, { cwd, windowsHide: true, env: { ...process.env, LLM_MODE: 'fake', LLM_PROVIDER: 'gemini', GEMINI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.logs = '';
  child.once('error', error => { child.startError = error; });
  child.stdout.on('data', chunk => { child.logs = (child.logs + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { child.logs = (child.logs + chunk).slice(-4000); });
  children.push(child);
  return child;
}
async function ready(url) {
  for (let index = 0; index < 100; index++) {
    for (const child of children) { if (child.startError) throw child.startError; if (child.exitCode !== null) throw new Error(`Verification server exited: ${child.logs}`); }
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Verification server did not start: ${url}`);
}
function stop() {
  if (stopPromise) return stopPromise;
  stopPromise = stopResources();
  return stopPromise;
}
async function stopResources() {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    }
  }
  // Verify the resolved target before recursive removal on Windows too.
  if (temporary && path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('writing-stage3-')) fs.rmSync(temporary, { recursive: true, force: true });
}
process.once('SIGINT', () => { stop().finally(() => process.exit(130)); });
process.once('SIGTERM', () => { stop().finally(() => process.exit(143)); });

async function setup() {
  await freePort(8000); await freePort(5173);
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writing-stage3-'));
  const verificationId = randomUUID();
  const python = path.join(root, process.platform === 'win32' ? 'backend/.venv/Scripts/python.exe' : 'backend/.venv/bin/python');
  start(python, ['-c', 'import sys; from pathlib import Path; import uvicorn; from app.main import create_app; from app.db import create_db_engine; app=create_app(create_db_engine(Path(sys.argv[1]))); app.add_api_route("/api/verification/"+sys.argv[2], lambda: {"verification":"fake"}); uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")', path.join(temporary, 'app.db'), verificationId], path.join(root, 'backend'));
  start(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js')], path.join(root, 'frontend'));
  // A unique fixture-only route proves we reached this temporary backend,
  // even if another process races us for a checked port.
  await ready(`${origin}/api/verification/${verificationId}`);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  return { browser, origin, root };
}
module.exports = { setup, stop };
if (require.main === module) (async () => {
  await setup();
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  const errors = []; const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  const button = name => page.getByRole('button', { name, exact: true });
  const draft = async () => {
    const id = page.url().split('/drafts/')[1];
    return (await page.request.get(`${origin}/api/drafts/${id}`)).json();
  };
  async function idle() { await page.getByText('Saving or generating…', { exact: true }).waitFor({ state: 'hidden' }); }
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByText('backend: ok', { exact: true }).waitFor();
  await button('New draft').click();
  await page.getByLabel('Title', { exact: true }).fill('Browser checkpoint');
  await page.getByLabel('Topic', { exact: true }).fill('How software updates reduce risks');
  await page.getByLabel('Task, audience, purpose, and tone (optional)').fill('For college classmates; explain clearly.');
  await page.getByLabel('Planned sentences').selectOption('3');
  await page.getByLabel('Minimum words (optional)').fill('60');
  await button('Save').click();
  await page.getByText(/provide both word bounds/).waitFor();
  assert.deepEqual(await (await page.request.get(`${origin}/api/drafts`)).json(), []);
  await page.getByLabel('Maximum words (optional)').fill('90');
  await button('Save').click();
  await page.getByRole('heading', { name: 'Browser checkpoint', exact: true }).waitFor();
  await button('Generate sequence').click();
  await page.getByText(/Last generated in demo mode ·/).waitFor(); await idle();
  assert.equal(await page.locator('.intention-list li').count(), 3);
  await button('Edit intention 1').click();
  await page.getByLabel('Primary purpose').fill('Frame the topic');
  await button('Save').click(); await idle();
  await button('Move intention 1 down').click(); await idle();
  let saved = await draft();
  assert.equal(saved.intentions[1].function_label, 'Frame the topic');
  const originalIds = saved.intentions.map(item => item.id);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText(/Last generated in demo mode ·/).waitFor();
  assert.deepEqual((await draft()).intentions.map(item => item.id), originalIds);
  await button('Edit settings').click();
  await page.getByLabel('Minimum words (optional)').fill('200');
  await page.getByLabel('Maximum words (optional)').fill('250');
  await button('Save').click(); await idle();
  await page.getByText('Length targets may be difficult for this sentence count.', { exact: true }).waitFor();
  assert.equal((await draft()).target_word_min, 200);
  await button('Delete intention 1').click();
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('dialog'))), true);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await draft()).intentions.length, 3);
  await button('Delete intention 1').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete intention', exact: true }).click(); await idle();
  assert.deepEqual((await draft()).intentions.map(item => item.position), [0, 1]);
  await button('Add intention').click();
  await page.getByLabel('Primary purpose').fill('Close the paragraph');
  await page.getByLabel('Description', { exact: true }).fill('Return to the main point.');
  await page.getByLabel('Guiding question', { exact: true }).fill('What should the reader remember?');
  await button('Save').click(); await idle();
  saved = await draft();
  await page.request.patch(`${origin}/api/intentions/${saved.intentions[0].id}`, { data: { expected_revision: saved.intentions[0].revision, sentence_text: "Don't re-write this", user_notes: 'These notes should not count' } });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('3 intentions · 3 current words', { exact: true }).waitFor();
  await page.locator('.badge.written').waitFor();
  await button('Edit intention 1').click();
  await page.getByLabel('Primary purpose').fill('My local purpose');
  saved = await draft();
  await page.request.patch(`${origin}/api/intentions/${saved.intentions[0].id}`, { data: { expected_revision: saved.intentions[0].revision, function_label: 'Other tab purpose' } });
  await button('Save').click();
  await page.getByRole('heading', { name: 'Saved data changed', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Primary purpose').inputValue(), 'My local purpose');
  await button('Keep my edits').click(); await button('Save').click(); await idle();
  assert.equal((await draft()).intentions[0].function_label, 'My local purpose');
  await page.route('**/api/drafts/*/intentions/generate', route => route.fulfill({ status: 502, contentType: 'application/json', body: '{"detail":"Offline injected generation failure."}' }));
  await button('Generate sequence').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Replace sequence', exact: true }).click();
  await page.getByText('Offline injected generation failure.', { exact: true }).waitFor();
  assert.equal((await draft()).intentions[0].sentence_text, "Don't re-write this");
  await page.unroute('**/api/drafts/*/intentions/generate');
  await button('Edit intention 1').click(); await page.getByLabel('Primary purpose').fill('Saved despite a lost response');
  const firstId = (await draft()).intentions[0].id;
  await page.route(`**/api/intentions/${firstId}`, async route => { await route.fetch(); await route.abort('failed'); });
  await button('Save').click(); await button('Refresh saved data').waitFor();
  assert.equal(await button('Save').isDisabled(), true);
  await page.unroute(`**/api/intentions/${firstId}`);
  await button('Refresh saved data').click();
  await page.getByRole('heading', { name: 'Saved data changed', exact: true }).waitFor();
  await button('Use saved version').click(); await button('Cancel').click();
  assert.equal((await draft()).intentions[0].function_label, 'Saved despite a lost response');
  await button('Edit settings').click(); await page.getByLabel('Title', { exact: true }).fill('Unsaved title');
  await button('← All drafts').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Unsaved title');
  await button('Cancel').click(); await page.getByRole('dialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.route('**/api/drafts', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"Offline injected list failure."}' }));
  await button('← All drafts').click(); await page.getByText('Offline injected list failure.', { exact: true }).waitFor();
  await page.unroute('**/api/drafts'); await button('Retry loading drafts').click();
  await button('Browser checkpoint').click(); await page.getByRole('heading', { name: 'Browser checkpoint', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, '.tools/stage3-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: path.join(root, '.tools/stage3-mobile.png'), fullPage: true });
  await button('← All drafts').click(); await button('Delete draft Browser checkpoint').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByText('A clear paragraph starts with a plan.', { exact: true }).waitFor();
  assert.deepEqual(await (await page.request.get(`${origin}/api/drafts`)).json(), []);
  assert.deepEqual(errors, []);
  assert.equal(requests.every(url => url.startsWith(`${origin}/`)), true);
  console.log('PASS: real-browser CRUD/generation/reload, settings/advisories, conflicts/lost responses, modal focus/Escape, failure recovery, mobile layout, deletion; isolated SQLite and no remote calls');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(stop);
