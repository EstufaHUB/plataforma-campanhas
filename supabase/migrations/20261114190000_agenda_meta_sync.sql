-- Atualiza os resultados do Meta automaticamente a cada 6 horas.
-- Usa a chave pública (anon): a função só busca e grava métricas; o token do Meta fica no segredo META_ACCESS_TOKEN.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'meta-sync-6h',
  '0 */6 * * *',
  $$ select net.http_post(
       url := 'https://omkdwliaaixiurvtrmtz.supabase.co/functions/v1/meta-sync',
       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ta2R3bGlhYWl4aXVydnRybXR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0OTE3MjcsImV4cCI6MjExMDA2NzcyN30.tWBifCsAXagYDl2LxjpMJSubMILiPbtGkgZvU8kCeeQ'),
       body := '{}'::jsonb) $$
);
