import { $, api, node, timezone, parisDate } from './client.js';
import { showStudyPlan } from './planning.js';
import { badge, emptyState } from './ui.js';

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' });
const human = value => value.replaceAll('_', ' ');
const dueLabel = (date, time) => date ? `${date} · ${time ?? 'time unknown'} (Paris)` : 'Date unknown';
function timeRange(event) {
  if (event.allDay) return 'All day';
  const start = new Date(event.start), end = new Date(event.end);
  return parisDate(start) === parisDate(end)
    ? `${parisDate(start)} · ${timeFormat.format(start)}–${timeFormat.format(end)}`
    : `${dateTimeFormat.format(start)}–${dateTimeFormat.format(end)}`;
}
function assignmentCard(item) {
  const card = node('article', '', `record-card ${item.deadlineState === 'overdue' ? 'overdue' : ''}`);
  card.append(node('strong', item.title), node('p', `Due: ${dueLabel(item.dueDate, item.dueTime)}`));
  const labels = node('div', '', 'card-badges');
  labels.append(badge(human(item.status), item.status === 'completed' ? 'mint' : 'neutral'), badge(`${item.priority} priority`, item.priority === 'high' ? 'peach' : 'neutral'));
  if (item.deadlineState === 'overdue' || item.deadlineState === 'due_today') labels.append(badge(human(item.deadlineState), item.deadlineState === 'overdue' ? 'danger' : 'peach'));
  card.append(labels);
  if (item.course) card.append(node('p', `Course: ${item.course}`));
  if (item.estimatedMinutes !== null) card.append(node('p', `Estimated effort: ${item.estimatedMinutes} minutes`));
  return card;
}
const examStatus = {
  undated: 'Date unknown', date_passed: 'Scheduled date has passed; exact finish unknown',
  time_unknown_today: 'Today · start time unknown', upcoming: 'Upcoming', in_progress: 'In progress',
  started_end_unknown: 'Start time has passed; finish unknown', finished: 'Finished',
};
function examCard(item, conflict = false) {
  const card = node('article', '', `record-card exam-card ${conflict ? 'conflict' : ''}`);
  const countdown = item.daysUntil === null ? 'Date unknown' : item.daysUntil === 0 ? 'Today' : item.daysUntil === 1 ? 'Tomorrow' : item.daysUntil > 0 ? `In ${item.daysUntil} calendar days` : `${Math.abs(item.daysUntil)} calendar day(s) ago`;
  const labels = node('div', '', 'card-badges');
  labels.append(badge(countdown, item.daysUntil !== null && item.daysUntil <= 1 ? 'peach' : 'blue'), badge(human(item.preparationStatus), item.preparationStatus === 'ready' ? 'mint' : 'iris'));
  card.append(labels, node('strong', item.subject), node('p', dueLabel(item.examDate, item.startTime)));
  card.append(node('p', examStatus[item.timingStatus]));
  card.append(node('p', item.durationMinutes === null ? 'Duration unknown' : `Duration: ${item.durationMinutes} minutes`));
  if (item.location) card.append(node('p', `Location: ${item.location}`));
  if (conflict) card.append(node('p', '⚠ Scheduling conflict'));
  return card;
}
function eventCard(item, conflict = false) {
  const card = node('article', '', `event ${item.source} ${conflict ? 'conflict' : ''}`);
  card.append(node('strong', item.title), node('p', timeRange(item)), node('small', item.source === 'local' ? 'French lesson' : 'University · read-only'));
  if (item.location) card.append(node('p', item.location));
  if (conflict) card.append(node('p', '⚠ Scheduling conflict'));
  return card;
}
function conflictCard(item) {
  const card = node('article', '', 'record-card conflict');
  card.append(node('strong', item.events.map(event => `${event.title} (${event.source})`).join(' overlaps ')));
  card.append(node('p', `${dateTimeFormat.format(new Date(item.start))}–${dateTimeFormat.format(new Date(item.end))} (Paris)`));
  return card;
}
function section(parent, title, items, render, empty) {
  const section = node('section', '', 'dashboard-section');
  const heading = node('h3');
  heading.append(node('span', title), badge(`(${items.length})`, 'neutral'));
  section.append(heading);
  section.classList.toggle('is-empty', items.length === 0);
  if (!items.length) section.append(emptyState(empty));
  else items.forEach(item => section.append(render(item)));
  parent.append(section);
}
function overlapsDate(event, date) {
  return parisDate(new Date(event.start)) <= date && (parisDate(new Date(Date.parse(event.end) - 1)) >= date || parisDate(new Date(event.start)) === date);
}
function examOnDate(exam, date) {
  return exam.examDate === date || (exam.startsAt && exam.endsAt && overlapsDate({ start: exam.startsAt, end: exam.endsAt }, date));
}
function render(result) {
  $('dashboard-updated').textContent = `Updated ${dateTimeFormat.format(new Date(result.generatedAt))} · Europe/Paris`;
  const calendar = result.calendar;
  $('workspace-date').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(result.generatedAt));
  $('stat-classes').textContent = calendar.hasCache && !calendar.queryError ? String(result.today.events.length) : '—';
  $('stat-classes').closest('.stat-card').querySelector('small').textContent = calendar.hasCache && !calendar.queryError ? 'Classes & French lessons today' : 'Calendar incomplete · known lessons below';
  $('stat-deadlines').textContent = String(result.upcoming.assignments.length);
  $('stat-exams').textContent = String(result.upcoming.exams.length);
  $('dashboard-calendar-status').textContent = [
    calendar.hasCache ? `Calendar last synchronized ${dateTimeFormat.format(new Date(calendar.lastSyncedAt))} (Paris).` : 'University calendar has not synchronized. Classes and conflict checks are incomplete.',
    calendar.error ?? '', calendar.queryError ?? '',
    'Conflict checks only use known intervals; missing exam times or durations are not treated as free time.',
  ].filter(Boolean).join(' ');
  $('dashboard-calendar-status').className = !calendar.hasCache || calendar.error || calendar.queryError ? 'dashboard-warning' : '';
  const policy = result.policy;
  $('dashboard-policy').textContent = `Windows include today: approaching deadlines ${policy.deadlineWindowDays} Paris calendar days; exam preparation ${policy.preparationWindowDays} days; upcoming exams ${policy.examWindowDays} days. Undated items are listed separately.`;
  const attention = result.needsAttention;
  $('dashboard-attention-summary').textContent = `${attention.overdueAssignments.length} overdue · ${attention.approachingAssignments.length} approaching deadlines · ${attention.examsNeedingPreparation.length} exams needing preparation · ${attention.conflicts.length} remaining/upcoming conflicts`;
  const attentionArea = $('dashboard-attention');
  attentionArea.replaceChildren();
  const hasAttention = Object.values(attention).some(items => items.length > 0);
  $('attention-empty').hidden = hasAttention;
  $('attention-empty').replaceChildren(emptyState('No attention items in your saved data.', 'We’ll show recorded deadlines, preparation gaps and known conflicts here.'));
  section(attentionArea, 'Overdue assignments', attention.overdueAssignments, assignmentCard, 'No overdue assignments.');
  section(attentionArea, 'Approaching deadlines', attention.approachingAssignments, assignmentCard, 'No approaching deadlines.');
  section(attentionArea, 'Exams needing preparation', attention.examsNeedingPreparation, item => examCard(item), 'No upcoming exams flagged for preparation.');
  section(attentionArea, 'Remaining/upcoming conflicts', attention.conflicts, conflictCard, 'No conflicts detected among known intervals.');
  section(attentionArea, 'Assignments with unknown deadlines', attention.undatedAssignments, assignmentCard, 'No incomplete assignments with unknown deadlines.');
  section(attentionArea, 'Exams with unknown dates', attention.undatedExams, item => examCard(item), 'No exams with unknown dates.');
  section(attentionArea, 'Incomplete exam timing — conflict checks limited', attention.examsWithIncompleteTiming, item => examCard(item), 'No near-term exams with incomplete timing.');
  const today = $('dashboard-today');
  today.replaceChildren();
  $('dashboard-today-title').textContent = `Today, ${new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long' }).format(new Date(`${result.today.date}T12:00:00Z`))}`;
  const todayConflictIds = new Set(result.today.conflicts.flatMap(c => c.eventIds));
  section(today, 'Classes and French lessons', result.today.events, item => eventCard(item, todayConflictIds.has(item.id)), 'No classes in the stored calendar for today.');
  section(today, 'Assignments due today', result.today.assignments, assignmentCard, 'No assignments dated today.');
  section(today, 'Scheduled exams', result.today.exams, item => examCard(item, todayConflictIds.has(`exam:${item.id}`)), 'No exams dated or known to be ongoing today.');
  section(today, 'Today’s conflicts', result.today.conflicts, conflictCard, 'No conflicts detected among known intervals today.');
  const upcoming = $('dashboard-upcoming');
  upcoming.replaceChildren();
  section(upcoming, `Assignments · next ${policy.deadlineWindowDays} days`, result.upcoming.assignments, assignmentCard, 'No approaching incomplete assignments.');
  section(upcoming, `Exams · next ${policy.examWindowDays} days / ongoing`, result.upcoming.exams, item => examCard(item), 'No upcoming or known ongoing exams.');
  const week = result.week;
  const from = week.from.slice(0, 10);
  const lastDay = new Date(`${from}T12:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() + 6);
  $('dashboard-week-range').textContent = `${from} through ${parisDate(lastDay)} · Monday–Sunday · select a day to open the class calendar`;
  const timetable = $('dashboard-week');
  timetable.replaceChildren();
  const weekConflictIds = new Set(week.conflicts.flatMap(c => c.eventIds));
  for (let offset = 0; offset < 7; offset++) {
    const date = new Date(`${from}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const key = parisDate(date);
    const column = node('section', '', `calendar-day ${key === result.today.date ? 'is-today' : ''}`);
    const open = node('button', dayFormat.format(date));
    open.setAttribute('aria-label', `Open class calendar for ${key}`);
    open.onclick = () => document.dispatchEvent(new CustomEvent('academic:navigate', { detail: { page: 'calendar', date: key, view: 'day' } }));
    column.append(open);
    const events = week.events.filter(e => overlapsDate(e, key));
    const assignments = week.assignments.filter(a => a.dueDate === key);
    const exams = week.exams.filter(e => examOnDate(e, key));
    events.forEach(e => column.append(eventCard(e, weekConflictIds.has(e.id))));
    assignments.forEach(a => column.append(assignmentCard(a)));
    exams.forEach(e => column.append(examCard(e, weekConflictIds.has(`exam:${e.id}`))));
    if (!events.length && !assignments.length && !exams.length) column.append(node('p', 'No dated items', 'empty-day'));
    timetable.append(column);
  }
  $('dashboard-week-pending').replaceChildren();
  section($('dashboard-week-pending'), 'Incomplete assignments dated this week', week.pendingAssignments, assignmentCard, 'No incomplete assignments dated this week. See unknown deadlines above for undated work.');
  $('dashboard-week-conflicts').replaceChildren();
  section($('dashboard-week-conflicts'), 'This week’s conflicts (including earlier this week)', week.conflicts, conflictCard, 'No conflicts detected among known intervals this week.');
  $('dashboard-content').hidden = false;
}
let requestId = 0;
export async function showDashboard() {
  void showStudyPlan();
  const id = ++requestId;
  $('dashboard-refresh').disabled = true;
  try {
    const result = await api('/api/overview');
    if (id !== requestId) return;
    render(result);
    $('dashboard-error').textContent = '';
    document.dispatchEvent(new CustomEvent('academic:overview-updated', { detail: { date: result.today.date } }));
  } catch (error) {
    if (id === requestId) $('dashboard-error').textContent = `${error.message} Any displayed overview is the previous snapshot; check its update time.`;
  } finally { if (id === requestId) $('dashboard-refresh').disabled = false; }
}
$('dashboard-refresh').onclick = showDashboard;
for (const button of document.querySelectorAll('[data-open-page]')) button.onclick = () => document.dispatchEvent(new CustomEvent('academic:navigate', { detail: { page: button.dataset.openPage } }));
