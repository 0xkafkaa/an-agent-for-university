import { registerAcademicTools } from './academic-agent.js';
import { validate } from './records.js';

// The SDK and the CLI use the exact same academic tool definitions/services.
// The browser adds a stricter write-approval boundary; it never gets coding tools.
export function createChatTools(service, Type, guard) {
  const definitions = [];
  registerAcademicTools({ registerTool: tool => definitions.push(tool) }, () => service, Type);
  return definitions.map(tool => ({
    ...tool,
    async execute(id, params, signal, onUpdate, ctx) {
      const runId = guard.checkActive();
      const redactValue = (_key, value) => typeof value === 'string' ? guard.redact(value) : value;
      const input = JSON.parse(JSON.stringify(params), redactValue);
      const readOnly = tool.annotations?.readOnlyHint === true;
      if (!readOnly) { validate(tool.parameters, input); guard.requestWrite(); }
      if (!readOnly && !tool.name.startsWith('delete_')) {
        let preview = input;
        if (tool.name.startsWith('update_') || tool.name.startsWith('complete_')) {
          const record = service.records.get(tool.name.endsWith('_assignment') ? 'assignments' : 'exams', input.id);
          if (record.version !== input.version) throw new Error('The record changed. List records again to obtain its current version before requesting approval.');
          preview = { currentRecord: record, requestedChange: input };
        }
        const approved = await guard.confirm(`Allow ${tool.label}?`, JSON.stringify(preview, null, 2), tool.name, signal, id);
        if (!approved) throw new Error('User did not approve this change. No data changed.');
      }
      if (signal?.aborted) throw new Error('Chat turn cancelled.');
      guard.checkActive(false, runId);
      const result = await tool.execute(id, input, signal, onUpdate, {
        ...ctx, hasUI: true,
        ui: { confirm: async (title, message) => {
          const approved = await guard.confirm(title, message, tool.name, signal, id);
          if (signal?.aborted) return false;
          if (approved) guard.checkActive(false, runId);
          return approved;
        } },
      });
      if (!readOnly && !result.isError) guard.changed(tool.name);
      const safe = JSON.parse(JSON.stringify(result), redactValue);
      safe.content = safe.content.map(block => block.type === 'text' && block.text.length > 60000 ? {
        ...block, text: block.text.slice(0, 60000) + '\n[Result shortened. Use filtered list tools and pagination for the remaining data.]',
      } : block);
      return safe;
    },
  }));
}
