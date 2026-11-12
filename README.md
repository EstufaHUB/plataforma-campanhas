# Gestão de Campanhas

Plataforma de gestão de campanhas (clientes PTx LATAM, PTx EMEA e PTx OEM) com cronograma reverso em dias úteis.

- `app/` — página publicada no GitHub Pages (`index.html` + `config.js` com a chave **pública** do Supabase).
- `supabase/migrations/` — tabelas, perfis de acesso e regras RLS do banco.
- `docs/` — arquitetura e decisões.
- `mockup/` — protótipo original (dados de exemplo no navegador).

## Acesso

Qualquer pessoa pode criar conta, mas ela entra como **Aguardando liberação** e não vê nenhum dado.
Um administrador libera em **Configurações → Usuários e perfis → Acessos ao sistema**:

| Perfil | O que pode |
|---|---|
| Equipe da agência | Ver e editar tudo |
| Administrador | Equipe + liberar acessos |
| Cliente | Ver somente o próprio cliente e as campanhas dele |

As regras ficam no banco (RLS), não na página.
