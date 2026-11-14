const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const output = path.resolve('logs/month-density');
  const directory = path.join(output, 'data-' + Date.now());
  const plugin = path.join(directory, 'plugins/sample-game');
  await fs.mkdir(plugin, { recursive: true });
  await fs.copyFile('examples/plugins/sample-game/manifest.json', path.join(plugin, 'manifest.json'));
  const event = (id, date, category = 'event', state = 'exact') => ({
    id, title: id, category, source_url: 'https://example.com/',
    start: { at: '2026-10-01T12:00:00Z', state: 'exact' }, end: { at: date, state },
  });
  const events = [
    ...['a', 'b', 'c'].map(id => event(id, '2026-10-10T12:00:00Z')),
    event('shop', '2026-10-10T12:00:00Z', 'exchange'),
    ...['d', 'e'].map(id => event(id, '2026-10-20T12:00:00Z')),
    ...['f', 'g', 'h', 'i'].map(id => event(id, '2026-10-25T12:00:00Z')),
    event('estimated', '2026-10-20T12:00:00Z', 'event', 'estimated'),
    event('boundary', '2026-10-31T23:30:00Z'),
    ...Array.from({ length: 8 }, (_, i) => event('neighbor' + i, '2026-11-01T12:00:00Z')),
  ];
  await fs.writeFile(path.join(plugin, 'events.json'), JSON.stringify({ schema_version: 1, versions: [
    { id: 'density', name: '截止密度测试', source_url: 'https://example.com/', events },
  ] }));
  const port = await new Promise(resolve => {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
  });
  const base = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.CALENDAR_PYTHON || 'python', ['app.py', '--port', String(port), '--data-dir', directory, '--no-sync', '--no-desktop'], { windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
      if (attempt === 59) throw Error('Isolated server did not start');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const state = async () => (await fetch(base + '/api/state')).json();
    const write = async (url, body) => {
      const data = await state();
      const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Calendar-Token': data.csrf_token }, body: JSON.stringify(body) });
      assert.equal(response.ok, true);
    };
    await write('/api/settings', { timezone: 'America/New_York' });
    browser = await chromium.launch({ channel: process.env.CALENDAR_BROWSER || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-10-15T12:00:00Z'));
    await page.goto(base + '/?game=sample-game&view=month');
    await page.locator('.month-density-summary').waitFor();
    const cell = day => page.locator(`.month-cell:has(.month-date[data-day="${Date.parse(day) / 86400000}"])`);
    const fill = day => cell(day).evaluate(node => parseFloat(node.style.getPropertyValue('--deadline-fill')));
    assert.equal(await fill('2026-10-10'), 100);
    assert.equal(await fill('2026-10-20'), 50);
    assert.equal(await fill('2026-10-25'), 100);
    assert.equal(await fill('2026-10-31'), 25);
    assert.equal(await fill('2026-10-15'), 0);
    assert.equal(await fill('2026-11-01'), 0, 'Neighboring months do not set the fill scale');
    assert.equal(await page.locator('.month-density-peak').count(), 2);
    assert.match(await page.locator('.month-density-summary').innerText(), /最多 4 项.*10\/10.*10\/25/);
    assert.equal(await page.locator('.month-cell .density-day').count(), 0, 'Counts are plain text, without a badge');
    assert.match(await cell('2026-10-10').locator('.month-cutoff-count').innerText(), /4 项截止/);
    const placement = await cell('2026-10-10').evaluate(node => {
      const cell = node.getBoundingClientRect(), count = node.querySelector('.month-cutoff-count').getBoundingClientRect();
      return { right: cell.right - count.right, bottom: cell.bottom - count.bottom };
    });
    assert.ok(placement.right < 12 && placement.bottom < 12, 'Count stays in the lower right corner');
    await cell('2026-10-10').locator('.month-day-button').click({ position: { x: 15, y: 40 } });
    await page.locator('#deadlines-dialog[open]').waitFor();
    assert.equal(await page.locator('#deadlines-content .agenda-event').count(), 4);
    assert.deepEqual((await state()).workspace.view.focus, { date: null, event_id: null });
    await page.locator('#deadlines-dialog [data-close]').click();
    await page.locator('#deadlines-dialog').waitFor({ state: 'hidden' });
    await cell('2026-10-20').locator('.month-day-button').focus();
    await page.keyboard.press('Enter');
    await page.locator('#deadlines-dialog[open]').waitFor();
    assert.equal(await page.locator('#deadlines-content .agenda-event').count(), 2, 'Keyboard opens that day’s closing activities');
    await page.locator('#deadlines-dialog [data-close]').click();
    await page.locator('#deadlines-dialog').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, 'month-density.png') });
    await page.locator('[data-category="exchange"]').uncheck();
    await page.waitForFunction(() => document.querySelector('.month-cell[data-deadline-count="3"]'));
    assert.equal(await fill('2026-10-10'), 75);
    await page.locator('[data-category="exchange"]').check();
    const first = (await state()).events.find(event => event.game === 'sample-game' && event.title === 'a');
    await write('/api/events/' + first.id, { completed: true });
    await page.reload();
    await page.locator('.month-density-summary').waitFor();
    assert.equal(await fill('2026-10-10'), 75, 'Completed activities are excluded');
    await page.locator('#timezone-select').selectOption('Asia/Shanghai');
    await page.waitForFunction(() => document.querySelector('#zone-offset').textContent.includes('UTC+8'));
    assert.equal(await fill('2026-10-31'), 0, 'The closing date follows the display timezone');
    await page.locator('#event-search').fill('no-such-activity');
    assert.match(await page.locator('.month-density-summary').innerText(), /本月无明确截止/);
    assert.equal(await page.locator('.month-density-peak').count(), 0);
    await page.locator('#event-search').fill('');
    await page.locator('#workspace-button').click();
    await page.locator('#theme-preset').selectOption('dark');
    await page.locator('#save-theme').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.locator('#preferences-dialog').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, 'month-density-dark.png') });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.locator('#month-view').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    console.log('PASS: proportional month fills, tied peaks, empty days, adjacent month isolation, category/completion filters, timezone, day details, dark theme and narrow width');
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
