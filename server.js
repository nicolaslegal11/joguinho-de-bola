/* ============================================================
   QUADRA - Servidor de salas + relay WebSocket
   - Serve o jogo (HTML/JS)
   - Gerencia salas (código, times, pronto)
   - Repassa inputs dos convidados para o host
   - Repassa snapshots do host para os convidados

   O servidor NÃO roda a física: o host é o navegador do criador
   da sala (modelo host-autoritativo).

   Rodar: node server.js
   Variáveis: PORT (padrão 8083), HOST (padrão 127.0.0.1)
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8083);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;

const MAX_PLAYERS = 4;
const TEAM_SIZE = 2;
const MAX_MSG_PER_SEC = 400;
const MAX_PAYLOAD = 32 * 1024;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// ============================================================
//  HTTP (estáticos)
// ============================================================
const server = http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/health') {
        const body = JSON.stringify({
            ok: true,
            rooms: rooms.size,
            clients: clients.size,
            uptime: Math.round(process.uptime()),
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
        return;
    }

    if (pathname === '/') pathname = '/index.html';

    // Só arquivos da raiz, sem subir diretórios
    const safe = path.normalize(pathname).replace(/^([.]{2}[\/\\])+/, '');
    const file = path.join(ROOT, safe);

    if (!file.startsWith(ROOT)) {
        res.writeHead(403); res.end('403'); return;
    }

    const ext = path.extname(file).toLowerCase();
    if (!MIME[ext]) {
        res.writeHead(404); res.end('404'); return;
    }

    fs.readFile(file, function (err, data) {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Arquivo não encontrado');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[ext],
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
        });
        res.end(data);
    });
});

// ============================================================
//  ESTADO GLOBAL
// ============================================================
const clients = new Map(); // id -> client
const rooms = new Map();   // code -> room

let nextClientId = 1;
const startedAt = Date.now();

function makeId() {
    return 'c' + (nextClientId++);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRoomCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
        let code = '';
        for (let i = 0; i < 4; i++) {
            code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        }
        if (!rooms.has(code)) return code;
    }
    return 'R' + Date.now().toString(36).toUpperCase().slice(-3);
}

function cleanName(name) {
    let n = String(name == null ? '' : name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
    return n || 'Jogador';
}

function cleanTeam(t) {
    const n = Number(t);
    return n === 1 ? 1 : 0;
}

// ============================================================
//  SALAS
// ============================================================
function createRoom(hostClient) {
    const room = {
        code: makeRoomCode(),
        hostId: hostClient.id,
        clients: new Set([hostClient.id]),
        state: 'lobby', // lobby | playing
        roster: null,
        createdAt: Date.now(),
        lastActivity: Date.now(),
    };
    rooms.set(room.code, room);
    hostClient.roomCode = room.code;
    hostClient.ready = true;
    hostClient.team = 0;
    return room;
}

function getRoom(client) {
    if (!client.roomCode) return null;
    return rooms.get(client.roomCode) || null;
}

function roomPlayers(room) {
    const list = [];
    for (const id of room.clients) {
        const c = clients.get(id);
        if (!c) continue;
        list.push({
            id: c.id,
            name: c.name,
            team: c.team,
            ready: c.ready,
            ping: c.ping,
            host: c.id === room.hostId,
        });
    }
    // Host primeiro, depois por time/nome
    list.sort(function (a, b) {
        if (a.host !== b.host) return a.host ? -1 : 1;
        if (a.team !== b.team) return a.team - b.team;
        return a.name.localeCompare(b.name);
    });
    return list;
}

function teamCount(room, team) {
    let n = 0;
    for (const id of room.clients) {
        const c = clients.get(id);
        if (c && c.team === team) n++;
    }
    return n;
}

function autoTeam(room) {
    return teamCount(room, 0) <= teamCount(room, 1) ? 0 : 1;
}

function send(client, msg) {
    if (!client || !client.ws || client.ws.readyState !== 1) return;
    try {
        client.ws.send(JSON.stringify(msg));
    } catch (err) { /* conexão caiu */ }
}

function broadcast(room, msg, exceptId) {
    for (const id of room.clients) {
        if (id === exceptId) continue;
        send(clients.get(id), msg);
    }
}

function sendRoom(room) {
    const base = {
        t: 'room',
        room: {
            code: room.code,
            hostId: room.hostId,
            state: room.state,
            maxPlayers: MAX_PLAYERS,
            teamSize: TEAM_SIZE,
            players: roomPlayers(room),
        },
    };
    for (const id of room.clients) {
        const c = clients.get(id);
        if (!c) continue;
        send(c, Object.assign({ you: c.id }, base));
    }
}

function leaveRoom(client, reason) {
    const room = getRoom(client);
    if (!room) return;

    const wasHost = room.hostId === client.id;

    room.clients.delete(client.id);
    client.roomCode = null;
    client.ready = false;

    if (room.clients.size === 0) {
        rooms.delete(room.code);
        return;
    }

    if (wasHost) {
        // Escolhe o próximo host
        const nextId = room.clients.values().next().value;
        room.hostId = nextId;

        if (room.state === 'playing') {
            room.state = 'lobby';
            room.roster = null;
            broadcast(room, { t: 'matchEnded', reason: 'hostLeft' });
        }
        broadcast(room, { t: 'hostChanged', hostId: nextId });
    }

    if (room.state === 'playing' && !wasHost) {
        broadcast(room, { t: 'peerLeft', id: client.id }, client.id);
    }

    sendRoom(room);
}

// ============================================================
//  WEBSOCKET
// ============================================================
const wss = new WebSocketServer({ server: server, maxPayload: MAX_PAYLOAD });

wss.on('connection', function (ws, req) {
    const client = {
        id: makeId(),
        ws: ws,
        name: 'Jogador',
        roomCode: null,
        team: 0,
        ready: false,
        ping: 0,
        alive: true,
        lastPingSent: 0,
        msgWindowStart: Date.now(),
        msgWindowCount: 0,
    };
    clients.set(client.id, client);

    send(client, { t: 'welcome', id: client.id, maxPlayers: MAX_PLAYERS });
    console.log('[+] ' + client.id + ' conectou (' + clients.size + ' online)');

    ws.on('pong', function () {
        client.alive = true;
        if (client.lastPingSent) {
            client.ping = Date.now() - client.lastPingSent;
            client.lastPingSent = 0;
        }
    });

    ws.on('message', function (raw) {
        let msg;
        try {
            msg = JSON.parse(String(raw));
        } catch (err) {
            send(client, { t: 'error', code: 'bad_json', msg: 'Mensagem inválida' });
            return;
        }
        if (!msg || typeof msg !== 'object') return;

        // Rate limit simples por janela de 1s
        const now = Date.now();
        if (now - client.msgWindowStart > 1000) {
            client.msgWindowStart = now;
            client.msgWindowCount = 0;
        }
        client.msgWindowCount++;
        if (client.msgWindowCount > MAX_MSG_PER_SEC) {
            send(client, { t: 'error', code: 'rate', msg: 'Muitas mensagens' });
            ws.close();
            return;
        }

        handleMessage(client, msg);
    });

    ws.on('close', function () {
        leaveRoom(client, 'disconnect');
        clients.delete(client.id);
        console.log('[-] ' + client.id + ' saiu (' + clients.size + ' online)');
    });

    ws.on('error', function () { /* ignorado */ });
});

function handleMessage(client, msg) {
    const type = msg.t;

    // ----------------------------------------------------
    //  Entrar / criar sala
    // ----------------------------------------------------
    if (type === 'create') {
        if (getRoom(client)) leaveRoom(client, 'create');
        client.name = cleanName(msg.name);
        client.ping = 0;
        const room = createRoom(client);
        send(client, { t: 'created', code: room.code });
        sendRoom(room);
        return;
    }

    if (type === 'join') {
        const code = String(msg.code || '').toUpperCase().slice(0, 6);
        const room = rooms.get(code);
        if (!room) {
            send(client, { t: 'error', code: 'room_not_found', msg: 'Sala não encontrada' });
            return;
        }
        if (room.state === 'playing') {
            send(client, { t: 'error', code: 'match_running', msg: 'Partida em andamento' });
            return;
        }
        if (room.clients.size >= MAX_PLAYERS) {
            send(client, { t: 'error', code: 'room_full', msg: 'Sala cheia' });
            return;
        }

        if (getRoom(client) && getRoom(client).code !== code) {
            leaveRoom(client, 'join');
        }

        client.name = cleanName(msg.name);
        client.team = (msg.team === 0 || msg.team === 1) && teamCount(room, msg.team) < TEAM_SIZE
            ? msg.team
            : autoTeam(room);
        client.ready = false;
        client.roomCode = room.code;
        room.clients.add(client.id);
        room.lastActivity = Date.now();

        send(client, { t: 'joined', code: room.code });
        sendRoom(room);
        return;
    }

    const room = getRoom(client);
    if (!room) {
        if (type !== 'ping') {
            send(client, { t: 'error', code: 'no_room', msg: 'Você não está em uma sala' });
        }
    }

    // ----------------------------------------------------
    //  Ping / keepalive
    // ----------------------------------------------------
    if (type === 'ping') {
        send(client, { t: 'pong', ts: msg.ts, rtt: client.ping });
        return;
    }

    if (!room) return;

    // ----------------------------------------------------
    //  Nome / time / pronto
    // ----------------------------------------------------
    if (type === 'name') {
        client.name = cleanName(msg.name);
        sendRoom(room);
        return;
    }

    if (type === 'team') {
        if (room.state === 'playing') {
            send(client, { t: 'error', code: 'match_running', msg: 'Partida em andamento' });
            return;
        }
        const team = cleanTeam(msg.team);
        if (team !== client.team && teamCount(room, team) >= TEAM_SIZE) {
            send(client, { t: 'error', code: 'team_full', msg: 'Time cheio' });
            return;
        }
        client.team = team;
        sendRoom(room);
        return;
    }

    if (type === 'ready') {
        if (room.state === 'playing') return;
        client.ready = client.id === room.hostId ? true : !!msg.ready;
        sendRoom(room);
        return;
    }

    // ----------------------------------------------------
    //  Início da partida (somente host)
    // ----------------------------------------------------
    if (type === 'start') {
        if (client.id !== room.hostId) {
            send(client, { t: 'error', code: 'not_host', msg: 'Só o host pode iniciar' });
            return;
        }
        if (room.state === 'playing') return;
        if (room.clients.size === 0) return;

        const roster = roomPlayers(room).map(function (p) {
            return { id: p.id, name: p.name, team: p.team };
        });

        // Garante pelo menos 1 jogador em cada time quando possível
        room.state = 'playing';
        room.roster = roster;
        room.lastActivity = Date.now();

        broadcast(room, {
            t: 'start',
            roster: roster,
            maxScore: Number(msg.maxScore) || 0,
            timeLimit: Number(msg.timeLimit) || 0,
        });
        sendRoom(room);
        return;
    }

    // ----------------------------------------------------
    //  Voltar para o lobby (host)
    // ----------------------------------------------------
    if (type === 'lobby') {
        if (client.id !== room.hostId) return;
        room.state = 'lobby';
        room.roster = null;
        broadcast(room, { t: 'backToLobby' });
        sendRoom(room);
        return;
    }

    // ----------------------------------------------------
    //  Input do convidado -> host
    // ----------------------------------------------------
    if (type === 'input') {
        if (room.state !== 'playing') return;
        if (client.id === room.hostId) return;
        const host = clients.get(room.hostId);
        if (!host) return;
        send(host, {
            t: 'input',
            id: client.id,
            d: sanitizeInput(msg.d),
            seq: Number(msg.seq) || 0,
        });
        return;
    }

    // ----------------------------------------------------
    //  Snapshot/eventos do host -> convidados
    // ----------------------------------------------------
    if (type === 'frame') {
        if (room.state !== 'playing') return;
        if (client.id !== room.hostId) return;
        const frame = {
            t: 'frame',
            s: msg.s,
            ev: Array.isArray(msg.ev) ? msg.ev.slice(0, 40) : [],
            lastInputSeq: (msg.lastInputSeq && typeof msg.lastInputSeq === 'object')
                ? msg.lastInputSeq
                : null,
        };
        broadcast(room, frame, client.id);
        return;
    }

    if (type === 'leave') {
        leaveRoom(client, 'leave');
        return;
    }
}

function sanitizeInput(d) {
    if (!d || typeof d !== 'object') return { ax: 0, ay: 0, kick: false, power: false };
    return {
        ax: clamp(Number(d.ax) || 0, -1, 1),
        ay: clamp(Number(d.ay) || 0, -1, 1),
        kick: !!d.kick,
        power: !!d.power,
    };
}

function clamp(n, min, max) {
    return n < min ? min : (n > max ? max : n);
}

// ============================================================
//  HEARTBEAT / PING
// ============================================================
setInterval(function () {
    const now = Date.now();
    for (const client of clients.values()) {
        if (!client.alive) {
            try { client.ws.terminate(); } catch (err) {}
            continue;
        }
        client.alive = false;
        client.lastPingSent = now;
        try { client.ws.ping(); } catch (err) {}
    }
}, 15000);

// Atualiza ping nas salas periodicamente
setInterval(function () {
    for (const room of rooms.values()) {
        if (room.state === 'lobby') sendRoom(room);
    }
}, 10000);

// ============================================================
//  START
// ============================================================
server.listen(PORT, HOST, function () {
    console.log('Quadra online em http://' + HOST + ':' + PORT);
    console.log('Salas em memória. Ctrl+C para parar.');
});

process.on('SIGTERM', function () { shutdown(); });
process.on('SIGINT', function () { shutdown(); });

function shutdown() {
    console.log('\nEncerrando servidor...');
    for (const client of clients.values()) {
        try { client.ws.close(1001, 'Servidor encerrado'); } catch (err) {}
    }
    server.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 1500);
}
