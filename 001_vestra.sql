-- =====================================================================
-- VESTRA AI - esquema do banco (Supabase / PostgreSQL)
-- Como usar: Supabase > SQL Editor > New query > cole tudo > Run.
-- Seguro para rodar mais de uma vez. NAO foi executado por mim: rode e confira os erros.
-- =====================================================================

-- ---------- Tabelas ----------
create table if not exists public.plans (
  id text primary key,
  name text not null,
  price_cents integer not null check (price_cents > 0),
  credits integer not null check (credits > 0),
  hotmart_offer_code text,          -- preencha com o codigo da oferta na Hotmart
  checkout_url text,                -- preencha com o link de checkout da Hotmart
  active boolean not null default true
);
insert into public.plans (id, name, price_cents, credits) values
  ('essencial','Essencial',6490,50),
  ('profissional','Profissional',14990,150),
  ('premium','Premium',24990,400)
on conflict (id) do nothing;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text,
  terms_at timestamptz,
  credits integer not null default 0 check (credits >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  created_at timestamptz not null default now(),
  constraint reserved_le_credits check (reserved <= credits)
);
create unique index if not exists profiles_email_idx on public.profiles (email);

create table if not exists public.subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan_id text not null references public.plans(id),
  gateway text not null default 'hotmart',
  gateway_subscription_id text unique,
  status text not null check (status in ('active','past_due','canceled')),
  period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  subscription_id bigint references public.subscriptions(id),
  gateway_transaction_id text not null unique,
  amount_cents integer not null,
  status text not null,
  method text,
  paid_at timestamptz not null default now(),
  raw jsonb
);

create table if not exists public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delta integer not null,
  reason text not null,
  ref text not null,
  balance_after integer not null,
  created_at timestamptz not null default now(),
  unique (reason, ref)
);

create table if not exists public.generations (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  idem_key text not null,
  status text not null check (status in ('processing','completed','failed')),
  provider_id text,
  garment_path text not null,
  model_path text not null,
  result_path text,
  error text,
  style text,
  consent_at timestamptz not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (user_id, idem_key)
);

create table if not exists public.webhook_events (
  id text primary key,
  source text not null,
  received_at timestamptz not null default now(),
  payload jsonb
);

create table if not exists public.unmatched_payments (   -- pagamentos que NAO liberaram creditos (revisao manual)
  id bigint generated always as identity primary key,
  transaction_id text unique,
  email text,
  reason text,
  payload jsonb,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Perfil criado automaticamente no cadastro (Supabase Auth) ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, name, terms_at)
  values (new.id, lower(new.email), new.raw_user_meta_data->>'name',
          nullif(new.raw_user_meta_data->>'terms_at','')::timestamptz);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- RLS: cada usuario le SOMENTE os proprios dados; ninguem escreve pelo navegador ----------
alter table public.plans              enable row level security;
alter table public.profiles           enable row level security;
alter table public.subscriptions      enable row level security;
alter table public.payments           enable row level security;
alter table public.credit_ledger      enable row level security;
alter table public.generations        enable row level security;
alter table public.webhook_events     enable row level security;
alter table public.unmatched_payments enable row level security;

drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select to anon, authenticated using (active);
drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists subs_own on public.subscriptions;
create policy subs_own on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists pay_own on public.payments;
create policy pay_own on public.payments for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists ledger_own on public.credit_ledger;
create policy ledger_own on public.credit_ledger for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists gen_own on public.generations;
create policy gen_own on public.generations for select to authenticated using (user_id = (select auth.uid()));
-- webhook_events e unmatched_payments: sem policies = inacessiveis ao navegador (so service role)

-- Defesa em profundidade: retira escrita das roles publicas (RLS ja bloquearia sem policy de escrita)
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on public.webhook_events, public.unmatched_payments from anon, authenticated;
revoke select on public.payments from anon;

-- ---------- Funcoes de credito (UNICO caminho para alterar saldo) ----------
create or replace function public.reserve_generation(p_user uuid, p_idem text, p_style text, p_garment text, p_model text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  select id into v_id from generations where user_id = p_user and idem_key = p_idem;
  if found then return jsonb_build_object('id', v_id, 'dup', true); end if;
  perform 1 from subscriptions where user_id = p_user and status in ('active','canceled') and period_end > now();
  if not found then return jsonb_build_object('err', 'Assinatura inativa ou vencida.'); end if;
  update profiles set reserved = reserved + 1 where id = p_user and credits - reserved >= 1;
  if not found then return jsonb_build_object('err', 'Créditos insuficientes.'); end if;
  insert into generations (user_id, idem_key, status, garment_path, model_path, style, consent_at)
  values (p_user, p_idem, 'processing', p_garment, p_model, p_style, now()) returning id into v_id;
  return jsonb_build_object('id', v_id);
exception when unique_violation then
  select id into v_id from generations where user_id = p_user and idem_key = p_idem;
  return jsonb_build_object('id', v_id, 'dup', true);
end $$;

create or replace function public.complete_generation(p_gen bigint, p_result text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_bal integer;
begin
  update generations set status = 'completed', result_path = p_result, finished_at = now()
   where id = p_gen and status = 'processing' returning user_id into v_user;
  if not found then return false; end if;               -- ja finalizada: nunca cobra duas vezes
  update profiles set credits = credits - 1, reserved = reserved - 1 where id = v_user returning credits into v_bal;
  insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (v_user, -1, 'generation_debit', p_gen::text, v_bal);
  return true;
end $$;

create or replace function public.fail_generation(p_gen bigint, p_error text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_bal integer;
begin
  update generations set status = 'failed', error = left(p_error, 500), finished_at = now()
   where id = p_gen and status = 'processing' returning user_id into v_user;
  if not found then return false; end if;
  update profiles set reserved = reserved - 1 where id = v_user returning credits into v_bal;
  insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (v_user, 0, 'generation_failed', p_gen::text, v_bal);
  return true;                                           -- sem cobranca
end $$;

create or replace function public.grant_plan_credits(p_user uuid, p_plan text, p_txn text, p_amount integer,
  p_method text, p_sub text, p_rollover boolean, p_raw jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_pc integer; v_sub bigint; v_cr integer; v_res integer; v_left integer; v_bal integer;
begin
  if exists (select 1 from payments where gateway_transaction_id = p_txn) then return 'duplicate'; end if;
  select credits into v_pc from plans where id = p_plan;
  if not found then raise exception 'plano inexistente'; end if;
  insert into subscriptions (user_id, plan_id, gateway_subscription_id, status, period_end)
  values (p_user, p_plan, coalesce(p_sub, 'txn:' || p_txn), 'active', now() + interval '31 days')
  on conflict (gateway_subscription_id) do update
    set plan_id = excluded.plan_id, status = 'active', period_end = excluded.period_end, updated_at = now()
  returning id into v_sub;
  insert into payments (user_id, subscription_id, gateway_transaction_id, amount_cents, status, method, raw)
  values (p_user, v_sub, p_txn, p_amount, 'paid', p_method, p_raw);
  select credits, reserved into v_cr, v_res from profiles where id = p_user for update;
  v_left := v_cr - v_res;
  if not p_rollover and v_left > 0 then
    update profiles set credits = credits - v_left where id = p_user returning credits into v_bal;
    insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (p_user, -v_left, 'expiration', p_txn, v_bal);
  end if;
  update profiles set credits = credits + v_pc where id = p_user returning credits into v_bal;
  insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (p_user, v_pc, 'plan_renewal', p_txn, v_bal);
  return 'granted';
end $$;

create or replace function public.set_subscription_status(p_code text, p_status text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update subscriptions set status = p_status, updated_at = now()
   where gateway_subscription_id = p_code and status <> p_status;
  get diagnostics n = row_count; return n;
end $$;

create or replace function public.mark_payment_refunded(p_txn text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update payments set status = 'refunded' where gateway_transaction_id = p_txn;
  get diagnostics n = row_count; return n;
end $$;

-- Somente o servidor (service role) pode executar as funcoes
revoke all on function public.reserve_generation(uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.complete_generation(bigint,text) from public, anon, authenticated;
revoke all on function public.fail_generation(bigint,text) from public, anon, authenticated;
revoke all on function public.grant_plan_credits(uuid,text,text,integer,text,text,boolean,jsonb) from public, anon, authenticated;
revoke all on function public.set_subscription_status(text,text) from public, anon, authenticated;
revoke all on function public.mark_payment_refunded(text) from public, anon, authenticated;
grant execute on function public.reserve_generation(uuid,text,text,text,text) to service_role;
grant execute on function public.complete_generation(bigint,text) to service_role;
grant execute on function public.fail_generation(bigint,text) to service_role;
grant execute on function public.grant_plan_credits(uuid,text,text,integer,text,text,boolean,jsonb) to service_role;
grant execute on function public.set_subscription_status(text,text) to service_role;
grant execute on function public.mark_payment_refunded(text) to service_role;

-- ---------- Armazenamento privado das imagens (sem acesso publico) ----------
insert into storage.buckets (id, name, public) values ('vestra-private', 'vestra-private', false)
on conflict (id) do nothing;
-- Nenhuma policy em storage.objects: somente o servidor (service role) le/grava; usuarios recebem URLs assinadas temporarias.
