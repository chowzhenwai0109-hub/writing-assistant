// Real Edge + local FastAPI/SQLite. Every provider request is fake/offline.
const assert = require('node:assert/strict');
const path = require('node:path');
const { setup, stop } = require('./check_stage3_browser.cjs');

(async () => {
  const { browser, origin, root } = await setup();
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  const errors = [], requests = [], planBodies = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { requests.push(request.url()); if (request.url().endsWith('/plan')) planBodies.push(request.postDataJSON()); });
  const button = name => page.getByRole('button', { name, exact: true });
  let draft = await (await page.request.post(`${origin}/api/drafts`, { data: { title: 'Notes checkpoint', topic: 'How updates reduce risks', task_description: 'Explain to classmates.', target_sentence_count: 3, target_word_min: 30, target_word_max: 80 } })).json();
  draft = await (await page.request.post(`${origin}/api/drafts/${draft.id}/intentions/generate`, { data: { expected_revision: draft.revision, mode: 'replace', confirm_replace: false } })).json();
  const getDraft = async () => (await page.request.get(`${origin}/api/drafts/${draft.id}`)).json();
  await page.goto(`${origin}/#/drafts/${draft.id}`, { waitUntil: 'networkidle' });
  const notes = page.getByLabel('My rough notes', { exact: true }), sentence = page.getByLabel('My sentence', { exact: true });
  assert.equal(await button('Make plan from my notes').isDisabled(), true);
  assert.equal(planBodies.length, 0);
  await page.locator('.intention-select').nth(1).click();
  await sentence.fill('Updates protect our devices.'); await notes.fill('更新减少风险；没有证据就提问，不要编造数字。');
  await button('Make plan from my notes').click(); await page.getByText(/Demo plan ·/).waitFor();
  await page.getByRole('heading', { name: 'Slots', exact: true }).waitFor(); await page.getByRole('heading', { name: 'Gaps', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Ordering suggestion', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Matched keywords', exact: true }).waitFor();
  draft = await getDraft(); assert.equal(draft.intentions[1].user_notes, '更新减少风险；没有证据就提问，不要编造数字。');
  assert.equal(draft.intentions[1].sentence_text, 'Updates protect our devices.'); assert.equal(draft.intentions[1].status, 'written');
  await page.getByText('3 intentions · 4 current words', { exact: true }).waitFor();
  assert.equal(planBodies[0].expected_revision, draft.intentions[1].revision); assert.equal(planBodies[0].expected_draft_revision, draft.revision);
  for (const level of ['hint', 'structure', 'example']) {
    await page.getByLabel('Help level').selectOption(level); await button('Make plan from my notes').click(); await page.getByText(/Demo plan ·/).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Matched structures', exact: true }).count(), level === 'hint' ? 0 : 1);
    assert.equal(await page.getByRole('heading', { name: 'Plan examples', exact: true }).count(), level === 'example' ? 1 : 0);
    assert.equal((await getDraft()).revision, draft.revision); // Planning with saved notes is a no-op write.
  }
  assert.equal(await sentence.inputValue(), 'Updates protect our devices.');
  await button('Get Hints').click(); await page.getByText(/Demo guidance ·/).waitFor();
  await notes.fill('New notes clear both hint and plan.');
  assert.equal(await page.getByText(/Demo plan ·/).count(), 0); assert.equal(await page.getByText(/Demo guidance ·/).count(), 0);
  await page.getByText('Saved', { exact: true }).waitFor();
  // Delayed old plan cannot reappear after editing notes.
  let release, reached; const captured = new Promise(resolve => { reached = resolve; });
  await page.route('**/api/intentions/*/plan', async route => { const response = await route.fetch(); reached(); await new Promise(resolve => { release = resolve; }); try { await route.fulfill({ response }); } catch {} });
  await button('Make plan from my notes').click(); await captured;
  assert.equal(await button('Get Hints').isDisabled(), true); await notes.fill('Latest notes while planning.'); release();
  await page.getByText('Saved', { exact: true }).waitFor(); assert.equal(await page.getByText(/Demo plan ·/).count(), 0);
  await page.unroute('**/api/intentions/*/plan');
  // Failure preserves saved sentence and notes and does not replay the request.
  await page.route('**/api/intentions/*/plan', route => route.fulfill({ status: 502, contentType: 'application/json', body: '{"detail":"Offline injected plan failure."}' }));
  const countBeforeFailure = planBodies.length; await button('Make plan from my notes').click(); await page.getByText('Offline injected plan failure.', { exact: true }).waitFor();
  assert.equal(planBodies.length, countBeforeFailure + 1); assert.equal(await notes.inputValue(), 'Latest notes while planning.'); assert.equal(await sentence.inputValue(), 'Updates protect our devices.');
  await page.unroute('**/api/intentions/*/plan');
  // Selection flushes notes independently; reload preserves both buffers.
  await notes.fill('Sentence two notes.'); await page.locator('.intention-select').nth(0).click();
  await notes.fill('Sentence one notes only.'); await page.getByText('Saved', { exact: true }).waitFor();
  draft = await getDraft(); assert.equal(draft.intentions[0].user_notes, 'Sentence one notes only.'); assert.equal(draft.intentions[0].status, 'pending'); assert.equal(draft.intentions[1].user_notes, 'Sentence two notes.');
  await page.reload({ waitUntil: 'networkidle' }); assert.equal(await notes.inputValue(), 'Sentence one notes only.');
  // A notes conflict displays both saved fields and requires an explicit choice.
  draft = await getDraft(); const id = draft.intentions[0].id;
  await page.request.patch(`${origin}/api/intentions/${id}`, { data: { expected_revision: draft.intentions[0].revision, user_notes: 'Other tab notes.' } });
  await notes.fill('Local notes conflict.'); await button('Keep my writing').waitFor(); await page.getByText('Other tab notes.', { exact: true }).waitFor();
  assert.equal(await notes.inputValue(), 'Local notes conflict.'); await button('Keep my writing').click(); await page.getByText('Saved', { exact: true }).waitFor();
  assert.equal((await getDraft()).intentions[0].user_notes, 'Local notes conflict.');
  // Lost save reply is reconciled via read without replaying a notes PATCH.
  let patches = 0; await page.route(`**/api/intentions/${id}`, async route => { patches++; await route.fetch(); await route.abort('failed'); });
  await notes.fill('Committed notes with lost reply.'); await button('Retry writing save').waitFor(); await page.unroute(`**/api/intentions/${id}`);
  await button('Retry writing save').click(); await page.getByText('Saved', { exact: true }).waitFor(); assert.equal(patches, 1);
  // Reload offers paired recovery and waits for an explicit restore.
  await page.route(`**/api/intentions/${id}`, route => route.abort('failed'));
  await sentence.fill('Recover this sentence.'); await notes.fill('恢复这些笔记。'); await button('Retry writing save').waitFor();
  await page.reload({ waitUntil: 'networkidle' }); await button('Restore copy').waitFor();
  assert.equal(await notes.isDisabled(), true); await page.getByText('恢复这些笔记。', { exact: true }).waitFor();
  await page.unroute(`**/api/intentions/${id}`); await button('Restore copy').click(); await page.getByText('Saved', { exact: true }).waitFor();
  draft = await getDraft(); assert.equal(draft.intentions[0].user_notes, '恢复这些笔记。'); assert.equal(draft.intentions[0].sentence_text, 'Recover this sentence.');
  await page.getByLabel('Help level').selectOption('example'); await button('Make plan from my notes').click(); await page.getByText(/Demo plan ·/).waitFor();
  await page.screenshot({ path: path.join(root, '.tools/stage5-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(root, '.tools/stage5-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.equal(requests.every(url => url.startsWith(`${origin}/`)), true);
  console.log('PASS: real-browser multilingual notes, paired autosave/flush/reload, all plan levels and fields, no rewrites, stale replies, failures, conflicts, lost responses, paired recovery and mobile layout; isolated SQLite and no remote calls');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(stop);
