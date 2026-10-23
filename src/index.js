// Spike B: remote MCP server for Garmin's official Personal API, as a Cloudflare Worker.
// Zero dependencies. Stateless Streamable HTTP: every JSON-RPC message is one POST /mcp.
// ponytail: hand-rolled JSON-RPC like the desktop spike; swap in @modelcontextprotocol/sdk
// if the real kit needs sessions, resources or progress.

const HOST = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const KV_KEY = "garmin_jwt";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jwtExp = (jwt) => JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp;

let memo = null; // { token, exp }, survives across requests while the isolate lives

async function bearer(env, force = false) {
  const now = Date.now() / 1000;
  if (!force && memo && memo.exp - now > 3600) return memo.token;
  if (!force) {
    const cached = await env.TOKENS.get(KV_KEY, "json");
    if (cached && cached.exp - now > 3600) { memo = cached; return cached.token; }
  }
  const r = await fetch(HOST + TOKEN_PATH, { method: "POST", headers: { Authorization: `ApiKey ${env.GARMIN_PERSONAL_API_KEY}` } });
  if (r.status === 401 || r.status === 403)
    throw new Error("Garmin rejected the API key (expired or deleted). Create a new one in Garmin Connect > Settings > Personal API Key, then update the GARMIN_PERSONAL_API_KEY secret.");
  if (r.status === 429) throw new Error("Garmin is rate-limiting token requests. Wait a few minutes and try again.");
  if (!r.ok) throw new Error(`Token request failed: HTTP ${r.status}`);
  const token = (await r.text()).trim();
  memo = { token, exp: jwtExp(token) };
  await env.TOKENS.put(KV_KEY, JSON.stringify(memo), { expirationTtl: Math.max(60, Math.floor(memo.exp - now)) });
  return token;
}

async function garmin(env, path) {
  for (let auth = 0; auth < 2; auth++) {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const r = await fetch(HOST + path, {
        headers: { Authorization: `Bearer ${await bearer(env, auth === 1)}`, Accept: "application/json" },
      });
      if (r.status === 429 && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
      if (r.status === 401 && auth === 0) break; // token revoked early: re-mint once
      if (r.status === 204) return null;
      if (!r.ok) throw new Error(`Garmin returned HTTP ${r.status} for ${path.split("?")[0]}`);
      return r.json();
    }
  }
  throw new Error("Garmin keeps rejecting the token. Check your API key.");
}

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }); // ponytail: fixed TZ for the spike; kit reads the user's Garmin profile TZ
const hours = (s) => (s == null ? null : Math.round((s / 3600) * 10) / 10);
const mins = (s) => (s == null ? null : Math.round(s / 60));
const clock = (ms) => (ms == null ? null : new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" }));

const TOOLS = {
  get_sleep: {
    description: "Get a night's sleep from Garmin: sleep score, total hours, deep/light/REM/awake minutes, bed and wake time. date = the morning you woke up (YYYY-MM-DD), default today.",
    async run(env, { date = today() }) {
      const s = await garmin(env, `/sleep-service/sleep/dailySleep?date=${date}`);
      if (!s || s.sleepTimeSeconds == null) return { date, note: "No sleep recorded for this night." };
      return {
        date,
        score: s.sleepScores?.overall?.value ?? null,
        quality: s.sleepScores?.overall?.qualifierKey ?? null,
        total_hours: hours(s.sleepTimeSeconds),
        deep_min: mins(s.deepSleepSeconds), light_min: mins(s.lightSleepSeconds),
        rem_min: mins(s.remSleepSeconds), awake_min: mins(s.awakeSleepSeconds),
        bedtime: clock(s.sleepStartTimestampGMT), wake_time: clock(s.sleepEndTimestampGMT),
        avg_sleep_stress: s.avgSleepStress ?? null,
      };
    },
  },
  get_hrv: {
    description: "Get overnight HRV from Garmin: last-night average, 7-day average, personal baseline range and status (BALANCED/UNBALANCED/LOW). date = the morning after the night (YYYY-MM-DD), default today.",
    async run(env, { date = today() }) {
      const h = await garmin(env, `/hrv-service/hrv/${date}`);
      const s = h?.hrvSummary;
      if (!s) return { date, note: "No HRV recorded for this night (watch not worn, or not synced yet)." };
      return {
        date, last_night_avg: s.lastNightAvg, weekly_avg: s.weeklyAvg, status: s.status,
        baseline_balanced_low: s.baseline?.balancedLow, baseline_balanced_high: s.baseline?.balancedUpper,
      };
    },
  },
};

const DATE_SCHEMA = { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD; defaults to today" } } };

async function handle(env, msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "garmin-claude-worker", version: "0.0.1" } };
    case "ping":
      return {};
    case "tools/list":
      return { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: DATE_SCHEMA,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } })) };
    case "tools/call": {
      const tool = TOOLS[params?.name];
      if (!tool) throw Object.assign(new Error(`Unknown tool ${params?.name}`), { code: -32602 });
      try {
        const out = await tool.run(env, params.arguments || {});
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
    default:
      if (id === undefined) return undefined; // notification: no reply
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

// Auth: the buyer's MCP_TOKEN, either as "Authorization: Bearer <token>" (claude.ai Request headers)
// or as a path segment /t/<token>/mcp (fallback if the Request-headers field is not available).
// ponytail: spike supports both to learn which one claude.ai lets buyers use; kit keeps one.
function authorized(req, url, env) {
  if (!env.MCP_TOKEN) return false;
  const h = req.headers.get("authorization") || "";
  if (h.toLowerCase().startsWith("bearer ") && h.slice(7).trim() === env.MCP_TOKEN) return true;
  const m = url.pathname.match(/^\/t\/([^/]+)\/mcp$/);
  return !!m && m[1] === env.MCP_TOKEN;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const isMcp = url.pathname === "/mcp" || /^\/t\/[^/]+\/mcp$/.test(url.pathname);
    if (!isMcp) return new Response("garmin-claude-worker: POST /mcp", { status: 404 });
    if (!authorized(req, url, env)) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") return new Response(null, { status: 405 }); // no server-initiated stream
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    if (!env.GARMIN_PERSONAL_API_KEY) return json({ error: "GARMIN_PERSONAL_API_KEY secret is not set" }, 500);

    let msg;
    try { msg = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
    if (Array.isArray(msg)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches not supported" } }, 400);

    try {
      const result = await handle(env, msg);
      if (msg.id === undefined || result === undefined) return new Response(null, { status: 202 });
      return json({ jsonrpc: "2.0", id: msg.id, result });
    } catch (err) {
      return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: err.code ?? -32603, message: err.message } });
    }
  },
};
