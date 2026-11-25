-- Favoritos de cada usuário (páginas marcadas com a estrela; aparecem no menu lateral só para ele).
alter table public.perfis add column if not exists favoritos jsonb not null default '[]'::jsonb;
