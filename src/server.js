import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { AcademicService } from './service.js';
import { loadConfig, ROOT } from './config.js';
import { RecordError } from './records.js';
import { ChatManager } from './chat.js';
import { ChatError } from './pi-chat.js';

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new RecordError('Expected application/json.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new RecordError('Request too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RecordError('Invalid JSON.'); }
}
function queryFilters(searchParams) {
  const filters = {};
  for (const [key, value] of searchParams) {
    if (Object.hasOwn(filters, key)) throw new RecordError('Duplicate filter.');
    if (['limit', 'offset', 'days', 'minutes'].includes(key)) {
      if (!/^\d+$/.test(value)) throw new RecordError('Invalid numeric filter.');
      filters[key] = Number(value);
    } else if (['undated', 'overdue'].includes(key)) {
      if (!['true', 'false'].includes(value)) throw new RecordError('Invalid boolean filter.');
      filters[key] = value === 'true';
    } else Object.defineProperty(filters, key, { value, enumerable: true, configurable: true });
  }
  return filters;
}

export function createApp(service, port, { chat = new ChatManager(service) } = {}) {
  const token = randomBytes(32).toString('hex');
  const assets = new Map([
    ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
    ['/client.js', ['client.js', 'text/javascript']], ['/records.js', ['records.js', 'text/javascript']],
    ['/dashboard.js', ['dashboard.js', 'text/javascript']], ['/planning.js', ['planning.js', 'text/javascript']],
    ['/ui.js', ['ui.js', 'text/javascript']], ['/shell.js', ['shell.js', 'text/javascript']], ['/chat.js', ['chat.js', 'text/javascript']], ['/chat-stream.js', ['chat-stream.js', 'text/javascript']], ['/chat.css', ['chat.css', 'text/css']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']], ['/fonts/manrope.ttf', ['fonts/manrope.ttf', 'font/ttf']],
    ['/fonts/OFL.txt', ['fonts/OFL.txt', 'text/plain']],
  ]);
  const server = createServer(async (req, res) => {
    const listeningPort = server.address()?.port ?? port;
    const allowedHosts = new Set([`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`]);
    const host = req.headers.host;
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!allowedHosts.has(host)) return send(403, { error: 'Invalid host.' });
    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        const binary = contentType.startsWith('font/');
        let body = readFileSync(resolve(ROOT, 'public', file), binary ? undefined : 'utf8');
        if (file === 'index.html') body = body.replace('__CSRF__', token);
        res.writeHead(200, { 'Content-Type': `${contentType}${binary ? '' : '; charset=utf-8'}` });
        return res.end(body);
      }
      if (req.method === 'GET' && url.pathname === '/api/schedule') {
        return send(200, service.schedule(url.searchParams.get('date') ?? undefined, url.searchParams.get('view') ?? 'week'));
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        if (url.searchParams.size) throw new RecordError('Academic overview accepts no query parameters.');
        return send(200, service.overview());
      }
      if (req.method === 'GET' && url.pathname === '/api/study-plan') return send(200, service.suggestStudyPlan(queryFilters(url.searchParams)));
      const chatRoute = url.pathname.match(/^\/api\/chat\/sessions(?:\/([a-f0-9]{48})(?:\/(messages|confirm|cancel))?)?$/);
      if (chatRoute && req.method === 'GET' && chatRoute[1] && !chatRoute[2]) return send(200, chat.snapshot(chatRoute[1]));
      const recordRoute = url.pathname.match(/^\/api\/(assignments|exams)(?:\/([^/]+)(?:\/(complete))?)?$/);
      if (recordRoute && req.method === 'GET') {
        const [, kind, id] = recordRoute;
        if (recordRoute[3]) return send(404, { error: 'Not found.' });
        return send(200, id ? service.records.get(kind, id) : service.records.list(kind, queryFilters(url.searchParams)));
      }
      if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        const supplied = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
        const expected = Buffer.from(token);
        if (req.headers.origin !== `http://${host}` || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: 'Invalid request origin/token.' });
        if (chatRoute) {
          const [, id, action] = chatRoute;
          const body = await readJson(req);
          if (!id && req.method === 'POST') {
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ChatError('invalid_request', 'Session creation accepts an empty object.');
            return send(201, chat.create());
          }
          if (id && action === 'messages' && req.method === 'POST') {
            let ended = false;
            const job = chat.start(id, body, event => {
              if (ended || res.destroyed) return;
              if (res.writableLength > 1048576) { res.destroy(); return; }
              res.write(JSON.stringify(event) + '\n');
            });
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
            res.flushHeaders();
            const heartbeat = setInterval(() => { if (!ended && !res.destroyed) res.write('{"type":"heartbeat"}\n'); }, 15000);
            heartbeat.unref();
            const disconnected = () => { if (!ended) { try { chat.cancel(id); } catch { /* Session already removed. */ } } };
            res.on('close', disconnected);
            try { await job.done; }
            finally { ended = true; clearInterval(heartbeat); res.off('close', disconnected); if (!res.destroyed) res.end(); }
            return;
          }
          if (id && action === 'confirm' && req.method === 'POST') return send(200, chat.approve(id, body));
          if (id && action === 'cancel' && req.method === 'POST') return send(200, chat.cancel(id));
          if (id && !action && req.method === 'DELETE') return send(200, await chat.remove(id));
          return send(405, { error: 'Method not allowed.' });
        }
        if (url.pathname === '/api/study-plan' && req.method === 'POST') return send(200, service.suggestStudyPlan(await readJson(req)));
        if (recordRoute) {
          const [, kind, id, action] = recordRoute;
          const body = await readJson(req);
          if (id && (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'id'))) throw new RecordError('Record ID belongs in the URL; expected an object without id.');
          if (!id && req.method === 'POST') return send(201, service.records.create(kind, body));
          if (id && !action && req.method === 'PATCH') return send(200, service.records.update(kind, { id, ...body }));
          if (id && !action && req.method === 'DELETE') {
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['version', 'confirmed'].includes(k))) throw new RecordError('Invalid deletion request.');
            return send(200, service.records.delete(kind, { id, version: body.version }, body.confirmed));
          }
          if (id && kind === 'assignments' && action === 'complete' && req.method === 'POST') return send(200, service.records.complete({ id, ...body }));
          return send(405, { error: 'Method not allowed.' });
        }
        if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
        if (url.pathname === '/api/sync') return send(200, await service.sync());
        if (url.pathname === '/api/occurrence') {
          return send(200, service.overrideOccurrence(await readJson(req)));
        }
      }
      send(404, { error: 'Not found.' });
    } catch (error) {
      // Calendar text and network errors never reach logs or client responses.
      if (res.headersSent) { res.end(); return; }
      if (error instanceof ChatError) return send(error.status, { error: error.message, code: error.code });
      if (error instanceof RecordError) return send(error.status, { error: error.message });
      if (url.pathname.startsWith('/api/chat/')) return send(503, { error: 'The assistant is unavailable. Academic data remains available without AI.', code: 'assistant_unavailable' });
      const isPlanning = url.pathname === '/api/study-plan';
      const isOverview = url.pathname === '/api/overview';
      const isRecords = /^\/api\/(assignments|exams)(\/|$)/.test(url.pathname);
      const message = isPlanning ? 'Unable to generate study recommendations.' : isOverview ? 'Unable to load academic overview.' : isRecords ? 'Unable to access academic records.' : url.pathname === '/api/occurrence' ? error.message : 'Unable to load schedule. Check the date or cached calendar.';
      send(isRecords || isOverview || isPlanning ? 500 : 400, { error: message });
    }
  });
  server.chat = chat;
  server.on('close', () => { void chat.close().catch(() => {}); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConfig();
  const store = new Store(resolve(ROOT, '.local/academic.sqlite'));
  const service = new AcademicService(store, config);
  const server = createApp(service, config.port);
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`Academic calendar: http://127.0.0.1:${config.port}`);
    service.startRefresh();
  });
  server.on('error', () => { console.error('Unable to start local server; check the configured port.'); process.exit(1); });
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeIdleConnections();
    await server.chat.close();
    await service.stop();
    store.close();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
