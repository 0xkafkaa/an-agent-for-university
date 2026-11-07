import { $, api, node, timezone } from './client.js';
import { icon, notify } from './ui.js';
import { consumeChatStream } from './chat-stream.js';

const messages = new Map(), activity = new Map(), approvals = new Map();
const state = { id: null, model: null, sending: false, loaded: false, resetting: false };
let initialization, controller, generation = 0, displayedApproval;
try { state.id = sessionStorage.getItem('campus-chat-id'); } catch { /* Storage is optional. */ }
const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
function storeId(id) { try { if (id) sessionStorage.setItem('campus-chat-id', id); else sessionStorage.removeItem('campus-chat-id'); } catch { /* Same-tab memory still works. */ } }
function csrf() { return document.querySelector('meta[name="csrf-token"]').content; }
function renderStatus() {
  $('chat-connection').textContent = initialization ? 'Opening local conversation…' : approvals.size ? 'Waiting for your approval' : state.sending ? 'Pi is working…' : 'Ready when you are';
  $('chat-model').textContent = state.model ? `${state.model.name} · ${state.model.provider}` : 'Uses your Pi login · model selected on first send';
  $('chat-send').disabled = Boolean(state.sending || initialization || state.resetting);
  $('chat-new').disabled = Boolean(initialization || state.resetting);
  $('chat-stop').hidden = !state.sending;
  $('chat-state-dot').className = state.sending ? 'chat-state-dot is-working' : 'chat-state-dot';
  $('chat-launcher-label').textContent = approvals.size ? 'Approval needed' : state.sending ? 'Campus is replying…' : 'Ask Campus';
}
// Small safe text formatter: no HTML interpretation, external images or links.
function richText(parent, text) {
  parent.replaceChildren();
  let code;
  function inline(target, value) {
    for (const part of value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (part.startsWith('**') && part.endsWith('**')) target.append(node('strong', part.slice(2, -2)));
      else if (part.startsWith('`') && part.endsWith('`')) target.append(node('code', part.slice(1, -1)));
      else target.append(document.createTextNode(part));
    }
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { if (code) code = null; else { const pre = node('pre'); code = node('code'); pre.append(code); parent.append(pre); } continue; }
    if (code) { code.append(document.createTextNode(line + '\n')); continue; }
    if (!line.trim()) continue;
    const paragraph = node(/^#{1,3}\s/.test(line) ? 'h3' : 'p');
    inline(paragraph, line.replace(/^#{1,3}\s+/, ''));
    parent.append(paragraph);
  }
}
function upsertMessage(message) {
  const log = $('chat-transcript');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  let entry = messages.get(message.id);
  if (!entry) {
    const article = node('article', '', `chat-message chat-message-${message.role}`);
    const heading = node('div', '', 'chat-message-heading');
    heading.append(node('strong', message.role === 'assistant' ? 'Campus' : 'You'), node('small', time.format(new Date(message.createdAt))));
    const body = node('div', '', 'chat-message-body');
    const status = node('small', '', 'chat-message-state');
    article.append(heading, body, status);
    log.append(article);
    entry = { article, body, status }; messages.set(message.id, entry);
  }
  entry.message = message;
  if (message.role === 'assistant') richText(entry.body, message.text); else entry.body.textContent = message.text;
  entry.status.textContent = message.status === 'streaming' ? 'Replying…' : message.status === 'incomplete' ? 'Reply interrupted · review tool activity before retrying a write' : '';
  $('chat-welcome').hidden = messages.size > 0;
  if (atBottom || message.role === 'user') log.scrollTop = log.scrollHeight;
}
function renderActivity() {
  $('chat-activity').hidden = !activity.size;
  $('chat-activity-title').textContent = `Tool activity (${activity.size})`;
  $('chat-tool-list').replaceChildren(...[...activity.values()].map(item => {
    const row = node('div', '', `chat-tool chat-tool-${item.status}`);
    row.append(icon(item.status === 'completed' ? 'check' : item.status === 'failed' ? 'alert' : 'clock'), node('strong', item.name.replaceAll('_', ' ')), node('small', item.status));
    return row;
  }));
}
function settleDisplayedTurn() {
  for (const entry of messages.values()) if (entry.message.status === 'streaming') upsertMessage({ ...entry.message, status: 'incomplete' });
  for (const item of activity.values()) if (item.status === 'running') item.status = 'interrupted';
  renderActivity();
}
function resetTranscript() {
  for (const entry of messages.values()) entry.article.remove();
  messages.clear(); activity.clear(); approvals.clear();
  $('chat-welcome').hidden = false;
  renderActivity(); closeApproval();
}
function closeApproval() {
  displayedApproval = null;
  if ($('chat-approval').open) $('chat-approval').close();
}
function pumpApproval() {
  if (displayedApproval || document.querySelector('dialog[open]')) return;
  const approval = approvals.values().next().value;
  if (!approval) return;
  displayedApproval = approval.id;
  $('chat-approval-title').textContent = approval.title;
  $('chat-approval-preview').textContent = approval.message;
  $('chat-approval-expiry').textContent = `Expires ${time.format(new Date(approval.expiresAt))} (Paris). Already approved changes are not undone by stopping.`;
  $('chat-approval-error').textContent = '';
  $('chat-approve').disabled = false; $('chat-decline').disabled = false;
  $('chat-approval').showModal();
  $('chat-decline').focus();
}
async function decide(approved) {
  const id = displayedApproval, epoch = generation;
  if (!id || !state.id) return;
  $('chat-approve').disabled = true; $('chat-decline').disabled = true;
  try {
    await api(`/api/chat/sessions/${state.id}/confirm`, { confirmationId: id, approved });
    if (epoch !== generation) return;
    approvals.delete(id); if (displayedApproval === id) closeApproval(); pumpApproval(); renderStatus();
  } catch (error) {
    if (epoch !== generation) return;
    if (displayedApproval !== id) return;
    if (error.status === 409 || error.status === 404) { approvals.delete(id); closeApproval(); pumpApproval(); renderStatus(); }
    else { $('chat-approval-error').textContent = error.message; $('chat-approve').disabled = false; $('chat-decline').disabled = false; }
  }
}
$('chat-approve').onclick = () => void decide(true);
$('chat-decline').onclick = () => void decide(false);
$('chat-approval').addEventListener('cancel', event => { event.preventDefault(); void decide(false); });
document.addEventListener('close', () => queueMicrotask(pumpApproval), true);
function renderSnapshot(snapshot) {
  resetTranscript();
  state.id = snapshot.id; state.model = snapshot.model;
  $('chat-error').textContent = snapshot.lastError?.message ?? (snapshot.lastOutcome === 'cancelled' ? 'Previous reply stopped. Already approved changes are not undone.' : '');
  storeId(state.id);
  snapshot.messages.forEach(upsertMessage);
  snapshot.activity.forEach(item => activity.set(item.id, item));
  snapshot.confirmations.forEach(item => approvals.set(item.id, item));
  renderActivity(); renderStatus(); pumpApproval();
}
async function ensureConversation() {
  if (state.loaded && state.id) return;
  if (initialization) return initialization;
  initialization = (async () => {
    let snapshot;
    if (state.id) {
      try { snapshot = await api(`/api/chat/sessions/${state.id}`); }
      catch (error) { if (error.status !== 404) throw error; state.id = null; storeId(null); }
    }
    if (!snapshot) snapshot = await api('/api/chat/sessions', {});
    // A new document has no live stream to own old approvals. Cancel rather
    // than briefly presenting an action from an interrupted connection.
    if (snapshot.state === 'running') snapshot.confirmations = [];
    renderSnapshot(snapshot);
    state.loaded = true;
    if (snapshot.state === 'running') {
      await api(`/api/chat/sessions/${state.id}/cancel`, {});
      $('chat-error').textContent = 'A previous reply was interrupted by a reload. Already approved changes remain; review tool activity before retrying.';
      approvals.clear(); closeApproval();
    }
  })();
  renderStatus();
  try { await initialization; } finally { initialization = null; renderStatus(); }
}
export async function showChat() {
  try { await ensureConversation(); renderStatus(); pumpApproval(); }
  catch (error) { $('chat-error').textContent = `${error.message} Other pages do not require an AI connection.`; }
}
function handleEvent(event, optimisticId) {
  if (event.type === 'run_started') {
    messages.get(optimisticId)?.article.remove(); messages.delete(optimisticId);
    upsertMessage(event.message);
  }
  if (event.type === 'assistant_text') upsertMessage(event.message);
  if (event.type === 'model') { state.model = event.model; renderStatus(); }
  if (event.type === 'tool') { activity.set(event.id, event); renderActivity(); }
  if (event.type === 'confirmation') {
    approvals.set(event.id, event); renderStatus(); pumpApproval();
    if ($('placeholder').hidden) notify('Campus needs your approval for an academic change.');
  }
  if (event.type === 'confirmation_resolved') {
    approvals.delete(event.id);
    if (event.reason === 'expired') $('chat-error').textContent = 'That change’s approval expired. It was not authorized.';
    if (displayedApproval === event.id) closeApproval();
    pumpApproval(); renderStatus();
  }
  if (event.type === 'data_changed') {
    document.dispatchEvent(new CustomEvent('academic:data-changed'));
  }
  if (event.type === 'error') $('chat-error').textContent = event.message;
  if (event.type === 'done') {
    approvals.clear(); closeApproval();
    settleDisplayedTurn();
    if (event.cancelled && !$('chat-error').textContent) $('chat-error').textContent = 'Reply stopped. Already approved changes are not undone; review tool activity before retrying.';
  }
}
$('chat-form').onsubmit = async event => {
  event.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text || state.sending) return;
  state.sending = true; renderStatus();
  const epoch = generation;
  let optimisticId;
  try {
    await ensureConversation();
    $('chat-error').textContent = '';
    const requestId = crypto.randomUUID();
    optimisticId = `local-${requestId}`;
    upsertMessage({ id: optimisticId, role: 'user', text, createdAt: new Date().toISOString(), status: 'completed' });
    const abort = new AbortController(); controller = abort;
    const response = await fetch(`/api/chat/sessions/${state.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify({ text, requestId }), signal: abort.signal });
    if (response.ok) $('chat-input').value = '';
    let done = false;
    await consumeChatStream(response, event => { if (epoch !== generation) return; handleEvent(event, optimisticId); if (event.type === 'done') done = true; });
    if (!done && epoch === generation) throw new Error('Reply stream disconnected. Already approved changes may have succeeded; review tool activity before retrying.');
  } catch (error) {
    if (epoch === generation) {
      $('chat-error').textContent = error.name === 'AbortError' ? 'Reply stopped. Already approved changes are not undone.' : error.message;
      if (error.status && error.status !== 200 && optimisticId && messages.has(optimisticId)) { messages.get(optimisticId).article.remove(); messages.delete(optimisticId); }
      if (error.status === 404) { state.id = null; state.loaded = false; storeId(null); }
    }
  } finally {
    if (epoch === generation) { state.sending = false; controller = null; approvals.clear(); closeApproval(); settleDisplayedTurn(); renderStatus(); }
  }
};
$('chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.sending && !initialization) $('chat-form').requestSubmit(); }
});
$('chat-stop').onclick = () => {
  controller?.abort();
  if (state.id) void api(`/api/chat/sessions/${state.id}/cancel`, {}).catch(() => {});
};
$('chat-new').onclick = async () => {
  if (initialization || state.resetting) return;
  if (!window.confirm('Start a new conversation? This stops the current reply and clears this chat. Academic records and already approved changes are kept.')) return;
  state.resetting = true; renderStatus();
  generation++; controller?.abort();
  try {
    if (state.id) await api(`/api/chat/sessions/${state.id}`, {}, 'DELETE');
  } catch (error) { if (error.status !== 404) {
    $('chat-error').textContent = error.message;
    state.resetting = false; state.sending = false; controller = null;
    approvals.clear(); closeApproval(); renderStatus(); return;
  } }
  state.resetting = false;
  state.id = null; state.model = null; state.loaded = false; state.sending = false; controller = null;
  storeId(null); resetTranscript(); $('chat-error').textContent = '';
  await showChat(); $('chat-input').focus();
};
$('chat-launcher').onclick = () => {
  document.dispatchEvent(new CustomEvent('academic:navigate', { detail: { page: 'assistant' } }));
  $('chat-input').focus();
};
for (const button of document.querySelectorAll('[data-chat-prompt]')) button.onclick = () => { $('chat-input').value = button.dataset.chatPrompt; $('chat-input').focus(); };
