-- Aprovações feitas pelo cliente na página de pendências.
-- O cliente só registra a decisão (aprovado / ajustes) dos itens do próprio cliente; a plataforma da equipe
-- aplica a decisão na campanha e marca como aplicada. Assim a decisão não se perde se alguém da equipe
-- estiver com a campanha aberta e salvar por cima.
create table if not exists public.aprovacoes_cliente (
  id uuid primary key default gen_random_uuid(),
  cliente_id text not null references public.clientes(id) on delete cascade,
  campanha_id text not null,
  tipo text not null check (tipo in ('peca','lp','post')),
  alvo jsonb not null,                -- o que foi aprovado (ids das peças, idioma da LP, id do post…)
  etapa text not null,                -- conteudo | asset | layout
  decisao text not null check (decisao in ('aprovado','ajustes')),
  comentario text,
  autor uuid not null default auth.uid(),
  autor_nome text,
  criado_em timestamptz not null default now(),
  aplicado_em timestamptz
);
create index if not exists aprovacoes_cliente_pendentes on public.aprovacoes_cliente (aplicado_em) where aplicado_em is null;
alter table public.aprovacoes_cliente enable row level security;

drop policy if exists "aprovacoes: cliente registra as suas" on public.aprovacoes_cliente;
create policy "aprovacoes: cliente registra as suas" on public.aprovacoes_cliente for insert
  with check (cliente_id = cliente_atual() and autor = auth.uid() and aplicado_em is null);

drop policy if exists "aprovacoes: equipe vê todas, cliente vê as suas" on public.aprovacoes_cliente;
create policy "aprovacoes: equipe vê todas, cliente vê as suas" on public.aprovacoes_cliente for select
  using (eh_equipe() or cliente_id = cliente_atual());

drop policy if exists "aprovacoes: equipe marca como aplicada" on public.aprovacoes_cliente;
create policy "aprovacoes: equipe marca como aplicada" on public.aprovacoes_cliente for update
  using (eh_equipe()) with check (eh_equipe());
