-- Invoices enviadas aos clientes (seção Administrativo). Só a equipe da agência vê e edita.
create table if not exists public.invoices (
  id            text primary key,
  dados         jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);
alter table public.invoices enable row level security;
create policy "invoices: equipe lê"    on public.invoices for select using (public.eh_equipe());
create policy "invoices: equipe cria"  on public.invoices for insert with check (public.eh_equipe());
create policy "invoices: equipe edita" on public.invoices for update using (public.eh_equipe()) with check (public.eh_equipe());
create policy "invoices: equipe exclui" on public.invoices for delete using (public.eh_equipe());
