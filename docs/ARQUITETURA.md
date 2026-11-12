# Plataforma de Gestão de Campanhas — Arquitetura e Regras de Negócio

> Documento da etapa "apresentar antes de desenvolver" (seção 18 da especificação).
> Status: **proposta para validação**. Nada foi implementado ainda.
> As decisões pendentes estão em [DECISOES.md](DECISOES.md).

---

## 1. Arquitetura do sistema

```
┌──────────────────────────── Navegador / PWA ────────────────────────────┐
│ React + TypeScript (Vite) · Tailwind · shadcn/ui · TanStack Query       │
│ Recharts · FullCalendar (editorial) · Gantt próprio em SVG              │
│                                                                         │
│  pages/  components/  hooks/  services/  (só leitura/escrita via API)   │
│  packages/schedule-engine  ← usado apenas para PRÉVIA, nunca grava      │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ supabase-js (chave pública "anon" + JWT do usuário)
┌───────────────▼──────────────────── Supabase ───────────────────────────┐
│ Auth (email/senha ou magic link)                                        │
│ PostgreSQL + RLS em todas as tabelas                                    │
│ Edge Functions (Deno):                                                  │
│   • schedule-calculate  → roda o motor e grava a versão do cronograma   │
│   • schedule-simulate   → simula impacto (feriados, nova data)          │
│   • notifications-scan  → gera alertas (agendada por pg_cron, diária)   │
│ Storage: anexos, assets, versões de arquivos                            │
│ Triggers SQL: activity_logs, flag "master desatualizado", dedupe        │
└─────────────────────────────────────────────────────────────────────────┘
GitHub: repositório privado · Actions (lint, typecheck, testes do motor,
        migrations validadas) · deploy do front (Vercel ou Netlify)
```

**Princípios**

- **Motor de cronograma em um único lugar** (`packages/schedule-engine`, TypeScript puro, sem dependências). O mesmo código roda na Edge Function (fonte da verdade, que grava) e no navegador (só para a prévia antes de confirmar). A tabela `campaign_schedule_tasks` **não aceita escrita direta do cliente**: a RLS bloqueia, e só a Edge Function com service role grava.
- **Nada simulado no front:** toda ação persiste no banco. Os testes obrigatórios (seção 17) viram testes automatizados do motor e testes de integração no banco.
- **Monorepo:**

```
apps/web/                  front-end React (PWA)
packages/schedule-engine/  motor de cronograma + testes (Vitest)
packages/shared/           tipos, enums, validações (Zod)
supabase/migrations/       schema SQL versionado + RLS + seeds
supabase/functions/        Edge Functions
docs/                      este documento e as decisões
```

---

## 2. Estrutura de navegação

```
Barra lateral
├── Dashboard
├── Clientes
│   └── Cliente X
│       └── Campanhas (lista com filtros, ordenação e indicador de saúde)
│           └── Campanha Y
│               ├── Visão geral
│               ├── Cronograma        (Lista · Gantt · versões · comparação)
│               ├── Gestão de ações   (Lista · Kanban)
│               ├── Budgets e KPIs
│               ├── Entregáveis       (Por canal · Conteúdos por país · Calendário editorial)
│               └── Mercados e países (Cards · Tabela consolidada)
├── Cronograma anual  (Veiculação · Produção e planejamento)
├── Calendário editorial (consolidado, todas as campanhas)
├── Notificações
└── Configurações
    ├── Usuários e permissões
    ├── Modelos de cronograma (versionados)
    ├── Calendários e feriados (+ simulação de impacto)
    ├── Regiões, países e idiomas (padrões de idioma-base)
    └── Canais
```

Rotas: `/clientes/:clientId/campanhas/:campaignId/:aba`. Cada notificação aponta para uma rota profunda, por exemplo `…/mercados?pais=DE` ou `…/entregaveis/:id`.

---

## 3. Modelo de dados

Convenções: `uuid` como PK, `created_at/created_by/updated_at/updated_by` em todas as tabelas, `archived_at` em vez de exclusão física nas entidades principais.

### Cadastros base
| Tabela | Campos principais |
|---|---|
| `regions` | code (EMEA, LATAM, NA, APAC, OTHER), name, default_base_language |
| `countries` | iso2, name, region_id, default_language, calendar_id |
| `languages` | code (en, pt-BR, es, de…), name |
| `calendars` | name, kind (agency, country, custom), country_id, region, city |
| `holidays` | calendar_id, name, date, country, state, city, scope (nacional, estadual, municipal, agência), active |
| `users` (profile ligado ao `auth.users`) | name, email, area, role (inclui **cliente**), title, status, calendar_id, client_id (só para o perfil cliente) |
| `teams` | name, area |

### Clientes e campanhas
| Tabela | Campos principais |
|---|---|
| `clients` | name, hq_country_id, calendar_id, account_owner_id, archived_at |
| `campaigns` | client_id **NOT NULL**, name, description, objective, launch_date **NOT NULL**, flight_end_date, base_language, account_owner_id, planning_owner_id, planning_url, report_url, planned_budget, notes, status, health, template_version_id, current_schedule_version_id |
| `campaign_channels` | campaign_id, channel |
| `campaign_markets` | campaign_id, country_id, local_language, uses_base_language (bool), launch_date, local_owner_id, validator_id, calendar_id, status, notes |
| `campaign_languages` | campaign_id, language, role (base, target) |

### Modelo de cronograma (versionado)
| Tabela | Campos principais |
|---|---|
| `workflow_templates` | name, is_default |
| `workflow_template_versions` | template_id, version, published_at, **imutável depois de publicada** |
| `workflow_template_tasks` | version_id, key (P1…), name, phase, area, duration_bd, scope (global, per_market), calendar_rule (agency, client, market), skip_if_base_language, is_milestone, sort |
| `workflow_dependencies` | version_id, task_key, predecessor_key, type (FS, SS), lag_bd |

### Cronograma da campanha
| Tabela | Campos principais |
|---|---|
| `campaign_schedule_versions` | campaign_id, version, reason, launch_dates_snapshot, created_by, is_current, applied_at |
| `campaign_schedule_tasks` | schedule_version_id, template_task_key, market_id (null = global), owner_id, duration_bd, planned_start, planned_end, early_start, late_start, slack_bd, is_critical, status, actual_start, actual_end, forecast_start, forecast_end, locked (concluída ou em andamento) |
| `campaign_schedule_task_deps` | task_id, predecessor_task_id, type, lag_bd |

O grafo é **expandido** por mercado: cada etapa `per_market` vira um nó por país. As dependências entre uma etapa global e uma etapa por país ligam o nó global a todos os nós de país.

### Gestão de ações (independente)
| Tabela | Campos principais |
|---|---|
| `campaign_actions` | campaign_id, market_id, name, description, owner_id, start_date, due_date, priority, status, sort, copied_from_template_task_key (só informativo, **sem FK para o cronograma**) |

### Entregáveis, master e traduções
| Tabela | Campos principais |
|---|---|
| `master_contents` | campaign_id, kind (lp, copy, briefing), title, body, base_language, status, approved_at, approved_version, current_version |
| `master_content_versions` | master_content_id, version, body, created_by |
| `translations` | master_content_id, market_id, target_language, body, translator_id, validator_id, start_date, due_date, status, **based_on_master_version**, is_outdated, approved_at |
| `deliverables` | campaign_id, channel, name, format, objective, content_owner_id, design_owner_id, due_date, status_content, status_design, status_final, master_content_id |
| `deliverable_briefings` | deliverable_id, audience, key_message, copy, headline, cta, references, notes, language |
| `deliverable_versions` | deliverable_id, version, file_path / canva_url, notes, created_by |
| `deliverable_markets` | deliverable_version_id, market_id, language: **um mesmo arquivo vinculado a vários países** |
| `deliverable_approvals` | deliverable_id, market_id, stage (content, asset, final), result (approved, rejected, changes_requested), comment, decided_by, decided_at, version_id |
| `editorial_posts` | campaign_id, market_id, date, network, language, format, theme, pillar, objective, caption, visual_brief, owner_id, asset_url, status |

> Observação: a especificação lista `deliverable_translations`. Proponho generalizar para `master_contents` + `translations`, para que textos de LP, copies e briefings usem o mesmo mecanismo de master e versão local.

### Budget, KPIs e transversais
| Tabela | Campos principais |
|---|---|
| `campaign_budgets` | campaign_id, channel, market_id, platform, period_start, period_end, planned, spent, currency |
| `budget_changes` | budget_id, field, old, new, justification, changed_by |
| `campaign_kpis` | campaign_id, channel, market_id, metric, unit, period, target, actual |
| `comments` | entity_type, entity_id, body, author_id |
| `attachments` | entity_type, entity_id, storage_path, url |
| `notifications` | user_id, type, entity_type, entity_id, link, **dedupe_key UNIQUE**, read_at |
| `activity_logs` | entity_type, entity_id, action, diff (jsonb), actor_id, at (preenchido por trigger) |

---

## 4. Motor de cronograma reverso

### 4.1 Funções de calendário
```
isBusinessDay(d, cal)          seg–sex e fora dos feriados ativos de cal
nextBD(d, cal) / prevBD(d, cal)
endFromStart(start, n, cal)    o início conta como o 1º dia
startFromEnd(end, n, cal)
countBD(a, b, cal)
```
Cada nó usa o calendário da sua `calendar_rule`:
- **agency**: atividades internas.
- **client**: calendário do país-sede do cliente.
- **market**: calendário do país do card (validadores locais).

### 4.2 Algoritmo
1. **Validação:** cada data de lançamento precisa ser dia útil (ver D8). Se não for, o sistema **bloqueia e pede outra data**.
2. **Expansão do grafo:** etapas globais aparecem uma vez. Etapas por mercado geram um nó por país. Em países que usam o idioma-base, as etapas de tradução são puladas e as dependências "atravessam" o nó pulado.
3. **Passagem reversa (ALAP):** cada etapa terminal "Programar e lançar" do país *m* termina em `launch_date(m)`. Para cada nó, em ordem topológica inversa:
   - limite de fim = mín. de `prevBD(LS(sucessor))` para sucessores **FS**
   - limite de início = mín. de `LS(sucessor)` para sucessores **SS**
   - `LS = mín(startFromEnd(limite de fim), limite de início)`; `LF = endFromStart(LS)`

   Uma etapa global com sucessores em vários países recebe automaticamente o **mais restritivo** (o mercado que exige início mais cedo).
4. **Data de início da campanha** = `LS("Recebimento do briefing")`.
5. **Passagem direta (ASAP)** a partir dessa data: `ES = máx(nextBD(EF(pred)) se FS; ES(pred) se SS)`.
6. **Folga** = `countBD(ES, LS)`. **Caminho crítico** = nós com folga 0.
7. **Datas planejadas** = ES/EF (agendamento o mais cedo possível, conforme D1).
8. **Inviabilidade:** se algum nó não iniciado tiver `LS < hoje` (ou `< data real` da predecessora), o cronograma fica **inviável**. O sistema mostra quantos dias úteis faltam e quais etapas e países estão afetados.

Tipos de dependência: a especificação cita quatro (fim-para-início, início simultâneo, paralelismo e dependência múltipla), mas no motor eles se reduzem a **FS e SS (com defasagem opcional)**. "Paralelismo" significa simplesmente que duas etapas compartilham a mesma predecessora. "Dependência múltipla" significa que uma etapa tem várias predecessoras, e o motor sempre espera todas.

### 4.3 Exemplo real (calculado por um protótipo do algoritmo)
Lançamento em **ter 15/06/2027**, um mercado, feriado de Corpus Christi em 27/05/2027:

| Etapa | Dur. | Início | Fim | Folga |
|---|---:|---|---|---:|
| Recebimento do briefing | 1 | **sex 07/05** | 07/05 | 0 |
| Criar conceito | 2 | seg 10/05 | ter 11/05 | 0 |
| Aprovar conceito | 1 | qua 12/05 | 12/05 | 0 |
| Criar KV ‖ Criar conteúdo LP | 3 ‖ 2 | qui 13/05 | seg 17/05 ‖ sex 14/05 | 7 |
| Criar textos master | 3 | qui 13/05 | seg 17/05 | 0 |
| Validar textos master | 2 | ter 18/05 | qua 19/05 | 0 |
| Traduzir LP → Validar LP (mesmo dia, SS) | 1 → 3 | ter 18/05 | ter 18/05 → qui 20/05 | 7 |
| Criar assets master + Canva | 4 | qui 20/05 | ter 25/05 | 0 |
| Aprovar assets master | 2 | qua 26/05 | **sex 28/05** (pula o feriado) | 0 |
| Ajustar → Adaptar → Enviar → Aprovar → Ajustar → Aprovação final | 1·2·1·3·1·2 | seg 31/05 | sex 11/06 | 0 |
| Programação da LP (fornecedor) | 5 | seg 24/05 | seg 31/05 (pula o feriado) | 7 |
| Receber LPs → Revisar LPs | 1 · 1 | ter 01/06 | qua 02/06 | 7 |
| **Programar e lançar** | 2 | seg 14/06 | **ter 15/06** | 0 |

**Resultado:** são necessários **27 dias úteis**. O caminho crítico passa por **assets**, não pela LP. Mesmo com os 5 dias de programação da LP pelo fornecedor (D2), a trilha da LP tem 7 dias úteis de folga.

---

## 5. Mapeamento das dependências (modelo padrão v1)

`FS` = fim-para-início · `SS` = início simultâneo · **G** = global · **M** = por mercado

| Chave | Etapa | Área | Dur. | Escopo | Predecessoras |
|---|---|---|---:|:-:|---|
| P1 | Recebimento do briefing | Atendimento | 1 | G | — |
| P2 | Criar conceito estratégico | Planejamento | 2 | G | P1 FS |
| P3 | Aprovar conceito com o cliente | Cliente | 1 | G | P2 FS |
| P4 | Criar KV | Design | 3 | G | P3 FS |
| P5 | Criar conteúdo da LP (master) | Conteúdo | 2 | G | P3 FS |
| P6 | Aprovar conteúdo da LP | Cliente | 1 | G | P5 FS |
| P7 | Aprovar KV | Cliente | 1 | G | P4 FS |
| P8 | Traduzir conteúdo da LP | Conteúdo | 1 | M¹ | P6 FS |
| P10 | Validar conteúdo traduzido da LP | Validadores | 3 | M¹ | P8 **SS** |
| P9 | Criar layout da LP | Design | 1 | M | P8 FS + P7 FS |
| P11 | Validar layout da LP | Cliente | 1 | M | P9 FS |
| P12 | Enviar LP para programação | Atendimento | 1 | M | P11 FS + P10 FS |
| P13 | Programação da LP (fornecedor) | Externo | 5 | M | P12 FS |
| L1 | Receber LPs programadas | Atendimento | 1 | M | P13 FS |
| L2 | Revisar LPs | Design + Conteúdo | 1 | M | L1 FS |
| A1 | Criar textos master (idioma-base) | Conteúdo | 3 | G | P3 FS |
| A2 | Validar textos master | Cliente | 2 | G | A1 FS |
| A3 | Traduzir conteúdos | Conteúdo | 1 | M¹ | A2 FS |
| A4 | Criar assets master + Canva template | Design | 4 | G | A2 FS (paralelo a A3) |
| A5 | Validar traduções | Validadores | 3 | M¹ | A3 FS |
| A6 | Aprovar assets master | Cliente | 2 | G | A4 FS |
| A7 | Ajustar assets master | Design | 1 | G | A6 FS |
| A8 | Adaptar assets para o idioma | Design | 2 | M | A7 FS **+ A5 FS** (ver D3) |
| A9 | Enviar assets para aprovação | Atendimento | 1 | M | A8 FS |
| A10 | Aprovar assets locais | Validadores | 3 | M | A9 FS |
| A11 | Ajustar assets locais | Design | 1 | M | A10 FS |
| A12 | Aprovação final dos assets | Validadores | 2 | M | A11 FS |
| L3 | Programar campanha e lançar | Digital | 2 | M | L2 FS + A12 FS, **termina no lançamento** |

¹ Pulada em países que usam o idioma-base (por exemplo, Reino Unido em campanha EN e Brasil em campanha PT).

Os nomes "em inglês" do modelo original viram "no idioma-base", porque em LATAM o master é em português.

---

## 6. Dias úteis e feriados

- Dia útil é de segunda a sexta, desde que a data não esteja entre os feriados **ativos** do calendário aplicável.
- O dia de início conta como o 1º dia: 3 dias a partir de segunda terminam na quarta. Se a segunda for feriado, a etapa vai de terça a quinta.
- Nenhum início ou fim cai em dia não útil, por construção, já que todas as datas saem de `nextBD`/`prevBD`.
- Calendários: um da agência (padrão), um por país e calendários personalizados. Um calendário de país herda os feriados nacionais e permite adicionar os estaduais e municipais.
- **Simulação de impacto:** ao criar, editar ou desativar um feriado, a Edge Function `schedule-simulate` recalcula em memória as campanhas ativas afetadas. Ela mostra a lista "etapa X de campanha Y muda de A para B" e só grava depois da confirmação, gerando uma nova versão do cronograma.

### Alteração de datas (versionamento)
1. Uma nova data de lançamento (ou um novo feriado) gera uma **versão candidata**.
2. A tela compara a versão atual com a candidata: as etapas alteradas ficam destacadas e o sistema mostra o delta em dias úteis.
3. **Concluídas:** as datas reais ficam congeladas e nunca mudam.
4. **Em andamento:** o início real fica congelado. O fim só muda se o usuário escolher.
5. **Futuras:** são recalculadas.
6. Ao confirmar, a versão anterior fica no histórico (`is_current = false`) e o log registra quem confirmou e por quê.

---

## 7. Estrutura multipaís e multilíngue

- Cada `campaign_market` é um card, com status calculados a partir das traduções, entregáveis e aprovações daquele país, **nunca misturados com os de outro país**.
- **Master único:** existe um `master_contents` por conteúdo. Os cards exibem a coluna do idioma-base por referência (join), e não por cópia.
- **Tradução:** há um registro por país (`translations`), com status, responsável e histórico próprios. Enquanto o master não estiver aprovado, o status fica travado em "Aguardando aprovação do master" (regra garantida por **constraint e trigger no banco**, não só na interface).
- **Master alterado depois de aprovado:** um trigger marca `is_outdated = true` em toda tradução com `based_on_master_version < versão atual` e notifica os responsáveis. **Nada é retraduzido automaticamente.**
- **Assets compartilhados:** uma `deliverable_version` pode ser vinculada a vários mercados (`deliverable_markets`). A aprovação continua sendo **por mercado** (`deliverable_approvals.market_id`).
- **Datas diferentes por país:** o motor já trata isso na expansão do grafo. O risco é avaliado por país: um país inviável recebe alerta próprio e não altera os demais.

---

## 8. Proposta de interface

- **Visual:** fundo `#F7F8F7`, superfícies brancas, bordas `#E4E7E5`, destaque **verde petróleo `#0F5257`**. Tipografia Inter. Ícones Lucide (os mesmos do shadcn).
- **Status por cor:**
  - cinza = não iniciado
  - azul = em andamento
  - âmbar = aguardando
  - violeta = em revisão
  - verde = concluído
  - vermelho = atrasado ou bloqueado
- **Saúde do cronograma:** 🟢 no prazo · 🟡 folga crítica (até 2 dias úteis) · 🔴 atrasado ou inviável.
- **Gantt:** componente próprio em SVG. As bibliotecas prontas com caminho crítico costumam ter licença comercial ou GPL. O componente mostra:
  - linhas agrupadas por fase, com etapas por país recolhíveis sob a etapa global
  - barras cheias para etapas globais e listradas para etapas por país
  - contorno vermelho no caminho crítico e folga em cinza claro
  - marcos em losango
  - setas de dependência
- **Lista e Kanban:** tabela densa com filtros fixos no topo. Kanban com status como colunas.
- **Estados de tela:** carregamento (skeleton), vazio (com ação principal), erro (com "tentar de novo") e sucesso (toast).
- **Responsivo:** a barra lateral vira um menu inferior no celular. O Gantt no celular vira uma lista com uma minibarra por linha.

---

## 9. Plano de fases (resumo)

Segue a seção 18. A **Fase 2 (motor)** começa pelos testes: os 24 cenários da seção 17 que envolvem datas viram testes automatizados no `packages/schedule-engine` **antes** de qualquer tela de cronograma. Ao final de cada fase haverá um relatório com o que foi implementado, o que ficou pendente e quais testes rodaram.
