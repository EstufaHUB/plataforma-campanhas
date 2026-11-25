// Sincroniza resultados do Gerenciador de Anúncios do Meta para a tabela resultados_meta.
// Lê, em cada campanha da plataforma, a lista dados.metaVinculos = [{conta, campanhaId, marca, canal, pais}].
// Precisa do segredo META_ACCESS_TOKEN (token de usuário do sistema com permissão ads_read).
// Chamada pelo agendamento (pg_cron) ou pelo botão "Atualizar agora" da plataforma.
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

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
function leadsDe(actions: { action_type: string; value: string }[] | undefined, acaoResultado?: string | string[] | null) {
  if (!actions) return 0;
  const tipos = Array.isArray(acaoResultado) && acaoResultado.length ? acaoResultado : typeof acaoResultado === "string" && acaoResultado ? [acaoResultado] : TIPOS_LEAD;
  return Math.max(0, ...actions.filter((a) => tipos.includes(a.action_type)).map((a) => +a.value || 0));
}
// o que o Gerenciador conta como "resultado": o evento de otimização dos conjuntos (ex.: COMPLETE_REGISTRATION = cadastro concluído no site)
// LEAD ou sem evento → tipos de lead padrão (null)
function acaoDoConjunto(po: Record<string, unknown> | undefined): string[] | null {
  if (!po) return null;
  if (po.custom_conversion_id) return [`offsite_conversion.custom.${po.custom_conversion_id}`];
  const e = String(po.custom_event_type || ""); if (!e || e === "LEAD" || e === "OTHER") return null;
  const k = e.toLowerCase(); return [`offsite_conversion.fb_pixel_${k}`, k, `onsite_web_${k}`, `onsite_conversion.${k}`, `omni_${k}`];
}
const acaoDosConjuntos = (as: Record<string, unknown>[]) => { for (const a of as) { const t = acaoDoConjunto(a.promoted_object as Record<string, unknown>); if (t) return t; } return null; };
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

// só entram as campanhas veiculadas pela Estufa: "ESTUFA" no nome, como [ESTUFA] ou Estufa_ (as outras da conta são do cliente)
const ehEstufa = (nome: unknown) => /(^|[\[\s_\-|])estufa($|[\]\s_\-|])/i.test(String(nome || ""));
// ---------- retrato das contas: todas as campanhas ativas de cada conta (Status pontual) ----------
async function graph(path: string, token: string, params: Record<string, string>) {
  const out: Record<string, unknown>[] = [];
  let u: string | null = (() => { const x = new URL(`${GRAPH}/${path}`); x.searchParams.set("access_token", token); for (const [k, v] of Object.entries(params)) x.searchParams.set(k, v); return x.toString(); })();
  for (let i = 0; u && i < 20; i++) {
    let r = await fetch(u), j = await r.json();
    // limite de chamadas do Meta (códigos 4, 17, 613, 80004): espera 2s e tenta uma vez de novo (mais que isso estoura o tempo da função)
    if (j.error && [4, 17, 613, 80000, 80004].includes(+j.error.code)) { await new Promise((ok) => setTimeout(ok, 2000)); r = await fetch(u); j = await r.json(); }
    if (!r.ok || j.error) throw new Error(`${path.split('/').pop()}: ${j.error?.error_user_msg || j.error?.message || 'Meta respondeu ' + r.status}`);
    if (Array.isArray(j.data)) out.push(...j.data); else return [j];
    u = j.paging?.next || null;
  }
  return out;
}
type Acao = { action_type: string; value: string };
const acao = (a: Acao[] | undefined, t: string) => +((a || []).find((x) => x.action_type === t)?.value || 0);
// resultado de acordo com o objetivo da campanha
function resultado(obj: string, a: Acao[] | undefined, reach: number, tipos?: string[] | null) {
  if (tipos && ["OUTCOME_LEADS", "OUTCOME_SALES", "CONVERSIONS", "LEAD_GENERATION"].includes(obj)) return { n: leadsDe(a, tipos), tipo: obj === "OUTCOME_SALES" ? "compras" : "leads" };
  if (obj === "OUTCOME_LEADS") { const l = leadsDe(a); if (l) return { n: l, tipo: "leads" };
    const cust = (a || []).filter((x) => x.action_type.startsWith("offsite_conversion.custom.")).map((x) => +x.value || 0); return { n: cust.length ? Math.max(...cust) : 0, tipo: cust.length ? "conversões" : "leads" }; }
  if (obj === "OUTCOME_ENGAGEMENT") return { n: acao(a, "post_engagement"), tipo: "engajamentos" };
  if (obj === "OUTCOME_TRAFFIC") return { n: acao(a, "link_click"), tipo: "cliques" };
  if (obj === "OUTCOME_AWARENESS") return { n: reach, tipo: "alcance" };
  if (obj === "OUTCOME_SALES") return { n: Math.max(acao(a, "offsite_conversion.fb_pixel_purchase"), acao(a, "purchase")), tipo: "compras" };
  return { n: acao(a, "link_click"), tipo: "cliques" };
}
// ---------- custo de referência: média dos últimos 6 meses por objetivo de mídia e país ----------
const PAISES_COD = ["DE","FR","IT","UK","GB","ES","NL","BR","AR","CL","CO","MX","PY","UY","US","CA","AU","NZ","JP","PE","KZ","UA","TR","PL","BE","AT","CZ","HU","RO","PT","IE","DK","SE","NO","FI","ZA"];
const paisNome = (n: string) => { const c = String(n).toUpperCase().split(/[_\s\-|·]+/).find((x) => PAISES_COD.includes(x)); return c === "GB" ? "UK" : c || null; };
const OBJ_LEAD = ["OUTCOME_LEADS", "LEAD_GENERATION", "CONVERSIONS"], OBJ_AW = ["OUTCOME_AWARENESS", "REACH", "BRAND_AWARENESS"], OBJ_ENG = ["OUTCOME_ENGAGEMENT", "POST_ENGAGEMENT", "VIDEO_VIEWS", "PAGE_LIKES"], OBJ_TRAF = ["OUTCOME_TRAFFIC", "LINK_CLICKS"];
// objetivo de mídia da plataforma → campanhas do mesmo tipo no Meta e o que conta como resultado (Alcance: custo por mil pessoas)
const METRICAS: Record<string, { objs: string[]; res: (a: Acao[] | undefined, reach: number) => number; mil?: boolean }> = {
  "Conversão": { objs: OBJ_LEAD, res: (a) => { const l = leadsDe(a); if (l) return l; const cust = (a || []).filter((x) => x.action_type.startsWith("offsite_conversion.custom.")).map((x) => +x.value || 0); return cust.length ? Math.max(...cust) : 0; } },
  "Alcance": { objs: OBJ_AW, res: (_a, reach) => reach, mil: true },
  "Engajamento": { objs: OBJ_ENG, res: (a) => acao(a, "post_engagement") },
  "Tráfego": { objs: OBJ_TRAF, res: (a) => acao(a, "link_click") },
  "Link click": { objs: OBJ_TRAF, res: (a) => acao(a, "link_click") },
  "Visita": { objs: OBJ_TRAF, res: (a) => acao(a, "landing_page_view") },
};
async function referencia(act: string, token: string) {
  const ate = new Date(), desde = new Date(ate.getTime() - 182 * 864e5), d = (x: Date) => x.toISOString().slice(0, 10);
  const linhas = await graph(`${act}/insights`, token, { level: "campaign", time_range: JSON.stringify({ since: d(desde), until: d(ate) }), fields: "campaign_id,campaign_name,objective,spend,reach,actions", limit: "500" }).then((l) => l.filter((x) => ehEstufa(x.campaign_name)));
  const porObj: Record<string, Record<string, { gasto: number; res: number; n: number; custo?: number }>> = {};
  // contribuição de cada campanha (para a plataforma tirar a própria campanha da média dela)
  const porCamp: Record<string, Record<string, { gasto: number; res: number; pais: string | null }>> = {};
  for (const [mid, m] of Object.entries(METRICAS)) {
    const acc: Record<string, { gasto: number; res: number; n: number }> = {};
    for (const l of linhas) {
      if (!m.objs.includes(l.objective as string)) continue;
      const gasto = +(l.spend as string) || 0, res = m.res(l.actions as Acao[], +(l.reach as string) || 0);
      if (gasto < 50 || res < (m.mil ? 1000 : 3)) continue;   // ignora campanhas com gasto ou resultado pequenos demais
      const pc = paisNome(l.campaign_name as string); (porCamp[l.campaign_id as string] = porCamp[l.campaign_id as string] || {})[mid] = { gasto, res, pais: pc };
      for (const k of [pc || "?", "*"]) { const x = acc[k] || (acc[k] = { gasto: 0, res: 0, n: 0 }); x.gasto += gasto; x.res += res; x.n++; }
    }
    delete acc["?"];
    for (const x of Object.values(acc)) (x as { custo?: number }).custo = x.gasto / x.res * (m.mil ? 1000 : 1);
    if (Object.keys(acc).length) porObj[mid] = acc;
  }
  return { desde: d(desde), ate: d(ate), porObj, porCamp };
}
async function retratoContas(admin: ReturnType<typeof createClient>, token: string) {
  const { data: cfg } = await admin.from("config").select("valor").eq("chave", "contasStatus").single();
  const contas = (cfg?.valor || []) as { conta: string; nome: string; grupo: string }[];
  const feito: unknown[] = [];
  for (const ct of contas) {
    try {
      const act = `act_${ct.conta}`;
      const [info] = await graph(act, token, { fields: "name,currency" });
      const camps = await graph(`${act}/campaigns`, token, { fields: "id,name,objective,start_time,stop_time,daily_budget,lifetime_budget,effective_status,updated_time", effective_status: '["ACTIVE","PAUSED"]', limit: "200" }).then((l) => l.filter((c) => ehEstufa(c.name)));
      const ids = new Set(camps.map((c) => c.id as string));
      // conjuntos (uma chamada só, apenas das campanhas da Estufa): budget quando a campanha não tem, e evento de otimização
      let conjs: Record<string, unknown>[] = [];
      try { for (let i = 0; i < camps.length; i += 100) conjs.push(...await graph(`${act}/adsets`, token, { fields: "campaign_id,daily_budget,lifetime_budget,end_time,start_time,effective_status,promoted_object", effective_status: '["ACTIVE","PAUSED","CAMPAIGN_PAUSED"]', filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: camps.slice(i, i + 100).map((c) => c.id) }]), limit: "500" })); } catch (_) { conjs = []; /* sem conjuntos nesta rodada: segue com o que tem */ }
      const adsets = conjs.filter((a) => a.effective_status !== "PAUSED");
      const filtro = JSON.stringify([{ field: "campaign.effective_status", operator: "IN", value: ["ACTIVE", "PAUSED"] }]);
      const porId = (lista: Record<string, unknown>[]) => Object.fromEntries(lista.map((x) => [x.campaign_id as string, x]));
      const sete = await graph(`${act}/insights`, token, { level: "campaign", date_preset: "last_7d", fields: "campaign_id,spend,actions,reach", filtering: filtro, limit: "500" });
      const S7 = porId(sete);
      // pausadas no Gerenciador: entram se ainda estão no período e gastaram nos últimos 30 dias (pausa recente)
      const pausadas = camps.filter((c) => c.effective_status === "PAUSED");
      let S30: Record<string, Record<string, unknown>> = {};
      if (pausadas.length) S30 = porId(await graph(`${act}/insights`, token, { level: "campaign", date_preset: "last_30d", fields: "campaign_id,spend", filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: pausadas.slice(0, 100).map((c) => c.id) }]), limit: "500" }));
      const gastou = (M: Record<string, Record<string, unknown>>, id: string) => +((M[id] || {}).spend as string) > 0;
      const hoje = Date.now(), noAr = (c: Record<string, unknown>) => (!c.stop_time || Date.parse(c.stop_time as string) >= hoje - 864e5) &&
        (c.effective_status === "PAUSED" ? gastou(S30, c.id as string) : (gastou(S7, c.id as string) || (c.start_time && Date.parse(c.start_time as string) >= hoje - 3 * 864e5)));
      const ativas = camps.filter((c) => ids.has(c.id as string) && noAr(c)), total: Record<string, unknown>[] = [];
      // evento de otimização dos conjuntos de cada campanha (o "resultado" do Gerenciador)
      const evento: Record<string, string[] | null> = {};
      for (const c of ativas) { const cj = conjs.filter((a) => a.campaign_id === c.id); evento[c.id as string] = cj.length ? acaoDosConjuntos(cj) : null; }
      // total desde o início, só das campanhas no ar (em lotes, para contas com muito histórico)
      for (let i = 0; i < ativas.length; i += 25) total.push(...await graph(`${act}/insights`, token, { level: "campaign", date_preset: "maximum", fields: "campaign_id,spend,impressions,reach,clicks,actions", filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: ativas.slice(i, i + 25).map((c) => c.id) }]), limit: "100" }));
      const T = porId(total);
      // gasto por mês (para o plano mensal de budget do Status pontual)
      const porMes: Record<string, Record<string, number>> = {};
      try { for (let i = 0; i < ativas.length; i += 25) for (const l of await graph(`${act}/insights`, token, { level: "campaign", date_preset: "maximum", time_increment: "monthly", fields: "campaign_id,spend", filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: ativas.slice(i, i + 25).map((c) => c.id) }]), limit: "500" })) {
        const id = l.campaign_id as string, m = String(l.date_start || "").slice(0, 7); if (!m) continue; (porMes[id] = porMes[id] || {})[m] = Math.round(((porMes[id][m] || 0) + (+(l.spend as string) || 0)) * 100) / 100; } } catch (_) { /* sem gasto mensal nesta rodada */ }
      const campanhas = ativas.map((c) => {
        const t = (T[c.id as string] || {}) as Record<string, unknown>, s7 = (S7[c.id as string] || {}) as Record<string, unknown>;
        const obj = c.objective as string, ev = evento[c.id as string], r = resultado(obj, t.actions as Acao[], +(t.reach as string) || 0, ev), r7 = resultado(obj, s7.actions as Acao[], +(s7.reach as string) || 0, ev);
        // budget por dia: diário da campanha; vitalício ÷ dias; sem budget na campanha, soma dos conjuntos ativos
        let diario: number | null = c.daily_budget ? +(c.daily_budget as string) / 100 : null;
        const porDias = (lt: number, ini?: string, fim?: string) => ini && fim ? lt / Math.max(1, Math.round((Date.parse(fim) - Date.parse(ini)) / 864e5)) : null;
        if (diario == null && c.lifetime_budget) diario = porDias(+(c.lifetime_budget as string) / 100, c.start_time as string, c.stop_time as string);
        if (diario == null) { const as = adsets.filter((a) => a.campaign_id === c.id); if (as.length) diario = as.reduce((s, a) => s + (a.daily_budget ? +(a.daily_budget as string) / 100 : (a.lifetime_budget ? porDias(+(a.lifetime_budget as string) / 100, a.start_time as string, a.end_time as string) || 0 : 0)), 0) || null; }
        const inv = +(t.spend as string) || 0, inv7 = +(s7.spend as string) || 0;
        return { id: c.id, nome: c.name, objetivo: obj, inicio: c.start_time || null, fim: c.stop_time || null, budgetDiario: diario,
          investido: inv, impressoes: +(t.impressions as string) || 0, alcance: +(t.reach as string) || 0, cliques: +(t.clicks as string) || 0,
          resultados: r.n, tipoResultado: r.tipo, custoResultado: r.n ? inv / r.n : null, gasto7: inv7, resultados7: r7.n, porMes: porMes[c.id as string] || {},
          ...(c.effective_status === "PAUSED" ? { pausada: true, pausadaEm: c.updated_time || null } : {}) };
      });
      let bench = null; try { bench = await referencia(act, token); } catch (_) { /* sem referência nesta rodada */ }
      await admin.from("meta_contas").upsert({ conta: ct.conta, dados: { nome: info?.name || ct.nome, moeda: info?.currency || null, grupo: ct.grupo, campanhas, bench }, atualizado_em: new Date().toISOString() });
      feito.push({ conta: ct.conta, ok: true, campanhas: campanhas.length });
    } catch (e) { feito.push({ conta: ct.conta, ok: false, erro: String((e as Error).message || e) }); }
  }
  return feito;
}

// ---------- alerta de budget: avisa por e-mail quando o investido chega a 90% (e a 100%) do budget total ----------
const fmt = (v: number, m: string) => { try { return v.toLocaleString("pt-BR", { style: "currency", currency: m || "BRL", maximumFractionDigits: 0 }); } catch { return String(Math.round(v)); } };
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
async function alertasBudget(admin: ReturnType<typeof createClient>) {
  const [{ data: camps }, { data: rms }, { data: mcs }, { data: cfg }, { data: adms }] = await Promise.all([
    admin.from("campanhas").select("id, dados"), admin.from("resultados_meta").select("campanha_id, meta_campanha, dados"),
    admin.from("meta_contas").select("conta, dados"), admin.from("config").select("chave, valor").in("chave", ["alertasBudget", "contasStatus", "ocultasStatus", "alertasEmail"]),
    admin.from("perfis").select("email, papel").eq("papel", "admin")]);
  const ant = ((cfg || []).find((r) => r.chave === "alertasBudget")?.valor || {}) as Record<string, { nivel: number; em: string }>;
  const nomesConta = Object.fromEntries((((cfg || []).find((r) => r.chave === "contasStatus")?.valor || []) as { conta: string; grupo: string }[]).map((c) => [String(c.conta), c.grupo]));
  const ocultas = ((cfg || []).find((r) => r.chave === "ocultasStatus")?.valor || {}) as Record<string, unknown>;
  type Item = { chave: string; campanha: string; pais: string; inv: number; total: number; moeda: string; nivel: number; onde: string; campId?: string; conta?: string; fase?: string; marca?: string; fim?: string };
  const itens: Item[] = [], vinculadas = new Set<string>(), hoje = new Date().toISOString().slice(0, 10);
  // campanhas da plataforma: budget do país no canal (ficha) × investido no Gerenciador
  for (const c of camps || []) { const d = c.dados || {}; if (d.arquivada || d.status === "Concluída") continue;
    for (const v of (d.metaVinculos || []) as Record<string, string>[]) { vinculadas.add(v.campanhaId); if (ocultas[v.campanhaId]) continue;
      const cfgs = Object.entries((d.canaisCfg || {}) as Record<string, { paises?: { cod: string; budget?: number }[]; moeda?: string }>)
        .filter(([k]) => k.split(/[|@]/)[0] === (v.canal || "Meta Ads") && (!v.fase || !k.includes("@") || k.endsWith("@" + v.fase)) && (!v.marca || !k.includes("|") || k.includes("|" + v.marca)));
      const cf = cfgs.map(([, x]) => x).find((x) => (x.paises || []).some((p) => p.cod === v.pais)); const pc = cf && (cf.paises || []).find((p) => p.cod === v.pais);
      const r = (rms || []).find((x) => x.campanha_id === c.id && x.meta_campanha === v.campanhaId); const total = +(pc?.budget || 0);
      // investido só a partir do início do período (país, fase ou campanha): gasto anterior no Gerenciador não conta para o budget da ficha
      const iniPer = String((pc as Record<string, unknown>)?.ini || (d.faseada ? d.fasesDatas?.[v.fase || "Lead gen"]?.ini : "") || d.lancamento || "").slice(0, 10);
      const pdia = (r?.dados?.porDia || []) as { data: string; investido: number }[];
      const inv = iniPer && pdia.length ? pdia.filter((x) => String(x.data) >= iniPer).reduce((t, x) => t + (+x.investido || 0), 0) : +(r?.dados?.investido || 0);
      // fase ou campanha já encerrada, ou campanha parada no Gerenciador: não avisa
      const fimPer = d.faseada ? (d.fasesDatas?.[v.fase || "Lead gen"]?.fim || d.fimVeiculacao) : d.fimVeiculacao, st = String(r?.dados?.status || ""), fimMeta = String(r?.dados?.fimMeta || "").slice(0, 10);
      if ((fimPer && fimPer < hoje) || ["PAUSED", "CAMPAIGN_PAUSED", "ARCHIVED", "DELETED"].includes(st) || (fimMeta && fimMeta < hoje)) continue;
      if (total > 0 && inv >= total * 0.9) itens.push({ chave: v.campanhaId, campanha: d.nome, pais: v.pais || "", inv, total, moeda: cf?.moeda || d.moeda || "BRL", nivel: inv >= total ? 100 : 90, onde: "Campanha da plataforma", campId: c.id, fase: d.faseada ? (v.fase || "Lead gen") : undefined, marca: v.marca || undefined, fim: fimPer || undefined, conta: String(v.conta || "").replace(/^act_/, "") }); } }
  // campanhas só no Gerenciador (com data de fim): budget diário × dias do período
  for (const m of mcs || []) for (const mc of ((m.dados?.campanhas || []) as Record<string, unknown>[])) { const id = String(mc.id);
    if (vinculadas.has(id) || ocultas[id] || mc.pausada || !mc.fim || !mc.inicio || !mc.budgetDiario) continue; if (String(mc.fim).slice(0, 10) < hoje) continue;
    const total = +(mc.budgetDiario as number) * dias(String(mc.inicio).slice(0, 10), String(mc.fim).slice(0, 10)), inv = +(mc.investido as number || 0);
    if (total > 0 && inv >= total * 0.9) itens.push({ chave: id, campanha: String(mc.nome), pais: "", inv, total, moeda: m.dados?.moeda || "BRL", nivel: inv >= total ? 100 : 90, onde: nomesConta[String(m.conta)] || m.dados?.nome || "Gerenciador", conta: String(m.conta), fim: String(mc.fim).slice(0, 10) }); }
  const novos = itens.filter((i) => !ant[i.chave] || ant[i.chave].nivel < i.nivel);
  const prox: Record<string, Record<string, unknown>> = {}; for (const i of itens) prox[i.chave] = { nivel: Math.max(i.nivel, ant[i.chave]?.nivel || 0), em: ant[i.chave] && ant[i.chave].nivel >= i.nivel ? ant[i.chave].em : hoje,
    campanha: i.campanha, pais: i.pais, inv: Math.round(i.inv * 100) / 100, total: Math.round(i.total * 100) / 100, moeda: i.moeda, onde: i.onde, campId: i.campId || null, conta: i.conta || null, fase: i.fase || null, marca: i.marca || null, fim: i.fim || null, atualizado: new Date().toISOString() };
  await admin.from("config").upsert({ chave: "alertasBudget", valor: prox });
  const cfgEmail = ((cfg || []).find((r) => r.chave === "alertasEmail")?.valor || {}) as { para?: string[]; ativo?: boolean };
  if (cfgEmail.ativo === false) return { avisos: itens.length, novos: novos.length, enviado: false, desligado: true };
  const para = (cfgEmail.para && cfgEmail.para.length ? cfgEmail.para : (adms || []).map((a) => a.email)).filter(Boolean), user = (Deno.env.get("GMAIL_USER") || "").trim(), pass = (Deno.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
  if (!novos.length || !para.length || !user || !pass) return { avisos: itens.length, novos: novos.length, enviado: false };
  const linhas = novos.sort((a, b) => b.inv / b.total - a.inv / a.total).map((i) => { const pct = Math.round(i.inv / i.total * 100), cor = i.nivel >= 100 ? "#a32d2d" : "#8a5a00";
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${i.campanha}</b>${i.pais ? " · " + i.pais : ""}<div style="color:#6b7a80;font-size:12px">${i.onde}</div></td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(i.inv, i.moeda)} de ${fmt(i.total, i.moeda)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:${cor};font-weight:700">${pct}%${i.nivel >= 100 ? " · estourou" : ""}</td></tr>`; }).join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2a2f;line-height:1.5"><p style="margin:0 0 12px">Estas campanhas chegaram perto do budget total (ou passaram dele). Confira e, se for o caso, ajuste ou pause no Gerenciador.</p>
    <table style="border-collapse:collapse;font-size:13px;width:100%;max-width:640px"><tr style="background:#f3f4f6"><th style="text-align:left;padding:6px 10px">Campanha</th><th style="text-align:right;padding:6px 10px">Investido</th><th style="text-align:right;padding:6px 10px">Do total</th></tr>${linhas}</table>
    <p style="margin:14px 0 0;color:#6b7a80;font-size:12px">Aviso automático da plataforma de campanhas Estufa (a cada sincronização com o Meta). Cada campanha avisa uma vez ao chegar a 90% e outra vez se passar de 100%.</p></div>`;
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  await t.sendMail({ from: `"Estufa · Alertas" <${user}>`, to: para.join(", "), subject: `Budget no limite: ${novos.length} campanha${novos.length === 1 ? "" : "s"}${novos.some((i) => i.nivel >= 100) ? " (alguma já estourou)" : ""}`, html });
  return { avisos: itens.length, novos: novos.length, enviado: true, para };
}

// ---------- campanha pausada no Gerenciador: vira pendência em Digital › Atividades (justificar a pausa) e avisa por e-mail ----------
// Estado em config.alertasPausa = { [id da campanha no Meta]: {campanha, pais, onde, campId, conta, pausadaEm, avisadaEm, reativadaEm?, pend} }.
// Só o servidor grava essa chave; a justificativa fica na plataforma (metasStatus[id].pausaJust), então não há disputa de gravação.
async function alertasPausa(admin: ReturnType<typeof createClient>) {
  const [{ data: camps }, { data: rms }, { data: mcs }, { data: cfg }, { data: adms }] = await Promise.all([
    admin.from("campanhas").select("id, dados"), admin.from("resultados_meta").select("campanha_id, meta_campanha, dados"),
    admin.from("meta_contas").select("conta, dados"), admin.from("config").select("chave, valor").in("chave", ["alertasPausa", "contasStatus", "ocultasStatus", "alertasEmail"]),
    admin.from("perfis").select("email, papel").eq("papel", "admin")]);
  const linhaCfg = (cfg || []).find((r) => r.chave === "alertasPausa"), primeira = !linhaCfg;
  const ant = (linhaCfg?.valor || {}) as Record<string, Record<string, unknown>>;
  const nomesConta = Object.fromEntries((((cfg || []).find((r) => r.chave === "contasStatus")?.valor || []) as { conta: string; grupo: string }[]).map((c) => [String(c.conta), c.grupo]));
  const ocultas = ((cfg || []).find((r) => r.chave === "ocultasStatus")?.valor || {}) as Record<string, unknown>;
  const agora = new Date(), hoje = agora.toISOString().slice(0, 10), PAUSA = ["PAUSED", "CAMPAIGN_PAUSED"];
  type P = { id: string; campanha: string; pais: string; onde: string; campId: string | null; conta: string | null; pausadaEm: string | null };
  const pausadas: Record<string, P> = {};
  // campanhas da plataforma vinculadas ao Meta (status lido em cada sincronização dos vínculos)
  const vinc: Record<string, { c: Record<string, unknown>; d: Record<string, unknown>; v: Record<string, string> }> = {};
  for (const c of camps || []) { const d = c.dados || {}; if (d.arquivada || d.status === "Concluída" || d.tipo) continue;
    for (const v of (d.metaVinculos || []) as Record<string, string>[]) vinc[v.campanhaId] = { c, d, v }; }
  for (const [id, x] of Object.entries(vinc)) { if (ocultas[id]) continue;
    const r = (rms || []).find((y) => y.campanha_id === x.c.id && y.meta_campanha === id); if (!r) continue;
    const st = String(r.dados?.status || ""), fimMeta = String(r.dados?.fimMeta || "").slice(0, 10);
    const fimPer = String((x.d.faseada ? (x.d.fasesDatas as Record<string, { fim?: string }>)?.[x.v.fase || "Lead gen"]?.fim : "") || x.d.fimVeiculacao || "").slice(0, 10);
    if (!PAUSA.includes(st) || (fimMeta && fimMeta < hoje) || (fimPer && fimPer < hoje)) continue;
    pausadas[id] = { id, campanha: String(x.d.nome || id), pais: x.v.pais || "", onde: "Campanha da plataforma", campId: String(x.c.id), conta: String(x.v.conta || "").replace(/^act_/, "") || null, pausadaEm: (r.dados?.statusEm as string) || null }; }
  // campanhas só no Gerenciador (retrato das contas): as pausadas recentes ainda no período
  for (const m of mcs || []) for (const mc of ((m.dados?.campanhas || []) as Record<string, unknown>[])) { const id = String(mc.id); if (vinc[id] || ocultas[id]) continue;
    if (!mc.pausada || (mc.fim && String(mc.fim).slice(0, 10) < hoje)) continue;
    pausadas[id] = { id, campanha: String(mc.nome), pais: "", onde: nomesConta[String(m.conta)] || m.dados?.nome || "Gerenciador", campId: null, conta: String(m.conta), pausadaEm: (mc.pausadaEm as string) || null }; }
  // novas pausas: não estavam pausadas na rodada anterior. Na primeira rodada, só conta pausa dos últimos 2 dias (as antigas entram sem aviso).
  const recente = (em: string | null) => !!em && Date.parse(em) >= agora.getTime() - 2 * 864e5;
  const novas: P[] = [], prox: Record<string, Record<string, unknown>> = {};
  for (const p of Object.values(pausadas)) { const a = ant[p.id];
    const nova = a ? !!a.reativadaEm : (primeira ? recente(p.pausadaEm) : true);
    if (nova) novas.push(p);
    prox[p.id] = nova ? { ...p, avisadaEm: agora.toISOString(), pend: true } : { pend: false, ...(a || {}), ...p, pausadaEm: (a?.pausadaEm as string) || p.pausadaEm, reativadaEm: null }; }
  // as que voltaram a rodar (ou saíram do retrato): guarda por 60 dias, para a pendência de justificativa continuar
  for (const [id, a] of Object.entries(ant)) { if (prox[id]) continue;
    const reat = (a.reativadaEm as string) || agora.toISOString();
    if (Date.parse(reat) >= agora.getTime() - 60 * 864e5) prox[id] = { ...a, reativadaEm: reat }; }
  await admin.from("config").upsert({ chave: "alertasPausa", valor: prox });
  const cfgEmail = ((cfg || []).find((r) => r.chave === "alertasEmail")?.valor || {}) as { para?: string[]; ativo?: boolean };
  if (cfgEmail.ativo === false) return { pausadas: Object.keys(pausadas).length, novas: novas.length, enviado: false, desligado: true };
  const para = (cfgEmail.para && cfgEmail.para.length ? cfgEmail.para : (adms || []).map((a) => a.email)).filter(Boolean), user = (Deno.env.get("GMAIL_USER") || "").trim(), pass = (Deno.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
  if (!novas.length || !para.length || !user || !pass) return { pausadas: Object.keys(pausadas).length, novas: novas.length, enviado: false };
  const quando = (em: string | null) => em ? new Date(em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  const linhas = novas.map((i) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${i.campanha}</b>${i.pais ? " · " + i.pais : ""}<div style="color:#6b7a80;font-size:12px">${i.onde}</div></td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${quando(i.pausadaEm)}</td></tr>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2a2f;line-height:1.5"><p style="margin:0 0 12px">${novas.length === 1 ? "Esta campanha foi pausada" : "Estas campanhas foram pausadas"} no Gerenciador de Anúncios do Meta. A plataforma criou uma pendência em <b>Digital › Atividades</b> para registrar o motivo da pausa.</p>
    <table style="border-collapse:collapse;font-size:13px;width:100%;max-width:640px"><tr style="background:#f3f4f6"><th style="text-align:left;padding:6px 10px">Campanha</th><th style="text-align:right;padding:6px 10px">Pausada em</th></tr>${linhas}</table>
    <p style="margin:14px 0 0"><a href="https://estufahub.github.io/plataforma-campanhas/#/atividades" style="color:#1d6b4f;font-weight:700">Justificar em Atividades →</a></p>
    <p style="margin:14px 0 0;color:#6b7a80;font-size:12px">Aviso automático da plataforma de campanhas Estufa (a cada sincronização com o Meta). O horário é o da última alteração da campanha no Gerenciador.</p></div>`;
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  await t.sendMail({ from: `"Estufa · Alertas" <${user}>`, to: para.join(", "), subject: novas.length === 1 ? `Campanha pausada no Gerenciador: ${novas[0].campanha}${novas[0].pais ? " · " + novas[0].pais : ""}` : `${novas.length} campanhas pausadas no Gerenciador`, html });
  return { pausadas: Object.keys(pausadas).length, novas: novas.length, enviado: true, para };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = Deno.env.get("META_ACCESS_TOKEN");
  if (!token) return json({ erro: "Falta configurar o segredo META_ACCESS_TOKEN no Supabase." }, 500);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // quem chamou: usuário da equipe (botão) ou o agendamento (sem usuário)
  // parte: "vinculos" (resultados das campanhas da plataforma) ou "contas" (retrato das contas + alertas); sem parte = as duas.
  // Separadas, cada chamada cabe no tempo máximo da função.
  let apenas: string | null = null, listar = false, parte: string | null = null;
  try { const corpo = await req.json(); apenas = corpo?.campanha ?? null; listar = !!corpo?.listarContas; parte = corpo?.parte ?? null; } catch { /* sem corpo */ }
  const auth = req.headers.get("Authorization") || "";
  const { data: u } = await admin.auth.getUser(auth.replace("Bearer ", ""));
  if (u?.user) {
    const { data: p } = await admin.from("perfis").select("papel").eq("id", u.user.id).single();
    if (!p || !["equipe", "admin"].includes(p.papel)) return json({ erro: "Sem permissão." }, 403);
  }

  // lista as contas de anúncios que o token enxerga (para adicionar no Status pontual)
  if (listar) {
    if (!u?.user) return json({ erro: "Faça login." }, 401);
    try { const cs = await graph("me/adaccounts", token, { fields: "name,account_id,currency,account_status,business_name", limit: "200" });
      return json({ contas: cs.map((c) => ({ conta: c.account_id, nome: c.name, moeda: c.currency, ativa: c.account_status === 1, empresa: c.business_name || null })) });
    } catch (e) { return json({ erro: String((e as Error).message || e) }, 500); }
  }
  let q = admin.from("campanhas").select("id, dados");
  if (apenas) q = q.eq("id", apenas);
  const { data: campanhas, error } = await q;
  if (error) return json({ erro: error.message }, 500);

  const feito: unknown[] = [];
  for (const c of (parte === "contas" ? [] : campanhas || [])) {
    const vinculos = (c.dados?.metaVinculos || []) as { campanhaId: string; acaoResultado?: string; [k: string]: unknown }[];
    for (const v of vinculos) {
      try {
        // sem ação escolhida no vínculo: usa o evento de otimização dos conjuntos (igual ao "Resultados" do Gerenciador)
        let acaoV: string | string[] | null = v.acaoResultado || null;
        if (!acaoV) { try { acaoV = acaoDosConjuntos(await graph(`${v.campanhaId}/adsets`, token, { fields: "promoted_object", limit: "100" })); } catch (_) { /* tipos de lead padrão */ } }
        const total = (await insights(v.campanhaId, token, { date_preset: "maximum" }))[0] || {};
        const dias = await insights(v.campanhaId, token, { date_preset: "maximum", time_increment: "1", limit: "500" });
        let status: string | null = null, statusEm: string | null = null, paradaEm: string | null = null;
        try { const [st] = await graph(v.campanhaId, token, { fields: "effective_status,updated_time,stop_time" }); status = (st?.effective_status as string) || null; statusEm = (st?.updated_time as string) || null; paradaEm = (st?.stop_time as string) || null; } catch (_) { /* sem status nesta rodada */ }
        const dados = {
          vinculo: v,
          moeda: total.account_currency || null,
          investido: +(total.spend as string) || 0,
          impressoes: +(total.impressions as string) || 0,
          cliques: +(total.clicks as string) || 0,
          alcance: +(total.reach as string) || 0,
          leads: leadsDe(total.actions as never, acaoV),
          engajamentos: acaoDe(total.actions as never, "post_engagement"),
          cliquesLink: acaoDe(total.actions as never, "link_click"),
          visitas: acaoDe(total.actions as never, "landing_page_view"),
          porDia: dias.map((d) => ({ data: d.date_start, investido: +(d.spend as string) || 0, leads: leadsDe(d.actions as never, acaoV), impressoes: +(d.impressions as string) || 0, engajamentos: acaoDe(d.actions as never, "post_engagement"), cliquesLink: acaoDe(d.actions as never, "link_click"), visitas: acaoDe(d.actions as never, "landing_page_view") })),
          status, statusEm, fimMeta: paradaEm,
          fonte: "Meta Graph API",
        };
        await admin.from("resultados_meta").upsert({ campanha_id: c.id, meta_campanha: v.campanhaId, dados, atualizado_em: new Date().toISOString() });
        feito.push({ campanha: c.id, meta: v.campanhaId, ok: true });
      } catch (e) {
        feito.push({ campanha: c.id, meta: v.campanhaId, ok: false, erro: String((e as Error).message || e) });
      }
    }
  }
  // sem campanha específica (agendamento ou botão do Status pontual): atualiza também o retrato das contas
  const fazContas = !apenas && parte !== "vinculos";
  const contas = fazContas ? await retratoContas(admin, token) : [];
  let alertas: unknown = null; if (fazContas) { try { alertas = await alertasBudget(admin); } catch (e) { alertas = { erro: String((e as Error).message || e) }; } }
  let pausas: unknown = null; if (fazContas) { try { pausas = await alertasPausa(admin); } catch (e) { pausas = { erro: String((e as Error).message || e) }; } }
  return json({ resultado: feito, contas, alertas, pausas });
});
