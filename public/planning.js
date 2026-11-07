import { $, api, node, timezone, parisDate } from './client.js';
import { badge, emptyState, minutesLabel } from './ui.js';

const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
const human = text => text.replaceAll('_', ' ');
const basis = { record_estimate: 'Recorded total effort estimate (not measured remaining work)', starter_suggestion: 'Suggested starter budget; effort is unknown', user_request: 'Explicit user-requested budget' };
let args = {}, requestId = 0, lastClock;
function values() {
  const data = Object.fromEntries(new FormData($('planning-form')));
  const result = { days: Number(data.days) };
  if (data.date) result.date = data.date;
  if (data.subject.trim()) result.subject = data.subject.trim();
  if (data.minutes) result.minutes = Number(data.minutes);
  const preferences = {};
  if (data.windowStart || data.windowEnd) {
    if (!data.windowStart || !data.windowEnd) throw new Error('Provide both study-window start and end.');
    preferences.windows = [{ start: data.windowStart, end: data.windowEnd.trim() }];
  }
  for (const key of ['dailyLimitMinutes', 'minSessionMinutes', 'maxSessionMinutes', 'breakMinutes', 'eventBufferMinutes', 'starterMinutes']) if (data[key] !== '') preferences[key] = Number(data[key]);
  if (Object.keys(preferences).length) result.preferences = preferences;
  return result;
}
function list(id, items) {
  $(id).replaceChildren(...items.map(text => node('li', text)));
}
function renderCoverage(summary) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  const percent = summary.targetMinutes ? Math.min(100, Math.round(summary.plannedMinutes / summary.targetMinutes * 100)) : 0;
  for (const [stroke, dash] of [['var(--line-strong)', null], ['#8e7edd', `${percent / 100 * 163.36} 163.36`]]) {
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    for (const [key, value] of Object.entries({ cx: '32', cy: '32', r: '26', fill: 'none', stroke, 'stroke-width': '6', 'stroke-linecap': 'round' })) circle.setAttribute(key, value);
    if (dash) circle.setAttribute('stroke-dasharray', dash);
    svg.append(circle);
  }
  const label = node('div', '', 'coverage-label');
  label.append(node('strong', summary.targetMinutes ? `${percent}%` : '—'), node('small', 'Budget covered'), node('small', 'Not task completion'));
  $('planning-coverage').replaceChildren(svg, label);
}
function render(plan) {
  lastClock = { server: Date.parse(plan.generatedAt), client: Date.now() };
  $('planning-updated').textContent = `Generated ${dateTime.format(new Date(plan.generatedAt))} · Europe/Paris · ${plan.range.from.slice(0, 10)} through ${dateTime.format(new Date(Date.parse(plan.range.to) - 1))}`;
  const summary = plan.summary;
  renderCoverage(summary);
  $('stat-focus').textContent = plan.availability === 'unavailable' ? '—' : minutesLabel(summary.plannedMinutes);
  $('stat-focus-caption').textContent = plan.availability === 'unavailable' ? 'Calendar needed for study suggestions' : `${plan.days.length}-day preview · not booked`;
  $('planning-status').textContent = `Availability: ${human(plan.availability)} · ${summary.freeMinutes} candidate free minutes · ${summary.plannedMinutes} proposed study minutes · ${summary.unallocatedMinutes} budget minutes not covered.${summary.requestedMinutes !== null ? ` Requested total: ${summary.requestedMinutes}; shortfall: ${summary.requestedShortfallMinutes} minutes.` : ''}`;
  $('planning-status').className = plan.availability === 'calendar_based' ? '' : 'dashboard-warning';
  const policy = plan.policy;
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  $('planning-policy').textContent = `Study preferences, not claims about your commitments: ${policy.windows.map(w => `${w.start}–${w.end}`).join(', ')} Paris · ${policy.weekdays.map(d => names[d - 1]).join(', ')} · ${policy.minSessionMinutes}–${policy.maxSessionMinutes} min sessions · ${policy.dailyLimitMinutes} min/day · ${policy.breakMinutes} min breaks · ${policy.eventBufferMinutes} min event buffers · unknown effort starter ${policy.starterMinutes} min.`;
  $('planning-warnings').replaceChildren();
  if (plan.warnings.length) $('planning-warnings').append(node('p', plan.warnings[0].message, 'dashboard-warning'));
  if (plan.warnings.length > 1) {
    const more = node('details');
    more.append(node('summary', `${plan.warnings.length - 1} more ${plan.warnings.length === 2 ? 'thing' : 'things'} to check before following this plan`));
    plan.warnings.slice(1).forEach(w => more.append(node('p', w.message, 'dashboard-warning')));
    $('planning-warnings').append(more);
  }
  list('planning-insights', plan.insights);
  const sessions = $('planning-sessions');
  sessions.replaceChildren();
  for (const session of plan.sessions) {
    const card = node('article', '', 'record-card');
    const labels = node('div', '', 'card-badges');
    labels.append(badge(minutesLabel(session.minutes), 'iris'), badge(session.tentative ? 'Provisional' : 'Calendar-based', session.tentative ? 'peach' : 'mint'));
    card.append(labels, node('strong', session.title), node('p', `${dateTime.format(new Date(session.start))}–${dateTime.format(new Date(session.end))} (Paris)`));
    const explanation = node('details');
    explanation.append(node('summary', 'Why this block?'), node('p', session.kind === 'requested' ? 'User-requested topic, not an academic record' : human(session.kind)), node('p', basis[session.budgetBasis]), node('p', session.reason));
    if (session.topics.length) explanation.append(node('p', `Stored revision topics: ${session.topics.join('; ')}`));
    card.append(explanation);
    sessions.append(card);
  }
  if (!plan.sessions.length) sessions.append(emptyState('No sessions proposed yet.', 'Check your calendar, workload and study limits. No suggestions does not mean all work is done.', 'clock'));
  const free = $('planning-free');
  free.replaceChildren();
  for (const day of plan.days) {
    const section = node('section');
    section.append(node('h4', `${day.date} · ${minutesLabel(day.freeMinutes)} candidate time · ${minutesLabel(day.plannedMinutes)} proposed`));
    for (const period of plan.freePeriods.filter(p => p.date === day.date)) section.append(node('p', `${dateTime.format(new Date(period.start))}–${dateTime.format(new Date(period.end))} · ${minutesLabel(period.minutes)}`));
    if (!day.freeMinutes) section.append(node('small', 'No usable periods under the current constraints.'));
    free.append(section);
  }
  const workload = $('planning-workload');
  workload.replaceChildren();
  for (const task of plan.workload) {
    const card = node('article', '', `record-card ${task.urgency === 'overdue' ? 'overdue' : ''}`);
    card.append(node('strong', task.title), node('p', `${human(task.kind)} · ${human(task.urgency)} · ${human(task.status)}`));
    card.append(node('p', task.dueDate ? `Actual due/exam date: ${task.dueDate} · ${task.dueTime ?? 'time unknown'}` : 'Deadline/date unknown'));
    card.append(node('p', `${task.budgetMinutes} minute planning budget: ${basis[task.budgetBasis]}`));
    card.append(node('p', `${task.allocatedMinutes} minutes proposed; ${task.unallocatedMinutes} not covered${task.unallocatedReason ? ` (${human(task.unallocatedReason)})` : ''}. This is not a completion status.`));
    if (task.planningCutoff) card.append(node('p', `Planning cutoff: ${dateTime.format(new Date(task.planningCutoff))} (Paris) · ${human(task.cutoffReason)}; not an invented deadline.`));
    workload.append(card);
  }
  if (!plan.workload.length) workload.append(node('p', 'No matching active workload. Specify a topic to request study without creating an assignment or exam.'));
  list('planning-exclusions', plan.excludedDates.map(e => `${e.date}: ${e.reason}`));
  list('planning-notes', plan.notes);
  $('planning-result').hidden = false;
}
export async function showStudyPlan() {
  const id = ++requestId;
  $('planning-generate').disabled = true;
  try {
    const plan = await api('/api/study-plan', Object.keys(args).length ? args : undefined);
    if (id !== requestId) return;
    render(plan);
    $('planning-error').textContent = '';
  } catch (error) {
    if (id === requestId) $('planning-error').textContent = `${error.message} Any displayed plan is the previous preview; check its generation time and settings.`;
  } finally { if (id === requestId) $('planning-generate').disabled = false; }
}
$('planning-form').onsubmit = event => {
  event.preventDefault();
  try { args = values(); void showStudyPlan(); }
  catch (error) { $('planning-error').textContent = error.message; }
};
$('planning-form').onreset = () => { args = {}; void showStudyPlan(); };
for (const [id, offset] of [['planning-today', 0], ['planning-tomorrow', 1]]) $(id).onclick = () => {
  const currentDate = lastClock ? parisDate(new Date(lastClock.server + Date.now() - lastClock.client)) : parisDate();
  const date = new Date(`${currentDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  $('planning-form').elements.date.value = parisDate(date);
  $('planning-form').elements.days.value = '1';
  $('planning-form').requestSubmit();
};
