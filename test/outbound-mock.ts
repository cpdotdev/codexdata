// Outbound stub for tests: vitest-pool-workers 0.22 no longer provides fetchMock, so Miniflare's
// `outboundService` intercepts every outbound fetch from the test Worker (Durable Object included).
// This function runs in the Node process; test code scripts replies and reads the log through
// `https://mock.local/*`.
//
//   POST https://mock.local/reset                      clear the scripted replies and the log
//   POST https://mock.local/oauth  {status, body}      enqueue one reply for auth.openai.com/oauth/token
//   POST https://mock.local/npm    {version}           set the registry.npmjs.org reply
//   GET  https://mock.local/log                        outbound requests received so far [{url, method, body}]
//
// Unscripted hosts → 502 JSON `{error:"unmocked"}` (and logged), so tests never actually reach the
// network.

interface Scripted {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface LogEntry {
  url: string;
  method: string;
  body: string;
}

const state = {
  oauth: [] as Scripted[],
  npm: { status: 200, body: JSON.stringify({ version: "0.153.4" }) } as Scripted,
  log: [] as LogEntry[],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scripted(reply: Scripted): Response {
  return new Response(reply.body, {
    status: reply.status,
    headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
  });
}

export async function outboundMock(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === "mock.local") {
    switch (`${request.method} ${url.pathname}`) {
      case "POST /reset":
        state.oauth = [];
        state.npm = { status: 200, body: JSON.stringify({ version: "0.153.4" }) };
        state.log = [];
        return json({ ok: true });
      case "POST /oauth":
        state.oauth.push((await request.json()) as Scripted);
        return json({ ok: true, queued: state.oauth.length });
      case "POST /npm": {
        const { version } = (await request.json()) as { version: string };
        state.npm = { status: 200, body: JSON.stringify({ version }) };
        return json({ ok: true });
      }
      case "GET /log":
        return json(state.log);
      default:
        return json({ error: "unknown control route" }, 404);
    }
  }

  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  state.log.push({ url: request.url, method: request.method, body });

  if (url.hostname === "auth.openai.com" && url.pathname === "/oauth/token") {
    const reply = state.oauth.shift();
    if (!reply) return json({ error: "no scripted oauth reply" }, 599);
    return scripted(reply);
  }
  if (url.hostname === "registry.npmjs.org") {
    return scripted(state.npm);
  }
  return json({ error: "unmocked", url: request.url }, 502);
}
