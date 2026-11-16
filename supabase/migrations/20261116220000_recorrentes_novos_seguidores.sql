-- Novos seguidores (PTx - LATAM, AR e BR) também são campanhas recorrentes
update public.config
   set valor = (select jsonb_agg(distinct v) from jsonb_array_elements(valor || '["120239924212120454","120239923937270454"]'::jsonb) v)
 where chave = 'campanhasRecorrentes';
