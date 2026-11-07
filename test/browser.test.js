// Optional real Chromium/Brave smoke test. Uses a temporary, unauthenticated
// browser profile and in-memory database, never the user's data or ICS feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { AcademicService } from '../src/service.js';
import { createApp } from '../src/server.js';
import { ChatManager } from '../src/chat.js';
import { fakeChatFactory } from '../test-support/fake-chat.js';
import { DateTime } from 'luxon';

test('desktop browser: redesigned workspace, keyboard navigation, themes, planning and CRUD' , { skip: !process.env.ACADEMIC_BROWSER, timeout: 30000 }, async t => {
  const store = new Store(':memory:');
  const service = new AcademicService(store, { frenchStartDate: '2026-01-01', refreshMinutes: 15 }, fetch, () => DateTime.fromISO('2026-11-19T10:00:00', { zone: 'Europe/Paris' }));
  const fake = fakeChatFactory(async ({ text, call, answer, signal }) => {
    if (text === 'Browser slow reply') { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return; }
    if (text === 'Browser create assignment') {
      const result = await call('create_assignment', { title: 'Browser AI assignment' });
      answer(result.isError ? 'Change was not approved.' : 'Saved Browser AI assignment after approval.');
      return;
    }
    await call('get_academic_overview', {});
    answer('Fixture answer backed by your overview. <img src=x onerror="window.chatXss=true">');
  });
  const chat = new ChatManager(service, fake);
  const server = createApp(service, 0, { chat });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const profile = mkdtempSync(join(tmpdir(), 'academic-browser-'));
  const browser = spawn(process.env.ACADEMIC_BROWSER, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', '--disable-background-networking', '--disable-component-update', 'about:blank'], { stdio: 'ignore' });
  let launchError, socket;
  browser.on('error', error => { launchError = error; });
  t.after(async () => {
    socket?.close();
    if (browser.pid && browser.exitCode === null) { const exited = once(browser, 'exit'); browser.kill('SIGKILL'); await exited; }
    await chat.close();
    server.close(); server.closeAllConnections(); await once(server, 'close');
    store.close(); rmSync(profile, { recursive: true, force: true });
  });
  let address;
  for (let i = 0; i < 200 && !address; i++) {
    if (launchError) throw launchError;
    try { const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n'); address = `ws://127.0.0.1:${port}${path}`; } catch { await sleep(50); }
  }
  assert.ok(address, 'Browser debugging endpoint started');
  socket = new WebSocket(address);
  await once(socket, 'open');
  let id = 0, session;
  const pending = new Map(), errors = [], violations = [], externalRequests = [];
  const base = `http://127.0.0.1:${server.address().port}`;
  let acceptDialog = false;
  function send(method, params = {}, sessionId = session) {
    return new Promise((resolve, reject) => {
      const callId = ++id;
      pending.set(callId, { resolve, reject });
      socket.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message)); else call?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.source === 'violation') violations.push(message.params.entry.text);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && !message.params.request.url.startsWith(`${base}/`)) externalRequests.push(message.params.request.url);
    if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: acceptDialog });
  });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async function wait(expression) {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await sleep(25); }
    const diagnostic = await evaluate('({hash:location.hash,activeTag:document.activeElement.tagName,activeName:document.activeElement.name,activeId:document.activeElement.id,commandOpen:document.querySelector("#command-dialog").open})');
    throw new Error(`Browser condition not reached: ${expression}; ${JSON.stringify(diagnostic)}; ${JSON.stringify(errors)}`);
  }
  async function screenshot(name, target) {
    if (!process.env.UI_SCREENSHOT_DIR) return;
    mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
    if (target) await evaluate(`document.getElementById(${JSON.stringify(target)}).scrollIntoView({block:'start',behavior:'instant'})`);
    else await evaluate('window.scrollTo({top:0,behavior:"instant"})');
    await evaluate('Promise.all(document.getAnimations().filter(a => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(process.env.UI_SCREENSHOT_DIR, `${name}.png`), Buffer.from(image.data, 'base64'));
  }
  async function key(key, code = key, modifiers = 0) {
    const virtualKey = { Enter: 13, ArrowDown: 40, ArrowUp: 38, Escape: 27, KeyK: 75, Digit2: 50 }[code];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: virtualKey });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtualKey });
  }
  await send('Page.navigate', { url: base });
  await wait('document.querySelector("#dashboard-content")?.hidden === false');
  assert.equal(await evaluate('document.querySelector("#dashboard").hidden'), false);
  assert.equal(await evaluate('document.querySelectorAll("#dashboard-week .calendar-day").length'), 7);
  assert.ok(await evaluate('document.querySelector("#dashboard-calendar-status").textContent.includes("has not synchronized")'));
  await wait('document.querySelector("#planning-result")?.hidden === false');
  assert.ok(await evaluate('document.querySelector("#planning-status").textContent.includes("unavailable")'));
  await evaluate('document.fonts.ready');
  assert.equal(await evaluate('document.fonts.check("14px Manrope")'), true);
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  assert.equal(await evaluate('document.querySelector("#stat-classes").textContent'), '—', 'Incomplete calendars must not present a fabricated total');
  assert.equal(await evaluate('document.querySelector("#stat-deadlines").textContent'), '0');
  await screenshot('01-dashboard-empty');
  await evaluate('document.querySelector("[data-open-page=calendar]").click()');
  await wait('document.querySelector("#timetable .calendar-day") !== null');
  await evaluate('document.querySelector("[data-page=assignments]").click()');
  await wait('!document.querySelector("#assignments").hidden && document.querySelector("#assignments-list").textContent.includes("No matching")');
  await evaluate(`const form = document.querySelector('#assignments-form'); form.elements.title.value = 'Browser probability'; form.elements.course.value = 'Probability'; form.requestSubmit();`);
  await wait('document.querySelector("#assignments-list").textContent.includes("Browser probability")');
  let assignment = service.records.list('assignments').items[0];
  assert.equal(assignment.dueDate, null);
  assert.equal(assignment.dueTime, null);
  await screenshot('02-assignments');
  await evaluate(`[...document.querySelectorAll('#assignments-list button')].find(b => b.textContent === 'Edit').click()`);
  await wait('document.querySelector("#assignments-editor-title").textContent.includes("Edit")');
  await evaluate(`document.querySelector('#assignments-form').elements.description.value = 'Manual edit'; document.querySelector('#assignments-form').requestSubmit()`);
  await wait('document.querySelector("#assignments-list").textContent.includes("Manual edit")');
  await evaluate(`[...document.querySelectorAll('#assignments-list button')].find(b => b.textContent === 'Mark completed').click()`);
  await wait('!document.querySelector("#assignments-list").textContent.includes("Mark completed")');
  assignment = service.records.get('assignments', assignment.id);
  assert.equal(assignment.status, 'completed');
  assert.equal(assignment.description, 'Manual edit');
  await evaluate('document.querySelector("[data-record-status=completed]").click()');
  await wait('document.querySelector("[data-record-status=completed]").getAttribute("aria-pressed") === "true" && document.querySelector("#assignments-list").getAttribute("aria-busy") === "false"');
  assert.ok(await evaluate('document.querySelector("#assignments-list").textContent.includes("Browser probability")'));
  await evaluate(`[...document.querySelectorAll('#assignments-list button')].find(b => b.textContent === 'Delete').click()`);
  assert.equal(service.records.list('assignments').total, 1, 'Dismissing confirmation preserves record');
  acceptDialog = true;
  await evaluate(`[...document.querySelectorAll('#assignments-list button')].find(b => b.textContent === 'Delete').click()`);
  await wait('document.querySelector("#assignments-list").textContent.includes("No matching")');
  assert.equal(service.records.list('assignments').total, 0);
  await evaluate(`document.querySelector('[data-page=exams]').click(); const exam = document.querySelector('#exams-form'); exam.elements.subject.value = 'Browser algebra'; exam.elements.examDate.value = '2026-11-20'; exam.elements.startTime.value = '09:00'; exam.elements.topics.value = 'Matrices\\nEigenvalues'; exam.requestSubmit();`);
  await wait('document.querySelector("#exams-list").textContent.includes("Browser algebra")');
  const exam = service.records.list('exams').items[0];
  assert.equal(exam.startTime, '09:00');
  assert.equal(exam.durationMinutes, null);
  assert.deepEqual(exam.topics, ['Matrices', 'Eigenvalues']);
  await screenshot('03-exams');
  await evaluate('document.querySelector("[data-page=calendar]").click()');
  assert.equal(await evaluate('document.querySelector("#calendar").hidden'), false);
  const overdue = service.records.create('assignments', { title: 'Dashboard overdue <img src=x onerror="window.dashboardXss=true">', dueDate: '2026-11-18' });
  service.records.create('assignments', { title: 'Dashboard date-only', dueDate: '2026-11-19' });
  service.records.create('exams', { subject: 'Dashboard undated exam' });
  service.records.create('exams', { subject: 'Dashboard conflicting exam', examDate: '2026-11-19', startTime: '15:00', durationMinutes: 60 });
  store.saveSync('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:browser-class\r\nDTSTART;TZID=Europe/Paris:20261119T150000\r\nDTEND;TZID=Europe/Paris:20261119T170000\r\nSUMMARY:Dashboard university class\r\nEND:VEVENT\r\nEND:VCALENDAR', '2026-11-19T08:00:00Z');
  await evaluate('document.querySelector("[data-page=dashboard]").click()');
  await wait('document.querySelector("#dashboard-attention").textContent.includes("Dashboard overdue")');
  assert.ok(await evaluate('document.querySelector("#dashboard-today").textContent.includes("Dashboard date-only")'));
  assert.ok(await evaluate('document.querySelector("#dashboard-upcoming").textContent.includes("Tomorrow")'));
  assert.ok(await evaluate('document.querySelector("#dashboard-attention").textContent.includes("Dashboard undated exam")'));
  assert.ok(await evaluate('document.querySelector("#dashboard-attention-summary").textContent.includes("3 remaining/upcoming conflicts")'));
  assert.equal(await evaluate('document.querySelectorAll("#dashboard img").length'), 0, 'Academic text is rendered as text, not HTML');
  assert.equal(await evaluate('Boolean(window.dashboardXss)'), false);
  assert.equal(await evaluate('document.querySelector("#stat-classes").textContent'), '2');
  await screenshot('04-dashboard-populated');
  service.records.complete({ id: overdue.id, version: overdue.version });
  await evaluate('document.querySelector("#dashboard-refresh").click()');
  await wait('document.querySelector("#dashboard-attention .dashboard-section h3").textContent.includes("(0)")');
  const beforePlan = store.db.prepare('SELECT total_changes() AS n').get().n;
  await evaluate(`const preview = document.querySelector('#planning-form'); preview.elements.date.value = '2026-11-19'; preview.elements.days.value = '1'; preview.elements.subject.value = 'Explicit study <img src=x onerror="window.planXss=true">'; preview.elements.minutes.value = '100'; preview.elements.dailyLimitMinutes.value = '60'; preview.requestSubmit();`);
  await wait('document.querySelector("#planning-status").textContent.includes("60 proposed study minutes") && document.querySelector("#planning-status").textContent.includes("Requested total: 100")');
  assert.ok(await evaluate('document.querySelector("#planning-sessions").textContent.includes("Explicit study <img")'));
  assert.equal(await evaluate('document.querySelectorAll("#planning-result img").length'), 0);
  assert.equal(await evaluate('Boolean(window.planXss)'), false);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, beforePlan, 'Planning must not create or modify records');
  assert.equal(service.planningPolicy.dailyLimitMinutes, 180, 'Preview settings are temporary');
  await screenshot('10-planning-preview', 'study-planning');
  await evaluate(`document.querySelector('#planning-form').elements.windowStart.value = '20:00'; document.querySelector('#planning-form').elements.windowEnd.value = '08:00'; document.querySelector('#planning-form').requestSubmit();`);
  await wait('document.querySelector("#planning-error").textContent.includes("previous preview")');
  await evaluate('document.querySelector("#planning-form").reset()');
  await wait('document.querySelector("#planning-error").textContent === "" && document.querySelector("#planning-policy").textContent.includes("180 min/day")');
  await evaluate('document.querySelector("#planning-tomorrow").click()');
  await wait('document.querySelector("#planning-updated").textContent.includes("2026-11-20") && !document.querySelector("#planning-generate").disabled');
  assert.equal(await evaluate('document.querySelector("#planning-form").elements.date.value'), '2026-11-20');
  await evaluate('document.querySelector("#dashboard-week .calendar-day button").click()');
  await wait('document.querySelector("#calendar").hidden === false && document.querySelector("#view").value === "day"');
  assert.equal(await evaluate('document.querySelector("#date").value'), '2026-11-16');
  await evaluate('document.querySelector("#view").value = "week"; document.querySelector("#view").dispatchEvent(new Event("change"))');
  await wait('document.querySelectorAll("#timetable .calendar-day").length === 7');
  await screenshot('05-calendar');
  await evaluate('document.querySelector("[data-page=assistant]").click()');
  await wait('!document.querySelector("#chat-send").disabled');
  assert.equal(fake.stats.created, 0, 'Opening chat must not initialize a model');
  await screenshot('06-assistant');
  await evaluate('document.querySelector("[data-chat-prompt]").click()');
  assert.equal(fake.stats.prompts.length, 0, 'Prompt cards only fill the composer');
  assert.equal(await evaluate('document.querySelector("#chat-input").value'), 'What should I focus on today?');
  await evaluate('document.querySelector("#chat-form").requestSubmit()');
  await wait('!document.querySelector("#chat-send").disabled && document.querySelector("#chat-transcript").textContent.includes("Fixture answer")');
  assert.equal(fake.stats.created, 1);
  assert.equal(await evaluate('document.querySelectorAll("#chat-transcript img").length'), 0);
  assert.equal(await evaluate('Boolean(window.chatXss)'), false);
  assert.ok(await evaluate('document.querySelector("#chat-tool-list").textContent.includes("completed")'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 780, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector("#chat-activity").open = true');
  assert.ok(await evaluate('document.querySelector("#chat-send").getBoundingClientRect().bottom <= document.querySelector(".chat-panel").getBoundingClientRect().bottom'), 'Expanded activity never clips the composer on a laptop-height viewport');
  assert.ok(await evaluate('document.querySelector("#chat-transcript").clientHeight > 0'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector("#chat-activity").open = false');
  await screenshot('11-chat-response');
  const beforeChatWrite = service.records.list('assignments').total;
  await evaluate('document.querySelector("#chat-input").value = "Browser create assignment"; document.querySelector("#chat-form").requestSubmit()');
  await wait('document.querySelector("#chat-approval").open');
  assert.equal(service.records.list('assignments').total, beforeChatWrite);
  assert.ok(await evaluate('document.querySelector("#chat-approval-preview").textContent.includes("Browser AI assignment")'));
  await key('k', 'KeyK', 4);
  assert.equal(await evaluate('document.querySelector("#command-dialog").open'), false, 'Approval dialog cannot be obscured by keyboard palette');
  await key('Escape');
  await wait('!document.querySelector("#chat-approval").open && !document.querySelector("#chat-send").disabled');
  assert.equal(service.records.list('assignments').total, beforeChatWrite);
  await evaluate('document.querySelector("#chat-input").value = "Browser create assignment"; document.querySelector("#chat-form").requestSubmit()');
  await wait('document.querySelector("#chat-approval").open');
  await screenshot('12-chat-approval');
  await evaluate('document.querySelector("#chat-approve").click()');
  await wait('!document.querySelector("#chat-approval").open && !document.querySelector("#chat-send").disabled');
  assert.equal(service.records.list('assignments').total, beforeChatWrite + 1);
  assert.equal(fake.stats.created, 1, 'Pi session is reused across turns');
  const promptCount = fake.stats.prompts.length;
  await evaluate('window.chatReloadMarker = true');
  await send('Page.reload');
  await wait('!window.chatReloadMarker && document.querySelector("#chat-send") && !document.querySelector("#chat-send").disabled && document.querySelector("#chat-transcript").textContent.includes("Saved Browser AI assignment")');
  assert.equal(fake.stats.prompts.length, promptCount, 'Reload restores history without model requests');
  await evaluate('document.querySelector("#chat-input").value = "Browser slow reply"; document.querySelector("#chat-form").requestSubmit()');
  await wait('!document.querySelector("#chat-stop").hidden');
  await evaluate('document.querySelector("[data-page=calendar]").click()');
  assert.equal(await evaluate('document.querySelector("#chat-launcher").hidden'), false);
  await evaluate('document.querySelector("#chat-launcher").click()');
  await wait('!document.querySelector("#placeholder").hidden');
  await evaluate('document.querySelector("#chat-stop").click()');
  await wait('!document.querySelector("#chat-send").disabled');
  assert.ok(await evaluate('document.querySelector("#chat-error").textContent.includes("stopped")'));
  await evaluate('document.querySelector("#chat-new").click()');
  await wait('!document.querySelector("#chat-send").disabled && document.querySelectorAll("#chat-transcript .chat-message").length === 0');
  assert.equal(service.records.list('assignments').total, beforeChatWrite + 1, 'New chat preserves academic records');
  await key('k', 'KeyK', 4);
  await wait('document.querySelector("#command-dialog").open');
  await screenshot('07-command-palette');
  await send('Input.insertText', { text: 'New assignment' });
  await wait('document.querySelectorAll("#command-results button").length === 1');
  await key('ArrowDown');
  await key('Enter');
  await wait('!document.querySelector("#command-dialog").open && !document.querySelector("#assignments").hidden && document.activeElement.name === "title"');
  assert.equal(await evaluate('location.hash'), '#assignments');
  await key('k', 'KeyK', 4);
  await wait('document.querySelector("#command-dialog").open');
  await key('Escape');
  await wait('!document.querySelector("#command-dialog").open');
  assert.equal(await evaluate('document.activeElement.name'), 'title', 'Closing the palette restores keyboard focus');
  await evaluate('history.back()');
  await wait('!document.querySelector("#placeholder").hidden');
  await key('™', 'Digit2', 1);
  await wait('!document.querySelector("#calendar").hidden');
  assert.equal(await evaluate('document.querySelector("nav [aria-current]").dataset.page'), 'calendar');
  await evaluate('document.querySelector("#theme-toggle").click()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  const shellBackground = await evaluate('getComputedStyle(document.body).backgroundColor');
  assert.equal(shellBackground, 'rgb(18, 23, 34)');
  assert.equal(await evaluate('localStorage.getItem("campus-theme")'), 'dark');
  await screenshot('08-calendar-dark');
  await evaluate('document.querySelector("[data-page=dashboard]").click()');
  await wait('document.querySelector("#dashboard-content").hidden === false');
  await screenshot('09-dashboard-dark');
  await send('Page.reload');
  await wait('document.querySelector("#dashboard-content")?.hidden === false');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark', 'Theme persists across reloads');
  assert.equal(await evaluate('document.querySelector("#breadcrumb-page").textContent'), 'Overview');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'The desktop workspace should not overflow horizontally');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#dashboard")).animationName'), 'none');
  assert.deepEqual(violations, [], 'CSP stays strict without unsafe-inline or remote dependencies');
  assert.deepEqual(externalRequests, [], 'Frontend fonts, icons and assets must remain local');
  assert.deepEqual(errors, []);
});
