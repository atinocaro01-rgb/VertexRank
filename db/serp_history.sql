-- VertexRank rank history. Run once in Supabase: Dashboard -> SQL Editor -> paste -> Run.
-- Row Level Security is switched on with NO policies, so the public (anon) key can read and write nothing.
-- Only the server, using SUPABASE_SERVICE_ROLE_KEY, touches these tables. Never put that key in browser code.

create table if not exists tracked_keywords (
  id uuid primary key default gen_random_uuid(),
  site_host text not null check (site_host ~ '^[a-z0-9.-]{1,253}$'),
  query text not null check (char_length(query) between 1 and 150),
  country text not null,
  device text not null check (device in ('desktop', 'mobile')),
  active boolean not null default true,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (site_host, query, country, device)
);

create table if not exists rank_snapshots (
  id bigint generated always as identity primary key,
  keyword_id uuid not null references tracked_keywords (id) on delete cascade,
  checked_at timestamptz not null default now(),
  position int check (position between 1 and 100), -- null = the site was not in the results returned
  ranking_url text,
  provider text not null,
  trigger text not null check (trigger in ('manual', 'scheduled')),
  top_results jsonb -- the first page: [{rank, title, url}]
);
create index if not exists rank_snapshots_keyword_time on rank_snapshots (keyword_id, checked_at desc);
create index if not exists rank_snapshots_time on rank_snapshots (checked_at);

-- One row per scheduled run. The unique (job, run_day) is the claim that stops a duplicated cron delivery
-- from spending the search allowance twice in the same day.
create table if not exists job_runs (
  id bigint generated always as identity primary key,
  job text not null,
  run_day date not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  checked int not null default 0,
  errors jsonb,
  note text,
  unique (job, run_day)
);

alter table tracked_keywords enable row level security;
alter table rank_snapshots enable row level security;
alter table job_runs enable row level security;
