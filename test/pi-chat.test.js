import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sdk from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, validateToolArguments, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { DateTime } from 'luxon';
import { normalizeAiSelection } from '../src/config.js';
import { Store } from '../src/store.js';
import { AcademicService } from '../src/service.js';
import { createPiChatSession, requireModelAuthentication } from '../src/pi-chat.js';
import { registerAcademicTools } from '../src/academic-agent.js';

test('real Pi SDK initializes an isolated academic-only session without provider requests or discovered extensions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'campus-sdk-'));
  const store = new Store(':memory:');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let now = DateTime.fromISO('2026-11-19T10:00:00', { zone: 'Europe/Paris' });
  const service = new AcademicService(store, { frenchStartDate: '2026-01-01', refreshMinutes: 15 }, fetch, () => now);
  let approvalRequests = 0;
  const runtime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(directory, 'models-cache'), refreshOnCreate: false, allowModelNetwork: false });
  await runtime.setRuntimeApiKey('openai', 'fixture-not-a-real-provider-key');
  const model = runtime.getModels('openai')[0];
  assert.ok(model);
  let generationRequests = 0;
  // The runtime, not a fake AgentSession, is the boundary. A model request in
  // session creation would fail this test rather than contact a paid provider.
  runtime.streamSimple = () => { generationRequests++; throw new Error('Unexpected provider request'); };
  let loader;
  const isolatedSdk = { ...sdk, getAgentDir: () => directory, DefaultResourceLoader: class extends sdk.DefaultResourceLoader { constructor(options) { super(options); loader = this; } } };
  const session = await createPiChatSession({ service, signal: new AbortController().signal, selection: { provider: model.provider, model: model.id }, guard: { checkActive() {}, requestWrite() {}, confirm: async () => { approvalRequests++; return false; }, changed() {}, redact: value => value } }, { sdk: isolatedSdk, modelRuntime: runtime });
  t.after(() => session.dispose());
  const names = session.getActiveToolNames();
  assert.equal(names.length, 14);
  for (const name of ['bash', 'read', 'write', 'edit', 'find', 'grep', 'ls', 'codemode', 'execute', 'web_search']) assert.ok(!names.includes(name));
  assert.ok(names.includes('get_academic_overview'));
  assert.ok(names.includes('suggest_study_plan'));
  assert.equal(loader.getExtensions().extensions.length, 1, 'Only our trusted inline academic factory');
  assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert.equal(session.messages.length, 0);
  assert.equal(generationRequests, 0);
  assert.ok(!session.systemPrompt.includes('config.local.json'));
  const events = [], contexts = [];
  session.subscribe(event => events.push(event));
  runtime.streamSimple = (selected, context) => {
    generationRequests++; contexts.push(context);
    const stream = createAssistantMessageEventStream();
    const toolTurn = generationRequests % 2 === 1;
    const content = toolTurn ? [{ type: 'toolCall', id: `sdk-fixture-tool-${generationRequests}`, name: generationRequests === 1 ? 'get_academic_overview' : 'create_assignment', arguments: generationRequests === 1 ? {} : { title: 'Must respect denial' } }] : [{ type: 'text', text: 'SDK fixture réponse.' }];
    const message = { role: 'assistant', content, api: selected.api, provider: selected.provider, model: selected.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: toolTurn ? 'toolUse' : 'stop', timestamp: Date.now() };
    stream.push({ type: 'start', partial: message });
    if (toolTurn) {
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message });
    } else {
      stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: content[0].text, partial: message });
      stream.push({ type: 'text_end', contentIndex: 0, content: content[0].text, partial: message });
    }
    stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
    return stream;
  };
  await session.prompt('What should I focus on today?', { expandPromptTemplates: false, source: 'rpc' });
  assert.equal(generationRequests, 2);
  assert.ok(events.some(event => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && event.assistantMessageEvent.delta.includes('réponse')));
  assert.ok(events.some(event => event.type === 'tool_execution_end' && event.toolName === 'get_academic_overview' && !event.isError));
  assert.ok(JSON.stringify(contexts[0]).includes('Current Paris date/time'));
  assert.ok(!JSON.stringify(contexts[0]).includes('config.local.json'));
  assert.ok(!JSON.stringify(contexts[0]).includes('"name":"bash"'));
  now = now.plus({ days: 1 });
  await session.prompt('Create an assignment', { expandPromptTemplates: false, source: 'rpc' });
  assert.equal(generationRequests, 4);
  assert.equal(approvalRequests, 1);
  assert.equal(service.records.list('assignments').total, 0);
  assert.ok(events.some(event => event.type === 'tool_execution_end' && event.toolName === 'create_assignment' && event.isError));
  assert.ok(JSON.stringify(contexts[0]).includes('2026-11-19'));
  assert.ok(JSON.stringify(contexts[2]).includes('2026-11-20'), 'Paris context is rebuilt per user turn');
});

test('legacy Codex login is diagnosed without copying credentials or switching the selected OpenAI model', async () => {
  const model = { provider: 'openai', id: 'gpt-5.5' };
  const runtime = {
    hasConfiguredAuth: () => false,
    getAvailableSnapshot: () => [{ provider: 'openai-codex', id: 'legacy-model' }],
    listCredentials: async () => [{ providerId: 'openai-codex', type: 'oauth', access: 'fixture-secret-must-not-appear' }],
    getAuth: () => assert.fail('Must not request resolved credentials'),
    setRuntimeApiKey: () => assert.fail('Must not copy credentials'),
  };
  await assert.rejects(requireModelAuthentication(runtime, model), error => {
    assert.equal(error.code, 'auth_provider_mismatch');
    assert.ok(error.message.includes('/login openai'));
    assert.ok(error.message.includes('Sign in with ChatGPT'));
    assert.ok(error.message.includes('legacy'));
    assert.ok(!error.message.includes('fixture-secret'));
    return true;
  });
  assert.deepEqual(model, { provider: 'openai', id: 'gpt-5.5' });
});

test('authentication diagnostics honor matching credentials/public models and name the missing provider', async () => {
  const model = { provider: 'openai', id: 'example' };
  const configured = { hasConfiguredAuth: () => true, listCredentials: () => assert.fail('Unnecessary metadata access') };
  await requireModelAuthentication(configured, model);
  await requireModelAuthentication({ hasConfiguredAuth: () => false, getAvailableSnapshot: () => [model] }, model);
  await assert.rejects(requireModelAuthentication({ hasConfiguredAuth: () => false, getAvailableSnapshot: () => [], listCredentials: async () => [] }, { provider: 'anthropic', id: 'example' }), error => error.code === 'authentication_required' && error.message.includes('/login anthropic'));
});

test('AI selection accepts Pi IDs only, never application-stored credentials', () => {
  assert.equal(normalizeAiSelection(undefined), null);
  assert.deepEqual(normalizeAiSelection({ provider: 'openai-codex', model: ' example-model ' }), { provider: 'openai-codex', model: 'example-model' });
  for (const value of ['', [], { provider: 'openai' }, { provider: 'openai', model: '' }, { provider: 'openai', model: 'example', apiKey: 'not-accepted' }]) assert.throws(() => normalizeAiSelection(value), /Credentials stay in Pi/);
});

test('shared calendar tools expose valid schemas and actual service results', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const service = new AcademicService(store, { frenchStartDate: '2026-01-01', refreshMinutes: 15 });
  const tools = [];
  registerAcademicTools({ registerTool: tool => tools.push(tool) }, () => service, Type);
  assert.equal(tools.length, 14);
  for (const tool of tools.filter(tool => tool.name.includes('schedule') || tool.name === 'get_calendar_events')) {
    const args = { date: '2026-11-19' };
    validateToolArguments(tool, { name: tool.name, arguments: args });
    const result = await tool.execute('test', args);
    validateToolArguments({ name: tool.name + '_output', parameters: tool.outputSchema }, { name: tool.name + '_output', arguments: result.structuredContent });
    assert.deepEqual(result.structuredContent, service.schedule(args.date, tool.name === 'get_today_schedule' ? 'day' : 'week'));
  }
});
