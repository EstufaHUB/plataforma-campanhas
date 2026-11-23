// Lista os arquivos de uma pasta do Google Drive compartilhada como "qualquer pessoa com o link".
// Usada pelo Social media: o time cola o link da pasta do carrossel e a plataforma monta um card por arquivo.
// Não precisa de chave nem de login no Google: lê a visualização pública da pasta (embeddedfolderview).
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const desfaz = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const tipoDe = (nome: string) => /\.(mp4|mov|m4v|webm|avi)$/i.test(nome) ? "video" : /\.(png|jpe?g|gif|webp|heic|avif)$/i.test(nome) ? "image" : "outro";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { pasta } = await req.json().catch(() => ({}));
    const id = String(pasta || "").match(/folders\/([\w-]{10,})/)?.[1] || String(pasta || "").match(/^[\w-]{10,}$/)?.[0];
    if (!id) return json({ erro: "Link de pasta do Drive inválido." }, 400);
    const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${id}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return json({ erro: "Não foi possível abrir a pasta. Confira se ela está compartilhada como “qualquer pessoa com o link”." }, 400);
    const html = await r.text();
    const itens = html.split('class="flip-entry"').slice(1).map((p) => {
      const href = p.match(/href="([^"]+)"/)?.[1] || "", nome = desfaz(p.match(/flip-entry-title">([^<]*)/)?.[1] || "");
      const arq = href.match(/file\/d\/([\w-]+)/)?.[1];
      return arq ? { id: arq, nome, tipo: tipoDe(nome), link: `https://drive.google.com/file/d/${arq}/view` } : null;
    }).filter((x) => x && x.tipo !== "outro") as { id: string; nome: string; tipo: string; link: string }[];
    if (!itens.length && !/flip-entry/.test(html)) return json({ erro: "A pasta não está pública. Compartilhe como “qualquer pessoa com o link” e tente de novo." }, 400);
    itens.sort((a, b) => a.nome.localeCompare(b.nome, "pt", { numeric: true, sensitivity: "base" }));
    return json({ arquivos: itens });
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
