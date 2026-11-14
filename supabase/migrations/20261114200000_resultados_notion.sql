-- Entregáveis vindos de bancos do Notion (só leitura na plataforma).
-- Escritos só pela função notion-sync (chave de serviço); lidos por quem tem acesso à campanha.
create table public.resultados_notion (
  campanha_id   text not null references public.campanhas (id) on delete cascade,
  notion_db     text not null,               -- id do banco no Notion
  dados         jsonb not null,              -- {titulo, url, itens:[...]}
  atualizado_em timestamptz not null default now(),
  primary key (campanha_id, notion_db)
);

alter table public.resultados_notion enable row level security;

create policy "notion: equipe vê tudo, cliente vê os seus" on public.resultados_notion
  for select to authenticated using (
    public.eh_equipe()
    or exists (select 1 from public.campanhas c where c.id = campanha_id and c.cliente_id = public.cliente_atual())
  );

-- atualização automática a cada hora (a função só lê o Notion; o token fica no segredo NOTION_TOKEN)
select cron.schedule(
  'notion-sync-1h',
  '15 * * * *',
  $$ select net.http_post(
       url := 'https://omkdwliaaixiurvtrmtz.supabase.co/functions/v1/notion-sync',
       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ta2R3bGlhYWl4aXVydnRybXR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0OTE3MjcsImV4cCI6MjExMDA2NzcyN30.tWBifCsAXagYDl2LxjpMJSubMILiPbtGkgZvU8kCeeQ'),
       body := '{}'::jsonb) $$
);
