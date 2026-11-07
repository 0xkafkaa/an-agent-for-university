// POST streaming uses newline-delimited JSON so ordinary same-origin CSRF
// headers and cancellation work without query-string credentials or SSE cookies.
export async function consumeChatStream(response, onEvent) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error ?? 'The assistant request failed.');
    error.status = response.status; error.code = body.code;
    throw error;
  }
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('Invalid assistant stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  function line(text) {
    if (!text.trim()) return;
    if (text.length > 1048576) throw new Error('Assistant event exceeded the size limit.');
    const event = JSON.parse(text);
    if (!event || typeof event.type !== 'string') throw new Error('Invalid assistant event.');
    onEvent(event);
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1); }
      if (buffer.length > 1048576) throw new Error('Assistant stream exceeded the size limit.');
      if (done) { line(buffer); return; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
