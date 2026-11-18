# Quadra - Bola e Chute: jogo online (2v2 com amigos)

## Como jogar agora (túnel ativo)

Servidor local rodando em `http://127.0.0.1:8083/` e exposto por túnel público:

**URL ativa (Serveo, já validada):**
```
https://40a24d3c0519e091-186-192-97-195.serveousercontent.com
```

Ao abrir, o Serveo pode mostrar um aviso "Continue to Site" — clique nele uma vez.

### Passos para jogar com amigos
1. Abra o link no navegador (celular ou computador).
2. Digite seu nome (fica vazio por padrão; preencha antes de criar/entrar).
3. Clique **CRIAR SALA** → aparece um código de 4 caracteres (ex.: `RTXT`).
4. Compartilhe o link e o código com até 3 amigos (máximo 4 jogadores, 2 por time).
5. Cada amigo abre o link, digita o nome, clica **ENTRAR** e preenche o código.
6. No overlay da sala, cada um pode trocar de time e marcar "Estou pronto".
7. O **host** clica **INICIAR** (exige pelo menos 2 jogadores).
8. Jogue! Use as setas/WASD para mover, **Espaço** para chutar, **E** para ativar o próximo chute (superchute). No celular, use o joystick ao tocar a metade esquerda da tela e os botões de Chute/Poder à direita.

### Regras do superchute
- Ative o poder (E / botão Poder). O jogador escurece.
- Com a bola, chame o chute: ela gruda e você carrega (0,7 s), acelerando progressivamente, na direção da mira.
- Após a carga, dispara com flash branco e auras. A marca de terra (linha marrom contínua) começa no instante do chute e some só no gol.
- Gol de superchute coloca uma **coroa dourada** no autor por 6 s e sobe o nome dele.

## Como subir o túnel Cloudflare (o que você pediu)

O arquivo `./start-online.sh` sobe o servidor e um túnel Cloudflare quick-tunnel na porta 8083:

```bash
cd "/root/jogo de bola"
./start-online.sh
```

Ele imprime algo como:
```
============================================
  Jogo online: https://xxxx.trycloudflare.com
============================================
```

Compartilhe esse link com os amigos. Se der erro `502 Direct Cloudflare connection unavailable`, a rede deste ambiente está bloqueando o quick-tunnel do Cloudflare temporariamente — tente novamente em instantes ou use o túnel Serveo ativo acima (ou `bore.pub`, veja abaixo).

## Fallbacks já validados

Se o Cloudflare não estiver disponível, use um destes (já testados com o jogo completo: lobby, sala, partida, superchute, coroa e sincronização):

- Serveo (HTTPS, aviso "Continue to Site" uma vez):  
  `https://40a24d3c0519e091-186-192-97-195.serveousercontent.com`
- bore.pub (HTTP sem aviso, porta variável): rode `./bore local 8083 --to bore.pub` (binário em `/tmp/opencode/bore`) e use o `http://bore.pub:PORTA` que ele imprimir.

## Arquivos do projeto

| Arquivo | Função |
|---|---|
| `index.html` | Jogo integrado: simulação, lobby online, sala, rede WebSocket, efeitos |
| `sim.js` | Simulação pura (física, times, super, coroa, eventos, snapshot) — usada pelo host e pelos testes |
| `server.js` | Servidor HTTP estático + WebSocket (salas, relay de convidado→host, snapshots→convidados) |
| `test-sim.js` | 10 testes headless da simulação |
| `test-server.js` | 12 testes de protocolo do servidor |
| `start-online.sh` | Sobe servidor + túnel Cloudflare |

## Controles resumidos

- Mover: setas ou WASD (joystick no celular ao tocar a metade esquerda).
- Chute: Espaço ou botão **Chute** (direita da tela). Segurar o botão ativa mira visual.
- Poder/Superchute: **E** ou botão **Poder** (ativa o próximo chute; jogador escurece).
- Tela cheia: botão ⛶ no canto.
- Sair da partida (host): envia `lobby` e volta para a sala; convidado volta ao lobby principal.

## Notas técnicas

- Modelo host no navegador: o host simula a partida a 20 fps e envia quadros; convidados enviam inputs a 60 fps com interpolação de 80 ms.
- Máximo 4 jogadores (2 por time), código de sala de 4 caracteres, auto-balanceamento de times.
- Se o host sair durante a partida, a partida acaba, volta ao lobby e outro jogador é promovido a host.
