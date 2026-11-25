-- Clientes: status manual (ativo/inativo), grupo (cliente principal dos subclientes) e logo (imagem pequena em data URL).
alter table public.clientes add column if not exists status text not null default 'ativo';
alter table public.clientes add column if not exists grupo text;
alter table public.clientes add column if not exists logo text;
