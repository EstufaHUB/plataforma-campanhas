-- Programação de posts do Social media no Instagram (manual: a pessoa clica em "Programar").
-- A fila fica numa tabela própria (e não dentro de campanhas.dados) para que uma página aberta,
-- que grava a linha inteira do projeto, nunca desfaça o estado de uma publicação.
create table if not exists public.social_publicacoes (
  id text primary key,
  projeto_id text not null references public.campanhas(id) on delete cascade,
  post_id text not null,
  perfil text,
  ig_user_id text not null,
  quando timestamptz not null,
  status text not null default 'agendado' check (status in ('agendado','publicando','publicado','erro','cancelado')),
  payload jsonb not null,            -- o que foi aprovado no clique: formato, links, legenda, collab
  estado jsonb not null default '{}',-- uso da função: contêineres criados no Instagram
  erro text,
  ig_media_id text,
  permalink text,
  criado_por text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  publicado_em timestamptz
);
create index if not exists social_publicacoes_fila on public.social_publicacoes (status, quando);
create index if not exists social_publicacoes_post on public.social_publicacoes (post_id);
alter table public.social_publicacoes enable row level security;

drop policy if exists "social_publicacoes: equipe lê" on public.social_publicacoes;
drop policy if exists "social_publicacoes: equipe programa" on public.social_publicacoes;
drop policy if exists "social_publicacoes: equipe cancela" on public.social_publicacoes;
create policy "social_publicacoes: equipe lê" on public.social_publicacoes for select using (public.tem_acesso('campanhas'));
create policy "social_publicacoes: equipe programa" on public.social_publicacoes for insert with check (public.tem_acesso('campanhas') and status = 'agendado');
create policy "social_publicacoes: equipe cancela" on public.social_publicacoes for update using (public.tem_acesso('campanhas'));

-- pelo app, a equipe só cancela uma publicação ainda agendada (ou que deu erro); publicar é só da função
create or replace function public.social_publicacoes_protege() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    if old.status not in ('agendado','erro') or new.status <> 'cancelado'
       or new.payload is distinct from old.payload or new.ig_user_id is distinct from old.ig_user_id or new.quando is distinct from old.quando then
      raise exception 'Pelo app só dá para cancelar uma publicação programada.';
    end if;
  end if;
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists social_publicacoes_protege on public.social_publicacoes;
create trigger social_publicacoes_protege before update on public.social_publicacoes for each row execute function public.social_publicacoes_protege();

-- arquivos copiados do Drive para o Instagram buscar (a API só aceita links públicos diretos)
insert into storage.buckets (id, name, public) values ('social-midia', 'social-midia', true) on conflict (id) do nothing;

-- a cada 5 minutos a função publica o que chegou na hora
do $$ begin perform cron.unschedule('ig-publicar-5min'); exception when others then null; end $$;
select cron.schedule(
  'ig-publicar-5min',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://omkdwliaaixiurvtrmtz.supabase.co/functions/v1/ig-publicar',
       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ta2R3bGlhYWl4aXVydnRybXR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0OTE3MjcsImV4cCI6MjExMDA2NzcyN30.tWBifCsAXagYDl2LxjpMJSubMILiPbtGkgZvU8kCeeQ'),
       body := '{"fila":true}'::jsonb) $$
);
