export const NOFLY_REFUSED = -32001;

export function safeJson(value) {
  if (value == null) return '';
  try {
    const text = JSON.stringify(value);
    return text.length > 20000 ? text.slice(0, 20000) : text;
  } catch {
    return '';
  }
}

export const MAX_LINE_CHARS = 64 * 1024 * 1024;

export function createLineFramer(onMessage, { maxLine = MAX_LINE_CHARS, onOverflow } = {}) {
  let buffer = '';
  let dropping = false;
  const emit = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      onMessage(null, line);
      return;
    }
    onMessage(message, line);
  };
  return (chunk) => {
    let text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = text.indexOf('\n');
    while (newline !== -1) {
      const line = buffer + text.slice(0, newline);
      buffer = '';
      if (dropping) dropping = false;
      else emit(line);
      text = text.slice(newline + 1);
      newline = text.indexOf('\n');
    }
    if (dropping) return;
    buffer += text;
    if (buffer.length > maxLine) {
      onOverflow?.(buffer.slice(0, 4096));
      dropping = true;
      buffer = '';
    }
  };
}

export function idInHead(head) {
  const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(String(head ?? ''));
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

export function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function refusal(id, message, data) {
  return { jsonrpc: '2.0', id, error: { code: NOFLY_REFUSED, message, data } };
}

const BLOCKED_INIT_WAIT_MS = 3000;

export function sendBlockedInitialize(reason, server, verdict) {
  const data = {
    source: 'nofly-mcp-shim',
    server,
    refusedBy: 'policy',
    ...(verdict?.state ? { state: verdict.state } : {}),
    ...(verdict?.eventId ? { eventId: verdict.eventId } : {}),
  };
  return new Promise((done) => {
    let finished = false;
    const finish = (id) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.pause();
      process.stdout.write(`${JSON.stringify(refusal(id, reason, data))}\n`, () => done());
    };
    const timer = setTimeout(() => finish(0), BLOCKED_INIT_WAIT_MS);
    const framer = createLineFramer((message) => {
      if (message && typeof message === 'object' && !Array.isArray(message) && (typeof message.id === 'number' || typeof message.id === 'string')) finish(message.id);
    });
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', framer);
    process.stdin.once('end', () => finish(0));
    process.stdin.once('error', () => finish(0));
  });
}
