-- notificações arquivadas (somem da lista de quem arquivou)
alter table public.notif_estado add column if not exists arquivada_em timestamptz;
