-- =============================================================================
-- Flow Analytics | Visão Gerencial (menu Gerencial)
-- -----------------------------------------------------------------------------
-- Camada de dados da tela "Visão Gerencial":
--   1. Configuração: etapas e tipos de entrega (delivery_categories + labels),
--      feriados e preferências de layout por usuário.
--   2. Tempo útil no banco: business_offset_seconds / business_seconds_between
--      (segunda a sexta, 08:30–18:00, America/Sao_Paulo, menos feriados).
--   3. Views materializadas por LABEL (ciclos add→remove, adds e labels atuais),
--      atualizadas pelo orquestrador ao fim da fase label_events e por pg_cron
--      a cada 15 min.
--   4. Views de leitura filtradas pela empresa do usuário (is_company_member).
--   5. RPCs de agregação (SECURITY INVOKER): medianas, totais, desenvolvedores
--      e lista de Issues. O frontend só lê e formata.
--
-- Regras (docs/PLANO_VISAO_GERENCIAL.md, frontend):
--   * Entrega = Issue closed com closed_at no período (data local São Paulo).
--   * Ciclo de label: eventos em ordem cronológica; add abre (add repetido com
--     ciclo aberto é ignorado); remove fecha (remove sem ciclo aberto é ignorado);
--     ciclo aberto fecha no closed_at.
--   * Passagens = quantidade de eventos add das labels da etapa.
--   * Tempo total do fluxo = UNIÃO dos intervalos das etapas selecionadas.
--   * Tipo com analyze_duration = false: conta em quantidade, nunca em duração.
--   * Labels casadas por nome normalizado lower(btrim(nome)).
--
-- Fonte das tabelas *_gitlab: Edge Functions da integração nova
-- (CONTEXTO_INTEGRACAO_GITLAB_SUPABASE.md). Elas continuam sem acesso direto de
-- anon/authenticated; somente as views e RPCs abaixo as leem.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Configuração
-- -----------------------------------------------------------------------------

create or replace function public.vg_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Admin ou Editor ativo na empresa (permissão edit_content do app).
create or replace function public.vg_can_edit_config(_company uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.company_users
    where user_id = auth.uid()
      and company_id = _company
      and active = true
      and role in ('ADMIN', 'EDITOR')
  );
$$;

create table if not exists public.delivery_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('stage', 'delivery_type')),
  name text not null check (length(btrim(name)) between 1 and 80),
  color text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer not null default 0,
  active boolean not null default true,
  -- etapa: vem marcada por padrão no filtro "Etapas analisadas no tempo";
  -- tipo: false = conta só em quantidade, nunca em métricas de duração.
  analyze_duration boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_delivery_categories_name
  on public.delivery_categories (company_id, kind, lower(btrim(name)));
create index if not exists idx_delivery_categories_company
  on public.delivery_categories (company_id, kind, sort_order);

drop trigger if exists trg_delivery_categories_updated_at on public.delivery_categories;
create trigger trg_delivery_categories_updated_at
  before update on public.delivery_categories
  for each row execute function public.vg_touch_updated_at();

create table if not exists public.delivery_category_labels (
  category_id uuid not null references public.delivery_categories(id) on delete cascade,
  label_name text not null check (length(btrim(label_name)) between 1 and 255),
  label_key text generated always as (lower(btrim(label_name))) stored,
  created_at timestamptz not null default now(),
  primary key (category_id, label_key)
);

create index if not exists idx_delivery_category_labels_key
  on public.delivery_category_labels (label_key);

create table if not exists public.business_holidays (
  id uuid primary key default gen_random_uuid(),
  -- null = feriado de todas as empresas
  company_id uuid references public.companies(id) on delete cascade,
  holiday_date date not null,
  description text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_business_holidays
  on public.business_holidays (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date);
create index if not exists idx_business_holidays_date
  on public.business_holidays (holiday_date);

create table if not exists public.dashboard_user_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  dashboard text not null check (dashboard in ('visao_gerencial')),
  layout jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id, dashboard)
);

drop trigger if exists trg_dashboard_user_preferences_updated_at on public.dashboard_user_preferences;
create trigger trg_dashboard_user_preferences_updated_at
  before update on public.dashboard_user_preferences
  for each row execute function public.vg_touch_updated_at();

-- RLS ------------------------------------------------------------------------

alter table public.delivery_categories enable row level security;
alter table public.delivery_category_labels enable row level security;
alter table public.business_holidays enable row level security;
alter table public.dashboard_user_preferences enable row level security;

drop policy if exists vg_categories_select on public.delivery_categories;
create policy vg_categories_select on public.delivery_categories
  for select to authenticated
  using (public.is_company_member(auth.uid(), company_id));

drop policy if exists vg_categories_insert on public.delivery_categories;
create policy vg_categories_insert on public.delivery_categories
  for insert to authenticated
  with check (public.vg_can_edit_config(company_id));

drop policy if exists vg_categories_update on public.delivery_categories;
create policy vg_categories_update on public.delivery_categories
  for update to authenticated
  using (public.vg_can_edit_config(company_id))
  with check (public.vg_can_edit_config(company_id));

drop policy if exists vg_categories_delete on public.delivery_categories;
create policy vg_categories_delete on public.delivery_categories
  for delete to authenticated
  using (public.vg_can_edit_config(company_id));

drop policy if exists vg_category_labels_select on public.delivery_category_labels;
create policy vg_category_labels_select on public.delivery_category_labels
  for select to authenticated
  using (exists (
    select 1 from public.delivery_categories c
    where c.id = category_id and public.is_company_member(auth.uid(), c.company_id)
  ));

drop policy if exists vg_category_labels_insert on public.delivery_category_labels;
create policy vg_category_labels_insert on public.delivery_category_labels
  for insert to authenticated
  with check (exists (
    select 1 from public.delivery_categories c
    where c.id = category_id and public.vg_can_edit_config(c.company_id)
  ));

drop policy if exists vg_category_labels_delete on public.delivery_category_labels;
create policy vg_category_labels_delete on public.delivery_category_labels
  for delete to authenticated
  using (exists (
    select 1 from public.delivery_categories c
    where c.id = category_id and public.vg_can_edit_config(c.company_id)
  ));

drop policy if exists vg_holidays_select on public.business_holidays;
create policy vg_holidays_select on public.business_holidays
  for select to authenticated
  using (company_id is null or public.is_company_member(auth.uid(), company_id));

drop policy if exists vg_holidays_write on public.business_holidays;
create policy vg_holidays_write on public.business_holidays
  for all to authenticated
  using (company_id is not null and public.vg_can_edit_config(company_id))
  with check (company_id is not null and public.vg_can_edit_config(company_id));

drop policy if exists vg_preferences_own on public.dashboard_user_preferences;
create policy vg_preferences_own on public.dashboard_user_preferences
  for all to authenticated
  using (user_id = auth.uid() and public.is_company_member(auth.uid(), company_id))
  with check (user_id = auth.uid() and public.is_company_member(auth.uid(), company_id));

revoke all on public.delivery_categories, public.delivery_category_labels,
  public.business_holidays, public.dashboard_user_preferences from anon;
grant select, insert, update, delete on public.delivery_categories to authenticated;
grant select, insert, delete on public.delivery_category_labels to authenticated;
grant select, insert, update, delete on public.business_holidays to authenticated;
grant select, insert, update, delete on public.dashboard_user_preferences to authenticated;
grant all on public.delivery_categories, public.delivery_category_labels,
  public.business_holidays, public.dashboard_user_preferences to service_role;

-- -----------------------------------------------------------------------------
-- 2. Tempo útil
-- -----------------------------------------------------------------------------
-- MANTER IGUAL a src/lib/time/business-hours.ts (frontend): expediente 08:30 às
-- 18:00 (34.200 s), segunda a sexta, fuso America/Sao_Paulo, menos feriados.
--
-- business_offset_seconds(ts) = segundos úteis desde 2000-01-03 (segunda-feira)
-- até ts. É monotônica, então:
--   * tempo útil entre a e b = offset(b) − offset(a);
--   * a união de intervalos pode ser feita sobre os offsets (dois intervalos que
--     se tocam só fora do expediente se juntam sem alterar a soma).
-- Cálculo aritmético (sem generate_series), barato para todos os eventos.

create or replace function public.business_offset_seconds(p_ts timestamptz, p_company_id uuid default null)
returns bigint
language sql
stable
parallel safe
set search_path = public
as $$
  with l as (
    select (p_ts at time zone 'America/Sao_Paulo') as lt
  ), d as (
    select lt, lt::date as day, greatest(lt::date - date '2000-01-03', 0) as n
    from l
  ), x as (
    select
      d.lt,
      d.day,
      (d.n / 7) * 5 + least(d.n % 7, 5) as weekdays_before,
      (select count(distinct h.holiday_date)
         from public.business_holidays h
        where h.holiday_date >= date '2000-01-03'
          and h.holiday_date < d.day
          and extract(isodow from h.holiday_date) < 6
          and (h.company_id is null or h.company_id = p_company_id)) as holidays_before,
      extract(isodow from d.day) < 6
        and not exists (
          select 1 from public.business_holidays h
           where h.holiday_date = d.day
             and (h.company_id is null or h.company_id = p_company_id)) as is_business_day
    from d
  )
  select ((x.weekdays_before - x.holidays_before) * 34200
          + case when x.is_business_day
                 then least(34200, greatest(0, floor(extract(epoch from (x.lt - (x.day + time '08:30'))))))
                 else 0 end)::bigint
  from x;
$$;

create or replace function public.business_seconds_between(p_start timestamptz, p_end timestamptz, p_company_id uuid default null)
returns bigint
language sql
stable
parallel safe
set search_path = public
as $$
  select case
    when p_start is null or p_end is null or p_end <= p_start then 0::bigint
    else greatest(0, public.business_offset_seconds(p_end, p_company_id)
                   - public.business_offset_seconds(p_start, p_company_id))
  end;
$$;

grant execute on function public.business_offset_seconds(timestamptz, uuid) to authenticated, service_role;
grant execute on function public.business_seconds_between(timestamptz, timestamptz, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Views materializadas (nível de label; sem filtro de usuário)
-- -----------------------------------------------------------------------------

-- Labels atuais das Issues fechadas: raw_payload->'labels' (REST, nomes; cobre
-- todas as Issues) ∪ issue_labels_gitlab (GraphQL, quando já sincronizado).
drop materialized view if exists public.mv_vg_issue_labels cascade;
create materialized view public.mv_vg_issue_labels as
with closed as (
  select i.id, i.raw_payload, ig.company_id
  from public.issues_gitlab i
  join public.integrations_gitlab ig on ig.id = i.integration_id
  where i.state = 'closed' and i.closed_at is not null
), names as (
  select c.company_id, c.id as issue_id,
         case when jsonb_typeof(e.value) = 'object' then e.value ->> 'name'
              else e.value #>> '{}' end as label_name
  from closed c
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(c.raw_payload -> 'labels') = 'array' then c.raw_payload -> 'labels'
         else '[]'::jsonb end) as e(value)
  union all
  select c.company_id, c.id, l.name
  from closed c
  join public.issue_labels_gitlab il on il.issue_id = c.id
  join public.labels_gitlab l on l.id = il.label_id
)
select company_id, issue_id, lower(btrim(label_name)) as label_key
from names
where label_name is not null and btrim(label_name) <> ''
group by company_id, issue_id, lower(btrim(label_name));

create unique index uq_mv_vg_issue_labels on public.mv_vg_issue_labels (issue_id, label_key);
create index idx_mv_vg_issue_labels_key on public.mv_vg_issue_labels (company_id, label_key);

-- Ciclos add → remove por Issue fechada × label normalizada.
-- Estado após cada evento = a própria ação; início de ciclo = add cujo evento
-- anterior não é add; fim = remove cujo evento anterior é add. Inícios e fins
-- se alternam, então o n-ésimo fim fecha o n-ésimo início.
drop materialized view if exists public.mv_vg_label_cycles cascade;
create materialized view public.mv_vg_label_cycles as
with ev as (
  select e.issue_id, ig.company_id, i.closed_at,
         lower(btrim(coalesce(l.name, e.label_name_snapshot))) as label_key,
         e.action, e.occurred_at, e.gitlab_event_id
  from public.label_events_gitlab e
  join public.issues_gitlab i on i.id = e.issue_id and i.state = 'closed' and i.closed_at is not null
  join public.integrations_gitlab ig on ig.id = i.integration_id
  left join public.labels_gitlab l on l.id = e.label_id
  where btrim(coalesce(l.name, e.label_name_snapshot, '')) <> ''
), seq as (
  select ev.*,
         lag(action) over (partition by issue_id, label_key order by occurred_at, gitlab_event_id) as prev_action
  from ev
), starts as (
  select company_id, issue_id, label_key, closed_at, occurred_at as cycle_start,
         row_number() over (partition by issue_id, label_key order by occurred_at, gitlab_event_id) as n
  from seq
  where action = 'add' and (prev_action is null or prev_action = 'remove')
), ends as (
  select issue_id, label_key, occurred_at as cycle_end,
         row_number() over (partition by issue_id, label_key order by occurred_at, gitlab_event_id) as n
  from seq
  where action = 'remove' and prev_action = 'add'
), cycles as (
  select s.company_id, s.issue_id, s.label_key, s.n::integer as cycle_no, s.cycle_start,
         coalesce(e.cycle_end, greatest(s.cycle_start, s.closed_at)) as cycle_end,
         e.cycle_end is null as is_open
  from starts s
  left join ends e on e.issue_id = s.issue_id and e.label_key = s.label_key and e.n = s.n
)
select c.company_id, c.issue_id, c.label_key, c.cycle_no, c.cycle_start, c.cycle_end, c.is_open,
       public.business_offset_seconds(c.cycle_start, c.company_id) as b_start,
       public.business_offset_seconds(c.cycle_end, c.company_id) as b_end
from cycles c;

create unique index uq_mv_vg_label_cycles on public.mv_vg_label_cycles (issue_id, label_key, cycle_no);
create index idx_mv_vg_label_cycles_key on public.mv_vg_label_cycles (company_id, label_key);

-- Passagens: quantidade de eventos add por Issue fechada × label.
drop materialized view if exists public.mv_vg_label_adds cascade;
create materialized view public.mv_vg_label_adds as
select ig.company_id, e.issue_id,
       lower(btrim(coalesce(l.name, e.label_name_snapshot))) as label_key,
       count(*)::integer as adds
from public.label_events_gitlab e
join public.issues_gitlab i on i.id = e.issue_id and i.state = 'closed' and i.closed_at is not null
join public.integrations_gitlab ig on ig.id = i.integration_id
left join public.labels_gitlab l on l.id = e.label_id
where e.action = 'add'
  and btrim(coalesce(l.name, e.label_name_snapshot, '')) <> ''
group by ig.company_id, e.issue_id, lower(btrim(coalesce(l.name, e.label_name_snapshot)));

create unique index uq_mv_vg_label_adds on public.mv_vg_label_adds (issue_id, label_key);
create index idx_mv_vg_label_adds_key on public.mv_vg_label_adds (company_id, label_key);

revoke all on public.mv_vg_issue_labels, public.mv_vg_label_cycles, public.mv_vg_label_adds
  from public, anon, authenticated;
grant select on public.mv_vg_issue_labels, public.mv_vg_label_cycles, public.mv_vg_label_adds to service_role;

-- Atualização (orquestrador ao fim de label_events + pg_cron a cada 15 min).
create or replace function public.vg_refresh_metrics()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently public.mv_vg_issue_labels;
  refresh materialized view concurrently public.mv_vg_label_cycles;
  refresh materialized view concurrently public.mv_vg_label_adds;
end;
$$;

revoke all on function public.vg_refresh_metrics() from public, anon, authenticated;
grant execute on function public.vg_refresh_metrics() to service_role;

-- -----------------------------------------------------------------------------
-- 4. Views de leitura (empresa do usuário)
-- -----------------------------------------------------------------------------
-- Rodam com o dono (leem *_gitlab e as MVs) e filtram as empresas em que o
-- usuário autenticado é membro ativo. Sem membership, retornam vazio.

create or replace view public.vw_vg_closed_issues with (security_barrier = true) as
select i.id as issue_id,
       ig.company_id,
       i.integration_id,
       i.gitlab_id,
       i.iid,
       i.title,
       i.web_url,
       i.closed_at,
       (i.closed_at at time zone 'America/Sao_Paulo')::date as closed_date,
       p.id as project_id,
       p.name as project_name,
       p.path_with_namespace as project_path,
       g.id as group_id,
       g.name as group_name,
       g.full_path as group_path,
       u.id as assignee_id,
       u.name as assignee_name,
       u.username as assignee_username,
       coalesce(t.type_ids, '{}'::uuid[]) as type_ids,
       coalesce(t.excluded, false) as excluded_from_duration,
       i.label_events_synced_at is not null as has_history,
       i.synced_at
from public.issues_gitlab i
join public.integrations_gitlab ig on ig.id = i.integration_id
join public.projects_gitlab p on p.id = i.project_id
left join public.groups_gitlab g on g.id = p.group_id
left join public.users_gitlab u on u.id = i.primary_assignee_id
left join lateral (
  select array_agg(distinct c.id) as type_ids,
         bool_or(not c.analyze_duration) as excluded
  from public.mv_vg_issue_labels il
  join public.delivery_category_labels dl on dl.label_key = il.label_key
  join public.delivery_categories c on c.id = dl.category_id
  where il.issue_id = i.id
    and c.company_id = ig.company_id
    and c.kind = 'delivery_type'
    and c.active
) t on true
where i.state = 'closed'
  and i.closed_at is not null
  and ig.company_id in (select co.id from public.companies co where public.is_company_member(auth.uid(), co.id));

-- Ciclos de cada etapa ativa (etapa = uma ou mais labels).
create or replace view public.vw_vg_stage_cycles with (security_barrier = true) as
select c.company_id,
       c.id as stage_id,
       lc.issue_id,
       lc.label_key,
       lc.cycle_no,
       lc.cycle_start,
       lc.cycle_end,
       lc.is_open,
       lc.b_start,
       lc.b_end,
       (lc.b_end - lc.b_start) as business_seconds
from public.delivery_categories c
join public.delivery_category_labels dl on dl.category_id = c.id
join public.mv_vg_label_cycles lc on lc.company_id = c.company_id and lc.label_key = dl.label_key
where c.kind = 'stage'
  and c.active
  and c.company_id in (select co.id from public.companies co where public.is_company_member(auth.uid(), co.id));

-- Passagens por Issue × etapa.
create or replace view public.vw_vg_stage_adds with (security_barrier = true) as
select c.company_id,
       c.id as stage_id,
       a.issue_id,
       sum(a.adds)::integer as passes
from public.delivery_categories c
join public.delivery_category_labels dl on dl.category_id = c.id
join public.mv_vg_label_adds a on a.company_id = c.company_id and a.label_key = dl.label_key
where c.kind = 'stage'
  and c.active
  and c.company_id in (select co.id from public.companies co where public.is_company_member(auth.uid(), co.id))
group by c.company_id, c.id, a.issue_id;

-- Issue × etapa: tempo útil (união dos ciclos das labels da etapa) e passagens.
create or replace view public.vw_vg_issue_stage_time with (security_barrier = true) as
with o as (
  select company_id, stage_id, issue_id, b_start, b_end,
         max(b_end) over (partition by issue_id, stage_id order by b_start, b_end
                          rows between unbounded preceding and 1 preceding) as prev_max
  from public.vw_vg_stage_cycles
), g as (
  select o.*,
         sum(case when prev_max is null or b_start > prev_max then 1 else 0 end)
           over (partition by issue_id, stage_id order by b_start, b_end rows unbounded preceding) as grp
  from o
), isl as (
  select company_id, stage_id, issue_id, grp, min(b_start) as s, max(b_end) as e
  from g
  group by company_id, stage_id, issue_id, grp
), t as (
  select company_id, stage_id, issue_id, sum(e - s)::bigint as business_seconds
  from isl
  group by company_id, stage_id, issue_id
)
select coalesce(t.company_id, a.company_id) as company_id,
       coalesce(t.stage_id, a.stage_id) as stage_id,
       coalesce(t.issue_id, a.issue_id) as issue_id,
       coalesce(t.business_seconds, 0)::bigint as business_seconds,
       coalesce(a.passes, 0) as passes,
       t.issue_id is not null as has_cycle
from t
full join public.vw_vg_stage_adds a on a.issue_id = t.issue_id and a.stage_id = t.stage_id;

-- Entregas por dia × tipo × projeto × responsável (tipo null = sem tipo).
create or replace view public.vw_vg_daily_deliveries with (security_barrier = true) as
select ci.company_id,
       ci.closed_date,
       t.type_id,
       ci.project_id,
       ci.assignee_id,
       count(*)::integer as deliveries
from public.vw_vg_closed_issues ci
left join lateral unnest(case when cardinality(ci.type_ids) = 0 then array[null::uuid] else ci.type_ids end) as t(type_id) on true
group by ci.company_id, ci.closed_date, t.type_id, ci.project_id, ci.assignee_id;

-- Catálogo de labels (para a configuração): nomes únicos e Issues fechadas.
create or replace view public.vw_vg_label_catalog with (security_barrier = true) as
with names as (
  select ig.company_id, lower(btrim(l.name)) as label_key, min(btrim(l.name)) as label_name
  from public.labels_gitlab l
  join public.integrations_gitlab ig on ig.id = l.integration_id
  where btrim(l.name) <> ''
  group by ig.company_id, lower(btrim(l.name))
), uses as (
  select company_id, label_key, count(*)::integer as closed_issues
  from public.mv_vg_issue_labels
  group by company_id, label_key
)
select n.company_id, n.label_key, n.label_name, coalesce(u.closed_issues, 0) as closed_issues
from names n
left join uses u on u.company_id = n.company_id and u.label_key = n.label_key
where n.company_id in (select co.id from public.companies co where public.is_company_member(auth.uid(), co.id));

revoke all on public.vw_vg_closed_issues, public.vw_vg_stage_cycles, public.vw_vg_stage_adds,
  public.vw_vg_issue_stage_time, public.vw_vg_daily_deliveries, public.vw_vg_label_catalog
  from public, anon;
grant select on public.vw_vg_closed_issues, public.vw_vg_stage_cycles, public.vw_vg_stage_adds,
  public.vw_vg_issue_stage_time, public.vw_vg_daily_deliveries, public.vw_vg_label_catalog
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. RPCs (SECURITY INVOKER: a regra de empresa das views continua valendo)
-- -----------------------------------------------------------------------------
-- Convenções dos filtros:
--   * null = todos; array vazio = nenhum.
--   * p_assignee_ids aceita '00000000-0000-0000-0000-000000000000' = "Sem responsável".
--   * p_type_ids: Issue com ao menos um dos tipos.
--   * p_stage_ids null = etapas ativas com analyze_duration = true.

create or replace function public.vg_filtered_issues(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_project_ids uuid[] default null,
  p_assignee_ids uuid[] default null,
  p_type_ids uuid[] default null
)
returns setof public.vw_vg_closed_issues
language sql
stable
security invoker
set search_path = public
as $$
  select ci.*
  from public.vw_vg_closed_issues ci
  where ci.company_id = p_company_id
    and (p_from is null or ci.closed_date >= p_from)
    and (p_to is null or ci.closed_date <= p_to)
    and (p_project_ids is null or ci.project_id = any(p_project_ids))
    and (p_assignee_ids is null
         or coalesce(ci.assignee_id, '00000000-0000-0000-0000-000000000000'::uuid) = any(p_assignee_ids))
    and (p_type_ids is null or ci.type_ids && p_type_ids);
$$;

create or replace function public.vg_selected_stages(p_company_id uuid, p_stage_ids uuid[] default null)
returns table (stage_id uuid, sort_order integer)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id, c.sort_order
  from public.delivery_categories c
  where c.company_id = p_company_id
    and c.kind = 'stage'
    and c.active
    and (case when p_stage_ids is null then c.analyze_duration else c.id = any(p_stage_ids) end);
$$;

-- Issue × etapa selecionada (somente Issues que entram em duração).
create or replace function public.vg_issue_stage_seconds(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_project_ids uuid[] default null,
  p_assignee_ids uuid[] default null,
  p_type_ids uuid[] default null,
  p_stage_ids uuid[] default null
)
returns table (issue_id uuid, stage_id uuid, business_seconds bigint, passes integer, has_cycle boolean)
language sql
stable
security invoker
set search_path = public
as $$
  with iss as (
    select f.issue_id
    from public.vg_filtered_issues(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids) f
    where not f.excluded_from_duration
  ), st as (
    select s.stage_id from public.vg_selected_stages(p_company_id, p_stage_ids) s
  )
  select t.issue_id, t.stage_id, t.business_seconds, t.passes, t.has_cycle
  from public.vw_vg_issue_stage_time t
  join iss on iss.issue_id = t.issue_id
  join st on st.stage_id = t.stage_id
  where t.company_id = p_company_id;
$$;

-- Tempo total do fluxo por Issue: união dos ciclos das etapas selecionadas.
-- Só Issues com ao menos um ciclo nessas etapas (as demais não entram na mediana).
create or replace function public.vg_issue_flow_seconds(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_project_ids uuid[] default null,
  p_assignee_ids uuid[] default null,
  p_type_ids uuid[] default null,
  p_stage_ids uuid[] default null
)
returns table (issue_id uuid, flow_seconds bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with iss as (
    select f.issue_id
    from public.vg_filtered_issues(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids) f
    where not f.excluded_from_duration
  ), st as (
    select s.stage_id from public.vg_selected_stages(p_company_id, p_stage_ids) s
  ), cy as (
    select c.issue_id, c.b_start, c.b_end
    from public.vw_vg_stage_cycles c
    join iss on iss.issue_id = c.issue_id
    join st on st.stage_id = c.stage_id
    where c.company_id = p_company_id
  ), o as (
    select cy.*,
           max(b_end) over (partition by cy.issue_id order by b_start, b_end
                            rows between unbounded preceding and 1 preceding) as prev_max
    from cy
  ), g as (
    select o.*,
           sum(case when prev_max is null or b_start > prev_max then 1 else 0 end)
             over (partition by o.issue_id order by b_start, b_end rows unbounded preceding) as grp
    from o
  ), isl as (
    select g.issue_id, grp, min(b_start) as s, max(b_end) as e
    from g
    group by g.issue_id, grp
  )
  select isl.issue_id, sum(e - s)::bigint
  from isl
  group by isl.issue_id;
$$;

-- KPIs, por projeto/grupo/tipo, série semanal do período e evolução de 30 dias.
create or replace function public.vg_delivery_summary(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_project_ids uuid[] default null,
  p_assignee_ids uuid[] default null,
  p_type_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_days integer;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_total integer;
  v_prev integer;
  v_result jsonb;
begin
  if p_company_id is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'Período ou empresa inválidos' using errcode = '22023';
  end if;
  if p_to - p_from > 3660 then
    raise exception 'Período máximo de 10 anos' using errcode = '22023';
  end if;
  v_days := p_to - p_from + 1;

  select count(*) into v_total
  from public.vg_filtered_issues(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids);

  select count(*) into v_prev
  from public.vg_filtered_issues(p_company_id, p_from - v_days, p_from - 1, p_project_ids, p_assignee_ids, p_type_ids);

  with cur as (
    select * from public.vg_filtered_issues(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids)
  ), by_project as (
    select project_id, max(project_name) as project_name, max(project_path) as project_path,
           (array_agg(group_id))[1] as group_id, max(group_name) as group_name, count(*)::integer as deliveries
    from cur group by project_id
  ), by_group as (
    select group_id, max(group_name) as group_name, max(group_path) as group_path,
           count(distinct project_id)::integer as projects, count(*)::integer as deliveries
    from cur group by group_id
  ), by_type as (
    select t.type_id, count(*)::integer as deliveries
    from cur cross join unnest(cur.type_ids) as t(type_id)
    where p_type_ids is null or t.type_id = any(p_type_ids)
    group by t.type_id
  ), weeks as (
    select w::date as week_start,
           (select count(*) from cur where date_trunc('week', cur.closed_date)::date = w::date)::integer as deliveries
    from generate_series(date_trunc('week', p_from), date_trunc('week', p_to), interval '1 week') as w
  ), trend_issues as (
    select * from public.vg_filtered_issues(p_company_id, v_today - 29, v_today, p_project_ids, p_assignee_ids, p_type_ids)
  ), trend_types as (
    select ti.closed_date, t.type_id, count(*)::integer as deliveries
    from trend_issues ti
    left join lateral unnest(case when cardinality(ti.type_ids) = 0 then array[null::uuid] else ti.type_ids end) as t(type_id) on true
    where p_type_ids is null or t.type_id = any(p_type_ids)
    group by ti.closed_date, t.type_id
  ), trend as (
    select d::date as day,
           (select count(*) from trend_issues ti where ti.closed_date = d::date)::integer as deliveries,
           coalesce((select jsonb_agg(jsonb_build_object('type_id', tt.type_id, 'deliveries', tt.deliveries)
                                      order by tt.deliveries desc)
                       from trend_types tt where tt.closed_date = d::date), '[]'::jsonb) as by_type
    from generate_series(v_today - 29, v_today, interval '1 day') as d
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days,
                                 'previous_from', p_from - v_days, 'previous_to', p_from - 1),
    'total', v_total,
    'previous_total', v_prev,
    'change_pct', case when v_prev > 0 then round((v_total - v_prev) * 100.0 / v_prev, 1) end,
    'per_day', round(v_total::numeric / v_days, 2),
    'per_week', round(v_total::numeric / greatest(v_days / 7.0, 1), 2),
    'per_month', round(v_total::numeric / greatest(v_days / 30.0, 1), 2),
    'weeks_in_period', round(v_days / 7.0, 1),
    'months_in_period', round(greatest(v_days / 30.0, 1), 1),
    'untyped', (select count(*) from cur where cardinality(cur.type_ids) = 0),
    'by_project', coalesce((select jsonb_agg(to_jsonb(bp) order by bp.deliveries desc, bp.project_name) from by_project bp), '[]'::jsonb),
    'by_group', coalesce((select jsonb_agg(to_jsonb(bg) order by bg.deliveries desc, bg.group_name) from by_group bg), '[]'::jsonb),
    'by_type', coalesce((select jsonb_agg(to_jsonb(bt) order by bt.deliveries desc) from by_type bt), '[]'::jsonb),
    'weekly', coalesce((select jsonb_agg(to_jsonb(wk) order by wk.week_start) from weeks wk), '[]'::jsonb),
    'trend_30d', jsonb_build_object(
      'from', v_today - 29, 'to', v_today,
      'days', coalesce((select jsonb_agg(to_jsonb(tr) order by tr.day) from trend tr), '[]'::jsonb))
  ) into v_result;

  return v_result;
end;
$$;

-- Medianas por etapa e por tipo × etapa, mediana do fluxo total, passagens e gargalo.
create or replace function public.vg_flow_medians(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_project_ids uuid[] default null,
  p_assignee_ids uuid[] default null,
  p_type_ids uuid[] default null,
  p_stage_ids uuid[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with iss as (
    select f.issue_id, f.type_ids, f.excluded_from_duration
    from public.vg_filtered_issues(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids) f
  ), st as (
    select s.stage_id, s.sort_order from public.vg_selected_stages(p_company_id, p_stage_ids) s
  ), fl as (
    select * from public.vg_issue_flow_seconds(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids, p_stage_ids)
  ), ss as (
    select * from public.vg_issue_stage_seconds(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids, p_stage_ids)
  ), sample as (
    select fl.issue_id, fl.flow_seconds, iss.type_ids
    from fl join iss on iss.issue_id = fl.issue_id
  ), n as (
    select count(*)::integer as n from sample
  ), stage_stats as (
    select st.stage_id, st.sort_order,
           (select percentile_cont(0.5) within group (order by ss.business_seconds)
              from ss where ss.stage_id = st.stage_id and ss.has_cycle) as median_seconds,
           (select count(*) from ss where ss.stage_id = st.stage_id and ss.has_cycle)::integer as issues,
           (select coalesce(sum(ss.passes), 0) from ss join sample s on s.issue_id = ss.issue_id
             where ss.stage_id = st.stage_id)::integer as total_passes
    from st
  ), type_rows as (
    select t.type_id, count(*)::integer as issues,
           percentile_cont(0.5) within group (order by s.flow_seconds) as flow_median_seconds
    from sample s cross join unnest(s.type_ids) as t(type_id)
    where p_type_ids is null or t.type_id = any(p_type_ids)
    group by t.type_id
  ), type_stage as (
    select t.type_id, ss.stage_id, count(*)::integer as issues,
           percentile_cont(0.5) within group (order by ss.business_seconds) as median_seconds,
           avg(ss.passes) as avg_passes
    from ss
    join sample s on s.issue_id = ss.issue_id
    cross join unnest(s.type_ids) as t(type_id)
    where ss.has_cycle and (p_type_ids is null or t.type_id = any(p_type_ids))
    group by t.type_id, ss.stage_id
  )
  select jsonb_build_object(
    'eligible_issues', (select count(*) from iss where not iss.excluded_from_duration),
    'excluded_issues', (select count(*) from iss where iss.excluded_from_duration),
    'sample_issues', (select n from n),
    'flow_median_seconds', (select percentile_cont(0.5) within group (order by flow_seconds) from sample),
    'stage_ids', coalesce((select jsonb_agg(st.stage_id order by st.sort_order) from st), '[]'::jsonb),
    'bottleneck_stage_id', (select stage_id from stage_stats where median_seconds is not null
                             order by median_seconds desc, sort_order limit 1),
    'stages', coalesce((select jsonb_agg(jsonb_build_object(
        'stage_id', x.stage_id,
        'median_seconds', x.median_seconds,
        'issues', x.issues,
        'total_passes', x.total_passes,
        'avg_passes', case when (select n from n) > 0 then round(x.total_passes::numeric / (select n from n), 2) end
      ) order by x.sort_order) from stage_stats x where x.issues > 0 or x.total_passes > 0), '[]'::jsonb),
    'by_type', coalesce((select jsonb_agg(jsonb_build_object(
        'type_id', tr.type_id,
        'issues', tr.issues,
        'flow_median_seconds', tr.flow_median_seconds,
        'stages', coalesce((select jsonb_agg(jsonb_build_object(
            'stage_id', ts.stage_id, 'median_seconds', ts.median_seconds,
            'issues', ts.issues, 'avg_passes', round(ts.avg_passes, 2)))
          from type_stage ts where ts.type_id = tr.type_id), '[]'::jsonb)
      ) order by tr.issues desc) from type_rows tr), '[]'::jsonb)
  );
$$;

-- Por responsável atual (null = "Sem responsável").
create or replace function public.vg_developer_metrics(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_project_ids uuid[] default null,
  p_assignee_ids uuid[] default null,
  p_type_ids uuid[] default null,
  p_stage_ids uuid[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with iss as (
    select f.issue_id, f.assignee_id, f.assignee_name, f.assignee_username, f.type_ids
    from public.vg_filtered_issues(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids) f
  ), fl as (
    select * from public.vg_issue_flow_seconds(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids, p_stage_ids)
  ), ss as (
    select * from public.vg_issue_stage_seconds(p_company_id, p_from, p_to, p_project_ids, p_assignee_ids, p_type_ids, p_stage_ids)
  ), devs as (
    select assignee_id, max(assignee_name) as assignee_name, max(assignee_username) as assignee_username,
           count(*)::integer as deliveries
    from iss group by assignee_id
  ), dev_types as (
    select iss.assignee_id, t.type_id, count(*)::integer as deliveries
    from iss cross join unnest(iss.type_ids) as t(type_id)
    where p_type_ids is null or t.type_id = any(p_type_ids)
    group by iss.assignee_id, t.type_id
  ), dev_flow as (
    select iss.assignee_id, count(*)::integer as sample_issues,
           percentile_cont(0.5) within group (order by fl.flow_seconds) as flow_median_seconds
    from fl join iss on iss.issue_id = fl.issue_id
    group by iss.assignee_id
  ), dev_stage as (
    select iss.assignee_id, ss.stage_id,
           count(*) filter (where ss.has_cycle)::integer as issues,
           percentile_cont(0.5) within group (order by ss.business_seconds) filter (where ss.has_cycle) as median_seconds,
           sum(ss.passes)::integer as total_passes
    from ss join iss on iss.issue_id = ss.issue_id
    group by iss.assignee_id, ss.stage_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'assignee_id', d.assignee_id,
      'assignee_name', d.assignee_name,
      'assignee_username', d.assignee_username,
      'deliveries', d.deliveries,
      'sample_issues', coalesce(df.sample_issues, 0),
      'flow_median_seconds', df.flow_median_seconds,
      'by_type', coalesce((select jsonb_agg(jsonb_build_object('type_id', dt.type_id, 'deliveries', dt.deliveries)
                                            order by dt.deliveries desc)
                             from dev_types dt where dt.assignee_id is not distinct from d.assignee_id), '[]'::jsonb),
      'stages', coalesce((select jsonb_agg(jsonb_build_object(
                    'stage_id', ds.stage_id, 'issues', ds.issues,
                    'median_seconds', ds.median_seconds, 'total_passes', ds.total_passes))
                  from dev_stage ds where ds.assignee_id is not distinct from d.assignee_id), '[]'::jsonb)
    ) order by d.deliveries desc, d.assignee_name nulls last), '[]'::jsonb)
  from devs d
  left join dev_flow df on df.assignee_id is not distinct from d.assignee_id;
$$;

-- Lista de Issues para o painel lateral.
-- p_dimension: null|'all', 'project', 'group', 'type', 'assignee' ('none' = sem
-- responsável), 'stage' (Issues com ciclo na etapa), 'day' (yyyy-mm-dd; ignora
-- o período, usado pela evolução de 30 dias).
create or replace function public.vg_issue_list(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_project_ids uuid[] default null,
  p_assignee_ids uuid[] default null,
  p_type_ids uuid[] default null,
  p_stage_ids uuid[] default null,
  p_dimension text default null,
  p_value text default null,
  p_limit integer default 500
)
returns table (
  issue_id uuid,
  iid bigint,
  title text,
  web_url text,
  project_name text,
  group_name text,
  assignee_id uuid,
  assignee_name text,
  closed_at timestamptz,
  type_ids uuid[],
  excluded_from_duration boolean,
  has_history boolean,
  flow_seconds bigint,
  stages jsonb
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_from date := p_from;
  v_to date := p_to;
  v_uuid uuid;
begin
  if p_dimension is not null and p_dimension not in ('all', 'project', 'group', 'type', 'assignee', 'stage', 'day') then
    raise exception 'Dimensão inválida: %', p_dimension using errcode = '22023';
  end if;
  if p_dimension = 'day' then
    v_from := p_value::date;
    v_to := v_from;
  elsif p_dimension in ('project', 'group', 'type', 'stage')
        or (p_dimension = 'assignee' and p_value <> 'none') then
    v_uuid := p_value::uuid;
  end if;

  return query
  with iss as (
    select f.*
    from public.vg_filtered_issues(p_company_id, v_from, v_to, p_project_ids, p_assignee_ids, p_type_ids) f
    where case p_dimension
            when 'project' then f.project_id = v_uuid
            when 'group' then f.group_id is not distinct from v_uuid
            when 'type' then v_uuid = any(f.type_ids)
            when 'assignee' then f.assignee_id is not distinct from v_uuid
            else true
          end
  ), fl as (
    select * from public.vg_issue_flow_seconds(p_company_id, v_from, v_to, p_project_ids, p_assignee_ids, p_type_ids, p_stage_ids)
  ), ss as (
    select * from public.vg_issue_stage_seconds(p_company_id, v_from, v_to, p_project_ids, p_assignee_ids, p_type_ids, p_stage_ids)
  )
  select i.issue_id, i.iid, i.title, i.web_url, i.project_name, i.group_name, i.assignee_id, i.assignee_name,
         i.closed_at, i.type_ids, i.excluded_from_duration, i.has_history, fl.flow_seconds,
         coalesce((select jsonb_agg(jsonb_build_object('stage_id', ss.stage_id,
                                                       'business_seconds', ss.business_seconds,
                                                       'passes', ss.passes,
                                                       'has_cycle', ss.has_cycle))
                     from ss where ss.issue_id = i.issue_id), '[]'::jsonb)
  from iss i
  left join fl on fl.issue_id = i.issue_id
  where p_dimension is distinct from 'stage'
     or exists (select 1 from ss where ss.issue_id = i.issue_id and ss.stage_id = v_uuid and ss.has_cycle)
  order by i.closed_at desc
  limit least(greatest(coalesce(p_limit, 500), 1), 2000);
end;
$$;

-- Opções dos filtros e cobertura dos dados.
create or replace function public.vg_filter_options(p_company_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with ci as (
    select * from public.vw_vg_closed_issues where company_id = p_company_id
  )
  select jsonb_build_object(
    'projects', coalesce((select jsonb_agg(x order by x.name) from (
        select project_id as id, max(project_name) as name, max(project_path) as path,
               (array_agg(group_id))[1] as group_id, max(group_name) as group_name,
               count(*)::integer as closed_issues
        from ci group by project_id) x), '[]'::jsonb),
    'assignees', coalesce((select jsonb_agg(x order by x.name nulls last) from (
        select assignee_id as id, max(assignee_name) as name, max(assignee_username) as username,
               count(*)::integer as closed_issues
        from ci group by assignee_id) x), '[]'::jsonb),
    'closed_issues', (select count(*) from ci),
    'with_history', (select count(*) from ci where has_history),
    'min_closed_date', (select min(closed_date) from ci),
    'max_closed_date', (select max(closed_date) from ci),
    'last_synced_at', (select max(synced_at) from ci)
  );
$$;

grant execute on function
  public.vg_filtered_issues(uuid, date, date, uuid[], uuid[], uuid[]),
  public.vg_selected_stages(uuid, uuid[]),
  public.vg_issue_stage_seconds(uuid, date, date, uuid[], uuid[], uuid[], uuid[]),
  public.vg_issue_flow_seconds(uuid, date, date, uuid[], uuid[], uuid[], uuid[]),
  public.vg_delivery_summary(uuid, date, date, uuid[], uuid[], uuid[]),
  public.vg_flow_medians(uuid, date, date, uuid[], uuid[], uuid[], uuid[]),
  public.vg_developer_metrics(uuid, date, date, uuid[], uuid[], uuid[], uuid[]),
  public.vg_issue_list(uuid, date, date, uuid[], uuid[], uuid[], uuid[], text, text, integer),
  public.vg_filter_options(uuid)
to authenticated, service_role;

revoke execute on function
  public.vg_filtered_issues(uuid, date, date, uuid[], uuid[], uuid[]),
  public.vg_selected_stages(uuid, uuid[]),
  public.vg_issue_stage_seconds(uuid, date, date, uuid[], uuid[], uuid[], uuid[]),
  public.vg_issue_flow_seconds(uuid, date, date, uuid[], uuid[], uuid[], uuid[]),
  public.vg_delivery_summary(uuid, date, date, uuid[], uuid[], uuid[]),
  public.vg_flow_medians(uuid, date, date, uuid[], uuid[], uuid[], uuid[]),
  public.vg_developer_metrics(uuid, date, date, uuid[], uuid[], uuid[], uuid[]),
  public.vg_issue_list(uuid, date, date, uuid[], uuid[], uuid[], uuid[], text, text, integer),
  public.vg_filter_options(uuid),
  public.vg_can_edit_config(uuid)
from public, anon;
grant execute on function public.vg_can_edit_config(uuid) to authenticated, service_role;

-- Escrita da configuração (SECURITY INVOKER: valem as policies de Admin/Editor).
-- Salva a categoria e substitui as labels numa única transação.
create or replace function public.vg_save_category(
  p_company_id uuid,
  p_kind text,
  p_name text,
  p_color text,
  p_active boolean,
  p_analyze_duration boolean,
  p_labels text[],
  p_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_labels text[];
begin
  if not public.vg_can_edit_config(p_company_id) then
    raise exception 'Sem permissão para alterar etapas e tipos' using errcode = '42501';
  end if;
  if p_kind not in ('stage', 'delivery_type') then
    raise exception 'Tipo de categoria inválido' using errcode = '22023';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Informe o nome' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.label_name), '{}')
    into v_labels
  from (
    select distinct on (lower(btrim(l))) btrim(l) as label_name
    from unnest(coalesce(p_labels, '{}')) as l
    where btrim(l) <> ''
    order by lower(btrim(l)), btrim(l)
  ) x;
  if cardinality(v_labels) = 0 then
    raise exception 'Informe ao menos uma label do GitLab' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.delivery_categories (company_id, kind, name, color, sort_order, active, analyze_duration)
    values (p_company_id, p_kind, btrim(p_name), p_color,
            coalesce((select max(sort_order) + 1 from public.delivery_categories
                       where company_id = p_company_id and kind = p_kind), 1),
            coalesce(p_active, true), coalesce(p_analyze_duration, true))
    returning id into v_id;
  else
    update public.delivery_categories
       set name = btrim(p_name), color = p_color,
           active = coalesce(p_active, active),
           analyze_duration = coalesce(p_analyze_duration, analyze_duration)
     where id = v_id and company_id = p_company_id and kind = p_kind;
    if not found then
      raise exception 'Item não encontrado' using errcode = 'P0002';
    end if;
  end if;

  delete from public.delivery_category_labels
   where category_id = v_id
     and label_key <> all (select lower(l) from unnest(v_labels) as l);

  insert into public.delivery_category_labels (category_id, label_name)
  select v_id, l from unnest(v_labels) as l
  on conflict do nothing;

  return v_id;
end;
$$;

-- Reordena as categorias de um tipo conforme a ordem do array.
create or replace function public.vg_reorder_categories(p_company_id uuid, p_kind text, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.vg_can_edit_config(p_company_id) then
    raise exception 'Sem permissão para alterar etapas e tipos' using errcode = '42501';
  end if;
  update public.delivery_categories c
     set sort_order = o.ord
    from unnest(p_ids) with ordinality as o(id, ord)
   where c.id = o.id and c.company_id = p_company_id and c.kind = p_kind;
end;
$$;

revoke execute on function
  public.vg_save_category(uuid, text, text, text, boolean, boolean, text[], uuid),
  public.vg_reorder_categories(uuid, text, uuid[])
from public, anon;
grant execute on function
  public.vg_save_category(uuid, text, text, text, boolean, boolean, text[], uuid),
  public.vg_reorder_categories(uuid, text, uuid[])
to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Seed (empresas com integração GitLab)
-- -----------------------------------------------------------------------------

with companies_with_gitlab as (
  select distinct ig.company_id
  from public.integrations_gitlab ig
  join public.companies c on c.id = ig.company_id
), seed(kind, name, color, sort_order, analyze_duration, labels) as (
  values
    ('stage', 'Em Desenvolvimento',      '#3B86DB', 1, true,  array['Em Desenvolvimento']),
    ('stage', 'Impedimentos',            '#DA4F4F', 2, true,  array['Impedimentos']),
    ('stage', 'Code Review',             '#8467DB', 3, true,  array['Code Review']),
    ('stage', 'Aguardando Terceiro',     '#8696A3', 4, false, array['Aguardando Terceiro']),
    ('stage', 'Retornado do Teste',      '#EA7A36', 5, true,  array['Retornado do Teste']),
    ('stage', 'Aguardando Homologação',  '#D9AE2E', 6, true,  array['Aguardando Homologação']),
    ('stage', 'Em Homologação',          '#2FB287', 7, true,  array['Em Homologação']),
    ('stage', 'Aguardando Deploy',       '#1E9A62', 8, true,  array['Aguardando Deploy']),
    ('delivery_type', 'Correção',                '#DA4F4F', 1, true,  array['Correção']),
    ('delivery_type', 'Melhoria',                '#2A9D66', 2, true,  array['Melhoria', 'Melhorias']),
    ('delivery_type', 'Refatoração',             '#DE9A2E', 3, true,  array['Refatoração']),
    ('delivery_type', 'Apoio Técnico',           '#3B86DB', 4, true,  array['Apoio Técnico']),
    ('delivery_type', 'Novo Produto',            '#8467DB', 5, true,  array['Novo Produto']),
    ('delivery_type', 'Adequação de Integração', '#139797', 6, false, array['Adequação de Integração'])
), ins as (
  insert into public.delivery_categories (company_id, kind, name, color, sort_order, analyze_duration)
  select cg.company_id, s.kind, s.name, s.color, s.sort_order, s.analyze_duration
  from companies_with_gitlab cg cross join seed s
  on conflict (company_id, kind, lower(btrim(name))) do nothing
  returning id, kind, name
)
insert into public.delivery_category_labels (category_id, label_name)
select ins.id, l.label_name
from ins
join seed s on s.kind = ins.kind and s.name = ins.name
cross join lateral unnest(s.labels) as l(label_name)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 7. pg_cron: refresh das MVs a cada 15 min (garantia além do orquestrador)
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vg_refresh_metrics', '*/15 * * * *', 'select public.vg_refresh_metrics();');
  else
    raise notice 'pg_cron não instalado: agende public.vg_refresh_metrics() manualmente.';
  end if;
end;
$$;
