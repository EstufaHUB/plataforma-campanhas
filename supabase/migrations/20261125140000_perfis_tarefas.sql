-- Atividades pessoais de cada usuário (sem campanha), na "Minha página". Cada um edita as próprias.
alter table public.perfis add column if not exists tarefas jsonb not null default '[]'::jsonb;
