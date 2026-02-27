interface Env {
  DB: D1Database;
}

const ALLOWED_ORIGINS = ['https://joshburke.github.io'];

function isAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = isAllowedOrigin(origin);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') return 'Anonymous';
  const trimmed = name.trim().replace(/<[^>]*>/g, '').slice(0, 30);
  return trimmed || 'Anonymous';
}

async function checkRateLimit(db: D1Database, ip: string): Promise<boolean> {
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();

  // Clean old windows and check
  const row = await db.prepare('SELECT count, window_start FROM rate_limits WHERE ip = ?').bind(ip).first<{ count: number; window_start: string }>();

  if (!row || row.window_start < hourAgo) {
    await db.prepare('INSERT OR REPLACE INTO rate_limits (ip, count, window_start) VALUES (?, 1, ?)').bind(ip, now).run();
    return true;
  }

  if (row.count >= 10) return false;

  await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE ip = ?').bind(ip).run();
  return true;
}

async function handlePostRun(request: Request, env: Env, origin: string | null): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await checkRateLimit(env.DB, ip))) {
    return json({ error: 'Rate limit exceeded. Max 10 submissions per hour.' }, 429, origin);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  const { peak_bankroll, final_bankroll, hands_played, win_rate, blackjacks, win_streak, highest_room, by_the_book, sixth_sense, share_data, client_hash } = body;
  const player_name = sanitizeName(body.player_name);

  // Validate
  const errors: string[] = [];
  if (typeof peak_bankroll !== 'number' || typeof final_bankroll !== 'number') errors.push('bankroll must be numbers');
  if (typeof hands_played !== 'number' || hands_played <= 0) errors.push('hands_played must be > 0');
  if (typeof win_rate !== 'number' || win_rate < 0 || win_rate > 100) errors.push('win_rate must be 0-100');
  if (typeof by_the_book !== 'number' || by_the_book < 0 || by_the_book > 100) errors.push('by_the_book must be 0-100');
  if (typeof sixth_sense !== 'number') errors.push('sixth_sense must be a number');
  if (typeof blackjacks !== 'number') errors.push('blackjacks must be a number');
  if (typeof win_streak !== 'number') errors.push('win_streak must be a number');
  if (typeof highest_room !== 'string' || !highest_room) errors.push('highest_room required');
  if (peak_bankroll < final_bankroll) errors.push('peak_bankroll must be >= final_bankroll');
  if (peak_bankroll > 1_000_000) errors.push('peak_bankroll exceeds maximum');

  if (errors.length) return json({ error: 'Validation failed', details: errors }, 400, origin);

  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO runs (id, player_name, peak_bankroll, final_bankroll, hands_played, win_rate, blackjacks, win_streak, highest_room, by_the_book, sixth_sense, share_data, client_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, player_name, peak_bankroll, final_bankroll, hands_played, win_rate, blackjacks, win_streak, highest_room, by_the_book, sixth_sense, share_data ?? null, client_hash ?? null).run();

  const rankRow = await env.DB.prepare('SELECT COUNT(*) as c FROM runs WHERE peak_bankroll > ?').bind(peak_bankroll).first<{ c: number }>();
  const rank = (rankRow?.c ?? 0) + 1;

  return json({ id, rank }, 201, origin);
}

async function handleGetRuns(url: URL, env: Env, origin: string | null): Promise<Response> {
  const period = url.searchParams.get('period') || 'alltime';
  let limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 100);

  let where = '';
  if (period === 'weekly') where = "WHERE submitted_at > datetime('now', '-7 days')";
  else if (period === 'daily') where = "WHERE submitted_at > datetime('now', '-1 day')";

  const rows = await env.DB.prepare(
    `SELECT id, player_name, peak_bankroll, final_bankroll, hands_played, win_rate, blackjacks, win_streak, highest_room, by_the_book, sixth_sense, submitted_at
     FROM runs ${where} ORDER BY peak_bankroll DESC LIMIT ?`
  ).bind(limit).all();

  return json({ runs: rows.results, period, limit }, 200, origin);
}

async function handleGetRun(id: string, env: Env, origin: string | null): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404, origin);
  return json(row, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const path = url.pathname;

    if (path === '/health' && request.method === 'GET') {
      return json({ status: 'ok', timestamp: new Date().toISOString() }, 200, origin);
    }

    if (path === '/runs' && request.method === 'POST') {
      return handlePostRun(request, env, origin);
    }

    if (path === '/runs' && request.method === 'GET') {
      return handleGetRuns(url, env, origin);
    }

    const runMatch = path.match(/^\/runs\/([a-f0-9-]+)$/);
    if (runMatch && request.method === 'GET') {
      return handleGetRun(runMatch[1], env, origin);
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};
