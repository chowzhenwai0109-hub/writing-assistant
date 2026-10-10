// Final Windows acceptance: actual batch/launcher, isolated SQLite, fake only.
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
let browser, child, temporary;
let launchRoot = root;
const dependencyLinks = [];
async function freePort(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}
async function until(check, message) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error(message);
}
async function start(model) {
  await freePort(8000); await freePort(5173);
  for (const file of ['stop', 'opened.json']) fs.rmSync(path.join(temporary, file), { force: true });
  const command = `""${path.join(launchRoot, 'Start Writing Assistant.bat')}" --mode fake --model ${model}"`;
  child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: temporary, windowsHide: true, windowsVerbatimArguments: true,
    env: { ...process.env, PYTHONPATH: temporary, WRITING_CHECK_DIR: temporary, LLM_MODE: 'fake', GEMINI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.logs = ''; child.once('error', error => { child.startError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { child.logs = (child.logs + chunk).slice(-6000); });
  await until(async () => {
    if (child.startError) throw child.startError;
    if (child.exitCode !== null) throw new Error(`Launcher exited: ${child.logs}`);
    if (!fs.existsSync(path.join(temporary, 'opened.json'))) return false;
    const marker = JSON.parse(fs.readFileSync(path.join(temporary, 'opened.json'), 'utf8'));
    assert.equal(marker.url, origin); assert.equal(marker.model, model); assert.equal(marker.mode, 'fake');
    const response = await fetch(`${origin}/api/verification/${path.basename(temporary)}`);
    return response.ok;
  }, 'Launcher/browser readiness timed out: ' + child.logs);
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  fs.writeFileSync(path.join(temporary, 'stop'), 'stop');
  await until(() => child.exitCode !== null, 'Launcher did not stop both servers');
  assert.equal(child.exitCode, 0, child.logs);
  await freePort(8000); await freePort(5173);
}
async function cleanup() {
  await browser?.close();
  if (child && child.exitCode === null) {
    try { await stopServer(); } catch { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
  }
  // Remove directory junctions nonrecursively before removing the fixture tree.
  for (const link of dependencyLinks) {
    if (temporary && path.resolve(link).startsWith(path.resolve(temporary) + path.sep)) fs.rmdirSync(link);
  }
  if (temporary && path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('writing-stage7-')) fs.rmSync(temporary, { recursive: true, force: true });
}

(async () => {
  assert.equal(process.platform, 'win32', 'This acceptance script verifies the Windows batch launcher.');
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writing-stage7-'));
  launchRoot = path.join(temporary, 'fresh source with spaces');
  // A clean source snapshot contains no real .env, DB or local tools. Reuse only
  // installed prerequisites/dependencies; no network installation is involved.
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  for (const name of listed.stdout.split('\0').filter(Boolean)) {
    const destination = path.resolve(launchRoot, name);
    assert.equal(destination.startsWith(path.resolve(launchRoot) + path.sep), true);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(root, name), destination);
  }
  for (const name of ['backend/.venv', 'frontend/node_modules', '.tools']) {
    const link = path.join(launchRoot, name); fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(root, name), link, 'junction'); dependencyLinks.push(link);
  }
  // Fixture-only interception leaves production launcher/app unchanged. The real
  // launcher owns processes, readiness and cleanup; browser opening is recorded.
  fs.writeFileSync(path.join(temporary, 'sitecustomize.py'), `
import os, sys
from pathlib import Path
if Path(sys.argv[0]).name == 'dev.py' and 'WRITING_CHECK_DIR' in os.environ:
    import subprocess, webbrowser, json, threading, time, _thread
    fixture = Path(os.environ['WRITING_CHECK_DIR'])
    original = subprocess.Popen
    def start(command, **kwargs):
        if isinstance(command, list) and 'uvicorn' in command:
            script = "import sys; from pathlib import Path; import uvicorn; from app.main import create_app; from app.db import create_db_engine; app=create_app(create_db_engine(Path(sys.argv[1]))); app.add_api_route('/api/verification/'+sys.argv[2], lambda: {'mode':'fake'}); uvicorn.run(app, host='127.0.0.1', port=8000, log_level='warning')"
            command = [sys.executable, '-c', script, str(fixture / 'app.db'), fixture.name]
            (fixture / 'selected.json').write_text(json.dumps({'model':kwargs['env']['LLM_MODEL'], 'mode':kwargs['env']['LLM_MODE']}))
        return original(command, **kwargs)
    subprocess.Popen = start
    def opened(url):
        selected = json.loads((fixture / 'selected.json').read_text())
        (fixture / 'opened.json').write_text(json.dumps({'url':url, **selected}))
        return True
    webbrowser.open = opened
    def shutdown():
        while not (fixture / 'stop').exists(): time.sleep(.1)
        _thread.interrupt_main()
    threading.Thread(target=shutdown, daemon=True).start()
`, 'utf8');
  await start('gemini-3.5-flash-lite');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
  const button = name => page.getByRole('button', { name, exact: true });
  await page.goto(origin, { waitUntil: 'networkidle' }); await page.getByText('backend: ok', { exact: true }).waitFor();
  await button('New draft').click();
  await page.getByLabel('Title', { exact: true }).fill('Final acceptance ' + randomUUID());
  await page.getByLabel('Topic', { exact: true }).fill('How software updates help');
  await page.getByLabel('Task, audience, purpose, and tone (optional)').fill('Explain to classmates.');
  await page.getByLabel('Planned sentences').selectOption('3');
  await page.getByLabel('Minimum words (optional)').fill('30'); await page.getByLabel('Maximum words (optional)').fill('80');
  await button('Save').click(); await button('Generate sequence').click(); await page.getByText(/Last generated in demo mode/).waitFor();
  await button('Edit intention 2').click(); await page.getByLabel('Primary purpose').fill('State a qualified point'); await button('Save').click();
  await page.getByText('Saving or generating…', { exact: true }).waitFor({ state: 'hidden' });
  await page.locator('.intention-select').nth(1).click();
  for (const level of ['hint', 'structure', 'example']) {
    await page.getByLabel('Help level').selectOption(level); await button('Get Hints').click(); await page.getByText(/Demo guidance ·/).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Examples', exact: true }).count(), level === 'example' ? 1 : 0);
  }
  const notes = page.getByLabel('My rough notes', { exact: true }), sentence = page.getByLabel('My sentence', { exact: true });
  await notes.fill('更新可以解决已知问题。');
  for (const level of ['hint', 'structure', 'example']) {
    await page.getByLabel('Help level').selectOption(level); await button('Make plan from my notes').click(); await page.getByText(/Demo plan ·/).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Plan examples', exact: true }).count(), level === 'example' ? 1 : 0);
  }
  await sentence.fill('Updates can address known problems.'); await button('Check my sentence').click();
  await page.getByRole('heading', { name: 'Fulfils intention: yes' }).waitFor();
  const draftUrl = page.url(), id = draftUrl.split('/drafts/')[1];
  const saved = await (await page.request.get(`${origin}/api/drafts/${id}`)).json();
  assert.equal(saved.intentions[1].status, 'checked'); assert.equal(saved.target_word_min, 30);
  await button('Generate sequence').click(); await page.getByRole('dialog', { name: 'Replace this sequence?' }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(await (await page.request.get(`${origin}/api/drafts/${id}`)).json(), saved);
  await page.screenshot({ path: path.join(root, '.tools/stage7-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(root, '.tools/stage7-mobile.png'), fullPage: true });
  // Stop the old tab's Vite reconnect loop before restarting. Reopen only after
  // the launcher confirms the API/proxy/HTML, as its browser-opening flow does.
  await page.goto('about:blank'); await stopServer(); await start('gemini-3.6-flash');
  await page.goto(draftUrl, { waitUntil: 'networkidle' }); await page.locator('.intention-select').nth(1).click();
  await page.getByRole('heading', { name: 'Fulfils intention: yes' }).waitFor();
  assert.equal(await notes.inputValue(), '更新可以解决已知问题。'); assert.equal(await sentence.inputValue(), 'Updates can address known problems.');
  assert.deepEqual(await (await page.request.get(`${origin}/api/drafts/${id}`)).json(), saved);
  // Final recovery check after server restart.
  await page.route(`**/api/intentions/${saved.intentions[1].id}`, route => route.abort('failed'));
  await notes.fill('Local recovery notes.'); await button('Retry writing save').waitFor();
  await page.reload({ waitUntil: 'networkidle' }); await page.locator('.intention-select').nth(1).click(); await button('Restore copy').waitFor();
  await page.unroute(`**/api/intentions/${saved.intentions[1].id}`); await button('Restore copy').click(); await page.getByText('Saved', { exact: true }).waitFor();
  assert.equal(await notes.inputValue(), 'Local recovery notes.');
  assert.deepEqual(errors, []);
  const remote = requests.filter(url => { const parsed = new URL(url); return parsed.protocol === 'blob:' ? parsed.origin !== origin : parsed.hostname !== '127.0.0.1' || !['5173', '8000'].includes(parsed.port); });
  assert.deepEqual(remote, [], 'Only loopback browser requests are allowed');
  await stopServer();
  console.log('PASS: actual Windows batch in a fresh source copy with spaces and installed dependencies, another cwd, readiness-before-browser, both model selections offline, create/settings/generate/edit/hints/plan/check, all help levels, cancel replacement, responsive layout, both-server restart/persistence, recovery and clean shutdown; isolated SQLite, no remote calls');
})().catch(e => { console.error(e); if (child) console.error(child.logs); process.exitCode = 1; }).finally(cleanup);
