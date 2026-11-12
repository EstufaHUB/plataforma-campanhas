# Decisões pendentes (ambiguidades da especificação)

Cada item traz a **recomendação**, que é o que será implementado se não houver objeção.

| # | Ambiguidade | Recomendação |
|---|---|---|
| D1 | Etapas com folga (por exemplo, a trilha da LP tem 12 dias úteis de folga) devem ser agendadas **o mais cedo possível** depois do briefing ou **o mais tarde possível**, perto do lançamento? | ✅ **Decidido: o mais cedo possível**, com a folga visível. |
| D2 | Entre "Enviar LP para programação" e "Receber LPs programadas" não existe prazo para a programação em si. Como está, a LP voltaria programada no dia seguinte. | ✅ **Decidido:** nova etapa "Programação da LP (fornecedor)" com **5 dias úteis** (editável). |
| D3 | "Adaptar assets para as demais línguas" depende só dos ajustes em inglês, mas precisa das traduções validadas. | Depender também de **"Validar traduções"** (FS). Hoje isso não muda nenhuma data, porque a validação tem 3 dias de folga. |
| D4 | Países que usam o idioma-base (Reino Unido em EN, Brasil em PT): quais etapas valem para eles? | Pular tradução e validação de tradução. **Manter** a aprovação local de assets e a revisão da LP. |
| D5 | "Cliente" é responsável por aprovações, mas não aparece como perfil de usuário. | ✅ **Decidido: o cliente tem login.** Novo perfil "Cliente", com acesso restrito (via RLS) às campanhas do próprio cliente, para aprovar conteúdos, assets e layouts. O Atendimento também pode registrar uma aprovação recebida por email, anexando a evidência. |
| D6 | Qual calendário vale para as etapas do Cliente? | O calendário do **país-sede do cliente**. Validadores usam o calendário do país do card. As equipes internas usam o calendário da agência. |
| D7 | Calendário da agência: em que cidade fica a agência (para feriados municipais e estaduais)? | ✅ **Decidido:** apenas os **feriados nacionais do Brasil**. Dias sem expediente são cadastrados manualmente. |
| D8 | A data de lançamento precisa ser dia útil em qual calendário? | Dia útil no **calendário da agência**, porque é a equipe Digital que lança. Se for feriado no país, o sistema mostra um aviso, mas não bloqueia. |
| D9 | "Enviar LP em todas as línguas" e "Enviar assets de todas as línguas" são lotes únicos ou etapas por país? | **Por país.** Quando as datas de lançamento coincidem, as etapas ficam alinhadas de qualquer forma. Quando divergem, cada país segue seu ritmo. |
| D10 | Os tipos "Paralelismo" e "Dependência múltipla" são tipos de dependência separados? | Implementar **FS e SS com defasagem**. Paralelismo e dependência múltipla surgem naturalmente da estrutura do grafo. |
| D11 | Etapa em andamento quando a data de lançamento muda. | O início real fica congelado. O fim previsto só muda se o usuário marcar. |
| D12 | Layout da LP por país ou único? | **Por país.** Cada idioma tem o seu layout. Ele depende do fim da tradução (FS), não da validação. |
