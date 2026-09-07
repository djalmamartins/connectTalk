# Changelog

## v0.13.1 — Queue Routing & Supervisor Escalation

- Corrige contador permanente de **Na fila**: somente atendimentos `waiting` entram no badge.
- Conversas sem ocorrência passam a aparecer como **Sem atendimento**.
- Distribuição automática passa a aguardar **30 segundos**.
- Roteamento prioriza atendentes online, autorizados e abaixo da capacidade.
- Escolha por menor carga ativa.
- Quando não há atendente operacional disponível, o atendimento é escalado para Supervisor/Admin online autorizado e abaixo da capacidade.
- Se ninguém puder receber, o atendimento permanece na fila.
- Roteador periódico redistribui atendimentos em espera quando a equipe volta a ficar disponível.
- Transferência manual para uma fila reinicia a janela de 30 segundos.
- `.gitignore` protege `data/`, `baileys_auth/`, `.env` e `node_modules/` para versionamento seguro.
