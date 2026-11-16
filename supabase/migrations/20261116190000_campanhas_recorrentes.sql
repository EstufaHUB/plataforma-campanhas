-- Campanhas do Gerenciador que são recorrentes (sempre no ar); as demais são pontuais.
insert into public.config (chave, valor) values ('campanhasRecorrentes', '[
  "120239931059590454",
  "120239931259890454",
  "120239931373390454",
  "120250625479950454"
]'::jsonb)
on conflict (chave) do nothing;
