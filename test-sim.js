/* Testes headless da simulação (rode: node test-sim.js) */
'use strict';

const SIM = require('./sim.js');
const assert = require('assert');

let passed = 0;
function ok(name, fn) {
    fn();
    passed++;
    console.log('  ok  ' + name);
}

function mk(players) {
    return SIM.createMatch({ players: players || [
        { id: 'a', name: 'A', team: 0 },
        { id: 'b', name: 'B', team: 1 },
    ]});
}

function stepFor(match, seconds, inputs, dt) {
    dt = dt || 1 / 60;
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) match.step(dt, inputs || {});
}

console.log('sim.js ' + SIM.VERSION + '\n');

ok('cria partida 1v1 com spawns válidos', function () {
    const m = mk();
    assert.strictEqual(m.state.players.length, 2);
    assert.strictEqual(m.state.players[0].team, 0);
    assert.strictEqual(m.state.players[1].team, 1);
    assert(m.state.players[0].x < m.state.players[1].x);
    assert.strictEqual(m.state.ball.x, SIM.COURT.x + SIM.COURT.w / 2);
});

ok('movimento responde ao input digital', function () {
    const m = mk();
    const p = m.state.players[0];
    const x0 = p.x;
    stepFor(m, 0.5, { a: { ax: 1, ay: 0 } });
    assert(p.x > x0 + 10, 'jogador deveria andar para a direita');
});

ok('chute normal dá impulso na bola', function () {
    const m = mk();
    const p = m.state.players[0];
    const b = m.state.ball;
    b.x = p.x + 25; b.y = p.y;
    stepFor(m, 1 / 60, { a: { ax: 0, ay: 0, kick: true } });
    assert(Math.hypot(b.vx, b.vy) > 100, 'bola deveria ganhar velocidade');
    const events = m.drainEvents();
    assert(events.some(e => e.type === 'kick'));
});

ok('poder arma e super carga dispara após 0.7s', function () {
    const m = mk();
    const p = m.state.players[0];
    const b = m.state.ball;
    p.powerArmed = true;
    b.x = p.x + 25; b.y = p.y;

    stepFor(m, 1 / 60, { a: { kick: true } });
    assert.strictEqual(p.superCharging, true, 'deveria entrar em carga');

    let fired = false;
    for (let i = 0; i < 60; i++) {
        m.step(1 / 60, {});
        if (m.drainEvents().some(e => e.type === 'superFire')) { fired = true; break; }
    }
    assert(fired, 'deveria emitir superFire');
    assert(Math.hypot(b.vx, b.vy) > 500, 'superchute deveria ser forte');
    assert.strictEqual(p.powerCooldown > 0, true);
});

ok('gol com superchute dá coroa ao autor', function () {
    const m = mk();
    const p = m.state.players[0];
    const b = m.state.ball;

    p.powerArmed = true;
    b.x = p.x + 25; b.y = p.y;
    stepFor(m, 1 / 60, { a: { kick: true } });
    // Termina a carga
    let fired = false;
    for (let i = 0; i < 90; i++) {
        m.step(1 / 60, {});
        if (m.drainEvents().some(e => e.type === 'superFire')) { fired = true; break; }
    }
    assert(fired);

    // Força a bola para dentro do gol direito (time 0 marca)
    b.x = SIM.COURT.x + SIM.COURT.w + 25;
    b.y = SIM.COURT.y + SIM.COURT.h / 2;
    b.vx = 100; b.vy = 0;
    m.step(1 / 60, {});

    assert.strictEqual(m.state.score[0], 1, 'time 0 deveria ter 1 gol');
    assert(p.crownTimer > 0, 'autor do gol deveria receber coroa');
    const ev = m.drainEvents().filter(e => e.type === 'goal')[0];
    assert(ev && ev.crown === true && ev.scorerId === p.id);
});

ok('gol contra com super não dá coroa', function () {
    const m = mk();
    const p = m.state.players[0];
    const b = m.state.ball;
    p.powerArmed = true;
    b.x = p.x + 25; b.y = p.y;
    stepFor(m, 1 / 60, { a: { kick: true } });
    for (let i = 0; i < 90; i++) m.step(1 / 60, {});

    b.x = SIM.COURT.x - 25;
    b.y = SIM.COURT.y + SIM.COURT.h / 2;
    b.vx = -100; b.vy = 0;
    m.step(1 / 60, {});

    assert.strictEqual(m.state.score[1], 1);
    assert.strictEqual(p.crownTimer, 0);
});

ok('reset após gol volta bola e jogadores ao spawn', function () {
    const m = mk();
    const p = m.state.players[0];
    const b = m.state.ball;
    b.x = SIM.COURT.x + SIM.COURT.w + 25;
    b.y = SIM.COURT.y + SIM.COURT.h / 2;
    m.step(1 / 60, {});
    assert.strictEqual(m.state.goalPending, true);

    stepFor(m, 0.25);
    assert.strictEqual(m.state.goalActive, true);

    stepFor(m, 1.9);
    assert.strictEqual(m.state.goalActive, false);
    assert(Math.abs(b.x - (SIM.COURT.x + SIM.COURT.w / 2)) < 0.001);
    assert(Math.abs(p.x - p.spawnX) < 0.001);
});

ok('4 jogadores em 2 times (2v2) sem sobrepor', function () {
    const m = mk([
        { id: 'a', team: 0 }, { id: 'b', team: 0 },
        { id: 'c', team: 1 }, { id: 'd', team: 1 },
    ]);
    const ps = m.state.players;
    assert.strictEqual(ps.length, 4);
    assert.strictEqual(ps.filter(p => p.team === 0).length, 2);
    assert.strictEqual(ps.filter(p => p.team === 1).length, 2);
    for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
            const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y);
            assert(d >= ps[i].r + ps[j].r, 'jogadores não devem nascer sobrepostos');
        }
    }
});

ok('snapshot traz jogadores, bola e placar', function () {
    const m = mk();
    const s = m.snapshot();
    assert(s.players.length === 2);
    assert(typeof s.ball.x === 'number');
    assert(Array.isArray(s.s) && s.s.length === 2);
    assert(typeof s.phase === 'string');
});

ok('tempo só conta em jogo e começa quando iniciado', function () {
    const m = SIM.createMatch({ started: true, players: [{ id: 'a', team: 0 }] });
    stepFor(m, 0.5);
    assert(m.state.time > 0.4 && m.state.time < 0.6, 'tempo deveria contar');
});

console.log('\n' + passed + ' testes passaram.');
