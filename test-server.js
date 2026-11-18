/* Testes do servidor de salas/relay (rode: node test-server.js) */
'use strict';

const { spawn } = require('child_process');
const WebSocket = require('ws');
const assert = require('assert');

const PORT = 8095;
const URL = 'ws://127.0.0.1:' + PORT;

let passed = 0;
function ok(name, fn) {
    return Promise.resolve(fn()).then(function () {
        passed++;
        console.log('  ok  ' + name);
    });
}

function startServer() {
    return new Promise(function (resolve, reject) {
        const proc = spawn(process.execPath, ['server.js'], {
            cwd: __dirname,
            env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1' }),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(function () {
            reject(new Error('servidor não iniciou: ' + out));
        }, 5000);
        proc.stdout.on('data', function (d) {
            out += d.toString();
            if (out.indexOf('Quadra online') >= 0) {
                clearTimeout(timer);
                resolve(proc);
            }
        });
        proc.stderr.on('data', function (d) { out += d.toString(); });
        proc.on('exit', function (code) {
            clearTimeout(timer);
            reject(new Error('servidor saiu: ' + code + ' ' + out));
        });
    });
}

function connect() {
    return new Promise(function (resolve, reject) {
        const ws = new WebSocket(URL);
        const client = { ws: ws, queue: [], waiters: [], closed: false };
        ws.on('message', function (raw) {
            const msg = JSON.parse(String(raw));
            const idx = client.waiters.findIndex(function (w) { return w.pred(msg); });
            if (idx >= 0) {
                const w = client.waiters.splice(idx, 1)[0];
                clearTimeout(w.timer);
                w.resolve(msg);
                return;
            }
            client.queue.push(msg);
        });
        ws.on('open', function () { resolve(client); });
        ws.on('error', reject);
        ws.on('close', function () { client.closed = true; });
    });
}

function waitFor(client, pred, ms) {
    ms = ms || 3000;
    return new Promise(function (resolve, reject) {
        // Já chegou?
        const idx = client.queue.findIndex(pred);
        if (idx >= 0) {
            resolve(client.queue.splice(idx, 1)[0]);
            return;
        }
        const waiter = {
            pred: pred,
            resolve: resolve,
            timer: setTimeout(function () {
                const i = client.waiters.indexOf(waiter);
                if (i >= 0) client.waiters.splice(i, 1);
                reject(new Error('timeout esperando mensagem'));
            }, ms),
        };
        client.waiters.push(waiter);
    });
}

function send(client, msg) {
    client.ws.send(JSON.stringify(msg));
}

function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}

(async function () {
    const proc = await startServer();
    console.log('servidor de teste iniciado\n');

    try {
        // 1. Conexão + welcome
        const host = await connect();
        const wHost = await waitFor(host, m => m.t === 'welcome');
        assert(/^c\d+$/.test(wHost.id));

        await ok('host cria sala', async function () {
            send(host, { t: 'create', name: 'Host' });
            const created = await waitFor(host, m => m.t === 'created');
            assert(/^[A-Z0-9]{4}$/.test(created.code));
            host.code = created.code;
            const room = await waitFor(host, m => m.t === 'room');
            assert.strictEqual(room.room.players.length, 1);
            assert.strictEqual(room.you, wHost.id);
        });

        // 2. Entram 3 convidados
        const guests = [];
        await ok('3 convidados entram e times ficam 2x2', async function () {
            for (let i = 0; i < 3; i++) {
                const g = await connect();
                g.welcome = await waitFor(g, m => m.t === 'welcome');
                send(g, { t: 'join', code: host.code, name: 'G' + (i + 1) });
                const joined = await waitFor(g, m => m.t === 'joined');
                assert.strictEqual(joined.code, host.code);
                guests.push(g);
            }
            const room = await waitFor(host, m => m.t === 'room' && m.room.players.length === 4);
            const teams = room.room.players.map(p => p.team).sort();
            assert.deepStrictEqual(teams, [0, 0, 1, 1]);
            host.room = room;
        });

        // 3. Quinto jogador é rejeitado
        await ok('quinta pessoa recebe room_full', async function () {
            const g = await connect();
            await waitFor(g, m => m.t === 'welcome');
            send(g, { t: 'join', code: host.code, name: 'G5' });
            const err = await waitFor(g, m => m.t === 'error');
            assert.strictEqual(err.code, 'room_full');
            g.ws.close();
        });

        // 4. Host inicia partida
        await ok('host inicia e todos recebem roster de 4', async function () {
            const startPromises = guests.map(g => waitFor(g, m => m.t === 'start'));
            const hostStart = waitFor(host, m => m.t === 'start');
            send(host, { t: 'start' });
            const started = await Promise.all([hostStart].concat(startPromises));
            for (const s of started) {
                assert.strictEqual(s.roster.length, 4);
                assert(s.roster.every(p => p.id && p.name));
            }
        });

        // 5. Input de convidado chega ao host
        await ok('input de convidado chega ao host', async function () {
            send(guests[0], { t: 'input', d: { ax: 1, ay: -1, kick: true, power: false } });
            const inp = await waitFor(host, m => m.t === 'input');
            assert.strictEqual(inp.id, guests[0].welcome.id);
            assert.deepStrictEqual(inp.d, { ax: 1, ay: -1, kick: true, power: false });
        });

        // 6. Frame do host chega aos convidados e não volta ao host
        await ok('frame do host é repassado só aos convidados', async function () {
            const frames = guests.map(g => waitFor(g, m => m.t === 'frame'));
            send(host, { t: 'frame', s: { tick: 7 }, ev: [{ type: 'goal' }] });
            const got = await Promise.all(frames);
            assert.strictEqual(got[0].s.tick, 7);
            assert.strictEqual(got[0].ev[0].type, 'goal');
            // host não deve receber o próprio frame
            await assert.rejects(waitFor(host, m => m.t === 'frame', 400));
        });

        // 7. Convidado não pode iniciar / trocar time em jogo
        await ok('convidado não pode iniciar partida', async function () {
            send(guests[1], { t: 'start' });
            const err = await waitFor(guests[1], m => m.t === 'error');
            assert.strictEqual(err.code, 'not_host');
        });

        await ok('troca de time bloqueada durante a partida', async function () {
            send(guests[1], { t: 'team', team: 0 });
            const err = await waitFor(guests[1], m => m.t === 'error');
            assert.strictEqual(err.code, 'match_running');
        });

        // 8. Saída de convidado avisa o host
        await ok('saída de convidado gera peerLeft', async function () {
            const left = waitFor(host, m => m.t === 'peerLeft');
            guests[2].ws.close();
            const msg = await left;
            assert.strictEqual(msg.id, guests[2].welcome.id);
        });

        // 9. Host sai: partida encerra e novo host é promovido
        await ok('saída do host encerra partida e promove novo host', async function () {
            const alive = guests.slice(0, 2);
            const ended = alive.map(g => waitFor(g, m => m.t === 'matchEnded'));
            const changed = alive.map(g => waitFor(g, m => m.t === 'hostChanged'));
            host.ws.close();
            await Promise.all(ended);
            await Promise.all(changed);
            const room = await waitFor(guests[0], m => m.t === 'room' && m.room.state === 'lobby' && m.room.hostId !== wHost.id);
            assert.strictEqual(room.room.state, 'lobby');
            const newHostId = room.room.hostId;
            assert(newHostId !== wHost.id);
            assert(room.room.players.some(p => p.id === newHostId && p.host));
        });

        // 10. Entrar em sala inexistente
        await ok('sala inexistente retorna erro', async function () {
            const g = await connect();
            await waitFor(g, m => m.t === 'welcome');
            send(g, { t: 'join', code: 'ZZZZ', name: 'X' });
            const err = await waitFor(g, m => m.t === 'error');
            assert.strictEqual(err.code, 'room_not_found');
            g.ws.close();
        });

        // 11. Health
        await ok('health responde', async function () {
            const res = await fetch('http://127.0.0.1:' + PORT + '/health');
            const data = await res.json();
            assert.strictEqual(data.ok, true);
        });

        console.log('\n' + passed + ' testes passaram.');
    } catch (err) {
        console.error('\nFALHOU:', err && err.stack || err);
        process.exitCode = 1;
    } finally {
        for (const g of []) g.ws.close();
        await sleep(200);
        proc.kill('SIGTERM');
        setTimeout(function () { process.exit(process.exitCode || 0); }, 500);
    }
})();
