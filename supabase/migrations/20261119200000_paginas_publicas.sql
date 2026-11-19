-- páginas publicadas na web (ex.: texto da landing page para o cliente ler sem login)
create table if not exists public.paginas_publicas (
  token text primary key,
  campanha_id text,
  chave text,
  titulo text,
  html text,
  atualizado_em timestamptz not null default now(),
  publicado_por uuid default auth.uid()
);
alter table public.paginas_publicas enable row level security;
drop policy if exists "paginas_publicas: ler" on public.paginas_publicas;
create policy "paginas_publicas: ler" on public.paginas_publicas for select to anon, authenticated using (true);
drop policy if exists "paginas_publicas: equipe edita" on public.paginas_publicas;
create policy "paginas_publicas: equipe edita" on public.paginas_publicas for all to authenticated using (public.eh_equipe()) with check (public.eh_equipe());
