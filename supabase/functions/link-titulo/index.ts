// Busca o título de uma página para transformar um link colado numa menção (como no Notion).
// POST {u: "https://..."} com a sessão da plataforma. Só lê páginas públicas: um Google Docs/Slides privado
// cai no login do Google e volta sem título (a plataforma então mostra o tipo do arquivo).
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const desfaz = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const SUFIXOS = / [-–|] (Google (Slides|Docs|Sheets|Drive|Apresentações|Documentos|Planilhas)|Canva|Figma|YouTube)$/i;
const privado = (h: string) => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/.test(h) || h.endsWith(".local") || h.endsWith(".internal");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { u } = await req.json().catch(() => ({}));
    let url: URL; try { url = new URL(String(u || "")); } catch { return json({ titulo: "" }); }
    if (url.protocol !== "https:" || privado(url.hostname)) return json({ titulo: "" });
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url.href, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept-Language": "en,pt" }, redirect: "follow", signal: ctl.signal }).finally(() => clearTimeout(t));
    const fim = new URL(r.url || url.href);
    if (!r.ok || /accounts\.google\.com|ServiceLogin|signin/i.test(fim.href) || !(r.headers.get("content-type") || "").includes("html")) { await r.body?.cancel(); return json({ titulo: "" }); }
    // lê só o começo da página (o título fica no <head>)
    const leitor = r.body!.getReader(); let html = "", n = 0;
    while (n < 400_000) { const { value, done } = await leitor.read(); if (done) break; html += new TextDecoder().decode(value); n += value.length; if (/<\/head>/i.test(html)) break; }
    leitor.cancel().catch(() => {});
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title/i)?.[1];
    const tt = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    const titulo = desfaz(og || tt || "").replace(SUFIXOS, "").slice(0, 200);
    return json({ titulo: /^(sign in|fazer login|google (slides|docs|sheets|drive))$/i.test(titulo) ? "" : titulo });
  } catch {
    return json({ titulo: "" });
  }
});
