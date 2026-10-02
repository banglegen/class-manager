-- Chạy file này trong Supabase: SQL Editor -> New query -> Run
-- (có thể chạy lại nhiều lần, không làm mất dữ liệu)

create table if not exists teams(
  id bigint generated always as identity primary key,
  name text unique not null,
  leader_student_id bigint
);

create table if not exists users(
  id bigint generated always as identity primary key,
  username text unique not null,
  password_hash text not null,
  full_name text not null,
  role text not null check (role in ('ADMIN','CLASS_LEADER','CLASS_VICE','TEAM_LEADER')),
  team_id bigint references teams(id) on delete set null,
  active integer not null default 1
);

create table if not exists students(
  id bigint generated always as identity primary key,
  student_code text unique not null,
  full_name text not null,
  gender text,
  team_id bigint references teams(id) on delete set null,
  active integer not null default 1
);

create table if not exists months(
  id bigint generated always as identity primary key,
  month integer not null,
  year integer not null,
  unique(month, year)
);

create table if not exists score_rules(
  id bigint generated always as identity primary key,
  name text not null,
  type text not null check (type in ('PLUS','MINUS')),
  points integer not null,
  description text
);

create table if not exists score_records(
  id bigint generated always as identity primary key,
  student_id bigint not null references students(id),
  month_id bigint not null references months(id),
  rule_id bigint references score_rules(id) on delete set null,
  points integer not null,
  description text,
  recorded_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_records_month_student on score_records(month_id, student_id);

create table if not exists classifications(
  id bigint generated always as identity primary key,
  min_score integer not null,
  max_score integer not null,
  name text not null
);

-- View tổng hợp điểm theo học sinh + tháng (tránh giới hạn 1000 dòng của API)
create or replace view v_month_scores as
select student_id, month_id,
  coalesce(sum(points),0)::int as total,
  coalesce(sum(case when points>0 then points else 0 end),0)::int as plus,
  coalesce(sum(case when points<0 then -points else 0 end),0)::int as minus,
  count(*)::int as records
from score_records
group by student_id, month_id;

-- Phiên đăng nhập (dùng chung giữa các server)
create table if not exists sessions(
  sid text primary key,
  sess jsonb not null,
  expire timestamptz not null
);
create index if not exists idx_sessions_expire on sessions(expire);
alter table sessions enable row level security;

-- Bảo mật: bật RLS và KHÔNG tạo policy => anon key không đọc/ghi được gì.
-- Server dùng service_role key nên vẫn truy cập bình thường.
alter table teams enable row level security;
alter table users enable row level security;
alter table students enable row level security;
alter table months enable row level security;
alter table score_rules enable row level security;
alter table score_records enable row level security;
alter table classifications enable row level security;
revoke all on v_month_scores from anon, authenticated;
