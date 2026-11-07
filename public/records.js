import { $, node, api } from './client.js';
import { icon, badge, emptyState, colorFor, minutesLabel } from './ui.js';

const state = Object.fromEntries(['assignments', 'exams'].map(kind => [kind, { selected: null, offset: 0, request: 0, filters: {} }]));
function labelDate(date, time) { return date ? `${date} · ${time ?? 'time unknown'} (Paris)` : 'Date unknown'; }
const human = value => value.replaceAll('_', ' ');
function resetEditor(kind, focus = false) {
  state[kind].selected = null;
  const form = $(`${kind}-form`);
  form.reset();
  form.closest('.editor-panel').classList.remove('is-editing');
  $(`${kind}-editor-title`).textContent = kind === 'assignments' ? 'New assignment' : 'New exam';
  if (focus) { form.closest('.editor-panel').scrollIntoView({ block: 'start' }); form.querySelector('input').focus({ preventScroll: true }); }
}
function formValues(kind) {
  const values = {};
  for (const [key, value] of new FormData($(`${kind}-form`))) {
    if (key === 'topics') values[key] = value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    else if (['estimatedMinutes', 'durationMinutes'].includes(key)) values[key] = value === '' ? null : Number(value);
    else values[key] = value === '' ? null : value;
  }
  return values;
}
function filterValues(kind) {
  const values = {};
  for (const [key, value] of new FormData($(`${kind}-filters`))) {
    if (value === '') continue;
    values[key] = ['undated', 'overdue'].includes(key) ? value === 'true' || value === 'on' : value;
  }
  return values;
}
function action(kind, text, callback) {
  const button = node('button', '', text === 'Delete' ? 'delete-action' : text === 'Edit' ? 'button-ghost' : 'button-small');
  if (text === 'Mark completed') button.append(icon('check'));
  button.append(document.createTextNode(text));
  button.type = 'button';
  button.onclick = async () => {
    button.disabled = true;
    $(`${kind}-error`).textContent = '';
    try { await callback(); }
    catch (error) { $(`${kind}-error`).textContent = error.message; }
    finally { button.disabled = false; }
  };
  return button;
}
function meta(text, symbol) {
  const paragraph = node('p', '', 'card-meta');
  paragraph.append(icon(symbol), node('span', text));
  return paragraph;
}
function updateTabs() {
  for (const button of document.querySelectorAll('[data-record-status]')) button.setAttribute('aria-pressed', String(button.dataset.recordStatus === (state.assignments.filters.status ?? '')));
}
export async function showRecords(kind) {
  const current = state[kind];
  const request = ++current.request;
  const list = $(`${kind}-list`);
  list.setAttribute('aria-busy', 'true');
  updateTabs();
  try {
    const query = new URLSearchParams({ ...current.filters, limit: 50, offset: current.offset });
    const result = await api(`/api/${kind}?${query}`);
    if (request !== current.request) return;
    if (!result.items.length && current.offset && result.total) { current.offset = Math.max(0, Math.floor((result.total - 1) / 50) * 50); return showRecords(kind); }
    $(`${kind}-error`).textContent = '';
    list.replaceChildren();
    $(`${kind}-result-total`).textContent = `${result.total} matching ${kind === 'assignments' ? 'assignment' : 'exam'}${result.total === 1 ? '' : 's'}`;
    $(`${kind}-count`).textContent = `${result.total ? current.offset + 1 : 0}–${current.offset + result.items.length} of ${result.total}`;
    $(`${kind}-previous`).disabled = current.offset === 0;
    $(`${kind}-next`).disabled = !result.hasMore;
    for (const record of result.items) {
      const card = node('article', '', `record-card ${kind === 'exams' ? 'exam-card' : ''} ${record.deadlineState === 'overdue' ? 'overdue' : ''}`);
      const topline = node('div', '', 'card-topline');
      topline.append(badge(record.course ?? (kind === 'exams' ? 'Exam' : 'Assignment'), kind === 'exams' ? 'blue' : colorFor(record.course ?? record.title)));
      if (kind === 'assignments') topline.append(badge(`${record.priority} priority`, record.priority === 'high' ? 'peach' : 'neutral'));
      else topline.append(badge(human(record.preparationStatus), record.preparationStatus === 'ready' ? 'mint' : 'iris'));
      card.append(topline, node('h3', record.title ?? record.subject));
      const actions = node('div', '', 'card-actions');
      if (kind === 'assignments') {
        card.append(meta(`Due: ${labelDate(record.dueDate, record.dueTime)}`, 'calendar'));
        const states = node('div', '', 'card-badges');
        states.append(badge(human(record.status), record.status === 'completed' ? 'mint' : record.status === 'in_progress' ? 'iris' : 'neutral'));
        if (record.deadlineState !== 'completed') states.append(badge(human(record.deadlineState), record.deadlineState === 'overdue' ? 'danger' : record.deadlineState === 'due_today' ? 'peach' : 'neutral'));
        card.append(states);
        if (record.description) card.append(node('p', record.description));
        card.append(meta(record.estimatedMinutes === null ? 'Effort unknown' : `Estimated effort: ${minutesLabel(record.estimatedMinutes)}`, 'clock'));
        if (record.status !== 'completed') actions.append(action(kind, 'Mark completed', async () => {
          await api(`/api/assignments/${record.id}/complete`, { version: record.version });
          $(`${kind}-message`).textContent = 'Assignment completed.';
          await showRecords(kind);
        }));
      } else {
        card.append(meta(labelDate(record.examDate, record.startTime), 'calendar'));
        card.append(meta(record.durationMinutes === null ? 'Duration unknown' : `Duration: ${minutesLabel(record.durationMinutes)}`, 'clock'));
        card.append(meta(record.location ? `Location: ${record.location}` : 'Location unknown', 'pin'));
        if (record.topics.length) {
          const topics = node('div', '', 'card-badges');
          record.topics.forEach(topic => topics.append(badge(topic, 'neutral')));
          card.append(topics);
        } else card.append(node('p', 'Topics unknown'));
      }
      actions.append(action(kind, 'Edit', async () => {
        const latest = await api(`/api/${kind}/${record.id}`);
        current.selected = latest;
        const form = $(`${kind}-form`);
        for (const input of form.querySelectorAll('[name]')) input.value = input.name === 'topics' ? latest.topics.join('\n') : latest[input.name] ?? '';
        $(`${kind}-editor-title`).textContent = kind === 'assignments' ? 'Edit assignment' : 'Edit exam';
        form.closest('.editor-panel').classList.add('is-editing');
        form.closest('.editor-panel').scrollIntoView({ block: 'start' });
        form.querySelector('input').focus({ preventScroll: true });
      }));
      actions.append(action(kind, 'Delete', async () => {
        if (!window.confirm(`Permanently delete “${record.title ?? record.subject}”?`)) return;
        await api(`/api/${kind}/${record.id}`, { version: record.version, confirmed: true }, 'DELETE');
        if (current.selected?.id === record.id) resetEditor(kind);
        $(`${kind}-message`).textContent = 'Record deleted.';
        await showRecords(kind);
      }));
      card.append(actions);
      const details = node('details');
      details.append(node('summary', 'Record details'), node('p', `Created: ${record.createdAt}\nModified: ${record.modifiedAt}\nID: ${record.id} · version ${record.version}`));
      card.append(details);
      list.append(card);
    }
    if (!result.items.length) list.append(emptyState('No matching records.', 'A clearer head starts here. Add a record, or adjust your filters.', kind === 'exams' ? 'cap' : 'check'));
    if (result.from || result.to) list.append(node('p', 'Date filters exclude records with unknown dates. Clear filters or choose Unknown to see those records.', 'caption'));
  } catch (error) { if (request === current.request) $(`${kind}-error`).textContent = error.message; }
  finally { if (request === current.request) list.setAttribute('aria-busy', 'false'); }
}
for (const kind of Object.keys(state)) {
  const current = state[kind];
  $(`${kind}-new`).onclick = () => resetEditor(kind, true);
  document.querySelector(`[data-new-record="${kind}"]`).onclick = () => resetEditor(kind, true);
  $(`${kind}-form`).onsubmit = async event => {
    event.preventDefault();
    const submit = event.submitter ?? $(`${kind}-form`).querySelector('button[type="submit"]');
    submit.disabled = true;
    $(`${kind}-error`).textContent = '';
    try {
      const values = formValues(kind);
      const record = current.selected;
      await api(`/api/${kind}${record ? `/${record.id}` : ''}`, record ? { version: record.version, changes: values } : values, record ? 'PATCH' : 'POST');
      resetEditor(kind);
      $(`${kind}-message`).textContent = 'Saved. The record may be outside your current filters.';
      await showRecords(kind);
    } catch (error) { $(`${kind}-error`).textContent = error.message; }
    finally { submit.disabled = false; }
  };
  $(`${kind}-filters`).onsubmit = event => {
    event.preventDefault(); current.filters = filterValues(kind); current.offset = 0; void showRecords(kind);
  };
  $(`${kind}-filters`).onreset = () => {
    current.filters = {}; current.offset = 0; void showRecords(kind);
  };
  $(`${kind}-previous`).onclick = () => { current.offset = Math.max(0, current.offset - 50); void showRecords(kind); };
  $(`${kind}-next`).onclick = () => { current.offset += 50; void showRecords(kind); };
}
for (const tab of document.querySelectorAll('[data-record-status]')) tab.onclick = () => {
  $('assignments-filters').elements.status.value = tab.dataset.recordStatus;
  $('assignments-filters').requestSubmit();
};
