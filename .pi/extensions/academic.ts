import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { resolve } from 'node:path';
import { Store } from '../../src/store.js';
import { AcademicService } from '../../src/service.js';
import { ROOT, loadConfig } from '../../src/config.js';
import { registerAcademicTools, academicSystemPrompt } from '../../src/academic-agent.js';

export default function (pi: ExtensionAPI) {
  let store: Store | undefined;
  let service: AcademicService | undefined;
  const getService = () => {
    if (!service) {
      store = new Store(resolve(ROOT, '.local/academic.sqlite'));
      service = new AcademicService(store, loadConfig());
      service.startRefresh();
    }
    return service;
  };
  pi.on('session_start', () => { getService(); });
  pi.on('session_shutdown', async () => {
    await service?.stop();
    store?.close();
    service = undefined;
    store = undefined;
  });
  pi.on('before_agent_start', event => ({
    systemPrompt: event.systemPrompt + '\n' + academicSystemPrompt(getService().records.context()),
  }));
  registerAcademicTools(pi, getService, Type);
}
