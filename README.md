# ConnectTalk v0.14.0 — Visual Refinement & Transfer Center

Esta versão refina a interface do atendimento e corrige a fila fantasma causada por versões antigas que criavam um atendimento apenas ao abrir uma conversa.

## Principais mudanças

- Identidade visual atualizada com a logo oficial enviada da Connect Condomínios.
- Layout refinado: cards mais leves, hierarquia visual melhor, cabeçalho do chat simplificado e barra operacional compacta.
- Novo modal **Trocar atendente**, inspirado na referência aprovada:
  - transferir para grupo/fila;
  - transferir diretamente para atendente;
  - atendentes offline, ausentes, sem acesso à fila ou lotados ficam indisponíveis;
  - motivo da transferência com até 500 caracteres;
  - opção de manter histórico visível.
- Alerta em tempo real para o atendente que recebe uma conversa transferida, com botão **Abrir conversa**.
- Evento de transferência passa a registrar motivo e destino.
- Correção estrutural da **fila fantasma**:
  - abrir/consultar conversa não cria mais atendimento;
  - GET de atendimento e workspace passam a ser somente leitura;
  - ocorrências antigas criadas apenas por abertura manual são limpas na inicialização;
  - contador “Na fila” considera apenas ocorrências realmente existentes com status `waiting`.
- Mantida a distribuição automática em 30 segundos da v0.13.1.
- Contact Core, presença real, supervisão e safe routing preservados.

## Atualização sem perder dados

Preserve sempre:

- `data/`
- `baileys_auth/`
- `.env` (se existir)

Copie `server.js`, `db.js`, `package.json`, `package-lock.json`, `public/` e `scripts/` sobre o projeto atual.

## Testes recomendados

1. Abrir uma conversa antiga sem nova mensagem: ela não deve aparecer em **Na fila** apenas por ter sido aberta.
2. Receber mensagem nova: atendimento deve entrar na fila e aguardar aproximadamente 30 segundos antes da distribuição automática.
3. Abrir **Transferir**: o modal deve seguir o novo modelo visual.
4. Transferir para atendente online: o destinatário deve receber um alerta em tempo real.
5. Tentar transferir para offline/ausente/lotado: opção deve ficar indisponível e o servidor continua validando a regra.
6. Confirmar que contato, histórico, etiquetas, notas e mensagens permanecem após a transferência.

## Versão

`v0.14.0`
