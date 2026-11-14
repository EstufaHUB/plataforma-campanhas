// Sincroniza bancos do Notion (entregáveis) para a tabela resultados_notion.
// Lê, em cada campanha da plataforma, a lista dados.notionVinculos = [{db, url, titulo}].
// Precisa do segredo NOTION_TOKEN (integração interna do Notion com acesso de leitura ao banco).
// Chamada pelo agendamento (pg_cron) ou pelo botão "Atualizar" da plataforma.
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.notion.com/v1";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type P = any;
const texto = (arr: P[] | undefined) => (arr || []).map((t: P) => t.plain_text).join("");
// pega a propriedade pelo nome, ignorando maiúsculas, espaços e pontuação ("Obs:" = "obs", "Asset approval " = "asset approval")
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
function prop(props: Record<string, P>, ...nomes: string[]) {
  const mapa: Record<string, P> = {};
  for (const [k, v] of Object.entries(props)) mapa[norm(k)] = v;
  for (const n of nomes) if (mapa[norm(n)]) return mapa[norm(n)];
  return undefined;
}
function valor(p: P) {
  if (!p) return null;
  switch (p.type) {
    case "title": return texto(p.title);
    case "rich_text": return texto(p.rich_text);
    case "status": return p.status?.name ?? null;
    case "select": return p.select?.name ?? null;
    case "multi_select": return (p.multi_select || []).map((o: P) => o.name);
    case "checkbox": return !!p.checkbox;
    case "url": return p.url;
    case "date": return p.date?.start ?? null;
    case "people": return (p.people || []).map((u: P) => u.name || null).filter(Boolean);
    default: return null;
  }
}

async function consultar(db: string, token: string) {
  const itens: P[] = [];
  let cursor: string | undefined;
  do {
    const r = await fetch(`${API}/databases/${db}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || `Notion respondeu ${r.status}`);
    for (const pg of j.results) {
      const pr = pg.properties || {};
      const titulo = Object.values(pr).find((x: P) => x.type === "title");
      itens.push({
        id: pg.id,
        url: pg.url,
        material: valor(titulo),
        status: valor(prop(pr, "Status")),
        topicos: valor(prop(pr, "Topic", "Canal", "Tópico")) || [],
        regiao: valor(prop(pr, "Region", "Região", "País")),
        aprovTexto: valor(prop(pr, "Asset text approval")) || false,
        aprovCopy: valor(prop(pr, "Copy approval")) || false,
        aprovAsset: valor(prop(pr, "Asset approval")) || false,
        responsaveis: valor(prop(pr, "Responsável", "Responsavel", "Owner")) || [],
        link: valor(prop(pr, "Link asset", "Link")),
        obs: valor(prop(pr, "Obs", "Observação", "Observações")),
        data: valor(prop(pr, "Data", "Date", "Prazo")),
        editado: pg.last_edited_time,
      });
    }
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return itens;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = Deno.env.get("NOTION_TOKEN");
  if (!token) return json({ erro: "Falta configurar o segredo NOTION_TOKEN no Supabase." }, 500);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
    for (const v of (c.dados?.notionVinculos || []) as { db: string; url?: string; titulo?: string }[]) {
      try {
        const itens = await consultar(v.db, token);
        await admin.from("resultados_notion").upsert({ campanha_id: c.id, notion_db: v.db, dados: { titulo: v.titulo || null, url: v.url || null, itens, fonte: "Notion API" }, atualizado_em: new Date().toISOString() });
        feito.push({ campanha: c.id, db: v.db, ok: true, itens: itens.length });
      } catch (e) {
        feito.push({ campanha: c.id, db: v.db, ok: false, erro: String((e as Error).message || e) });
      }
    }
  }
  return json({ resultado: feito });
});
