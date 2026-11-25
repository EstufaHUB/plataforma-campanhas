-- Comentários feitos pelo cliente (login de cliente) nas páginas que ele vê: comentários da página de um post/peça/LP,
-- da seção de entregáveis e do KV. O cliente não grava nas campanhas; registra aqui e a plataforma da equipe
-- coloca o comentário no lugar certo e marca como aplicado (mesmo esquema de aprovacoes_cliente).
create table if not exists public.comentarios_cliente (
  id uuid primary key default gen_random_uuid(),
  cliente_id text not null references public.clientes(id) on delete cascade,
  campanha_id text not null,          -- campanha ou projeto de social media
  alvo jsonb not null,                -- onde entra: {k:'doc', et, idi, mi} | {k:'sec', sec} | {k:'kv', e}
  texto text not null check (length(texto) between 1 and 5000),
  resp bigint,                        -- horário (ms) do comentário respondido, quando é uma resposta
  t bigint not null,                  -- horário (ms) do comentário, o mesmo que fica na campanha
  autor uuid not null default auth.uid(),
  autor_nome text,
  criado_em timestamptz not null default now(),
  aplicado_em timestamptz
);
create index if not exists comentarios_cliente_pendentes on public.comentarios_cliente (aplicado_em) where aplicado_em is null;
alter table public.comentarios_cliente enable row level security;

drop policy if exists "comentarios: cliente registra os seus" on public.comentarios_cliente;
create policy "comentarios: cliente registra os seus" on public.comentarios_cliente for insert
  with check (cliente_id = cliente_atual() and autor = auth.uid() and aplicado_em is null);

drop policy if exists "comentarios: equipe vê todos, cliente vê os seus" on public.comentarios_cliente;
create policy "comentarios: equipe vê todos, cliente vê os seus" on public.comentarios_cliente for select
  using (eh_equipe() or cliente_id = cliente_atual());

drop policy if exists "comentarios: equipe marca como aplicado" on public.comentarios_cliente;
create policy "comentarios: equipe marca como aplicado" on public.comentarios_cliente for update
  using (eh_equipe()) with check (eh_equipe());

-- Nomes da equipe para o cliente mencionar (@) e ver os avatares nos comentários.
-- O cliente não lê a tabela perfis; esta função devolve só nome e foto de quem é da equipe.
create or replace function public.equipe_nomes() returns table(nome text, foto text)
  language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(p.nome), ''), split_part(p.email, '@', 1)) as nome, p.foto
  from public.perfis p where p.papel in ('admin', 'equipe') and auth.uid() is not null
$$;
revoke all on function public.equipe_nomes() from public, anon;
grant execute on function public.equipe_nomes() to authenticated;
