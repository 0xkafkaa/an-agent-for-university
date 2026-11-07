import { $, timezone, parisDate, node, api } from './client.js';
import { showRecords } from './records.js';
import { showDashboard } from './dashboard.js';
import { setupShell } from './shell.js';
import { icon, emptyState } from './ui.js';
import { showChat } from './chat.js';
let activePage = 'dashboard';
const pages = { dashboard: 'Overview', calendar: 'Calendar', assignments: 'Assignments', exams: 'Exams', assistant: 'AI Assistant' };
const monthDay = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric' });
const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', month: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
let selected;
let requestId = 0;
async function load() {
  const id = ++requestId;
  try {
    const result = await api(`/api/schedule?date=${encodeURIComponent($('date').value)}&view=${$('view').value}`);
    if (id !== requestId) return;
    $('error').textContent = '';
    $('sync').textContent = `${result.sync.lastSyncedAt ? `Last synchronized: ${new Date(result.sync.lastSyncedAt).toLocaleString('en-GB', { timeZone: timezone })} (Paris)` : 'Not synchronized yet.'} ${result.sync.error || ''}`;
    const conflicting = new Set(result.conflicts.flatMap(c => c.eventIds));
    $('calendar-range').textContent = $('view').value === 'week' ? `${monthDay.format(new Date(result.from))} – ${monthDay.format(new Date(Date.parse(result.to) - 1))}` : dayFormat.format(new Date(result.from));
    $('conflicts').className = result.conflicts.length ? 'has-conflicts' : '';
    $('conflicts').textContent = result.conflicts.length ? `⚠ ${result.conflicts.length} scheduling conflict(s). Both events are retained.` : 'No scheduling conflicts.';
    const timetable = $('timetable');
    timetable.replaceChildren();
    timetable.className = $('view').value;
    // UTC noon is only used to enumerate date labels; event times always use Paris.
    const startDay = result.from.slice(0, 10);
    for (let offset = 0; offset < ($('view').value === 'week' ? 7 : 1); offset++) {
      const date = new Date(`${startDay}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      const key = parisDate(date);
      const column = node('section', '', `calendar-day ${key === parisDate() ? 'is-today' : ''}`);
      const heading = node('h2', '', 'day-heading');
      heading.append(node('span', weekday.format(date), 'day-name'), node('span', String(date.getUTCDate()), 'day-number'));
      heading.setAttribute('aria-label', dayFormat.format(date));
      column.append(heading);
      const dayEvents = result.events.filter(e => {
        // Compare calendar dates instead of using the week's offset across a DST transition.
        return parisDate(new Date(e.start)) <= key && (parisDate(new Date(Date.parse(e.end) - 1)) >= key || parisDate(new Date(e.start)) === key);
      });
      for (const event of dayEvents) {
        const card = node('article', '', `event ${event.source} ${conflicting.has(event.id) ? 'conflict' : ''}`);
        const crossesOffset = event.start.slice(-6) !== event.end.slice(-6);
        const clock = crossesOffset ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : timeFormat;
        card.append(node('p', event.allDay ? 'All day' : `${clock.format(new Date(event.start))}–${clock.format(new Date(event.end))}`, 'event-time'));
        card.append(node('strong', event.title));
        card.append(node('small', event.source === 'university' ? 'University · read-only' : 'French lesson · local'));
        if (event.location) { const location = node('p', '', 'card-meta'); location.append(icon('pin'), node('span', event.location)); card.append(location); }
        if (event.description || event.organizer) {
          const details = node('details'); details.append(node('summary', 'Details'));
          if (event.description) details.append(node('p', event.description));
          if (event.organizer) details.append(node('p', event.organizer));
          card.append(details);
        }
        if (conflicting.has(event.id)) card.append(node('p', '⚠ Overlapping event', 'conflict-note'));
        if (!event.readOnly) {
          const edit = node('button', 'Modify occurrence');
          edit.onclick = () => {
            selected = event;
            $('edit-start').value = event.start;
            $('edit-end').value = event.end;
            $('edit-location').value = event.location || '';
            $('edit-cancelled').checked = false;
            $('edit-confirm').checked = false;
            $('edit-error').textContent = '';
            $('edit-dialog').showModal();
          };
          card.append(edit);
        }
        column.append(card);
      }
      if (!dayEvents.length) column.append(emptyState('No classes', '', 'leaf'));
      timetable.append(column);
    }
  } catch (error) { if (id === requestId) $('error').textContent = error.message; }
}
$('date').value = parisDate();
$('date').onchange = load;
$('view').onchange = load;
function move(direction) {
  const date = new Date(`${$('date').value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + direction * ($('view').value === 'week' ? 7 : 1));
  $('date').value = parisDate(date);
  void load();
}
$('previous').onclick = () => move(-1);
$('next').onclick = () => move(1);
$('today').onclick = () => { $('date').value = parisDate(); void load(); };
$('refresh').onclick = async () => {
  $('refresh').disabled = true;
  try { await api('/api/sync', {}); await load(); }
  catch (error) { $('error').textContent = error.message; }
  finally { $('refresh').disabled = false; }
};
$('edit-close').onclick = () => $('edit-dialog').close();
$('edit-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/api/occurrence', { uid: selected.uid, recurrenceId: selected.recurrenceId, start: $('edit-start').value, end: $('edit-end').value, location: $('edit-location').value, cancelled: $('edit-cancelled').checked, confirmed: $('edit-confirm').checked });
    $('edit-dialog').close();
    await load();
  } catch (error) { $('edit-error').textContent = error.message; }
};
function activatePage(page, focus = false, pushHistory = true) {
  if (!Object.hasOwn(pages, page)) return;
  activePage = page;
  for (const nav of document.querySelectorAll('nav [data-page]')) {
    if (nav.dataset.page === page) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  for (const name of ['dashboard', 'calendar', 'assignments', 'exams']) $(name).hidden = page !== name;
  $('placeholder').hidden = page !== 'assistant';
  $('chat-launcher').hidden = page === 'assistant';
  if (page === 'assistant') void showChat();
  $('breadcrumb-page').textContent = pages[page];
  document.title = `${pages[page]} · Campus`;
  if (pushHistory && location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
  if (page === 'dashboard') void showDashboard();
  if (page === 'calendar') void load();
  if (['assignments', 'exams'].includes(page)) void showRecords(page);
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (focus) {
    const heading = $(page === 'assistant' ? 'placeholder' : page).querySelector('h1');
    heading.tabIndex = -1; heading.focus({ preventScroll: true });
  }
}
for (const button of document.querySelectorAll('nav [data-page]')) button.onclick = () => activatePage(button.dataset.page);
document.querySelector('.brand').onclick = event => { event.preventDefault(); activatePage('dashboard'); };
window.addEventListener('popstate', () => { if (Object.hasOwn(pages, location.hash.slice(1))) activatePage(location.hash.slice(1), false, false); });
window.addEventListener('hashchange', () => { if (Object.hasOwn(pages, location.hash.slice(1)) && location.hash.slice(1) !== activePage) activatePage(location.hash.slice(1), false, false); });
document.addEventListener('keydown', event => {
  if (activePage !== 'calendar' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) || document.querySelector('dialog[open]') || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'ArrowLeft') move(-1);
  if (event.key === 'ArrowRight') move(1);
  if (event.key.toLowerCase() === 't') $('today').click();
});
document.addEventListener('academic:navigate', ({ detail }) => {
  if (detail.page === 'calendar' && detail.date) {
    $('date').value = detail.date;
    $('view').value = detail.view ?? 'day';
  }
  document.querySelector(`nav [data-page="${detail.page}"]`)?.click();
});
document.addEventListener('academic:data-changed', () => {
  if (activePage === 'dashboard') void showDashboard();
  if (['assignments', 'exams'].includes(activePage)) void showRecords(activePage);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activePage === 'dashboard') void showDashboard();
});
setupShell(activatePage);
activatePage(Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard', false, false);
setInterval(() => {
  if (document.hidden) return;
  if (activePage === 'dashboard') void showDashboard();
  if (activePage === 'calendar') void load();
}, 60000);
