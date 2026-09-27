-- À exécuter une fois dans Supabase > SQL Editor

create table if not exists settings (
  key   text primary key,
  value text
);

create table if not exists media (
  id          uuid primary key default gen_random_uuid(),
  name        text unique not null,        -- nom utilisé dans funnel.json
  type        text not null,               -- 'photo' | 'video'
  path        text not null,               -- chemin dans le bucket "galerie"
  mime        text,
  size        bigint,
  tg_file_id  text,                        -- cache Telegram (évite de ré-uploader)
  tg_bot_id   bigint,                      -- file_id valable uniquement pour ce bot
  created_at  timestamptz default now()
);

create table if not exists fans (
  id            bigint primary key,        -- ID Telegram
  first_name    text,
  username      text,
  adult_ok      boolean default false,
  phase         int default 1,
  phase1_count  int default 0,
  step_id       text,
  step_msgs     int default 0,
  step_done     boolean default false,
  total_stars   int default 0,
  purchases     int default 0,
  status        text default 'active',   -- active | paused | stopped
  created_at    timestamptz default now(),
  last_seen     timestamptz default now()
);

create table if not exists messages (
  id          bigserial primary key,
  fan_id      bigint references fans(id) on delete cascade,
  role        text,                        -- 'user' | 'assistant'
  content     text,
  created_at  timestamptz default now()
);
create index if not exists idx_messages_fan on messages(fan_id, id desc);

create table if not exists sales (
  id          bigserial primary key,
  fan_id      bigint references fans(id) on delete cascade,
  step_id     text,
  stars       int,
  status      text,                        -- 'sent' | 'paid'
  created_at  timestamptz default now()
);

-- Sécurité : RLS activé sans policy = inaccessible avec la clé publique.
-- Le serveur utilise la clé service_role qui passe outre.
alter table settings enable row level security;
alter table media    enable row level security;
alter table fans     enable row level security;
alter table messages enable row level security;
alter table sales    enable row level security;

-- Bucket privé pour les contenus (le serveur le crée aussi automatiquement)
insert into storage.buckets (id, name, public)
values ('galerie', 'galerie', false)
on conflict (id) do nothing;

-- Mise à jour V4 (CRM) : à exécuter si la table fans existait déjà
alter table fans add column if not exists status text default 'active';
