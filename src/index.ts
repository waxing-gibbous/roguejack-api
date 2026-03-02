interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
}

const ALLOWED_ORIGINS = ['https://joshburke.github.io'];
const VALID_ROOMS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'obsidian'];
const MAX_SHARE_DATA_BYTES = 10_000;
const RATE_LIMIT_MAX = 10;

function isAllowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (env.ENVIRONMENT !== 'production' && /^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return null;
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = isAllowedOrigin(origin, env);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResp(data: unknown, status = 200, origin: string | null = null, env?: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...(env ? corsHeaders(origin, env) : {}) },
  });
}

function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') return 'Anonymous';
  const trimmed = name.trim().replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, '').slice(0, 30);
  return trimmed || 'Anonymous';
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && !Number.isNaN(v);
}

async function checkRateLimit(db: D1Database, ip: string): Promise<boolean> {
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();

  try {
    // Atomic upsert: reset window if expired, otherwise increment
    await db.prepare(
      `INSERT INTO rate_limits (ip, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END`
    ).bind(ip, now, hourAgo, hourAgo, now).run();

    // Check current count
    const row = await db.prepare('SELECT count FROM rate_limits WHERE ip = ?').bind(ip).first<{ count: number }>();
    return !row || row.count <= RATE_LIMIT_MAX;
  } catch (e) {
    console.error('Rate limit DB error:', e);
    return true; // Fail open
  }
}

/**
 * Statistical anomaly detection — rejects implausible scores.
 * Blackjack house edge means ~42-48% win rate long-term.
 */
function detectAnomalies(body: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const { peak_bankroll, hands_played, win_rate, blackjacks, win_streak, sixth_sense } = body as Record<string, number>;

  if (blackjacks > hands_played) flags.push('blackjacks cannot exceed hands_played');
  if (win_streak > hands_played) flags.push('win_streak cannot exceed hands_played');
  if (sixth_sense > hands_played) flags.push('sixth_sense cannot exceed hands_played');

  // Win rate thresholds by hand count
  if (hands_played >= 500 && win_rate > 58) flags.push('win_rate statistically implausible for hand count');
  else if (hands_played >= 100 && win_rate > 65) flags.push('win_rate statistically implausible for hand count');

  // Blackjack probability is ~4.8%. >15% at 100+ hands is very suspicious
  if (hands_played >= 100 && blackjacks / hands_played > 0.15) flags.push('blackjack rate statistically implausible');

  // Peak bankroll vs hands — $100k+ in <20 hands is suspect
  if (peak_bankroll > 100_000 && hands_played < 20) flags.push('peak_bankroll implausible for hand count');

  return flags;
}

async function handlePostRun(request: Request, env: Env, origin: string | null): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return jsonResp({ error: 'Unable to identify client' }, 400, origin, env);
  if (!(await checkRateLimit(env.DB, ip))) {
    return jsonResp({ error: 'Rate limit exceeded. Max 10 submissions per hour.' }, 429, origin, env);
  }

  let body: any;
  try { body = await request.json(); }
  catch { return jsonResp({ error: 'Invalid JSON' }, 400, origin, env); }

  const { peak_bankroll, final_bankroll, hands_played, win_rate, blackjacks, win_streak, highest_room, by_the_book, sixth_sense, share_data, client_hash } = body;
  const player_name = sanitizeName(body.player_name);

  // Type + range validation
  const errors: string[] = [];
  if (!isFiniteNum(peak_bankroll) || !isFiniteNum(final_bankroll)) errors.push('bankroll must be finite numbers');
  if (!isFiniteNum(hands_played) || hands_played <= 0 || hands_played > 100_000) errors.push('hands_played must be 1-100000');
  if (!isFiniteNum(win_rate) || win_rate < 0 || win_rate > 100) errors.push('win_rate must be 0-100');
  if (!isFiniteNum(by_the_book) || by_the_book < 0 || by_the_book > 100) errors.push('by_the_book must be 0-100');
  if (!isFiniteNum(sixth_sense) || sixth_sense < 0) errors.push('sixth_sense must be >= 0');
  if (!isFiniteNum(blackjacks) || blackjacks < 0) errors.push('blackjacks must be >= 0');
  if (!isFiniteNum(win_streak) || win_streak < 0) errors.push('win_streak must be >= 0');
  if (typeof highest_room !== 'string' || !VALID_ROOMS.includes(highest_room)) errors.push(`highest_room must be one of: ${VALID_ROOMS.join(', ')}`);
  if (isFiniteNum(peak_bankroll) && isFiniteNum(final_bankroll) && peak_bankroll < final_bankroll) errors.push('peak_bankroll must be >= final_bankroll');
  if (isFiniteNum(peak_bankroll) && peak_bankroll > 1_000_000) errors.push('peak_bankroll exceeds maximum');
  if (isFiniteNum(final_bankroll) && final_bankroll < 0) errors.push('final_bankroll must be >= 0');

  // share_data size cap
  if (share_data !== undefined && share_data !== null) {
    if (typeof share_data !== 'string') errors.push('share_data must be a string');
    else if (share_data.length > MAX_SHARE_DATA_BYTES) errors.push(`share_data exceeds ${MAX_SHARE_DATA_BYTES} byte limit`);
  }

  if (errors.length) return jsonResp({ error: 'Validation failed', details: errors }, 400, origin, env);

  // Statistical anomaly detection
  const anomalies = detectAnomalies(body);
  if (anomalies.length) return jsonResp({ error: 'Score rejected: statistically implausible', details: anomalies }, 422, origin, env);

  const id = crypto.randomUUID();

  // Round to integers for consistent storage
  const v = {
    pb: Math.round(peak_bankroll), fb: Math.round(final_bankroll),
    hp: Math.round(hands_played), wr: Math.round(win_rate),
    bk: Math.round(blackjacks), ws: Math.round(win_streak),
    bt: Math.round(by_the_book), ss: Math.round(sixth_sense),
  };

  await env.DB.prepare(
    `INSERT INTO runs (id, player_name, peak_bankroll, final_bankroll, hands_played, win_rate, blackjacks, win_streak, highest_room, by_the_book, sixth_sense, share_data, client_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, player_name, v.pb, v.fb, v.hp, v.wr, v.bk, v.ws, highest_room, v.bt, v.ss, share_data ?? null, client_hash ?? null).run();

  const rankRow = await env.DB.prepare('SELECT COUNT(*) as c FROM runs WHERE peak_bankroll > ?').bind(v.pb).first<{ c: number }>();
  const rank = (rankRow?.c ?? 0) + 1;

  return jsonResp({ id, rank }, 201, origin, env);
}

async function handleGetRuns(url: URL, env: Env, origin: string | null): Promise<Response> {
  const period = url.searchParams.get('period') || 'alltime';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 100);

  const cols = 'id, player_name, peak_bankroll, final_bankroll, hands_played, win_rate, blackjacks, win_streak, highest_room, by_the_book, sixth_sense, submitted_at';
  let query: string;
  if (period === 'weekly') query = `SELECT ${cols} FROM runs WHERE submitted_at > datetime('now', '-7 days') ORDER BY peak_bankroll DESC LIMIT ?`;
  else if (period === 'daily') query = `SELECT ${cols} FROM runs WHERE submitted_at > datetime('now', '-1 day') ORDER BY peak_bankroll DESC LIMIT ?`;
  else query = `SELECT ${cols} FROM runs ORDER BY peak_bankroll DESC LIMIT ?`;

  const rows = await env.DB.prepare(query).bind(limit).all();
  return jsonResp({ runs: rows.results, period, limit }, 200, origin, env);
}

async function handleGetRun(id: string, env: Env, origin: string | null): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, player_name, peak_bankroll, final_bankroll, hands_played, win_rate, blackjacks, win_streak, highest_room, by_the_book, sixth_sense, submitted_at, client_hash
     FROM runs WHERE id = ?`
  ).bind(id).first();
  if (!row) return jsonResp({ error: 'Not found' }, 404, origin, env);
  return jsonResp(row, 200, origin, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    const path = url.pathname;

    if (path === '/health' && request.method === 'GET') return jsonResp({ status: 'ok', timestamp: new Date().toISOString() }, 200, origin, env);
    if (path === '/runs' && request.method === 'POST') return handlePostRun(request, env, origin);
    if (path === '/runs' && request.method === 'GET') return handleGetRuns(url, env, origin);

    const runMatch = path.match(/^\/runs\/([a-f0-9-]+)$/);
    if (runMatch && request.method === 'GET') return handleGetRun(runMatch[1], env, origin);

    return jsonResp({ error: 'Not found' }, 404, origin, env);
  },
};
