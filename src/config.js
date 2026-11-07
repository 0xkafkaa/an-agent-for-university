import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { normalizePlanningPreferences } from './planning-policy.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function normalizeAiSelection(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['provider', 'model'].includes(key)) || typeof value.provider !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.provider) || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) throw new Error('ai must contain only a Pi provider and model ID. Credentials stay in Pi, not application configuration.');
  return { provider: value.provider, model: value.model.trim() };
}
export function loadConfig() {
  let config;
  try { config = JSON.parse(readFileSync(resolve(ROOT, 'config.local.json'), 'utf8')); }
  catch { throw new Error('Create config.local.json from config.example.json first.'); }
  let url;
  try { url = new URL(config.calendarUrl); } catch { throw new Error('Invalid calendar URL in local configuration.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Calendar URL must use HTTPS without user credentials.');
  const refreshMinutes = config.refreshMinutes ?? 15;
  const port = config.port ?? 3210;
  if (!Number.isInteger(refreshMinutes) || refreshMinutes < 1 || refreshMinutes > 1440) throw new Error('refreshMinutes must be 1–1440.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
  const ai = normalizeAiSelection(config.ai);
  return { calendarUrl: url.href, refreshMinutes, port, frenchStartDate: config.frenchStartDate ?? null, planning: normalizePlanningPreferences(config.planning), ai };
}
