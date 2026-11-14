// Sincroniza resultados do Gerenciador de Anúncios do Meta para a tabela resultados_meta.
// Lê, em cada campanha da plataforma, a lista dados.metaVinculos = [{conta, campanhaId, marca, canal, pais}].
// Precisa do segredo META_ACCESS_TOKEN (token de usuário do sistema com permissão ads_read).
// Chamada pelo agendamento (pg_cron) ou pelo botão "Atualizar agora" da plataforma.
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// leads = maior entre os tipos de lead que o Meta informa (formulário, pixel, agrupado)
const TIPOS_LEAD = ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"];
// acaoResultado: tipo de ação usado como resultado quando não é lead (ex.: offsite_conversion.custom.123 = download do ebook)
function leadsDe(actions: { action_type: string; value: string }[] | undefined, acaoResultado?: string) {
  if (!actions) return 0;
  const tipos = acaoResultado ? [acaoResultado] : TIPOS_LEAD;
  return Math.max(0, ...actions.filter((a) => tipos.includes(a.action_type)).map((a) => +a.value || 0));
}
const acaoDe = (actions: { action_type: string; value: string }[] | undefined, tipo: string) => +((actions || []).find((a) => a.action_type === tipo)?.value || 0);

async function insights(campanhaId: string, token: string, extra: Record<string, string>) {
  const u = new URL(`${GRAPH}/${campanhaId}/insights`);
  u.searchParams.set("fields", "spend,impressions,clicks,reach,actions,account_currency");
  u.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message || `Meta respondeu ${r.status}`);
  return j.data as Record<string, unknown>[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = Deno.env.get("META_ACCESS_TOKEN");
  if (!token) return json({ erro: "Falta configurar o segredo META_ACCESS_TOKEN no Supabase." }, 500);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // quem chamou: usuário da equipe (botão) ou o agendamento (sem usuário)
  let apenas: string | null = null;
  try { apenas = (await req.json())?.campanha ?? null; } catch { /* sem corpo */ }
  const auth = req.headers.get("Authorization") || "";
  const { data: u } = await admin.auth.getUser(auth.replace("Bearer ", ""));
  if (u?.user) {
    const { data: p } = await admin.from("perfis").select("papel").eq("id", u.user.id).single();
    if (!p || !["equipe", "admin"].includes(p.papel)) return json({ erro: "Sem permissão." }, 403);
  }

  let q = admin.from("campanhas").select("id, dados");
  if (apenas) q = q.eq("id", apenas);
  const { data: campanhas, error } = await q;
  if (error) return json({ erro: error.message }, 500);

  const feito: unknown[] = [];
  for (const c of campanhas || []) {
    const vinculos = (c.dados?.metaVinculos || []) as { campanhaId: string; acaoResultado?: string; [k: string]: unknown }[];
    for (const v of vinculos) {
      try {
        const total = (await insights(v.campanhaId, token, { date_preset: "maximum" }))[0] || {};
        const dias = await insights(v.campanhaId, token, { date_preset: "maximum", time_increment: "1", limit: "500" });
        const dados = {
          vinculo: v,
          moeda: total.account_currency || null,
          investido: +(total.spend as string) || 0,
          impressoes: +(total.impressions as string) || 0,
          cliques: +(total.clicks as string) || 0,
          alcance: +(total.reach as string) || 0,
          leads: leadsDe(total.actions as never, v.acaoResultado),
          engajamentos: acaoDe(total.actions as never, "post_engagement"),
          porDia: dias.map((d) => ({ data: d.date_start, investido: +(d.spend as string) || 0, leads: leadsDe(d.actions as never, v.acaoResultado), impressoes: +(d.impressions as string) || 0, engajamentos: acaoDe(d.actions as never, "post_engagement") })),
          fonte: "Meta Graph API",
        };
        await admin.from("resultados_meta").upsert({ campanha_id: c.id, meta_campanha: v.campanhaId, dados, atualizado_em: new Date().toISOString() });
        feito.push({ campanha: c.id, meta: v.campanhaId, ok: true });
      } catch (e) {
        feito.push({ campanha: c.id, meta: v.campanhaId, ok: false, erro: String((e as Error).message || e) });
      }
    }
  }
  return json({ resultado: feito });
});
