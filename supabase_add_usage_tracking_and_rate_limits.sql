-- Defense against /api/review-job being spammed (each call costs real
-- money -- it hits the Anthropic API) and a foundation for per-company
-- cost tracking. One log table serves both purposes: rate-limit checks
-- read recent rows from it, and monthly cost-per-company is just an
-- aggregate query against it.
--
-- Claude Sonnet 5 pricing (introductory, through Aug 31 2026):
--   $2 / million input tokens, $10 / million output tokens.
-- Standard pricing from Sept 1 2026: $3 / million input, $15 / million
-- output. Update billing_guardrails.input_price_per_million and
-- output_price_per_million on/after that date so cost tracking stays
-- accurate -- see the UPDATE statement at the bottom of this file.

-- ---------------------------------------------------------
-- 1. Tunable guardrails, single row, editable without a redeploy.
-- ---------------------------------------------------------
create table if not exists billing_guardrails (
  id int primary key default 1,
  input_price_per_million numeric not null default 2.00,
  output_price_per_million numeric not null default 10.00,
  daily_global_cost_cap_usd numeric not null default 10.00,
  per_ip_hourly_limit int not null default 8,
  per_company_daily_limit int not null default 150,
  updated_at timestamptz not null default now(),
  constraint billing_guardrails_single_row check (id = 1)
);

insert into billing_guardrails (id) values (1) on conflict (id) do nothing;

alter table billing_guardrails enable row level security;
-- No policies -- default-deny for everyone including logged-in
-- employees. Only read internally by the security-definer functions
-- below.

-- ---------------------------------------------------------
-- 2. Usage log -- one row per AI call, regardless of company.
-- ---------------------------------------------------------
create table if not exists ai_usage_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  subdomain text,
  ip_address text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  estimated_cost_usd numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_usage_log_company_created on ai_usage_log (company_id, created_at);
create index if not exists idx_ai_usage_log_ip_created on ai_usage_log (ip_address, created_at);

alter table ai_usage_log enable row level security;

-- Lets a future "usage this month" widget on the dashboard query this
-- directly as an authenticated company member.
create policy "ai_usage_select_company"
on ai_usage_log for select
to authenticated
using (company_id = get_my_company_id());
-- No insert/update/delete policy -- only log_ai_usage() (security
-- definer, below) writes here.

-- ---------------------------------------------------------
-- 3. check_rate_limit(): called BEFORE hitting the Anthropic API. If
--    this returns a non-null reason, /api/review-job must return 429
--    and skip the API call entirely -- the whole point is to never
--    spend money on a request that would exceed a guardrail.
-- ---------------------------------------------------------
create or replace function check_rate_limit(p_subdomain text, p_ip text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guard billing_guardrails%rowtype;
  v_company_id uuid;
  v_ip_count int;
  v_company_count int;
  v_global_cost numeric;
begin
  select * into v_guard from billing_guardrails where id = 1;
  if v_guard is null then
    return null; -- guardrails row missing somehow; fail open rather than break the form
  end if;

  select count(*) into v_ip_count
  from ai_usage_log
  where ip_address = p_ip
    and created_at > now() - interval '1 hour';
  if v_ip_count >= v_guard.per_ip_hourly_limit then
    return 'rate_limited_ip';
  end if;

  select id into v_company_id from companies where subdomain = lower(coalesce(p_subdomain, '')) limit 1;
  if v_company_id is not null then
    select count(*) into v_company_count
    from ai_usage_log
    where company_id = v_company_id
      and created_at > now() - interval '24 hours';
    if v_company_count >= v_guard.per_company_daily_limit then
      return 'rate_limited_company';
    end if;
  end if;

  -- Global circuit breaker: if the last 24h of ALL companies combined
  -- already hit the cap, block everything until it rolls off. This is
  -- the backstop against any abuse pattern the two checks above don't
  -- anticipate (e.g. a botnet spreading requests across many IPs).
  select coalesce(sum(estimated_cost_usd), 0) into v_global_cost
  from ai_usage_log
  where created_at > now() - interval '24 hours';
  if v_global_cost >= v_guard.daily_global_cost_cap_usd then
    return 'global_cap_reached';
  end if;

  return null;
end;
$$;

grant execute on function check_rate_limit(text, text) to anon, authenticated;

-- ---------------------------------------------------------
-- 4. log_ai_usage(): called AFTER the Anthropic API responds, with the
--    real token counts from the response. Computes estimated cost from
--    the current guardrails row so pricing updates apply automatically.
-- ---------------------------------------------------------
create or replace function log_ai_usage(
  p_subdomain text,
  p_ip text,
  p_input_tokens int,
  p_output_tokens int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_guard billing_guardrails%rowtype;
  v_cost numeric;
begin
  select id into v_company_id from companies where subdomain = lower(coalesce(p_subdomain, '')) limit 1;
  select * into v_guard from billing_guardrails where id = 1;

  v_cost := (coalesce(p_input_tokens, 0)::numeric / 1000000 * coalesce(v_guard.input_price_per_million, 2.00))
          + (coalesce(p_output_tokens, 0)::numeric / 1000000 * coalesce(v_guard.output_price_per_million, 10.00));

  insert into ai_usage_log (company_id, subdomain, ip_address, input_tokens, output_tokens, estimated_cost_usd)
  values (v_company_id, lower(coalesce(p_subdomain, '')), p_ip, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), v_cost);
end;
$$;

grant execute on function log_ai_usage(text, text, int, int) to anon, authenticated;

-- ---------------------------------------------------------
-- Run this after Aug 31 2026 when Claude Sonnet 5 moves to standard
-- pricing ($3/M input, $15/M output), so cost tracking stays accurate:
--
-- update billing_guardrails set
--   input_price_per_million = 3.00,
--   output_price_per_million = 15.00,
--   updated_at = now()
-- where id = 1;
