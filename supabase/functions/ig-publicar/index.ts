// Publicação programada no Instagram (Social media da plataforma).
// - {contas:true}  (usuário da equipe): lista as contas do Instagram que o token enxerga, para ligar a cada perfil.
// - {fila:true}    (agendamento a cada 5 min): publica o que está "agendado" e já chegou na hora; acompanha vídeos em processamento.
// Usa o mesmo segredo da sincronização de anúncios (META_ACCESS_TOKEN). Para publicar, o token precisa de
// instagram_basic + instagram_content_publish (+ pages_show_list / pages_read_engagement / business_management).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const GRAPH = "https://graph.facebook.com/v21.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
// deno-lint-ignore no-explicit-any
type P = any;

async function graph(path: string, token: string, params: Record<string, string> = {}, metodo = "GET") {
  const u = new URL(`${GRAPH}/${path}`);
  const corpo = new URLSearchParams({ ...params, access_token: token });
  const r = metodo === "GET" ? await fetch(`${u}?${corpo}`) : await fetch(u, { method: "POST", body: corpo });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.error_user_msg || j.error?.message || `Erro ${r.status} na API do Instagram`);
  return j;
}

const driveId = (u: string) => u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{10,})/)?.[1] || (u.includes("drive.google.com") ? u.match(/[?&]id=([\w-]{10,})/)?.[1] : undefined);

// baixa o arquivo (Drive público ou link direto), converte imagem para JPEG (a API só aceita JPEG) e sobe no Storage público
async function midiaPublica(admin: P, base: string, link: string, i: number, tipoPedido: string) {
  const id = driveId(link);
  const url = id ? `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t` : link;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!r.ok || ct.includes("text/html")) throw new Error(`Não consegui baixar o arquivo ${i + 1}. Confira se ele está compartilhado como “qualquer pessoa com o link”.`);
  let bytes = new Uint8Array(await r.arrayBuffer());
  const video = ct.startsWith("video/") || tipoPedido === "video" || /\.(mp4|mov|m4v)(\?|$)/i.test(link);
  let tipo = "video/mp4", ext = "mp4";
  if (!video) {
    if (!ct.includes("jpeg") && !ct.includes("jpg")) { const img = await Image.decode(bytes); bytes = await img.encodeJPEG(92); }
    tipo = "image/jpeg"; ext = "jpg";
  } else if (ct.includes("quicktime")) { tipo = "video/quicktime"; ext = "mov"; }
  const caminho = `${base}/${i + 1}.${ext}`;
  const up = await admin.storage.from("social-midia").upload(caminho, bytes, { contentType: tipo, upsert: true });
  if (up.error) throw new Error("Não foi possível guardar o arquivo: " + up.error.message);
  return { url: admin.storage.from("social-midia").getPublicUrl(caminho).data.publicUrl, video };
}

// cria os contêineres no Instagram (um por card, no carrossel) e devolve o id do contêiner principal
async function criarConteineres(admin: P, token: string, row: P) {
  const pl = row.payload || {}, ig = row.ig_user_id, fmt = pl.formato || "Estático", links: string[] = (pl.links || []).slice(0, 10), tipos: string[] = pl.tipos || [];
  if (!links.length) throw new Error("O post não tem link do asset.");
  const legenda = String(pl.legenda || "").slice(0, 2200), collab = (pl.collab || []).filter(Boolean);
  const extra: Record<string, string> = collab.length && fmt !== "Stories" ? { collaborators: JSON.stringify(collab) } : {};
  const base = `${row.projeto_id}/${row.id}`;
  if (fmt === "Carrossel" && links.length > 1) {
    const filhos: string[] = [];
    for (const [i, l] of links.entries()) {
      const m = await midiaPublica(admin, base, l, i, tipos[i] || pl.tipoMidia || "");
      const c = await graph(`${ig}/media`, token, m.video ? { is_carousel_item: "true", media_type: "VIDEO", video_url: m.url } : { is_carousel_item: "true", image_url: m.url }, "POST");
      filhos.push(c.id);
    }
    const c = await graph(`${ig}/media`, token, { media_type: "CAROUSEL", children: filhos.join(","), caption: legenda, ...extra }, "POST");
    return { container: c.id, filhos };
  }
  const m = await midiaPublica(admin, base, links[0], 0, tipos[0] || pl.tipoMidia || (fmt === "Reels" ? "video" : ""));
  if (fmt === "Stories") { const c = await graph(`${ig}/media`, token, m.video ? { media_type: "STORIES", video_url: m.url } : { media_type: "STORIES", image_url: m.url }, "POST"); return { container: c.id }; }
  if (fmt === "Reels" || m.video) { const c = await graph(`${ig}/media`, token, { media_type: "REELS", video_url: m.url, caption: legenda, share_to_feed: "true", ...extra }, "POST"); return { container: c.id }; }
  const c = await graph(`${ig}/media`, token, { image_url: m.url, caption: legenda, ...extra }, "POST");
  return { container: c.id };
}

async function avancar(admin: P, token: string, row: P) {
  const salvar = (campos: P) => admin.from("social_publicacoes").update(campos).eq("id", row.id);
  try {
    let estado = row.estado || {};
    if (!estado.container) { estado = await criarConteineres(admin, token, row); await salvar({ estado }); }
    const st = await graph(estado.container, token, { fields: "status_code,status" });
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error("O Instagram recusou o arquivo: " + (st.status || st.status_code));
    if (st.status_code !== "FINISHED") {   // vídeo ainda processando: tenta de novo na próxima rodada (até 1 hora)
      if (Date.now() - Date.parse(row.quando) > 3600e3) throw new Error("O Instagram não terminou de processar o vídeo em 1 hora.");
      await salvar({ estado: { ...estado, processando: st.status_code } }); return { id: row.id, aguardando: true };
    }
    // trava contra post duplicado: se uma rodada anterior caiu depois de mandar publicar, não manda de novo
    if (estado.enviado) throw new Error("A publicação foi enviada, mas não houve confirmação. Confira no Instagram antes de programar de novo.");
    await salvar({ estado: { ...estado, enviado: true } });
    const pub = await graph(`${row.ig_user_id}/media_publish`, token, { creation_id: estado.container }, "POST");
    let permalink = null; try { permalink = (await graph(pub.id, token, { fields: "permalink" })).permalink || null; } catch { /* sem link */ }
    await salvar({ status: "publicado", ig_media_id: pub.id, permalink, publicado_em: new Date().toISOString(), erro: null });
    return { id: row.id, publicado: true };
  } catch (e) {
    await salvar({ status: "erro", erro: String((e as Error).message || e).slice(0, 500) });
    return { id: row.id, erro: String((e as Error).message || e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = Deno.env.get("META_ACCESS_TOKEN");
  if (!token) return json({ erro: "Falta configurar o segredo META_ACCESS_TOKEN no Supabase." }, 500);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let corpo: P = {}; try { corpo = await req.json(); } catch { /* sem corpo */ }
  const { data: u } = await admin.auth.getUser((req.headers.get("Authorization") || "").replace("Bearer ", ""));
  if (u?.user) {
    const { data: p } = await admin.from("perfis").select("papel").eq("id", u.user.id).single();
    if (!p || !["equipe", "admin"].includes(p.papel)) return json({ erro: "Sem permissão." }, 403);
  }

  // contas do Instagram ligadas às páginas que o token enxerga
  if (corpo.contas) {
    if (!u?.user) return json({ erro: "Faça login." }, 401);
    try {
      const contas: P[] = []; let prox: string | null = null;
      do {
        const j: P = prox ? await (await fetch(prox)).json() : await graph("me/accounts", token, { fields: "name,instagram_business_account{id,username,name}", limit: "100" });
        if (j.error) throw new Error(j.error.message);
        for (const pg of j.data || []) if (pg.instagram_business_account) contas.push({ id: pg.instagram_business_account.id, username: pg.instagram_business_account.username, nome: pg.instagram_business_account.name || pg.name, pagina: pg.name });
        prox = j.paging?.next || null;
      } while (prox);
      return json({ contas });
    } catch (e) { return json({ erro: String((e as Error).message || e) }, 500); }
  }

  // fila: o que chegou na hora (e vídeos que ainda estavam processando)
  if (corpo.fila) {
    const agora = new Date().toISOString(), feito: P[] = [];
    const { data: prontos } = await admin.from("social_publicacoes").select("*").eq("status", "agendado").lte("quando", agora).order("quando").limit(5);
    for (const row of prontos || []) {
      const { data: meu } = await admin.from("social_publicacoes").update({ status: "publicando" }).eq("id", row.id).eq("status", "agendado").select("*");   // trava: só uma rodada pega cada post
      if (meu && meu.length) feito.push(await avancar(admin, token, meu[0]));
    }
    const { data: emAndamento } = await admin.from("social_publicacoes").select("*").eq("status", "publicando").lt("atualizado_em", new Date(Date.now() - 60e3).toISOString()).limit(5);
    for (const row of emAndamento || []) feito.push(await avancar(admin, token, row));
    return json({ resultado: feito });
  }
  return json({ erro: "Nada a fazer." }, 400);
});
