-- Estrutura inicial da plataforma de campanhas
-- Perfis de acesso:
--   pendente : criou a conta, mas ainda não foi liberado (não vê nada)
--   equipe   : equipe da agência (vê e edita tudo)
--   admin    : equipe + gerencia acessos
--   cliente  : vê somente o próprio cliente e as campanhas dele (somente leitura nesta etapa)

create table public.clientes (
  id            text primary key,
  nome          text not null,
  segmento      text not null default '',
  contato       text not null default '',
  arquivado     boolean not null default false,
  atualizado_em timestamptz not null default now()
);

create table public.perfis (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  nome       text not null default '',
  papel      text not null default 'pendente' check (papel in ('pendente', 'equipe', 'admin', 'cliente')),
  cliente_id text references public.clientes (id) on delete set null,
  criado_em  timestamptz not null default now()
);

-- Cada campanha guarda seu conteúdo completo (cronograma, ações, budgets, traduções...) em "dados".
create table public.campanhas (
  id             text primary key,
  cliente_id     text not null references public.clientes (id) on delete restrict,
  dados          jsonb not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid references auth.users (id) on delete set null default auth.uid()
);
create index campanhas_cliente_idx on public.campanhas (cliente_id);

-- Configurações gerais: modelo de cronograma, feriados, idiomas por região, equipe...
create table public.config (
  chave         text primary key,
  valor         jsonb not null,
  atualizado_em timestamptz not null default now()
);

create table public.log (
  id      bigint generated always as identity primary key,
  quando  timestamptz not null default now(),
  usuario uuid references auth.users (id) on delete set null default auth.uid(),
  quem    text not null default '',
  texto   text not null
);
create index log_quando_idx on public.log (quando desc);

-- ---------- funções auxiliares (security definer evita recursão nas políticas) ----------
create or replace function public.papel_atual() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select papel from public.perfis where id = auth.uid()), 'pendente');
$$;

create or replace function public.cliente_atual() returns text
language sql stable security definer set search_path = '' as $$
  select cliente_id from public.perfis where id = auth.uid();
$$;

create or replace function public.eh_equipe() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.papel_atual() in ('equipe', 'admin');
$$;

revoke execute on function public.papel_atual(), public.cliente_atual(), public.eh_equipe() from anon;

-- perfil criado automaticamente quando alguém cria a conta
create or replace function public.criar_perfil() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.perfis (id, email, nome)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'nome', ''));
  return new;
end;
$$;

create trigger ao_criar_usuario
  after insert on auth.users
  for each row execute function public.criar_perfil();

-- carimbo de atualização
create or replace function public.carimbar() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;
create trigger carimbo before update on public.clientes  for each row execute function public.carimbar();
create trigger carimbo before update on public.campanhas for each row execute function public.carimbar();
create trigger carimbo before update on public.config    for each row execute function public.carimbar();

-- ---------- RLS ----------
alter table public.clientes  enable row level security;
alter table public.perfis    enable row level security;
alter table public.campanhas enable row level security;
alter table public.config    enable row level security;
alter table public.log       enable row level security;

-- clientes
create policy "clientes: equipe vê todos, cliente vê o seu" on public.clientes
  for select to authenticated using (public.eh_equipe() or id = public.cliente_atual());
create policy "clientes: equipe cria" on public.clientes
  for insert to authenticated with check (public.eh_equipe());
create policy "clientes: equipe edita" on public.clientes
  for update to authenticated using (public.eh_equipe()) with check (public.eh_equipe());
create policy "clientes: admin exclui" on public.clientes
  for delete to authenticated using (public.papel_atual() = 'admin');

-- campanhas
create policy "campanhas: equipe vê todas, cliente vê as suas" on public.campanhas
  for select to authenticated using (public.eh_equipe() or cliente_id = public.cliente_atual());
create policy "campanhas: equipe cria" on public.campanhas
  for insert to authenticated with check (public.eh_equipe());
create policy "campanhas: equipe edita" on public.campanhas
  for update to authenticated using (public.eh_equipe()) with check (public.eh_equipe());
create policy "campanhas: admin exclui" on public.campanhas
  for delete to authenticated using (public.papel_atual() = 'admin');

-- config
create policy "config: quem tem acesso lê" on public.config
  for select to authenticated using (public.papel_atual() <> 'pendente');
create policy "config: equipe cria" on public.config
  for insert to authenticated with check (public.eh_equipe());
create policy "config: equipe edita" on public.config
  for update to authenticated using (public.eh_equipe()) with check (public.eh_equipe());

-- perfis: cada um vê o próprio; equipe vê todos; só admin muda papel/cliente
create policy "perfis: ver" on public.perfis
  for select to authenticated using (id = auth.uid() or public.eh_equipe());
create policy "perfis: admin edita" on public.perfis
  for update to authenticated using (public.papel_atual() = 'admin') with check (public.papel_atual() = 'admin');

-- log
create policy "log: equipe lê" on public.log
  for select to authenticated using (public.eh_equipe());
create policy "log: equipe registra" on public.log
  for insert to authenticated with check (public.eh_equipe() and usuario = auth.uid());

-- clientes reais
insert into public.clientes (id, nome, segmento) values
  ('cl1', 'PTx LATAM', 'América Latina'),
  ('cl2', 'PTx EMEA',  'Europa, Oriente Médio e África'),
  ('cl3', 'PTx OEM',   'OEM');
