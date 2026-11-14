// On-device acceptance check for the Playtime Android test APK (debug build: its WebView allows
// DevTools). Talks to the device with adb and drives the page over raw CDP (the WebView in many
// emulators is too old for Playwright's browser-level attach). Writes JSON and screenshots.
//   ADB=<adb.exe> SERIAL=127.0.0.1:16384 node device-check.cjs <phase> <outDir> [game]
// Phases: first (fresh install, no network use), restart (personal marks survive a restart),
//         seed + upgraded (install the new APK over an older one: marks, plans, new bundle),
//         bars (page inside the system bars, edge to edge), night (系统深浅色 reaches the shell),
//         offline (cold start with the app's traffic blocked), back, shell, tour,
//         security (another app cannot read the server), sync (one manual sync of one game).
const { execFileSync } = require("node:child_process"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const ADB = process.env.ADB, SERIAL = process.env.SERIAL || "127.0.0.1:16384", PKG = "io.github.zhenyufu039.playtime", FORWARD = 9333;
const phase = process.argv[2], out = path.resolve(process.argv[3] || "device-check");
fs.mkdirSync(out, { recursive: true });
const adb = (...args) => execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", timeout: 30000 }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GAMES = ["endfield-cn", "arknights-cn", "nikke-global", "azurlane-cn", "zzz-cn"];

async function waitFor(fn, label, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() > end) throw new Error("Timed out waiting for " + label); await sleep(1000); }
}

// Minimal CDP page: evaluate a function with one JSON argument, take screenshots.
class Page {
  constructor(ws, url) { this.ws = ws; this.pageUrl = url; this.id = 0; this.waiting = new Map(); ws.onmessage = m => { const r = JSON.parse(m.data); const w = this.waiting.get(r.id); if (w) { this.waiting.delete(r.id); r.error ? w.reject(new Error(r.error.message)) : w.resolve(r.result); } }; }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => { this.waiting.set(id, { resolve, reject }); setTimeout(() => { if (this.waiting.delete(id)) reject(new Error("CDP timeout: " + method)); }, 60000); }); }
  async evaluate(fn, arg) {
    const r = await this.send("Runtime.evaluate", { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true, userGesture: true }); // Clicks count as the user's (target=_blank needs that).
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitForFunction(fn, arg, label, ms = 30000) { return waitFor(() => this.evaluate(fn, arg), label, ms); }
  async screenshot(file) { const r = await this.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(out, file), Buffer.from(r.data, "base64")); }
  select(selector, value) { return this.evaluate(([s, v]) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); return el.value; }, [selector, value]); }
  click(selector) { return this.evaluate(s => { const el = document.querySelector(s); if (!el) throw new Error("missing " + s); el.click(); return true; }, selector); }
  url() { return this.pageUrl; }
  close() { this.ws.close(); }
}

async function attach() {
  const pid = await waitFor(() => adb("shell", "pidof", PKG), "app process");
  const socket = await waitFor(() => adb("shell", "cat /proc/net/unix").split("\n").map(l => l.trim().split(" ").pop()).find(n => n === "@webview_devtools_remote_" + pid), "WebView DevTools socket");
  adb("forward", "tcp:" + FORWARD, "localabstract:" + socket.slice(1));
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${FORWARD}/json/list`)).json()).find(t => t.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url)), "app page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const page = new Page(ws, target.url);
  await page.waitForFunction(() => !!(document.querySelector("#calendar") && window.PlaytimeWorkspace && document.querySelector("#game-select option")), null, "page ready", 120000);
  return { page, pid };
}
const state = page => page.evaluate(async () => (await fetch("/api/state")).json());
const launch = () => adb("shell", "am", "start", "-W", "-n", PKG + "/.MainActivity");
const save = (name, data) => fs.writeFileSync(path.join(out, name + ".json"), JSON.stringify(data, null, 2));
const installInfo = () => { const d = adb("shell", "dumpsys", "package", PKG); const pick = k => (new RegExp(k + "=([^\\s]+(?: [0-9:]+)?)").exec(d) || [])[1] || null; return { versionName: pick("versionName"), versionCode: pick("versionCode"), firstInstallTime: pick("firstInstallTime"), lastUpdateTime: pick("lastUpdateTime") }; };
const shownRows = page => page.evaluate(() => document.querySelectorAll("#calendar [data-event]").length);

(async () => {
  if (phase === "first") {
    adb("shell", "am", "force-stop", PKG); adb("shell", "pm", "clear", PKG); // A fresh install: no runtime, no data.
    const started = Date.now(); launch();
    const { page, pid } = await attach();
    const coldStartMs = Date.now() - started;
    const s = await state(page);
    const perGame = Object.fromEntries(GAMES.map(g => [g, s.events.filter(e => e.game === g).length]));
    const requests = s.network.sites.reduce((n, x) => n + x.requests, 0);
    for (const g of GAMES) assert.ok(perGame[g] > 0, "no bundled events for " + g);
    assert.equal(requests, 0, "the first launch contacted a source");
    assert.ok(Object.values(s.sync_schedule).every(x => x.enabled === false), "automatic sync is on");
    await page.screenshot("first-launch.png");
    // Filters on the first game: a category off and a search each narrow the list, and undo.
    const filter = await page.evaluate(async () => {
      const rows = () => document.querySelectorAll("#calendar [data-event]").length, wait = () => new Promise(r => setTimeout(r, 700));
      const box = document.querySelector('#category-filters input[data-category="event"]');
      const before = rows(); box.click(); await wait(); const categoryOff = rows(); box.click(); await wait(); const restored = rows();
      const search = document.querySelector("#event-search"), word = document.querySelector("#calendar [data-event] h3, #calendar [data-event] strong, #calendar [data-event]")?.innerText.trim().slice(0, 2);
      search.value = word; search.dispatchEvent(new Event("input", { bubbles: true })); await wait(); const searched = rows();
      search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); await wait();
      return { before, categoryOff, restored, search: word, searched, cleared: rows() };
    });
    assert.ok(filter.categoryOff < filter.before && filter.restored === filter.before, "category filter did not narrow and restore: " + JSON.stringify(filter));
    assert.ok(filter.searched > 0 && filter.searched < filter.before && filter.cleared === filter.before, "search did not narrow and restore: " + JSON.stringify(filter));
    // Switch through every game; each shows its own activities.
    const shown = {};
    for (const g of GAMES) {
      await page.select("#game-select", g);
      await page.waitForFunction(id => document.body.dataset.game === id, g, "game " + g);
      await sleep(700);
      shown[g] = await shownRows(page);
      await page.screenshot("game-" + g + ".png");
    }
    // Open a detail, star it and mark it complete with the dialog's own buttons.
    await page.select("#game-select", "nikke-global"); await sleep(700);
    const target = await page.evaluate(() => { const el = document.querySelector("#calendar [data-event]"); return el && el.dataset.event; });
    assert.ok(target, "no activity row to open");
    await page.click(`#calendar [data-event="${target}"]`);
    await page.waitForFunction(() => document.querySelector("#detail-dialog").open, null, "detail dialog");
    await sleep(500); await page.screenshot("detail.png");
    const before = (await state(page)).events.find(e => e.id === target);
    if (!before.starred) { await page.click("#toggle-starred"); await sleep(900); }
    if (!before.completed) { await page.click("#toggle-completed"); await sleep(900); }
    const marked = (await state(page)).events.find(e => e.id === target);
    assert.equal(marked.starred && marked.completed, true, "detail buttons did not save the marks");
    save("first", { pid, coldStartMs, appVersion: s.app_version, viewport: await page.evaluate(() => [innerWidth, innerHeight]), perGame, shownPerGame: shown, filter, networkRequests: requests, marked: { id: target, title: marked.title } });
    page.close();
  } else if (phase === "restart") {
    const { id } = JSON.parse(fs.readFileSync(path.join(out, "first.json"), "utf8")).marked;
    adb("shell", "am", "force-stop", PKG); launch();
    const { page, pid } = await attach();
    const e = (await state(page)).events.find(x => x.id === id);
    assert.equal(e.starred && e.completed, true, "marks were lost across a restart");
    await page.screenshot("after-restart.png");
    save("restart", { pid, id, starred: e.starred, completed: e.completed, port: new URL(page.url()).port });
    page.close();
  } else if (phase === "security") {
    // adb shell runs as another Linux user (another "app"): it can reach the port but has no cookie.
    const { page } = await attach();
    const port = Number(new URL(page.url()).port);
    const ask = (p, extra = "") => adb("shell", `printf 'GET ${p} HTTP/1.0\\r\\nHost: 127.0.0.1:${port}\\r\\n${extra}\\r\\n' | nc -w 3 127.0.0.1 ${port} | head -1`);
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    const result = { port, state: ask("/api/state"), page: ask("/"), forged: ask("/api/state", "Cookie: playtime_session=guess\\r\\n"),
      listen: adb("shell", "cat /proc/net/tcp /proc/net/tcp6").split("\n").map(l => l.trim().split(/\s+/)).filter(f => f[1] && f[1].endsWith(":" + hex) && f[3] === "0A").map(f => f[1]) };
    for (const k of ["state", "page", "forged"]) assert.match(result[k], /403/, k + " was served without the session");
    assert.ok(result.listen.length > 0 && result.listen.every(a => a.startsWith("0100007F:")), "server listens beyond loopback: " + result.listen);
    save("security", result);
    page.close();
  } else if (phase === "sync") {
    const game = process.argv[4] || "endfield-cn";
    const { page } = await attach();
    const before = (await state(page)).events.filter(e => e.game === game).length;
    await page.select("#game-select", game); await sleep(500);
    const status = await page.evaluate(async g => { const s = await (await fetch("/api/state")).json(); const r = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json", "X-Calendar-Token": s.csrf_token }, body: JSON.stringify({ game: g }) }); return r.status; }, game);
    await sleep(3000);
    const done = await waitFor(async () => { const s = await state(page); const x = s.sync_by_game[game]; return x && !x.running ? s : null; }, "sync to finish", 300000);
    await sleep(800); await page.screenshot("after-sync.png");
    const sync = done.sync_by_game[game];
    save("sync", { game, httpStatus: status, eventsBefore: before, eventsAfter: done.events.filter(e => e.game === game).length, sync, requests: done.network.sites.filter(x => x.requests).map(x => ({ site: x.site, requests: x.requests, error: x.error })), statusLine: await page.evaluate(() => document.querySelector("#source-status")?.innerText) });
    page.close();
  } else if (phase === "link") {
    // A source link leaves the app for the system browser; the app page stays where it was.
    const { page } = await attach();
    await page.select("#game-select", "nikke-global"); await sleep(700);
    const id = await page.evaluate(() => document.querySelector("#calendar [data-event]").dataset.event);
    await page.click(`#calendar [data-event="${id}"]`);
    await page.waitForFunction(() => document.querySelector("#detail-dialog").open, null, "detail dialog");
    const href = await page.evaluate(() => { const a = [...document.querySelectorAll("#detail-content a[href]")].find(x => /^https?:/.test(x.href) && !x.href.startsWith(location.origin)); a.click(); return a.href; });
    await sleep(2500);
    const resumed = adb("shell", "dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity'");
    const stillHere = await page.evaluate(() => location.origin + location.pathname);
    assert.ok(!resumed.includes(PKG), "the link opened inside the app: " + resumed);
    assert.ok(stillHere.startsWith("http://127.0.0.1:"), "the app page navigated away");
    adb("shell", "input", "keyevent", "4"); await sleep(1500);
    save("link", { href, resumed, appPage: stillHere, backToApp: adb("shell", "dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity'") });
    page.close();
  } else if (phase === "touch") {
    // Real Android touch input on the timeline: a swipe scrolls the page, a tap opens the detail.
    const { page } = await attach();
    await page.select("#game-select", "endfield-cn"); await sleep(500);
    await page.click("#timeline-view"); await sleep(900);
    const info = await page.evaluate(() => { const rows = [...document.querySelectorAll("#calendar .timeline-row[data-row-event]")]; rows[2].scrollIntoView({ block: "center" }); return { dpr: devicePixelRatio, heights: rows.map(r => Math.round(r.getBoundingClientRect().height)), starVisible: !!document.querySelector("#calendar [data-event-star]")?.checkVisibility() }; });
    await sleep(500);
    // The WebView fills the screen below the status bar; map CSS pixels to screen pixels from the window's top.
    const top = Number(adb("shell", "dumpsys window windows | grep -m1 -A20 'io.github.zhenyufu039.playtime/' | grep -m1 -o 'mFrame=\\[[0-9]*,[0-9]*' | sed 's/.*,//'") || 0);
    const at = sel => page.evaluate(s => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel);
    const screen = ([x, y]) => [Math.round(x * info.dpr), Math.round(y * info.dpr + top)];
    const swipes = {};
    for (const [label, sel] of [["bar", "#calendar .timeline-row[data-row-event]:nth-of-type(3) .bar-cell"], ["name", "#calendar .timeline-row[data-row-event]:nth-of-type(3) .event-name"]]) {
      await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: "center" }), sel); await sleep(600);
      const before = await page.evaluate(() => scrollY), [x, y] = screen(await at(sel));
      adb("shell", "input", "swipe", String(x), String(y), String(x), String(y - 400), "350"); await sleep(1500);
      swipes[label] = { before, after: await page.evaluate(() => scrollY) };
      assert.ok(swipes[label].after > swipes[label].before + 50, "swipe on " + label + " did not scroll: " + JSON.stringify(swipes[label]));
    }
    const sel = "#calendar .timeline-row[data-row-event] .event-name";
    await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: "center" }), sel); await sleep(800);
    const [tx, ty] = screen(await at(sel));
    adb("shell", "input", "tap", String(tx), String(ty)); await sleep(1200);
    const detail = await page.evaluate(() => document.querySelector("#detail-dialog").open);
    await page.screenshot("touch-detail.png");
    assert.ok(detail, "a tap on the row did not open the detail");
    await page.evaluate(() => document.querySelector("#detail-dialog [data-close]").click()); await sleep(500);
    await page.screenshot("touch-timeline.png");
    assert.ok(!info.starVisible && Math.max(...info.heights) <= 130, "rows are not compact: " + JSON.stringify(info));
    save("touch", { ...info, statusBarOffset: top, swipes, detailOpenedByTap: detail });
    page.close();
  } else if (phase === "art") {
    // Timeline bars with artwork: the date label must sit on the faded part, readable.
    const game = process.argv[4] || "nikke-global";
    const { page } = await attach();
    await page.select("#game-select", game); await sleep(500);
    await page.click("#timeline-view"); await sleep(1200);
    const bars = await page.evaluate(() => [...document.querySelectorAll("#calendar .event-bar.has-art")].slice(0, 6).map(b => {
      const art = b.querySelector(".bar-art"), lab = b.querySelector(".bar-label"), s = getComputedStyle(art), bb = b.getBoundingClientRect(), ab = art.getBoundingClientRect(), lb = lab.getBoundingClientRect();
      return { id: b.dataset.event, bar: [Math.round(bb.width), Math.round(bb.height)], art: [Math.round(ab.width), Math.round(ab.height)], mask: (s.webkitMaskImage && s.webkitMaskImage !== "none" ? s.webkitMaskImage : s.maskImage || "").slice(0, 80), labelLeft: Math.round(lb.left - bb.left), labelWidth: Math.round(lb.width), artRight: Math.round(ab.right - bb.left), text: lab.textContent, shadow: getComputedStyle(lab).textShadow.slice(0, 60), background: getComputedStyle(lab).backgroundColor };
    }));
    assert.ok(bars.length > 0, "no artwork bars on " + game);
    await page.evaluate(() => document.querySelector("#calendar .event-bar.has-art").closest(".timeline-row").scrollIntoView({ block: "start" })); await sleep(600);
    await page.screenshot("art-" + game + ".png");
    save("art-" + game, { bars });
    page.close();
  } else if (phase === "back") {
    // The hardware Back key: with the app shell present it closes layers first; with nothing to
    // close (or no shell yet) the app finishes instead of navigating the WebView away.
    adb("shell", "am", "force-stop", PKG); launch();
    const { page } = await attach();
    const shell = await page.evaluate(() => !!(window.PlaytimeShell && PlaytimeShell.enabled()));
    const url = page.url();
    adb("shell", "input", "keyevent", "4"); await sleep(1500);
    const top = adb("shell", "dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'");
    assert.ok(!top.includes(PKG), "Back on the main page did not leave the app: " + top);
    save("back", { shellPresent: shell, url, topAfterBack: top });
    page.close();
  } else if (phase === "shell") {
    // The app shell on the device's real local data: home, a detail with artwork, the month view.
    const { page } = await attach();
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true" && !!document.querySelector("#pt-shell [data-open-event]"), null, "shell with activities", 60000);
    const read = () => page.evaluate(() => ({ hash: location.hash, title: document.querySelector("#pt-shell .ps-title")?.textContent, rows: document.querySelectorAll("#pt-shell [data-open-event]").length, sync: document.querySelector("#pt-shell .ps-sync")?.textContent.trim(), scope: document.querySelector("#pt-shell .ps-scope")?.textContent.trim() }));
    const home = await read();
    await page.screenshot("shell-home.png");
    // A detail with real artwork if any row has one.
    const withArt = await page.evaluate(() => { const ids = [...document.querySelectorAll("#pt-shell [data-open-event]")].map(b => b.dataset.openEvent); return ids[0] || null; });
    let detail = null;
    if (withArt) {
      await page.click(`#pt-shell [data-open-event="${withArt}"]`); await sleep(900);
      detail = await page.evaluate(() => ({ title: document.querySelector("#pt-shell .ps-detail-t")?.textContent, art: !!document.querySelector("#pt-shell .ps-hero-img"), artLoaded: (() => { const i = document.querySelector("#pt-shell .ps-hero-img"); return i ? i.complete && i.naturalWidth > 0 : null; })(), source: document.querySelector("#pt-shell .ps-source")?.href || null }));
      await page.screenshot("shell-detail.png");
      adb("shell", "input", "keyevent", "4"); await sleep(900);
    }
    const afterBack = await read();
    await page.click('#pt-shell [data-tab="calendar"]'); await sleep(900);
    const month = await page.evaluate(() => ({ title: document.querySelector("#pt-shell .ps-month-h span")?.textContent, cells: document.querySelectorAll("#pt-shell .ps-cell[data-open-day]").length, withCounts: document.querySelectorAll("#pt-shell .ps-cell-n").length, today: document.querySelector("#pt-shell .ps-today")?.dataset.openDay }));
    await page.screenshot("shell-month.png");
    adb("shell", "input", "keyevent", "4"); await sleep(900);
    const backToHome = await read();
    assert.ok(home.rows > 0 && home.title === "近期", "shell home did not show activities: " + JSON.stringify(home));
    assert.ok(!detail || afterBack.hash === "#/upcoming", "Back did not close the detail: " + afterBack.hash);
    assert.ok(month.cells >= 28 && month.today, "month view incomplete: " + JSON.stringify(month));
    assert.equal(backToHome.title, "近期", "Back from 日历 did not return to 近期");
    save("shell", { home, detail, afterBack: afterBack.hash, month, backToHome: backToHome.hash });
    page.close();
  } else if (phase === "debugback") {
    const { page } = await attach();
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true" && !!document.querySelector("#pt-shell [data-open-event]"), null, "shell with activities", 60000);
    await page.evaluate(() => { window.__calls = []; const orig = PlaytimeShell.back; PlaytimeShell.back = () => { const r = orig(); __calls.push([r, location.hash, history.length]); return r; }; addEventListener("popstate", () => __calls.push(["pop", location.hash])); });
    const id = await page.evaluate(() => document.querySelector("#pt-shell [data-open-event]").dataset.openEvent);
    await page.click(`#pt-shell [data-open-event="${id}"]`); await sleep(800);
    const before = await page.evaluate(() => [location.hash, history.length]);
    adb("shell", "input", "keyevent", "4"); await sleep(1500);
    console.log(JSON.stringify({ before, calls: await page.evaluate(() => __calls), after: await page.evaluate(() => [location.hash, history.length]) }));
    page.close();
  } else if (phase === "seed") {
    // Before an upgrade (after "first"): a personal plan with notes, and the bundled build in use.
    const { page } = await attach();
    const created = await page.evaluate(async () => {
      const token = (await (await fetch("/api/state")).json()).csrf_token; // Writes carry the page's token, as the app does.
      const r = await fetch("/api/plans", { method: "POST", headers: { "Content-Type": "application/json", "X-Calendar-Token": token }, body: JSON.stringify({ title: "升级前的计划", start: "2026-11-20T12:00:00Z", end: "2026-11-20T14:00:00Z", timezone: "Asia/Shanghai", notes: "覆盖安装后应保留" }) }); // Fields the first release accepts.
      return { status: r.status, body: await r.json() };
    });
    assert.equal(created.status, 200, "plan was not saved: " + JSON.stringify(created));
    const plan = (await state(page)).plans.find(p => p.title === "升级前的计划");
    assert.ok(plan, "saved plan missing");
    save("seed", { plan, stamp: adb("shell", "run-as", PKG, "cat", "files/runtime/BUILD_STAMP"), install: installInfo() });
    page.close();
  } else if (phase === "upgraded") {
    // After installing the new APK over the old one: same data, new bundled build, the new shell.
    const { marked } = JSON.parse(fs.readFileSync(path.join(out, "first.json"), "utf8"));
    const seed = JSON.parse(fs.readFileSync(path.join(out, "seed.json"), "utf8"));
    adb("shell", "am", "force-stop", PKG); launch();
    const { page } = await attach();
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true" && !!document.querySelector("#pt-shell .ps-title"), null, "new app shell", 60000);
    const s = await state(page);
    const e = s.events.find(x => x.id === marked.id), plan = s.plans.find(p => p.id === seed.plan.id);
    assert.ok(e && e.starred && e.completed, "marks were lost by the upgrade");
    assert.ok(plan && plan.notes === seed.plan.notes && plan.start === seed.plan.start && plan.end === seed.plan.end && plan.timezone === seed.plan.timezone, "plan changed or was lost by the upgrade: " + JSON.stringify(plan));
    const stamp = adb("shell", "run-as", PKG, "cat", "files/runtime/BUILD_STAMP"), install = installInfo();
    assert.notEqual(stamp, seed.stamp, "the bundled build was not replaced");
    assert.equal(install.firstInstallTime, seed.install.firstInstallTime, "this was a fresh install, not an upgrade");
    await page.click('#pt-shell [data-tab="plans"]'); await sleep(900);
    const card = await page.evaluate(id => !!document.querySelector(`#pt-shell [data-edit-plan="${id}"]`), seed.plan.id);
    assert.ok(card, "the kept plan is not shown in 计划");
    await page.screenshot("upgraded-plans.png");
    save("upgraded", { stampBefore: seed.stamp, stampAfter: stamp, installBefore: seed.install, installAfter: install, marked: marked.id, plan: plan.id });
    page.close();
  } else if (phase === "bars") {
    // Edge to edge (Android 15, targetSdk 35): the page sits between the system bars, and the
    // shell's bar colour reaches the host.
    const { page } = await attach();
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true", null, "shell", 60000);
    // The view tree of this app's activity (uiautomator cannot dump a page that never goes idle).
    const tree = adb("shell", "dumpsys activity top").split("ACTIVITY ").find(part => part.startsWith(PKG)) || "";
    const web = /android\.webkit\.WebView\{[^}]* (\d+),(\d+)-(\d+),(\d+)\}/.exec(tree);
    const status = /type=statusBars frame=\[0,0\]\[\d+,(\d+)\] visible=true/.exec(adb("shell", "dumpsys window"));
    assert.ok(web, "WebView not found in the window");
    const top = Number(web[2]), statusHeight = status ? Number(status[1]) : 0;
    assert.ok(top >= statusHeight, `page starts at ${top}px, under the ${statusHeight}px status bar`);
    const host = await page.evaluate(() => typeof window.PlaytimeHost?.setBars === "function");
    assert.ok(host, "the bar colour bridge is missing");
    await page.screenshot("bars.png");
    save("bars", { webViewBounds: web.slice(1).map(Number), statusBarHeight: statusHeight, bridge: host });
    page.close();
  } else if (phase === "night") {
    // A system light/dark switch while a plan is being typed: the activity is not recreated (same
    // process, same page), the typed title stays, and the shell follows the system.
    adb("shell", "cmd", "uimode", "night", "no"); adb("shell", "am", "force-stop", PKG); launch();
    const { page, pid } = await attach();
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true", null, "shell", 60000);
    await page.evaluate(() => { location.hash = "#/plans"; });
    await page.waitForFunction(() => !!document.querySelector("#pt-shell .ps-fab"), null, "plans page");
    await page.click("#pt-shell .ps-fab");
    await page.waitForFunction(() => !!document.querySelector('#pt-shell [name="title"]'), null, "plan form");
    await page.evaluate(() => { const i = document.querySelector('#pt-shell [name="title"]'); i.value = "切换深浅色时在写"; i.dispatchEvent(new Event("input", { bubbles: true })); });
    const read = () => page.evaluate(() => ({ theme: document.querySelector("#pt-shell").dataset.theme, system: document.documentElement.dataset.systemDark, title: document.querySelector('#pt-shell [name="title"]')?.value }));
    const results = { start: await read() };
    for (const mode of ["yes", "no"]) {
      adb("shell", "cmd", "uimode", "night", mode);
      const want = mode === "yes" ? "dark" : "light";
      await page.waitForFunction(w => document.querySelector("#pt-shell").dataset.theme === w, want, "theme " + want, 15000);
      results[mode] = { ...(await read()), pid: adb("shell", "pidof", PKG) };
      await page.screenshot("night-live-" + mode + ".png");
    }
    assert.equal(results.yes.title, "切换深浅色时在写", "the draft was lost by the dark switch");
    assert.equal(results.no.title, "切换深浅色时在写", "the draft was lost by the light switch");
    assert.equal(results.yes.pid, pid, "the app process changed");
    await page.evaluate(() => { PlaytimeShell.back(); }); // Leave the draft: Back asks, then discard.
    await sleep(300); await page.evaluate(() => document.querySelector('#pt-shell [data-draft="discard"]')?.click());
    save("night", results);
    page.close();
  } else if (phase === "persist") {
    // 外观 → 深色 survives a cold start: the server comes back on the same port, so the page keeps
    // its origin and its stored choice.
    adb("shell", "cmd", "uimode", "night", "no");
    let { page } = await attach();
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true", null, "shell", 60000);
    const before = new URL(page.url()).port;
    await page.evaluate(() => { location.hash = "#/me/appearance"; });
    await page.waitForFunction(() => !!document.querySelector('#pt-shell [data-appearance="dark"]'), null, "appearance page");
    await page.click('#pt-shell [data-appearance="dark"]');
    await page.waitForFunction(() => document.querySelector("#pt-shell").dataset.theme === "dark", null, "dark chosen");
    await sleep(5000); // The WebView writes page storage to disk shortly after; a later kill keeps it.
    page.close();
    adb("shell", "am", "force-stop", PKG); launch();
    ({ page } = await attach());
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true", null, "shell", 60000);
    const after = new URL(page.url()).port, theme = await page.evaluate(() => document.querySelector("#pt-shell").dataset.theme);
    // Put it back to 跟随系统 for later checks.
    await page.evaluate(() => { location.hash = "#/me/appearance"; }); await sleep(600);
    await page.click('#pt-shell [data-appearance="system"]'); await sleep(600);
    assert.equal(after, before, "the server came back on another port");
    assert.equal(theme, "dark", "the chosen 深色 was not kept across a cold start");
    save("persist", { portBefore: before, portAfter: after, themeAfterRestart: theme });
    page.close();
  } else if (phase === "keyboard") {
    // With the keyboard up (edge to edge, adjustResize no longer applies), the page shrinks to the
    // space above it and the focused field is visible.
    const { page } = await attach();
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true", null, "shell", 60000);
    await page.evaluate(() => { location.hash = "#/plans"; });
    await page.waitForFunction(() => !!document.querySelector("#pt-shell .ps-fab"), null, "plans page");
    await page.click("#pt-shell .ps-fab"); await sleep(800);
    const before = await page.evaluate(() => innerHeight);
    const box = await page.evaluate(() => { const r = document.querySelector('#pt-shell [name="title"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, dpr: devicePixelRatio }; });
    const tree = () => adb("shell", "dumpsys activity top").split("ACTIVITY ").find(part => part.startsWith(PKG)) || "";
    const top = Number(/android\.webkit\.WebView\{[^}]* \d+,(\d+)-/.exec(tree())[1]);
    adb("shell", "input", "tap", String(Math.round(box.x * box.dpr)), String(Math.round(top + box.y * box.dpr)));
    await sleep(2000);
    const ime = /mInputShown=(\w+)/.exec(adb("shell", "dumpsys input_method"))?.[1];
    const webAfter = /android\.webkit\.WebView\{[^}]* (\d+,\d+-\d+,\d+)\}/.exec(tree())?.[1];
    const imeInset = /type=ime frame=(\[[^ ]+\]) visible=(\w+)/.exec(adb("shell", "dumpsys window"))?.slice(1).join(" visible=");
    const after = await page.evaluate(() => { const r = document.activeElement?.getBoundingClientRect(); return { innerHeight, focused: document.activeElement?.name || null, fieldBottom: r ? r.bottom : null }; });
    await page.screenshot("keyboard.png");
    adb("shell", "input", "keyevent", "111"); await sleep(500); // Escape closes the keyboard.
    await page.evaluate(() => { PlaytimeShell.back(); });
    save("keyboard", { imeShown: ime, imeInset, webViewAfter: webAfter, innerHeightBefore: before, ...after });
    assert.equal(after.focused, "title", "the title field did not take focus");
    // Some emulators report the keyboard as shown but give it no height (no space to avoid).
    const imeHeight = (() => { const m = /\[\d+,(\d+)\]\[\d+,(\d+)\]/.exec(imeInset || ""); return m ? Number(m[2]) - Number(m[1]) : 0; })();
    if (ime === "true" && imeHeight > 0) {
      assert.ok(after.innerHeight < before, "the page did not shrink above the keyboard");
      assert.ok(after.fieldBottom <= after.innerHeight, "the focused field is under the keyboard");
    } else console.log("NOTE keyboard: the on-screen keyboard took no screen space on this device (" + imeInset + "); not tested here");
    page.close();
  } else if (phase === "fontscale") {
    // The phone's text size (设置 → 显示 → 字体大小) reaches the page, and the shell still fits at
    // the largest common setting: nothing wider than the screen, tab labels and row titles shown.
    const original = adb("shell", "settings", "get", "system", "font_scale");
    const results = {};
    try {
      for (const scale of ["1.0", "1.3", "2.0"]) {
        adb("shell", "settings", "put", "system", "font_scale", scale); await sleep(1500);
        adb("shell", "am", "force-stop", PKG); launch();
        const { page } = await attach();
        await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true" && !!document.querySelector("#pt-shell .ps-title"), null, "shell", 60000);
        await sleep(800);
        results[scale] = await page.evaluate(() => {
          const px = sel => { const el = document.querySelector(sel); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
          const wide = [...document.querySelectorAll("#pt-shell *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== "absolute").length;
          const tabs = [...document.querySelectorAll("#pt-shell .ps-tabs button")].map(b => ({ text: b.innerText.trim(), fits: b.scrollWidth <= b.clientWidth + 1 }));
          return { title: px("#pt-shell .ps-title"), rowTitle: px("#pt-shell .ps-row-title"), body: px("#pt-shell .ps-note"), innerWidth, overflowing: wide, horizontalScroll: document.documentElement.scrollWidth > innerWidth + 1, tabs };
        });
        await page.screenshot("fontscale-" + scale + ".png");
        if (scale === "2.0") {
          // The other screens at the largest size, for review (and the same overflow check).
          const first = await page.evaluate(() => document.querySelector("#pt-shell [data-open-event]")?.dataset.openEvent || "");
          for (const [name, hash] of [["detail", "#/upcoming?event=" + first], ["filter", "#/upcoming?sheet=filter"], ["month", "#/calendar/month"], ["timeline", "#/calendar/timeline"], ["plan", "#/plans?sheet=plan-new"], ["appearance", "#/me/appearance"], ["sync", "#/me/sync"]]) {
            await page.evaluate(h => { location.hash = h; }, hash); await sleep(1200);
            results["2.0-" + name] = await page.evaluate(() => ({ overflowing: [...document.querySelectorAll("#pt-shell *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== "absolute" && !el.closest("#ps-timeline-mount")).length }));
            await page.screenshot("fontscale-2.0-" + name + ".png");
          }
          await page.evaluate(() => { history.replaceState(null, "", "#/upcoming"); });
        }
        page.close();
      }
    } finally {
      adb("shell", "settings", "put", "system", "font_scale", original === "null" ? "1.0" : original);
      adb("shell", "am", "force-stop", PKG);
    }
    save("fontscale", { original, results });
    console.log(JSON.stringify(results));
  } else if (phase === "resetlook") {
    // Test housekeeping: 外观 back to 跟随系统 and 标准 after checks that changed it.
    const { page } = await attach();
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true", null, "shell", 60000);
    await page.evaluate(() => { location.hash = "#/me/appearance"; });
    await page.waitForFunction(() => !!document.querySelector('#pt-shell [data-appearance="system"]'), null, "appearance page");
    await page.click('#pt-shell [data-appearance="system"]'); await sleep(600);
    if (await page.evaluate(() => !!document.querySelector('#pt-shell [data-preset="light"]'))) { await page.click('#pt-shell [data-preset="light"]'); await sleep(800); }
    const look = await page.evaluate(() => ({ preset: document.querySelector("#pt-shell").dataset.preset, mode: document.querySelector('#pt-shell [data-appearance][aria-checked="true"]')?.dataset.appearance }));
    await sleep(4000); // Let the WebView write its page storage before anything stops the app.
    page.evaluate(() => { history.replaceState(null, "", "#/upcoming"); }).catch(() => {});
    assert.deepEqual(look, { preset: "light", mode: "system" });
    save("resetlook", look);
    page.close();
  } else if (phase === "offline") {
    // Run with the app's own traffic blocked (outside loopback): a cold start still shows the
    // calendar from local data. No sync is attempted.
    adb("shell", "am", "force-stop", PKG); launch();
    const { page } = await attach();
    await page.waitForFunction(() => document.documentElement.dataset.shellReady === "true" && !!document.querySelector("#pt-shell [data-open-event]"), null, "shell with activities offline", 60000);
    const rows = await page.evaluate(() => document.querySelectorAll("#pt-shell [data-open-event]").length);
    await page.screenshot("offline.png");
    save("offline", { rows });
    page.close();
  } else if (phase === "tour") {
    // Screens of the current app for a UI/UX review: each main page, full length.
    const { page } = await attach();
    const full = async name => {
      const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: Math.max(document.documentElement.scrollHeight, innerHeight) }));
      const r = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, 6000), scale: 1 } });
      fs.writeFileSync(path.join(out, name + ".jpg"), Buffer.from(r.data, "base64"));
      return Math.round(h);
    };
    const reset = () => page.evaluate(() => { document.querySelectorAll("dialog[open]").forEach(d => d.close()); scrollTo(0, 0); });
    const lengths = {};
    await page.select("#game-select", "zzz-cn"); await sleep(600);
    const steps = [
      ["01-home-upcoming", "#upcoming-view"], ["02-timeline", "#timeline-view"], ["03-month", "#month-view"], ["04-list", "#list-view"],
      ["05-filter-sheet", "#filter-button"], ["06-detail", "#calendar [data-event]"], ["07-plans", "#rail-plans"], ["08-games", "#rail-games"],
      ["09-settings", "#workspace-button"], ["10-reminders", "#inbox-button"], ["11-sync", "#data-button"]];
    for (const [name, sel] of steps) {
      await reset(); await sleep(300);
      if (name !== "06-detail") await page.click("#upcoming-view").catch(() => {});
      await sleep(400);
      await page.click(sel).catch(e => { lengths[name] = "missing: " + e.message; });
      await sleep(1200);
      lengths[name] = lengths[name] || await full(name);
    }
    await reset();
    save("tour", { lengths, viewport: await page.evaluate(() => [innerWidth, innerHeight]) });
    page.close();
  } else throw new Error("unknown phase " + phase);
  console.log("PASS", phase);
  process.exit(0);
})().catch(error => { console.error("FAIL", phase, error); process.exit(1); });
