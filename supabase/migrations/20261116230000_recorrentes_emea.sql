-- PTx Trimble EMEA: FastApp e Newsletter (todos os países) são campanhas recorrentes
update public.config
   set valor = (select jsonb_agg(distinct v) from jsonb_array_elements(valor || '["120249383758200373","120249383731530373","120249383676580373","120249383441720373","120249383387340373","120249383289030373","120249382264310373","120249382252250373","120249382242870373","120249382224920373","120249381697940373"]'::jsonb) v)
 where chave = 'campanhasRecorrentes';
