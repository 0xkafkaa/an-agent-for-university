import { resolve } from 'node:path';
import { ROOT } from './config.js';
import { academicSystemPrompt } from './academic-agent.js';
import { createChatTools } from './chat-tools.js';

export class ChatError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export async function requireModelAuthentication(runtime, model) {
  if (runtime.hasConfiguredAuth(model.provider) || runtime.getAvailableSnapshot().some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return;
  // CredentialInfo exposes provider/type metadata only. Never request resolved
  // keys/tokens, copy credentials between providers, or silently change models.
  const metadata = await runtime.listCredentials();
  if (model.provider === 'openai' && metadata.some(item => item.providerId === 'openai-codex' && item.type === 'oauth')) {
    throw new ChatError('auth_provider_mismatch', 'The selected OpenAI model needs an openai login. Your existing openai-codex login is for the legacy Codex provider and cannot authenticate it. In this project run npx --no-install pi --no-extensions, then /login openai and choose Sign in with ChatGPT (not OpenAI Codex legacy or API key). After signing in, start New chat here. To keep the legacy login instead, use Pi /model to choose a supported openai-codex model. No credentials were changed.', 503);
  }
  throw new ChatError('authentication_required', `Pi has no authentication configured for the selected provider (${model.provider}). In Pi use /login ${model.provider}, or /model to select a provider you have already connected, then start New chat here. Your academic data remains available without AI.`, 503);
}

// Lazily imported SDK: ordinary calendar/form/dashboard use has no model/auth
// initialization. Credentials are read/refreshed by Pi, never returned to clients.
export async function createPiChatSession({ service, guard, signal, selection }, dependencies = {}) {
  const sdk = dependencies.sdk ?? await import('@earendil-works/pi-coding-agent');
  const { Type } = await import('typebox');
  guard.checkActive(false);
  const agentDir = sdk.getAgentDir();
  const defaults = sdk.SettingsManager.create(ROOT, agentDir, { projectTrusted: false });
  const provider = selection?.provider ?? defaults.getDefaultProvider();
  const modelId = selection?.model ?? defaults.getDefaultModel();
  const settings = sdk.SettingsManager.inMemory({
    ...(provider ? { defaultProvider: provider } : {}), ...(modelId ? { defaultModel: modelId } : {}),
    defaultThinkingLevel: 'low', defaultTools: [], cacheWarming: 'off',
    compaction: { enabled: false }, retry: { enabled: false }, httpIdleTimeoutMs: 120000,
    enableInstallTelemetry: false, enableAnalytics: false,
  });
  const modelRuntime = dependencies.modelRuntime ?? await sdk.ModelRuntime.create({
    authPath: resolve(agentDir, 'auth.json'), modelsPath: resolve(agentDir, 'models.json'),
    allowModelNetwork: false, signal,
  });
  let model;
  if (provider && modelId) {
    model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new ChatError('model_unavailable', 'The selected Pi model is unavailable. Check Pi /model or the local ai configuration.', 503);
    await requireModelAuthentication(modelRuntime, model);
  }
  const tools = createChatTools(service, Type, guard);
  const allowed = tools.map(tool => tool.name);
  const loader = new sdk.DefaultResourceLoader({
    cwd: ROOT, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: academicSystemPrompt(service.records.context()),
    extensionFactories: [pi => {
      for (const tool of tools) pi.registerTool(tool);
      pi.on('before_agent_start', () => ({
        systemPrompt: academicSystemPrompt(service.records.context()) + '\nBrowser safety: every academic write requires a real user approval dialog. The user may deny it. Never claim the confirmation came from the model or bypass it. Use academic tools only; no file, shell, network or coding tools exist in this chat.',
      }));
    }],
  });
  await loader.reload();
  guard.checkActive(false);
  const { session } = await sdk.createAgentSession({
    cwd: ROOT, agentDir, modelRuntime, model, resourceLoader: loader, settingsManager: settings,
    tools: allowed, noTools: 'builtin', sessionManager: sdk.SessionManager.inMemory(ROOT),
  });
  try {
    await session.bindExtensions({ mode: 'rpc' });
    guard.checkActive(false);
    if (!session.model) throw new ChatError('authentication_required', 'No authenticated Pi model is available. Connect your ChatGPT account with Pi /login and choose /model, then start a new chat.', 503);
    await requireModelAuthentication(modelRuntime, session.model);
    if (session.getActiveToolNames().length !== allowed.length || session.getActiveToolNames().some(name => !allowed.includes(name))) throw new ChatError('tool_policy_error', 'The assistant could not enforce its academic-only tool policy.', 503);
    return session;
  } catch (error) { session.dispose(); throw error; }
}
