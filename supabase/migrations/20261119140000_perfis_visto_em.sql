-- última vez em que cada usuário esteve com o sistema aberto (aparece no canto da tela, como no Notion)
alter table public.perfis add column if not exists visto_em timestamptz;
