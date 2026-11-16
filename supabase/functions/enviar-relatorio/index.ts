// Envia o relatório do Status pontual (.pptx anexo) por e-mail, pela conta Gmail da agência.
// Segredos: GMAIL_USER (endereço da conta) e GMAIL_APP_PASSWORD (senha de app do Google).
// Só a equipe da agência pode enviar (checado com eh_equipe() usando o login de quem chamou).
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ erro: "Faça login para enviar." }, 401);
    const { data: equipe } = await sb.rpc("eh_equipe");
    if (!equipe) return json({ erro: "Só a equipe da agência pode enviar relatórios." }, 403);

    const user = Deno.env.get("GMAIL_USER"), pass = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!user || !pass) return json({ erro: "Envio de e-mail ainda não configurado (faltam GMAIL_USER e GMAIL_APP_PASSWORD no Supabase)." }, 500);

    const b = await req.json();
    const para: string[] = (Array.isArray(b.para) ? b.para : []).map((x: string) => String(x).trim()).filter(Boolean);
    const cc: string[] = (Array.isArray(b.cc) ? b.cc : []).map((x: string) => String(x).trim()).filter(Boolean);
    if (!para.length) return json({ erro: "Informe ao menos um destinatário." }, 400);
    const ruins = [...para, ...cc].filter((e) => !EMAIL.test(e));
    if (ruins.length) return json({ erro: `E-mail inválido: ${ruins.join(", ")}` }, 400);
    if (para.length + cc.length > 30) return json({ erro: "No máximo 30 destinatários." }, 400);
    if (!b.anexo || typeof b.anexo !== "string") return json({ erro: "Apresentação não recebida." }, 400);
    if (b.anexo.length > 14_000_000) return json({ erro: "Apresentação grande demais para e-mail." }, 400);

    const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
    await t.sendMail({
      from: `"${String(b.remetenteNome || "Estufa").replace(/"/g, "")}" <${user}>`,
      to: para.join(", "),
      cc: cc.length ? cc.join(", ") : undefined,
      replyTo: u.user.email || undefined,
      subject: String(b.assunto || "Status das campanhas").slice(0, 200),
      html: String(b.html || ""),
      attachments: [{ filename: String(b.nomeArquivo || "relatorio.pptx").replace(/[\\/]/g, "-"), content: b.anexo, encoding: "base64",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }],
    });
    return json({ ok: true, enviados: para.length + cc.length });
  } catch (e) {
    return json({ erro: (e as Error).message || String(e) }, 500);
  }
});
