import { randomBytes, randomUUID } from 'node:crypto';
import { ChatError, createPiChatSession } from './pi-chat.js';

const token = () => randomBytes(24).toString('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateChatInput(body) {
  if (!object(body) || Object.keys(body).some(k => !['text', 'requestId'].includes(k)) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000 || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)) throw new ChatError('invalid_message', 'Provide a message of 1–8,000 characters and a unique request ID.');
}

export class ChatManager {
  constructor(service, { createSession = createPiChatSession, approvalTimeoutMs = 120000, turnTimeoutMs = 180000, idleTimeoutMs = 1800000, maxThreads = 8 } = {}) {
    this.service = service;
    this.createSession = createSession;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxThreads = maxThreads;
    this.threads = new Map();
    this.closed = false;
    this.secrets = [];
    if (service.config.calendarUrl) {
      this.secrets.push(service.config.calendarUrl);
      try {
        const url = new URL(service.config.calendarUrl);
        const path = url.pathname.split('/');
        if (path.at(-2) === 'ics' && path.at(-1).length >= 8) this.secrets.push(decodeURIComponent(path.at(-1)));
        for (const [key, value] of url.searchParams) if (/^(token|key|api_?key|access_token|auth)$/i.test(key) && value.length >= 8) this.secrets.push(value);
      } catch { /* Invalid configuration is handled by the calendar service. */ }
    }
  }
  redact = text => this.secrets.reduce((value, secret) => value.split(secret).join('[private calendar feed redacted]'), String(text));
  prune() {
    for (const [id, thread] of this.threads) if (!thread.run && Date.now() - thread.touched > this.idleTimeoutMs) {
      thread.session?.dispose(); this.threads.delete(id);
    }
  }
  create() {
    this.prune();
    if (this.closed) throw new ChatError('shutting_down', 'The assistant is shutting down.', 503);
    if (this.threads.size >= this.maxThreads) throw new ChatError('too_many_chats', 'Too many open chats. Close an unused chat or try again later.', 429);
    const id = token();
    this.threads.set(id, { id, messages: [], activity: [], approvals: new Map(), requests: new Set(), session: null, model: null, run: null, lastError: null, lastOutcome: null, touched: Date.now() });
    return this.snapshot(id);
  }
  get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) throw new ChatError('chat_not_found', 'Chat not found or expired. Start a new conversation.', 404);
    const thread = this.threads.get(id);
    if (thread && !thread.run && Date.now() - thread.touched > this.idleTimeoutMs) {
      thread.session?.dispose(); this.threads.delete(id);
      throw new ChatError('chat_not_found', 'Chat expired. Start a new conversation.', 404);
    }
    if (!thread) throw new ChatError('chat_not_found', 'Chat not found or expired. Start a new conversation.', 404);
    thread.touched = Date.now();
    return thread;
  }
  snapshot(id) {
    const thread = this.get(id);
    return { id, state: thread.run ? 'running' : 'idle', model: thread.model, lastError: thread.lastError, lastOutcome: thread.lastOutcome, messages: structuredClone(thread.messages), activity: structuredClone(thread.activity),
      confirmations: [...thread.approvals.values()].map(a => structuredClone(a.public)),
      persistence: 'Conversation stays in server memory while this app runs. Academic records remain in SQLite.' };
  }
  emit(thread, event) {
    try { thread.run?.emit(JSON.parse(this.redact(JSON.stringify(event)))); }
    catch { this.cancel(thread.id); }
  }
  confirm(thread, title, message, toolName, signal, toolCallId) {
    const run = thread.run;
    if (!run || run.abort.signal.aborted || signal?.aborted) return Promise.resolve(false);
    if (message.length > 16000) throw new ChatError('approval_too_large', 'This change is too large to review safely in chat. Review or edit the record with the manual academic forms instead.');
    const id = token();
    const publicInfo = { id, runId: run.id, toolName, toolCallId, title: this.redact(title), message: this.redact(message), expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString() };
    return new Promise(resolve => {
      const finish = (approved, reason) => {
        if (!thread.approvals.has(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        thread.approvals.delete(id);
        this.emit(thread, { type: 'confirmation_resolved', id, approved, reason });
        resolve(approved);
      };
      const aborted = () => finish(false, 'cancelled');
      const timer = setTimeout(() => finish(false, 'expired'), this.approvalTimeoutMs);
      timer.unref?.();
      thread.approvals.set(id, { public: publicInfo, finish });
      signal?.addEventListener('abort', aborted, { once: true });
      this.emit(thread, { type: 'confirmation', ...publicInfo });
    });
  }
  approve(id, body) {
    const thread = this.get(id);
    if (!object(body) || Object.keys(body).some(k => !['confirmationId', 'approved'].includes(k)) || typeof body.confirmationId !== 'string' || typeof body.approved !== 'boolean') throw new ChatError('invalid_confirmation', 'Invalid confirmation response.');
    const approval = thread.approvals.get(body.confirmationId);
    if (!approval || !thread.run || thread.run.abort.signal.aborted || Date.parse(approval.public.expiresAt) <= Date.now()) throw new ChatError('confirmation_expired', 'That confirmation is no longer active.', 409);
    approval.finish(body.approved, body.approved ? 'approved' : 'denied');
    return { ok: true };
  }
  start(id, body, emit) {
    validateChatInput(body);
    const thread = this.get(id);
    if (this.closed) throw new ChatError('shutting_down', 'The assistant is shutting down.', 503);
    if (thread.run) throw new ChatError('chat_busy', 'Wait for the current reply or stop it before sending another message.', 409);
    if (thread.requests.has(body.requestId)) throw new ChatError('duplicate_request', 'This message was already submitted. It will not be executed twice.', 409);
    if (thread.messages.length >= 100) throw new ChatError('chat_limit', 'This conversation is full. Start a new chat; academic records will remain unchanged.', 409);
    const run = { id: randomUUID(), abort: new AbortController(), emit, toolCalls: 0, current: null, failure: false, error: null };
    thread.requests.add(body.requestId);
    const user = { id: randomUUID(), role: 'user', text: this.redact(body.text.trim()), status: 'completed', createdAt: new Date().toISOString() };
    thread.messages.push(user);
    thread.run = run;
    thread.lastError = null; thread.lastOutcome = 'running';
    const done = Promise.resolve().then(() => this.perform(thread, run, user));
    run.done = done;
    return { runId: run.id, done };
  }
  assistantText(thread, run, text, status = 'streaming') {
    if (text.length > 64000) {
      run.error = new ChatError('reply_too_large', 'The reply exceeded the chat size limit. Ask for a smaller date range or a more specific question.');
      this.cancel(thread.id);
      text = text.slice(0, 64000);
    }
    if (text.trim()) run.hadText = true;
    if (!run.current) {
      run.current = { id: randomUUID(), role: 'assistant', text: '', status, createdAt: new Date().toISOString() };
      thread.messages.push(run.current);
    }
    run.current.text = this.redact(text);
    run.current.status = status;
    this.emit(thread, { type: 'assistant_text', message: structuredClone(run.current) });
  }
  onSessionEvent(thread, run, event) {
    if (thread.run !== run) return;
    if (event.type === 'message_start' && event.message.role === 'assistant') { run.current = null; run.rawText = ''; }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      run.rawText = (run.rawText ?? '') + event.assistantMessageEvent.delta;
      this.assistantText(thread, run, run.rawText);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const text = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text) this.assistantText(thread, run, text, ['error', 'aborted', 'length'].includes(event.message.stopReason) ? 'incomplete' : 'completed');
      if (event.message.stopReason === 'error' || (event.message.stopReason === 'aborted' && !run.abort.signal.aborted)) run.failure = true;
      if (event.message.stopReason === 'length') run.error = new ChatError('reply_incomplete', 'The response reached the model’s output limit. Ask it to continue; review tool activity before repeating a write.');
    }
    if (event.type === 'tool_execution_start') {
      const activity = { id: event.toolCallId, runId: run.id, name: event.toolName, status: 'running' };
      thread.activity.push(activity);
      thread.activity = thread.activity.slice(-100);
      this.emit(thread, { type: 'tool', ...activity });
    }
    if (event.type === 'tool_execution_end') {
      const activity = thread.activity.find(a => a.id === event.toolCallId);
      if (activity) { activity.status = event.isError ? 'failed' : 'completed'; this.emit(thread, { type: 'tool', ...activity }); }
    }
    if (event.type === 'compaction_start') this.emit(thread, { type: 'status', text: 'Pi is managing conversation context…' });
  }
  async perform(thread, run, user) {
    const timeout = setTimeout(() => { run.error = new ChatError('turn_timeout', 'The reply timed out. Already approved changes are not undone. Review tool activity before retrying.'); this.cancel(thread.id); }, this.turnTimeoutMs);
    timeout.unref?.();
    let unsubscribe;
    this.emit(thread, { type: 'run_started', runId: run.id, message: user });
    try {
      const guard = {
        checkActive: (count = true, expectedRunId) => {
          if (run.abort.signal.aborted || thread.run !== run || (expectedRunId && expectedRunId !== run.id)) throw new Error('Chat turn cancelled.');
          if (count && ++run.toolCalls > 24) { run.error = new ChatError('tool_limit', 'The assistant reached its tool-call limit. Ask for a smaller single task.'); this.cancel(thread.id); throw run.error; }
          return run.id;
        },
        requestWrite: () => {
          if (run.writeRequested) throw new Error('Only one academic change is allowed per message. Ask the user to send a separate message for each additional change; bulk operations are unsupported.');
          run.writeRequested = true;
        },
        confirm: (title, message, toolName, signal, toolCallId) => this.confirm(thread, title, message, toolName, signal, toolCallId),
        changed: toolName => this.emit(thread, { type: 'data_changed', toolName }), redact: this.redact,
      };
      // The guard is stable across turns; session tools route through the active run.
      thread.guard = guard;
      if (!thread.session) {
        const proxy = {
          checkActive: (...args) => thread.guard.checkActive(...args),
          requestWrite: (...args) => thread.guard.requestWrite(...args),
          confirm: (...args) => thread.guard.confirm(...args),
          changed: (...args) => thread.guard.changed(...args), redact: this.redact,
        };
        const session = await this.createSession({ service: this.service, guard: proxy, signal: run.abort.signal, selection: this.service.config.ai });
        if (run.abort.signal.aborted) { session.dispose(); throw new Error('Cancelled during startup.'); }
        thread.session = session;
        thread.model = { provider: this.redact(session.model.provider), id: this.redact(session.model.id), name: this.redact(session.model.name ?? session.model.id) };
      }
      this.emit(thread, { type: 'model', model: thread.model });
      unsubscribe = thread.session.subscribe(event => this.onSessionEvent(thread, run, event));
      await thread.session.prompt(user.text, { expandPromptTemplates: false, source: 'rpc' });
      if (run.failure) throw new ChatError('model_error', 'Pi could not complete the reply. Check your Pi login/model and network connection. Academic data is still available; review tool activity before retrying.', 503);
      if (run.error) throw run.error;
      if (!run.hadText && !run.abort.signal.aborted) throw new ChatError('empty_reply', 'Pi finished without a text reply. Review tool activity before retrying a write; already approved changes may have succeeded.');
    } catch (error) {
      const safe = run.error ?? (error instanceof ChatError ? error : run.abort.signal.aborted ? null : new ChatError('assistant_unavailable', 'The Pi assistant is unavailable. Check Pi /login, /model and your network, then start a new chat. Review tool activity before retrying a write; already approved changes are not undone.', 503));
      if (safe) {
        thread.lastError = { code: safe.code, message: safe.message };
        this.emit(thread, { type: 'error', ...thread.lastError });
      }
    } finally {
      clearTimeout(timeout);
      unsubscribe?.();
      for (const approval of [...thread.approvals.values()]) approval.finish(false, 'cancelled');
      for (const message of thread.messages) if (message.status === 'streaming') message.status = 'incomplete';
      for (const activity of thread.activity) if (activity.status === 'running') activity.status = 'interrupted';
      thread.lastOutcome = thread.lastError ? 'failed' : run.abort.signal.aborted ? 'cancelled' : 'completed';
      this.emit(thread, { type: 'done', runId: run.id, cancelled: run.abort.signal.aborted, model: thread.model });
      thread.run = null;
      thread.touched = Date.now();
    }
  }
  cancel(id) {
    const thread = this.get(id);
    if (thread.run) {
      thread.run.abort.abort();
      for (const approval of [...thread.approvals.values()]) approval.finish(false, 'cancelled');
      void thread.session?.abort().catch(() => {});
    }
    return { ok: true };
  }
  async remove(id) {
    const thread = this.get(id);
    this.cancel(id);
    await thread.run?.done;
    thread.session?.dispose();
    this.threads.delete(id);
    return { ok: true };
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const threads = [...this.threads.values()];
      for (const thread of threads) {
        if (thread.run) {
          thread.run.abort.abort();
          for (const approval of [...thread.approvals.values()]) approval.finish(false, 'cancelled');
          void thread.session?.abort().catch(() => {});
        }
      }
      await Promise.all(threads.map(thread => thread.run?.done));
      for (const thread of threads) thread.session?.dispose();
      this.threads.clear();
    })();
    return this.closing;
  }
}
