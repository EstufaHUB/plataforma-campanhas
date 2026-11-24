// Entrega um vídeo do Google Drive (compartilhado como "qualquer pessoa com o link") para o player da tela cheia do Social media.
// O Drive recusa o vídeo quando o pedido vem direto do navegador de outro site; vindo daqui, ele libera.
// GET ?id=<id do arquivo>&t=<token da sessão>. Repassa o pedaço pedido (Range), em partes de até 8 MB, para o player poder avançar e voltar.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "content-range, content-length, accept-ranges",
};
const PARTE = 8 * 1024 * 1024;
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const validos = new Map<string, number>();   // token -> validade (ms), para não consultar o login a cada pedaço do vídeo

async function logado(t: string) {
  if (!t) return false;
  const v = validos.get(t);
  if (v && v > Date.now()) return true;
  const { data } = await admin.auth.getUser(t);
  if (!data?.user) return false;
  validos.set(t, Date.now() + 10 * 60e3);
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const u = new URL(req.url), id = u.searchParams.get("id") || "";
  if (!/^[\w-]{10,}$/.test(id)) return new Response("id inválido", { status: 400, headers: cors });
  if (!(await logado(u.searchParams.get("t") || ""))) return new Response("Faça login.", { status: 401, headers: cors });

  // ?tipo=1: só diz se o arquivo é imagem ou vídeo (para a prévia do Stories escolher o player)
  if (u.searchParams.get("tipo")) {
    const r = await fetch(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, { headers: { "User-Agent": "Mozilla/5.0", Range: "bytes=0-0" } });
    const ct = (r.headers.get("content-type") || "").toLowerCase(); await r.body?.cancel();
    const tipo = !r.ok || ct.includes("text/html") ? "" : ct.startsWith("video/") ? "video" : ct.startsWith("image/") ? "image" : "";
    return new Response(JSON.stringify({ tipo }), { headers: { ...cors, "Content-Type": "application/json" } });
  }
  // pedaço pedido pelo player; sem fim (ou grande demais) vira uma parte de até 8 MB
  const m = (req.headers.get("range") || "").match(/bytes=(\d+)-(\d*)/);
  const ini = m ? +m[1] : 0, fim = m && m[2] ? Math.min(+m[2], ini + PARTE - 1) : ini + PARTE - 1;
  const r = await fetch(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, {
    headers: { "User-Agent": "Mozilla/5.0", Range: `bytes=${ini}-${fim}` },
  });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok || ct.includes("text/html")) { await r.body?.cancel(); return new Response("O vídeo não está compartilhado como “qualquer pessoa com o link”.", { status: 403, headers: cors }); }
  const h = new Headers(cors);
  h.set("Content-Type", ct.startsWith("video/") ? ct : "video/mp4");
  h.set("Accept-Ranges", "bytes");
  h.set("Cache-Control", "private, max-age=3600");
  for (const k of ["content-range", "content-length"]) { const v = r.headers.get(k); if (v) h.set(k, v); }
  return new Response(r.body, { status: r.status === 206 ? 206 : 200, headers: h });
});
