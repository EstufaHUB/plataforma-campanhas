-- Resultados das campanhas vindos do Gerenciador de Anúncios do Meta.
-- Escritos só pela função meta-sync (chave de serviço); lidos por quem tem acesso à campanha.
create table public.resultados_meta (
  campanha_id   text not null references public.campanhas (id) on delete cascade,
  meta_campanha text not null,               -- id da campanha no Meta
  dados         jsonb not null,              -- totais, por dia e metadados
  atualizado_em timestamptz not null default now(),
  primary key (campanha_id, meta_campanha)
);

alter table public.resultados_meta enable row level security;

create policy "resultados: equipe vê tudo, cliente vê os seus" on public.resultados_meta
  for select to authenticated using (
    public.eh_equipe()
    or exists (select 1 from public.campanhas c where c.id = campanha_id and c.cliente_id = public.cliente_atual())
  );
-- sem políticas de escrita: só a função (chave de serviço) grava
