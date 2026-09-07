# ConnectTalk v0.13.1 — Queue Routing & Supervisor Escalation

Melhorias desta versão:

- Contador **Na fila** considera somente atendimentos realmente em `waiting`. Conversas sem atendimento não inflam mais o badge.
- Conversas sem ocorrência aparecem como **Sem atendimento**, em vez de **Na fila**.
- Distribuição automática aguarda **30 segundos** antes de atribuir.
- Primeiro tenta atendentes (`agent`) online, autorizados na fila e abaixo da capacidade.
- Escolhe o menor carregamento.
- Se não houver atendente operacional disponível (incluindo sobrecarga), escala para Supervisor/Admin online autorizado e abaixo da capacidade.
- Se ninguém puder receber, permanece na fila sem transferência indevida.
- O roteador roda continuamente e também tenta filas antigas quando alguém volta a ficar online.
- Transferir manualmente para uma fila reinicia a janela de 30 segundos.
- Supervisão continua em tempo real.

## Regra de roteamento

`mensagem -> fila -> 30s -> atendente disponível -> supervisor/admin -> permanece na fila`

Dados existentes em `data/` e a sessão `baileys_auth/` devem ser preservados durante a atualização.
