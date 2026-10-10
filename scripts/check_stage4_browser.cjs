// Offline Stage 4 checkpoint using real Edge, FastAPI and isolated SQLite.
const assert = require('node:assert/strict');
const path = require('node:path');
const { setup, stop } = require('./check_stage3_browser.cjs');

(async () => {
  const { browser, origin, root } = await setup();
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  const button = name => page.getByRole('button', { name, exact: true });
  const body = { title: 'Hints checkpoint', topic: '软件 updates and café devices', task_description: 'Explain benefits to classmates.', target_sentence_count: 3, target_word_min: 30, target_word_max: 80 };
  let draft = await (await page.request.post(`${origin}/api/drafts`, { data: body })).json();
  draft = await (await page.request.post(`${origin}/api/drafts/${draft.id}/intentions/generate`, { data: { expected_revision: draft.revision, mode: 'replace', confirm_replace: false } })).json();
  const getDraft = async () => (await page.request.get(`${origin}/api/drafts/${draft.id}`)).json();
  await page.goto(`${origin}/#/drafts/${draft.id}`, { waitUntil: 'networkidle' });
  const sentence = page.getByLabel('My sentence', { exact: true });
  await sentence.fill('Updates protect our devices.');
  await page.getByText('Saved', { exact: true }).waitFor();
  draft = await getDraft(); assert.equal(draft.intentions[0].sentence_text, 'Updates protect our devices.');
  assert.equal(draft.intentions[0].status, 'written');
  await page.getByText('3 intentions · 4 current words', { exact: true }).waitFor();
  for (const level of ['hint', 'structure', 'example']) {
    await page.getByLabel('Help level').selectOption(level);
    await button('Get Hints').click();
    await page.getByText(/Demo guidance ·/).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Structures', exact: true }).count(), level === 'hint' ? 0 : 1);
    assert.equal(await page.getByRole('heading', { name: 'Examples', exact: true }).count(), level === 'example' ? 1 : 0);
  }
  assert.equal(await sentence.inputValue(), 'Updates protect our devices.');
  await sentence.fill('New writing before hints.'); await button('Get Hints').click();
  await page.getByText(/Demo guidance ·/).waitFor(); assert.equal((await getDraft()).intentions[0].sentence_text, 'New writing before hints.');
  // Returning a late valid response must not redisplay guidance after new typing.
  let release; let captured; const reached = new Promise(resolve => { captured = resolve; });
  await page.route('**/api/intentions/*/hints', async route => {
    const response = await route.fetch(); captured(); await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ response }); } catch { /* Client cancellation is expected. */ }
  });
  await button('Get Hints').click(); await reached; await sentence.fill('Changed while guidance waits.'); release();
  await page.getByText('Saved', { exact: true }).waitFor();
  assert.equal(await page.getByText(/Demo guidance ·/).count(), 0); await page.unroute('**/api/intentions/*/hints');
  // Selection flushes the first buffer while the second remains independent.
  await sentence.fill('First intention final.'); await page.locator('.intention-select').nth(1).click();
  await sentence.fill('Second intention words.'); await page.getByText('Saved', { exact: true }).waitFor();
  draft = await getDraft(); assert.equal(draft.intentions[0].sentence_text, 'First intention final.'); assert.equal(draft.intentions[1].sentence_text, 'Second intention words.');
  await page.reload({ waitUntil: 'networkidle' }); assert.equal(await sentence.inputValue(), 'First intention final.');
  assert.equal(await page.getByLabel('Help level').inputValue(), 'hint');
  // External edits pause autosave; Keep explicitly chooses the displayed revision.
  draft = await getDraft();
  await page.request.patch(`${origin}/api/intentions/${draft.intentions[0].id}`, { data: { expected_revision: draft.intentions[0].revision, sentence_text: 'Other tab writing.' } });
  await sentence.fill('My conflicting writing.'); await button('Keep my writing').waitFor();
  assert.equal(await sentence.inputValue(), 'My conflicting writing.'); await page.getByText('Other tab writing.', { exact: true }).waitFor();
  await button('Keep my writing').click(); await page.getByText('Saved', { exact: true }).waitFor();
  assert.equal((await getDraft()).intentions[0].sentence_text, 'My conflicting writing.');
  // A response lost after commit is reconciled by GET, never replayed.
  let patches = 0;
  await page.route(`**/api/intentions/${draft.intentions[0].id}`, async route => { patches++; await route.fetch(); await route.abort('failed'); });
  await sentence.fill('Saved despite lost reply.'); await button('Retry writing save').waitFor();
  await page.unroute(`**/api/intentions/${draft.intentions[0].id}`); await button('Retry writing save').click(); await page.getByText('Saved', { exact: true }).waitFor(); assert.equal(patches, 1);
  // Offline save persists a browser copy, reload offers explicit recovery.
  await page.route(`**/api/intentions/${draft.intentions[0].id}`, route => route.abort('failed'));
  await sentence.fill('Recover this local sentence.'); await button('Retry writing save').waitFor();
  await page.reload({ waitUntil: 'networkidle' }); await button('Restore copy').waitFor();
  assert.equal(await sentence.isDisabled(), true); assert.equal((await getDraft()).intentions[0].sentence_text, 'Saved despite lost reply.');
  await page.unroute(`**/api/intentions/${draft.intentions[0].id}`); await button('Restore copy').click(); await page.getByText('Saved', { exact: true }).waitFor();
  assert.equal((await getDraft()).intentions[0].sentence_text, 'Recover this local sentence.');
  await page.getByLabel('Help level').selectOption('example'); await button('Get Hints').click(); await page.getByText(/Demo guidance ·/).waitFor();
  await page.screenshot({ path: path.join(root, '.tools/stage4-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(root, '.tools/stage4-mobile.png'), fullPage: true });
  // Actual storage failure has a readable warning, while saving still works.
  const storagePage = await browser.newPage();
  await storagePage.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('Disabled'); } }); });
  await storagePage.goto(`${origin}/#/drafts/${draft.id}`, { waitUntil: 'networkidle' });
  await storagePage.getByText(/Local sentence and notes recovery is unavailable/).waitFor();
  await storagePage.getByLabel('My sentence').fill('Saved with storage disabled.'); await storagePage.getByText('Saved', { exact: true }).waitFor();
  assert.deepEqual(errors, []); assert.equal(requests.every(url => url.startsWith(`${origin}/`)), true);
  console.log('PASS: real-browser hints at all levels, Unicode context fingerprints, autosave/flush/reload, stale replies, conflicts, lost responses, explicit recovery, storage failure and mobile layout; no remote calls');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(stop);
