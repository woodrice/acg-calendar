// C0 integration: real loopback API, isolated data and fixed clock, no source-site access.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const output = path.resolve('logs/shell-source');
  await fs.mkdir(output, { recursive: true });
  const directory = await fs.mkdtemp(path.join(output, 'test-'));
  const port = await new Promise(resolve => {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
  const base = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.CALENDAR_PYTHON || 'python', ['app.py', '--port', String(port), '--data-dir', directory, '--no-sync', '--no-desktop'], { windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await fetch(base + '/api/health').then(response => response.ok, () => false)) break;
      if (attempt === 59) throw new Error('Test server did not start');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    browser = await chromium.launch({ channel: process.env.CALENDAR_BROWSER || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/New_York' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-10-27T20:00:00Z'));

    const requests = [];
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.goto(base + '/?view=timeline');
    await page.locator('.timeline-row').first().waitFor();
    assert.equal(await page.locator('#pt-shell').count(), 0);
    assert.ok(!requests.includes('/shell-source.js'));
    assert.equal((await page.request.get(base + '/shell/dev.html')).status(), 404);
    assert.equal((await page.request.get(base + '/shell/fixtures.js')).status(), 404);

    // Observe the normal start call without adding a production debug global.
    await page.route('**/shell/shell.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()) + `
        const originalStart = PlaytimeShell.start;
        PlaytimeShell.start = options => { window.__reviewSource = options.source; return originalStart(options); };` });
    });
    await page.goto(base + '/?shell=android');
    await page.locator('html[data-shell-ready="true"]').waitFor({ state: 'attached' });
    await page.locator('#pt-shell .ps-row').first().waitFor();
    assert.equal(await page.locator('.app-header').isVisible(), false);
    const status = await page.evaluate(() => {
      const s = __reviewSource, snapshot = s.snapshot();
      return { status: s.status, zone: s.helpers.zone, frozen: Object.isFrozen(snapshot.filters.types), today: snapshot.today,
        hasToken: Object.hasOwn(snapshot, 'csrf_token'), count: snapshot.upcoming.length };
    });
    assert.deepEqual({ ...status, count: status.count > 0 }, { status: 'ready', zone: 'America/New_York', frozen: true, today: '2026-10-27', hasToken: false, count: true });

    await page.locator('#pt-shell [data-tab="calendar"]').tap();
    await page.getByRole('tab', { name: '时间轴' }).tap();
    const embedded = page.locator('#ps-timeline-mount.embedded-timeline');
    const axis = embedded.locator('.timeline-scroll');
    await embedded.locator('.timeline-row[data-row-event]').first().waitFor();
    assert.match(await embedded.locator('output').innerText(), /2026\/10\/27/);
    assert.ok(await axis.evaluate(el => el.scrollWidth > el.clientWidth));
    await axis.evaluate(el => { el.scrollLeft = 100; });
    const eventButton = embedded.locator('.event-name[data-event]').first();
    await eventButton.tap();
    await page.locator('#pt-shell .ps-page-layer').waitFor();
    assert.equal(await page.locator('#detail-dialog[open]').count(), 0);
    await page.evaluate(() => PlaytimeShell.back());
    await page.locator('#pt-shell .ps-page-layer').waitFor({ state: 'detached' });
    assert.equal(await axis.evaluate(el => el.scrollLeft), 100);
    await embedded.locator('[data-deadline-day]').first().evaluate(button => button.click());
    await page.locator('#pt-shell .ps-sheet').waitFor();
    assert.equal(await page.locator('#deadlines-dialog[open]').count(), 0);
    await page.evaluate(() => PlaytimeShell.back());
    await page.locator('#pt-shell .ps-sheet').waitFor({ state: 'detached' });
    await embedded.getByRole('button', { name: '下一段' }).tap();
    assert.match(await embedded.locator('output').innerText(), /2026\/11\/10/);
    await page.getByRole('tab', { name: '截止月历' }).tap();
    assert.equal(await embedded.count(), 0);
    await page.getByRole('tab', { name: '时间轴' }).tap();
    assert.match(await embedded.locator('output').innerText(), /2026\/11\/10/);
    await embedded.getByRole('button', { name: '今天' }).tap();
    assert.match(await embedded.locator('output').innerText(), /2026\/10\/27/);
    await page.locator('#pt-shell [data-tab="upcoming"]').tap();

    await page.locator('#pt-shell .ps-row').first().tap();
    await page.locator('#pt-shell .ps-page-layer').waitFor();
    const changes = await page.evaluate(async () => {
      const s = __reviewSource, first = s.snapshot();
      const id = first.upcoming[0].items[0].id;
      let updates = 0;
      const unsubscribe = s.subscribe(() => updates++);
      const marked = await s.act('setStarred', { id, value: true });
      const starred = s.event(id).starred;
      const undone = await marked.undo();
      await s.act('setFilters', { hideCompleted: true });
      await s.act('setCompleted', { id, value: true });
      unsubscribe();
      const revision = s.snapshot().revision, before = updates;
      await s.act('setCompleted', { id, value: false });
      return { starred, undone: undone.ok, subscribed: before > 0, unsubscribed: updates === before,
        advanced: s.snapshot().revision > revision, olderSnapshotUntouched: !first.events.find(e => e.id === id).starred };
    });
    assert.deepEqual(changes, { starred: true, undone: true, subscribed: true, unsubscribed: true, advanced: true, olderSnapshotUntouched: true });
    assert.ok(await page.locator('#pt-shell .ps-page-layer').isVisible());

    const plans = await page.evaluate(async () => {
      const s = __reviewSource, args = { request_id: 'be1d0000000000000000000000000001', title: '跨夏令时', timezone: s.helpers.zone,
        local_start: '2026-11-01T01:30', local_end: '2026-11-01T02:00' };
      const ambiguous = await s.act('createPlan', args);
      const nonexistent = await s.act('createPlan', { ...args, local_start: '2027-03-14T02:30', local_end: '2027-03-14T04:00' });
      const results = await Promise.all([s.act('createPlan', { ...args, fold_start: 1 }), s.act('createPlan', { ...args, fold_start: 1 })]);
      const saved = s.snapshot().plans.filter(plan => plan.id === results[0].id);
      const updated = await s.act('updatePlan', { id: results[0].id, title: '已编辑' });
      await s.act('createPlan', { ...args, fold_start: 1 });
      const retained = s.snapshot().plans.find(plan => plan.id === results[0].id).title;
      const deleted = await s.act('deletePlan', { id: results[0].id });
      return { ambiguous: ambiguous.code, nonexistent: nonexistent.code, saved, sameId: results[0].id === results[1].id, updated: updated.ok, retained, deleted: deleted.ok };
    });
    assert.equal(plans.ambiguous, 'ambiguous_time');
    assert.equal(plans.nonexistent, 'nonexistent_time');
    assert.equal(plans.saved.length, 1);
    assert.equal(plans.saved[0].start, '2026-11-01T06:30:00Z');
    assert.equal(plans.saved[0].timezone, 'America/New_York');
    assert.ok(plans.sameId && plans.updated && plans.deleted);
    assert.equal(plans.retained, '已编辑');

    const scope = await page.evaluate(async () => {
      const s = __reviewSource, game = s.snapshot().games[0].id;
      const outcomes = await Promise.all([s.act('setScope', { mode: 'all' }), s.act('setScope', { mode: 'single', games: [game] })]);
      return { outcomes, final: s.snapshot().scope, game };
    });
    assert.ok(scope.outcomes.every(result => result.ok));
    assert.deepEqual(scope.final, { mode: 'single', games: [scope.game] });
    const sync = await page.evaluate(async () => {
      const s = __reviewSource;
      const data = await fetch('/api/state').then(r => r.json());
      const pause = await fetch('/api/network', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Calendar-Token': data.csrf_token }, body: JSON.stringify({ paused: true }) });
      if (!pause.ok) throw new Error('Failed to pause test network');
      await s.reload();
      return s.act('sync', { scope: s.snapshot().scope });
    });
    assert.equal(sync.code, 'paused');
    assert.ok(!requests.includes('/api/sync'));

    await page.evaluate(() => PlaytimeShell.back());
    await page.locator('#pt-shell .ps-page-layer').waitFor({ state: 'detached' });
    await page.locator('#pt-shell .ps-scope').tap();
    await page.locator('#pt-shell [data-scope-mode="all"]').tap();
    await page.waitForFunction(() => __reviewSource.snapshot().scope.mode === 'all');
    const initial = await page.evaluate(() => __reviewSource.snapshot().scope.games);
    assert.ok(initial.length >= 2);
    await page.locator('#pt-shell [data-scope-game]').evaluateAll(rows => {
      rows[0].click();
      rows[1].click();
    });
    await page.waitForFunction(count => __reviewSource.snapshot().scope.games.length === count, initial.length - 2);
    assert.equal(await page.locator('#pt-shell .ps-sheet').evaluate(sheet => getComputedStyle(sheet).animationName), 'none');
    await page.locator('#pt-shell .ps-sheet [data-back]').tap();
    await page.locator('#pt-shell .ps-sheet').waitFor({ state: 'detached' });

    await page.locator('#pt-shell [data-tab="plans"]').tap();
    const newPlan = page.getByRole('button', { name: '新建计划' });
    assert.ok(await newPlan.evaluate(button => getComputedStyle(button).color !== getComputedStyle(button).backgroundColor));
    await newPlan.tap();
    await page.locator('#pt-shell [name="title"]').fill('安卓夏令时测试');
    await page.locator('#pt-shell [name="start"]').fill('2026-11-01T01:30');
    await page.locator('#pt-shell [name="end"]').fill('2026-11-01T02:00');
    await page.locator('#pt-shell [data-plan-save]').tap();
    await page.getByRole('radio', { name: '较晚的一次' }).tap();
    await page.locator('#pt-shell [data-plan-save]').tap();
    await page.locator('#pt-shell .ps-sheet').waitFor({ state: 'detached' });
    const uiPlan = await page.evaluate(() => __reviewSource.snapshot().plans.find(plan => plan.title === '安卓夏令时测试'));
    assert.equal(uiPlan?.start, '2026-11-01T06:30:00Z');
    assert.deepEqual(errors, []);
    console.log('PASS: Android real source and C2 timeline — opt-in boot, timeline navigation and return, immutable snapshots, queued scope, DST, idempotent plans');
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
