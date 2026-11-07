// Deterministic test adapter, never imported by production. Real academic tool
// handlers and SQLite run underneath; only provider generation is replaced.
import { Type } from 'typebox';
import { createChatTools } from '../src/chat-tools.js';

export function fakeChatFactory(respond = async ({ answer, call }) => {
  const result = await call('get_academic_overview', {});
  answer(`Fixture response: ${result.structuredContent.needsAttention.undatedAssignments.length} undated assignments. <img src=x onerror="window.chatXss=true">`);
}) {
  const stats = { created: 0, prompts: [], disposed: 0 };
  const createSession = async ({ service, guard }) => {
    stats.created++;
    const tools = new Map(createChatTools(service, Type, guard).map(tool => [tool.name, tool]));
    const listeners = new Set();
    const emit = event => { for (const listener of listeners) listener(event); };
    let abort, pending;
    function answer(text) {
      if (abort.signal.aborted) throw new Error('Aborted');
      emit({ type: 'message_start', message: { role: 'assistant' } });
      const characters = Array.from(text);
      for (let i = 0; i < characters.length; i += 12) emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: characters.slice(i, i + 12).join('') } });
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
    }
    async function call(name, params) {
      const id = crypto.randomUUID();
      emit({ type: 'tool_execution_start', toolCallId: id, toolName: name, args: params });
      let result, isError = false;
      try {
        if (!tools.has(name)) throw new Error('Unknown tool');
        result = await tools.get(name).execute(id, params, abort.signal, () => {}, {});
      } catch (error) { isError = true; result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
      emit({ type: 'tool_execution_end', toolCallId: id, toolName: name, result, isError });
      return result;
    }
    return {
      model: { provider: 'fixture', id: 'test-model', name: 'Deterministic test model' },
      getActiveToolNames: () => [...tools.keys()],
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      prompt(text) {
        stats.prompts.push(text); abort = new AbortController();
        pending = Promise.resolve().then(() => respond({ text, call, answer, signal: abort.signal, service, emit, tools }));
        return pending;
      },
      async abort() { abort?.abort(); await pending?.catch(() => {}); },
      dispose() { stats.disposed++; abort?.abort(); listeners.clear(); },
    };
  };
  return { createSession, stats };
}
