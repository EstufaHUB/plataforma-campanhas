-- estado das notificações por pessoa: quando apareceu (hora real, igual em qualquer aparelho) e quando foi lida
create table if not exists public.notif_estado (
  user_id uuid not null references auth.users(id) on delete cascade,
  chave text not null,
  visto_em timestamptz not null default now(),
  lida_em timestamptz,
  primary key (user_id, chave)
);
alter table public.notif_estado enable row level security;
drop policy if exists "notif_estado: dono" on public.notif_estado;
create policy "notif_estado: dono" on public.notif_estado for all using (user_id = auth.uid()) with check (user_id = auth.uid());
