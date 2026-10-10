// Isolated SQLite, local FastAPI/Vite and real Edge; fake model only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { setup, stop } = require('./check_stage3_browser.cjs');

(async () => {
  const { browser, origin, root } = await setup();
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  const errors = [], urls = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { urls.push(req.url()); if (req.url().endsWith('/check')) checks.push(req.postDataJSON()); });
  const button = name => page.getByRole('button', { name, exact: true });
  let draft = await (await page.request.post(`${origin}/api/drafts`, { data: { title: 'Check checkpoint', topic: 'Software updates', target_sentence_count: 3 } })).json();
  draft = await (await page.request.post(`${origin}/api/drafts/${draft.id}/intentions/generate`, { data: { expected_revision: draft.revision, mode: 'replace', confirm_replace: false } })).json();
  const getDraft = async () => (await page.request.get(`${origin}/api/drafts/${draft.id}`)).json();
  const verdict = text => page.getByRole('heading', { name: `Fulfils intention: ${text}`, exact: true });
  await page.goto(`${origin}/#/drafts/${draft.id}`, { waitUntil: 'networkidle' });
  const sentence = page.getByLabel('My sentence', { exact: true }), notes = page.getByLabel('My rough notes', { exact: true });
  assert.equal(await button('Check my sentence').isDisabled(), true);
  await sentence.fill('Updates always guarantee safety.'); await notes.fill('Supplied rough context.');
  await button('Check my sentence').click(); await verdict('partly').waitFor(); await page.getByText(/Demo check ·/).waitFor();
  draft = await getDraft(); assert.equal(draft.intentions[0].status, 'checked'); assert.equal(draft.intentions[0].user_notes, 'Supplied rough context.');
  assert.equal(checks[0].expected_revision + 1, draft.intentions[0].revision); assert.equal(checks[0].expected_draft_revision + 1, draft.revision);
  assert.equal(await sentence.inputValue(), 'Updates always guarantee safety.');
  await page.getByLabel('Help level').selectOption('example'); await verdict('partly').waitFor(); assert.equal(checks.length, 1);
  await page.reload({ waitUntil: 'networkidle' }); await verdict('partly').waitFor(); await page.getByText(/Demo check ·/).waitFor();
  await notes.fill('Changed notes hide current feedback.'); assert.equal(await verdict('partly').count(), 0);
  await sentence.fill('Updates can address known problems.'); await button('Check my sentence').click(); await verdict('yes').waitFor();
  // Checking a later intention then editing earlier writing clears downstream checks.
  await page.locator('.intention-select').nth(1).click(); await sentence.fill('A later explanation.'); await button('Check my sentence').click(); await verdict('yes').waitFor();
  await page.locator('.intention-select').nth(0).click(); await sentence.fill('Earlier writing changed.');
  await page.getByText('Saved', { exact: true }).waitFor(); draft = await getDraft(); assert.equal(draft.intentions[1].last_check_json, null);
  // Lost check reply: read the committed result without a second model request.
  await page.route('**/api/intentions/*/check', async route => { await route.fetch(); await route.abort('failed'); });
  const count = checks.length; await button('Check my sentence').click(); await button('Refresh saved data').waitFor();
  assert.equal(await button('Check my sentence').isDisabled(), true); await page.unroute('**/api/intentions/*/check');
  await button('Refresh saved data').click(); await verdict('yes').waitFor(); assert.equal(checks.length, count + 1);
  // Model failure keeps an existing check and does not advance revisions.
  draft = await getDraft(); await page.route('**/api/intentions/*/check', route => route.fulfill({ status: 502, contentType: 'application/json', body: '{"detail":"Injected check failure."}' }));
  await button('Check my sentence').click(); await page.getByText('Injected check failure.', { exact: true }).waitFor();
  await verdict('yes').waitFor(); assert.equal((await getDraft()).revision, draft.revision); await page.unroute('**/api/intentions/*/check');
  // Delayed reply + typing: no old feedback or overwrite; reconcile explicitly.
  let release, reached; const captured = new Promise(resolve => { reached = resolve; });
  await page.route('**/api/intentions/*/check', async route => { const response = await route.fetch(); reached(); await new Promise(resolve => { release = resolve; }); try { await route.fulfill({ response }); } catch {} });
  await button('Check my sentence').click(); await captured;
  assert.equal(await button('Get Hints').isDisabled(), true); await notes.fill('Newer notes while checking.'); release();
  assert.equal(await verdict('yes').count(), 0); await page.unroute('**/api/intentions/*/check');
  await button('Keep my writing').waitFor(); assert.equal(await notes.inputValue(), 'Newer notes while checking.');
  await button('Keep my writing').click(); await page.getByText('Saved', { exact: true }).waitFor();
  await button('Refresh saved data').click(); await button('Check my sentence').click(); await verdict('yes').waitFor();
  await page.screenshot({ path: path.join(root, '.tools/stage6-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(root, '.tools/stage6-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.equal(urls.every(url => url.startsWith(`${origin}/`)), true);
  console.log('PASS: real-browser check flush, advisory verdict/status, persisted feedback/demo origin, help-level independence, invalidation, lost-response read, failures, typing during inference/conflict recovery and mobile layout; isolated SQLite and no remote calls');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(stop);
