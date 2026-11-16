-- Retrato das campanhas ativas de cada conta de anúncios do Meta (para o Status pontual).
-- Escrito só pela função meta-sync (chave de serviço); lido pela equipe.
create table public.meta_contas (
  conta         text primary key,            -- id da conta de anúncios (sem act_)
  dados         jsonb not null,              -- {nome, moeda, campanhas:[...]}
  atualizado_em timestamptz not null default now()
);
alter table public.meta_contas enable row level security;
create policy "meta_contas: equipe lê" on public.meta_contas for select to authenticated using (public.eh_equipe());

-- contas acompanhadas no Status pontual (grupo = como aparece na tela)
insert into public.config (chave, valor) values ('contasStatus', '[
  {"conta":"1301073288389463","nome":"PTx - LATAM","grupo":"PTx Trimble LATAM","marca":"PTx Trimble"},
  {"conta":"1795893434400921","nome":"Precision Planting Brasil","grupo":"Precision Planting BR","marca":"Precision Planting"},
  {"conta":"2203994956531366","nome":"IFS - EMEA","grupo":"PTx Trimble EMEA","marca":"PTx Trimble"},
  {"conta":"104318539744037","nome":"Precision Planting","grupo":"Precision Planting EMEA","marca":"Precision Planting"}
]'::jsonb)
on conflict (chave) do update set valor = excluded.valor;
