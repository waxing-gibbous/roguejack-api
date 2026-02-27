# Roguejack Scoreboard API

Cloudflare Workers + D1 API for Roguejack leaderboards.

## Setup

```bash
npm install
```

### Create D1 Database

```bash
npx wrangler d1 create roguejack-scores
```

Copy the `database_id` from the output into `wrangler.toml`.

### Apply Schema

```bash
npx wrangler d1 execute roguejack-scores --local --file=./schema.sql   # local dev
npx wrangler d1 execute roguejack-scores --remote --file=./schema.sql  # production
```

### Dev

```bash
npm run dev
```

### Deploy

```bash
npm run deploy
```

## Endpoints

- `GET /health` — Health check
- `GET /runs?period=alltime|weekly|daily&limit=25` — Leaderboard
- `GET /runs/:id` — Single run detail
- `POST /runs` — Submit a run
