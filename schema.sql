CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  player_name TEXT NOT NULL DEFAULT 'Anonymous',
  peak_bankroll INTEGER NOT NULL,
  final_bankroll INTEGER NOT NULL,
  hands_played INTEGER NOT NULL,
  win_rate INTEGER NOT NULL,
  blackjacks INTEGER NOT NULL,
  win_streak INTEGER NOT NULL,
  highest_room TEXT NOT NULL,
  by_the_book INTEGER NOT NULL,
  sixth_sense INTEGER NOT NULL,
  share_data TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_peak ON runs(peak_bankroll DESC);
CREATE INDEX IF NOT EXISTS idx_runs_submitted ON runs(submitted_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  ip TEXT PRIMARY KEY,
  count INTEGER DEFAULT 1,
  window_start TEXT NOT NULL
);
