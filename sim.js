/* ============================================================
   QUADRA - BOLA E CHUTE
   Simulação compartilhada (roda no navegador e no Node)

   Este arquivo contém apenas a física e as regras da partida.
   Nada de DOM, canvas, áudio ou efeitos visuais: os efeitos são
   disparados por eventos e desenhados pelo cliente.

   Uso:
     const match = QuadraSim.createMatch({ players: [...] });
     match.step(dt, inputs);      // inputs[id] = { ax, ay, kick, power }
     match.snapshot();            // estado para enviar pela rede
     match.drainEvents();         // eventos desde o último drain
   ============================================================ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.QuadraSim = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // ============================================================
    //  CONSTANTES
    // ============================================================
    const WORLD = { w: 1120, h: 600 };
    const COURT = { x: 100, y: 100, w: 920, h: 400 };
    const VERSION = '0.08';

    // Gol: abertura na parede lateral + bolsão rebaixado (para fora da quadra)
    const GOAL = {
        height: 160,
        depth: 58,
        y: COURT.y + (COURT.h - 160) / 2,
    };

    const PLAYER = {
        r: 22,
        mass: 0.7,
        maxSpeed: 160,
        responsiveness: 9,
    };

    const BALL = {
        r: 12,
        mass: 0.62,
        maxSpeed: 1000,
        damping: 1.15,
        wallBounce: 0.72,
    };

    const KICK = {
        range: 8,
        power: 560,
        cooldown: 0.08,
        chain: 0.35,
        playerBias: 0.15,
        maxBounces: 3,
    };

    const POWER = {
        superMultiplier: 1.8,
        cooldown: 6,
    };

    const SUPER_CHARGE_DURATION = 0.7;
    const CROWN_DURATION = 6.0;
    const GOAL_DURATION = 1.8;
    const GOAL_DELAY = 0.2;
    const MAX_PLAYERS = 4;

    const TEAM_COLORS = ['#e94560', '#3d9bff'];
    const TEAM_NAMES = ['Vermelho', 'Azul'];

    const EMPTY_INPUT = Object.freeze({ ax: 0, ay: 0, kick: false, power: false });

    // ============================================================
    //  CRIAÇÃO
    // ============================================================
    function spawnFor(team, indexInTeam) {
        const cx = COURT.x + COURT.w / 2;
        const cy = COURT.y + COURT.h / 2;
        const side = team === 0 ? -1 : 1;
        const x = cx + side * COURT.w * 0.21;
        const y = cy + (indexInTeam === 0 ? -58 : 58);
        return { x, y };
    }

    function makePlayer(spec, team, indexInTeam) {
        const pos = spawnFor(team, indexInTeam);
        return {
            id: spec.id,
            name: spec.name || spec.id,
            team: team,
            color: spec.color || TEAM_COLORS[team] || TEAM_COLORS[0],
            x: pos.x,
            y: pos.y,
            vx: 0,
            vy: 0,
            r: PLAYER.r,
            mass: PLAYER.mass,

            aimX: team === 0 ? 1 : -1,
            aimY: 0,

            kickCooldown: 0,

            // Poder / superchute
            powerArmed: false,
            powerCooldown: 0,
            superCharging: false,
            superChargeTimer: 0,
            superChargeDirX: team === 0 ? 1 : -1,
            superChargeDirY: 0,
            superChargeSpeed: 0,

            // Coroa (gol de superchute)
            crownTimer: 0,

            // Detecção de borda dos botões
            prevKick: false,
            prevPower: false,

            // Posição de nascimento (para reinício após gol)
            spawnX: pos.x,
            spawnY: pos.y,
        };
    }

    function normalizeSpecs(specs) {
        const list = (specs && specs.length ? specs : [{ id: 'p0', name: 'Você', team: 0 }]).slice(0, MAX_PLAYERS);
        const counts = [0, 0];
        return list.map((s, i) => {
            let team = Number.isFinite(s.team) ? (s.team & 1) : (i & 1);
            // Limita a 2 jogadores por time
            if (counts[team] >= 2) team = 1 - team;
            if (counts[team] >= 2) team = 0;
            const indexInTeam = counts[team]++;
            return { spec: s, team, indexInTeam };
        });
    }

    function createMatch(opts) {
        opts = opts || {};
        const now = Date.now();
        const players = normalizeSpecs(opts.players).map(function (entry) {
            return makePlayer(entry.spec, entry.team, entry.indexInTeam);
        });

        const match = {
            players: players,
            byId: {},
            ball: {
                x: COURT.x + COURT.w / 2,
                y: COURT.y + COURT.h / 2,
                vx: 0,
                vy: 0,
                r: BALL.r,
                mass: BALL.mass,
                angle: 0,
                lastSuperBy: null,
            },
            score: [0, 0],
            time: 0,
            started: !!opts.started,
            tick: 0,
            createdAt: now,

            goalPending: false,
            goalActive: false,
            goalTimer: 0,
            goalDelayTimer: 0,

            maxScore: opts.maxScore || 0,
            timeLimit: opts.timeLimit || 0,
            finished: false,
            winner: null,

            events: [],
            lastGoal: null,
        };

        players.forEach(function (p) { match.byId[p.id] = p; });
        return createApi(match);
    }

    // ============================================================
    //  API
    // ============================================================
    function createApi(match) {
        const api = {
            state: match,
            step: function (dt, inputs, kickBonuses, opts) {
            step(match, dt, inputs || {}, kickBonuses || {}, opts || {});
        },
            snapshot: function () { return buildSnapshot(match); },
            drainEvents: function () {
                const out = match.events;
                match.events = [];
                return out;
            },
            reset: function () { resetMatch(match, true); },
            version: VERSION,
        };
        return api;
    }

    function emit(match, type, data) {
        const ev = { type: type };
        if (data) {
            for (const k in data) ev[k] = data[k];
        }
        match.events.push(ev);
        // Limite de segurança caso ninguém consuma os eventos
        if (match.events.length > 120) match.events.splice(0, match.events.length - 120);
    }

    // ============================================================
    //  INPUT
    // ============================================================
    function readInput(inputs, player) {
        const raw = inputs[player.id];
        if (!raw) return EMPTY_INPUT;
        return raw;
    }

    function inputAxes(input) {
        let ax = Number(input.ax) || 0;
        let ay = Number(input.ay) || 0;
        // Teclado digital chega como -1/0/1; joystick pode ser analógico
        if (input.left) ax -= 1;
        if (input.right) ax += 1;
        if (input.up) ay -= 1;
        if (input.down) ay += 1;
        const len = Math.hypot(ax, ay);
        if (len > 1) { ax /= len; ay /= len; }
        return { ax: ax, ay: ay, has: len > 0.01 };
    }

    // ============================================================
    //  FÍSICA
    // ============================================================
    function playerInRange(match, p, rangeBonus = 0) {
        const b = match.ball;
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        return Math.hypot(dx, dy) <= p.r + b.r + KICK.range + rangeBonus;
    }

    function updatePlayer(match, p, dt, input) {
        // Super carga: bola grudada, jogador escuro, acelera progressivamente
        if (p.superCharging) {
            p.superChargeTimer = Math.max(0, p.superChargeTimer - dt);
            if (p.superChargeTimer <= 0) {
                p.superCharging = false;
                p.superChargeSpeed = 0;
                fireSuperShot(match, p);
            } else {
                const elapsed = SUPER_CHARGE_DURATION - p.superChargeTimer;
                const progress = elapsed / SUPER_CHARGE_DURATION;
                const speedMul = 0.45 + 0.8 * progress;
                p.superChargeSpeed = speedMul;

                p.vx = p.superChargeDirX * PLAYER.maxSpeed * speedMul;
                p.vy = p.superChargeDirY * PLAYER.maxSpeed * speedMul;
                p.x += p.vx * dt;
                p.y += p.vy * dt;

                const b = match.ball;
                const offsetDist = p.r + b.r;
                b.x = p.x + p.superChargeDirX * offsetDist;
                b.y = p.y + p.superChargeDirY * offsetDist;
                b.vx = p.vx;
                b.vy = p.vy;

                clampPlayer(p);
                return;
            }
        }

        p.superChargeSpeed = 0;

        const axes = inputAxes(input);
        const hasInput = axes.has;

        let targetVx = axes.ax * PLAYER.maxSpeed;
        let targetVy = axes.ay * PLAYER.maxSpeed;

        if (hasInput) {
            const len = Math.hypot(targetVx, targetVy);
            if (len > 0.01) {
                p.aimX = targetVx / len;
                p.aimY = targetVy / len;
            }
            const t = 1 - Math.exp(-PLAYER.responsiveness * dt);
            p.vx += (targetVx - p.vx) * t;
            p.vy += (targetVy - p.vy) * t;
        } else {
            const drag = Math.exp(-2.5 * dt);
            p.vx *= drag;
            p.vy *= drag;
        }

        p.x += p.vx * dt;
        p.y += p.vy * dt;
        clampPlayer(p);
    }

    // ReconSTRUÇÃO de posição para client-side prediction: aplica um passo de
    // movimento idêntico ao de updatePlayer, mas sem emitir eventos nem mexer
    // na bola. Usado pelo guest para replayar inputs ainda não confirmados
    // sobre o snapshot autoritativo do host.
    function predictPlayerMovement(p, dt, input) {
        if (!p || !Number.isFinite(dt) || dt <= 0) return;
        dt = Math.min(dt, 1 / 30);

        if (p.superCharging) {
            p.superChargeTimer = Math.max(0, p.superChargeTimer - dt);
            if (p.superChargeTimer <= 0) {
                p.superCharging = false;
                p.superChargeSpeed = 0;
            } else {
                const elapsed = SUPER_CHARGE_DURATION - p.superChargeTimer;
                const progress = elapsed / SUPER_CHARGE_DURATION;
                const speedMul = 0.45 + 0.8 * progress;
                p.superChargeSpeed = speedMul;
                p.vx = p.superChargeDirX * PLAYER.maxSpeed * speedMul;
                p.vy = p.superChargeDirY * PLAYER.maxSpeed * speedMul;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                clampPlayer(p);
                return;
            }
        }

        p.superChargeSpeed = 0;

        const axes = inputAxes(input);
        const hasInput = axes.has;
        let targetVx = axes.ax * PLAYER.maxSpeed;
        let targetVy = axes.ay * PLAYER.maxSpeed;

        if (hasInput) {
            const len = Math.hypot(targetVx, targetVy);
            if (len > 0.01) {
                p.aimX = targetVx / len;
                p.aimY = targetVy / len;
            }
            const t = 1 - Math.exp(-PLAYER.responsiveness * dt);
            p.vx += (targetVx - p.vx) * t;
            p.vy += (targetVy - p.vy) * t;
        } else {
            const drag = Math.exp(-2.5 * dt);
            p.vx *= drag;
            p.vy *= drag;
        }

        p.x += p.vx * dt;
        p.y += p.vy * dt;
        clampPlayer(p);
    }

    function clampPlayer(p) {
        const pad = 2 * p.r;
        const minX = COURT.x - pad;
        const maxX = COURT.x + COURT.w + pad;
        const minY = COURT.y - pad;
        const maxY = COURT.y + COURT.h + pad;

        if (p.x < minX) { p.x = minX; if (p.vx < 0) p.vx = 0; }
        if (p.x > maxX) { p.x = maxX; if (p.vx > 0) p.vx = 0; }
        if (p.y < minY) { p.y = minY; if (p.vy < 0) p.vy = 0; }
        if (p.y > maxY) { p.y = maxY; if (p.vy > 0) p.vy = 0; }
    }

    function updateBall(match, dt) {
        const b = match.ball;
        const damp = Math.exp(-BALL.damping * dt);
        b.vx *= damp;
        b.vy *= damp;

        const speed = Math.hypot(b.vx, b.vy);
        if (speed > BALL.maxSpeed) {
            b.vx = b.vx / speed * BALL.maxSpeed;
            b.vy = b.vy / speed * BALL.maxSpeed;
        }

        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.angle += (b.vx / b.r) * dt * 0.6;

        bounceBallWalls(match);
    }

    function collidePost(match, px, py) {
        const b = match.ball;
        const dx = b.x - px;
        const dy = b.y - py;
        const d = Math.hypot(dx, dy);
        if (d >= b.r || d < 1e-6) return;

        const nx = dx / d;
        const ny = dy / d;

        b.x = px + nx * b.r;
        b.y = py + ny * b.r;

        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
            const e = BALL.wallBounce;
            b.vx -= (1 + e) * vn * nx;
            b.vy -= (1 + e) * vn * ny;
        }
    }

    function bounceBallWalls(match) {
        const b = match.ball;
        const r = b.r;
        const lx = COURT.x;
        const rx = COURT.x + COURT.w;
        const ty = COURT.y;
        const by = COURT.y + COURT.h;
        const gTop = GOAL.y;
        const gBot = GOAL.y + GOAL.height;
        const e = BALL.wallBounce;

        collidePost(match, lx, gTop);
        collidePost(match, lx, gBot);
        collidePost(match, rx, gTop);
        collidePost(match, rx, gBot);

        if (b.y - r < ty) { b.y = ty + r; if (b.vy < 0) b.vy = -b.vy * e; }
        if (b.y + r > by) { b.y = by - r; if (b.vy > 0) b.vy = -b.vy * e; }

        // Lado esquerdo
        if (b.x < lx) {
            if (b.x - r < lx - GOAL.depth) {
                b.x = lx - GOAL.depth + r;
                if (b.vx < 0) b.vx = -b.vx * e;
            }
            if (b.y - r < gTop) { b.y = gTop + r; if (b.vy < 0) b.vy = -b.vy * e; }
            if (b.y + r > gBot) { b.y = gBot - r; if (b.vy > 0) b.vy = -b.vy * e; }
        } else if (b.x - r < lx) {
            const inMouth = b.y - r > gTop && b.y + r < gBot;
            if (!inMouth) {
                b.x = lx + r;
                if (b.vx < 0) b.vx = -b.vx * e;
            }
        }

        // Lado direito
        if (b.x > rx) {
            if (b.x + r > rx + GOAL.depth) {
                b.x = rx + GOAL.depth - r;
                if (b.vx > 0) b.vx = -b.vx * e;
            }
            if (b.y - r < gTop) { b.y = gTop + r; if (b.vy < 0) b.vy = -b.vy * e; }
            if (b.y + r > gBot) { b.y = gBot - r; if (b.vy > 0) b.vy = -b.vy * e; }
        } else if (b.x + r > rx) {
            const inMouth = b.y - r > gTop && b.y + r < gBot;
            if (!inMouth) {
                b.x = rx - r;
                if (b.vx > 0) b.vx = -b.vx * e;
            }
        }
    }

    function checkGoal(match) {
        if (match.goalActive) return null;
        const b = match.ball;
        const gTop = GOAL.y;
        const gBot = GOAL.y + GOAL.height;
        if (b.y <= gTop || b.y >= gBot) return null;
        if (b.x + b.r < COURT.x) return 'left';
        if (b.x - b.r > COURT.x + COURT.w) return 'right';
        return null;
    }

    function scoreGoal(match, side) {
        match.goalPending = true;
        match.goalDelayTimer = GOAL_DELAY;
        match.goalActive = false;
        match.started = true;

        const b = match.ball;
        b.vx = 0;
        b.vy = 0;

        const team = side === 'left' ? 1 : 0;
        match.score[team]++;

        // Coroa: autor do superchute que virou gol
        let scorer = null;
        let crown = false;
        if (b.lastSuperBy && match.byId[b.lastSuperBy]) {
            scorer = match.byId[b.lastSuperBy];
            if (scorer.team === team) {
                scorer.crownTimer = CROWN_DURATION;
                crown = true;
            }
        }
        b.lastSuperBy = null;

        match.lastGoal = {
            team: team,
            side: side,
            scorerId: scorer ? scorer.id : null,
            crown: crown,
            x: b.x,
            y: b.y,
        };

        emit(match, 'goal', {
            team: team,
            side: side,
            scorerId: scorer ? scorer.id : null,
            crown: crown,
            x: b.x,
            y: b.y,
            score: [match.score[0], match.score[1]],
        });

        // Fim de partida por placar
        if (match.maxScore > 0 && match.score[team] >= match.maxScore) {
            match.finished = true;
            match.winner = team;
            emit(match, 'finished', { winner: team, score: [match.score[0], match.score[1]] });
        }
    }

    function resetAfterGoal(match) {
        const b = match.ball;
        b.x = COURT.x + COURT.w / 2;
        b.y = COURT.y + COURT.h / 2;
        b.vx = 0;
        b.vy = 0;
        b.angle = 0;
        b.lastSuperBy = null;

        match.goalActive = false;
        match.goalTimer = 0;
        match.goalPending = false;
        match.goalDelayTimer = 0;

        match.players.forEach(function (p) {
            p.x = p.spawnX;
            p.y = p.spawnY;
            p.vx = 0;
            p.vy = 0;
            p.superCharging = false;
            p.superChargeTimer = 0;
            p.superChargeSpeed = 0;
            p.powerArmed = false;
        });

        emit(match, 'reset', {});
    }

    function resetMatch(match, full) {
        const b = match.ball;
        b.x = COURT.x + COURT.w / 2;
        b.y = COURT.y + COURT.h / 2;
        b.vx = 0;
        b.vy = 0;
        b.angle = 0;
        b.lastSuperBy = null;

        match.goalActive = false;
        match.goalTimer = 0;
        match.goalPending = false;
        match.goalDelayTimer = 0;
        match.time = 0;
        match.tick = 0;
        match.finished = false;
        match.winner = null;
        match.lastGoal = null;

        if (full) {
            match.score = [0, 0];
        }

        match.players.forEach(function (p) {
            p.x = p.spawnX;
            p.y = p.spawnY;
            p.vx = 0;
            p.vy = 0;
            p.kickCooldown = 0;
            p.powerArmed = false;
            p.powerCooldown = 0;
            p.superCharging = false;
            p.superChargeTimer = 0;
            p.superChargeSpeed = 0;
            p.crownTimer = 0;
            p.prevKick = false;
            p.prevPower = false;
        });

        emit(match, 'reset', { full: !!full });
    }

    // ============================================================
    //  COLISÕES
    // ============================================================
    function collidePlayerBallCore(match, p) {
        const b = match.ball;

        if (p.superCharging) {
            const offsetDist = p.r + b.r;
            b.x = p.x + p.superChargeDirX * offsetDist;
            b.y = p.y + p.superChargeDirY * offsetDist;
            b.vx = p.vx;
            b.vy = p.vy;
            return;
        }

        const dx = b.x - p.x;
        const dy = b.y - p.y;
        const dist = Math.hypot(dx, dy);
        const minDist = p.r + b.r;
        if (dist >= minDist) return;

        const nx = dist > 0.0001 ? dx / dist : 1;
        const ny = dist > 0.0001 ? dy / dist : 0;
        const overlap = minDist - dist;
        const totalMass = p.mass + b.mass;

        p.x -= nx * overlap * (b.mass / totalMass);
        p.y -= ny * overlap * (b.mass / totalMass);
        b.x += nx * overlap * (p.mass / totalMass);
        b.y += ny * overlap * (p.mass / totalMass);

        const rvx = b.vx - p.vx;
        const rvy = b.vy - p.vy;
        const velAlongNormal = rvx * nx + rvy * ny;
        if (velAlongNormal > 0) return;

        const e = 0.35;
        const j = -(1 + e) * velAlongNormal / (1 / p.mass + 1 / b.mass);

        p.vx -= (j * nx) / p.mass;
        p.vy -= (j * ny) / p.mass;
        b.vx += (j * nx) / b.mass;
        b.vy += (j * ny) / b.mass;
    }

    // Wrapper usado no step: resolve a colisão e rebate nas paredes.
    function collidePlayerBall(match, p) {
        collidePlayerBallCore(match, p);
        bounceBallWalls(match);
    }

    // Colisão entre dois jogadores, compartilhada pelo step e pelo replay da
    // reconciliação para o guest reproduzir localmente os empurrões do host.
    function collidePair(a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = a.r + b.r;
        if (dist >= minDist) return;

        const nx = dist > 0.0001 ? dx / dist : 1;
        const ny = dist > 0.0001 ? dy / dist : 0;
        const overlap = minDist - dist;
        const totalMass = a.mass + b.mass;

        a.x -= nx * overlap * (b.mass / totalMass);
        a.y -= ny * overlap * (b.mass / totalMass);
        b.x += nx * overlap * (a.mass / totalMass);
        b.y += ny * overlap * (a.mass / totalMass);

        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn > 0) return;

        const e = 0.15;
        const imp = -(1 + e) * vn / (1 / a.mass + 1 / b.mass);
        a.vx -= (imp * nx) / a.mass;
        a.vy -= (imp * ny) / a.mass;
        b.vx += (imp * nx) / b.mass;
        b.vy += (imp * ny) / b.mass;
    }

    function collidePlayers(match) {
        const list = match.players;
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                collidePair(list[i], list[j]);
            }
        }
    }

    // No guest o jogador remoto é tratado como obstáculo: recebe o input do
    // host, não pode ser deslocado pela predição local. Resolve a colisão
    // movendo apenas o jogador local, para ele não atravessar ninguém sem
    // criar divergência com o estado autoritativo.
    function collideLocalAgainst(match, localId) {
        const p = match.state && match.state.byId ? match.state.byId[localId] : null;
        const mover = p || match.players.find(function (q) { return q.id === localId; });
        if (!mover) return;
        for (let i = 0; i < match.players.length; i++) {
            const other = match.players[i];
            if (other === mover || other.id === localId) continue;
            const dx = other.x - mover.x;
            const dy = other.y - mover.y;
            const dist = Math.hypot(dx, dy);
            const minDist = mover.r + other.r;
            if (dist >= minDist) continue;
            const nx = dist > 0.0001 ? dx / dist : 1;
            const ny = dist > 0.0001 ? dy / dist : 0;
            mover.x -= nx * (minDist - dist);
            mover.y -= ny * (minDist - dist);
            const rel = (mover.vx - other.vx) * nx + (mover.vy - other.vy) * ny;
            if (rel < 0) {
                mover.vx -= rel * nx;
                mover.vy -= rel * ny;
            }
        }
    }

    // ============================================================
    //  CHUTE
    // ============================================================
    function tryKick(match, p, kickRangeBonus = 0) {
        if (match.goalActive) return;
        if (p.kickCooldown > 0) return;
        if (!playerInRange(match, p, kickRangeBonus)) return;

        const b = match.ball;
        let dx = b.x - p.x;
        let dy = b.y - p.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.0001) { dx = 1; dy = 0; dist = 1; }

        const nx = dx / dist;
        const ny = dy / dist;

        const along = b.vx * nx + b.vy * ny;
        const boost = Math.max(0, along) * KICK.chain;

        const isSuper = p.powerArmed && p.powerCooldown <= 0;
        const powerMul = isSuper ? POWER.superMultiplier : 1;

        if (isSuper) {
            p.powerArmed = true;
            p.kickCooldown = KICK.cooldown;

            p.superChargeDirX = nx;
            p.superChargeDirY = ny;

            const aimLen = Math.hypot(p.superChargeDirX, p.superChargeDirY);
            if (aimLen < 0.001) {
                p.superChargeDirX = p.aimX;
                p.superChargeDirY = p.aimY;
            }

            p.superCharging = true;
            p.superChargeTimer = SUPER_CHARGE_DURATION;

            emit(match, 'superStart', {
                id: p.id,
                x: p.x,
                y: p.y,
                dirX: p.superChargeDirX,
                dirY: p.superChargeDirY,
            });
            return;
        }

        // Chute normal anula a marcação de superchute anterior
        b.lastSuperBy = null;

        b.vx = nx * (KICK.power * powerMul + boost) + p.vx * KICK.playerBias;
        b.vy = ny * (KICK.power * powerMul + boost) + p.vy * KICK.playerBias;

        p.kickCooldown = KICK.cooldown;

        if (p.powerArmed && p.powerCooldown > 0) {
            p.powerArmed = false;
        }

        emit(match, 'kick', {
            id: p.id,
            super: false,
            x: b.x,
            y: b.y,
            vx: round(b.vx),
            vy: round(b.vy),
        });
    }

    function fireSuperShot(match, p) {
        if (match.goalActive) return;

        const b = match.ball;
        const nx = p.superChargeDirX;
        const ny = p.superChargeDirY;

        b.vx = nx * (KICK.power * POWER.superMultiplier) + p.vx * KICK.playerBias;
        b.vy = ny * (KICK.power * POWER.superMultiplier) + p.vy * KICK.playerBias;
        b.lastSuperBy = p.id;

        p.kickCooldown = KICK.cooldown;
        p.powerArmed = false;
        p.powerCooldown = POWER.cooldown;

        emit(match, 'superFire', {
            id: p.id,
            x: b.x,
            y: b.y,
            dirX: nx,
            dirY: ny,
            vx: round(b.vx),
            vy: round(b.vy),
        });
    }

    function togglePower(match, p) {
        if (p.powerCooldown > 0) return;
        p.powerArmed = !p.powerArmed;
        emit(match, 'power', { id: p.id, armed: p.powerArmed });
    }

    // ============================================================
    //  STEP
    // ============================================================
    // opts.localOnlyId: modo predição do guest.
    //   - só esse jogador é movido/chuta/poder (os demais vêm do snapshot do host)
    //   - gol/placar/fim e bola são do host (com ballRenderOnly, a bola nem é simulada)
    //   - por padrão jogadores remotos não colidem localmente (posições vêm do host)
    // opts.localCollisions: no modo predição, impede que o jogador local
    //   atravesse os remotos (colisão unilateral).
    // opts.ballRenderOnly: a bola NÃO é simulada localmente. Ela é renderizada
    //   pelo cliente a partir dos snapshots do host. Física de bola, chute e
    //   colisões com a bola ficam só no host — elimina a divergência que
    //   causava o "vai e volta" e a travadeira a cada contato.
    function step(match, dt, inputs, kickBonuses = {}, opts = {}) {
        if (!Number.isFinite(dt) || dt <= 0) return;
        dt = Math.min(dt, 1 / 30);

        match.tick++;

        const predictId = opts.localOnlyId || null;
        const isPredict = !!predictId;
        const ballRenderOnly = !!opts.ballRenderOnly;
        const b = match.ball;
        const savedBall = ballRenderOnly
            ? { x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: b.angle, lastSuperBy: b.lastSuperBy }
            : null;

        // Jogadores: movimento, chute e poder
        for (let i = 0; i < match.players.length; i++) {
            const p = match.players[i];
            if (isPredict && p.id !== predictId) continue;

            const input = readInput(inputs, p);

            const kickPressed = !!input.kick && !p.prevKick;
            const powerPressed = !!input.power && !p.prevPower;
            p.prevKick = !!input.kick;
            p.prevPower = !!input.power;

            updatePlayer(match, p, dt, input);

            // No guest o chute é só visual: quem aplica o impulso na bola é o
            // host, no tick em que o input chegar.
            if (kickPressed && !ballRenderOnly) tryKick(match, p, kickBonuses[p.id] || 0);
            if (powerPressed) togglePower(match, p);

            if (p.kickCooldown > 0) p.kickCooldown = Math.max(0, p.kickCooldown - dt);
            if (p.powerCooldown > 0) p.powerCooldown = Math.max(0, p.powerCooldown - dt);

            if (p.crownTimer > 0) p.crownTimer = Math.max(0, p.crownTimer - dt);
        }

        if (ballRenderOnly) {
            // updatePlayer gruda a bola durante a super carga e fireSuperShot
            // muda a velocidade: nada disso pode mexer na bola renderizada.
            b.x = savedBall.x; b.y = savedBall.y;
            b.vx = savedBall.vx; b.vy = savedBall.vy;
            b.angle = savedBall.angle; b.lastSuperBy = savedBall.lastSuperBy;
        }

        const faseParada = match.goalActive || match.goalPending;

        if (!faseParada) {
            if (!ballRenderOnly) {
                const ballVxBefore = b.vx;
                const ballVyBefore = b.vy;

                for (let i = 0; i < match.players.length; i++) {
                    const p = match.players[i];
                    if (isPredict && p.id !== predictId) continue;
                    collidePlayerBall(match, p);
                }
                if (!isPredict) collidePlayers(match);
                updateBall(match, dt);

                // Rebate detectado por mudança abrupta de velocidade além do
                // damping, para o host avisar os convidados (efeitos visuais).
                const damp = Math.exp(-BALL.damping * dt);
                const dvx = b.vx - ballVxBefore * damp;
                const dvy = b.vy - ballVyBefore * damp;
                if (Math.hypot(dvx, dvy) > 50) {
                    emit(match, 'bounce', {
                        x: b.x, y: b.y, vx: b.vx, vy: b.vy,
                    });
                }

                // Gol/placar são autoridade do host.
                if (!isPredict) {
                    const side = checkGoal(match);
                    if (side) scoreGoal(match, side);
                }
            }

            // Colisão unilateral: mesmo com a bola vinda do host, o jogador
            // local não atravessa os remotos.
            if (isPredict && opts.localCollisions) {
                collideLocalAgainst(match, predictId);
            }
        }

        // Delay/fim de gol e tempo: somente o host (autoridade)
        if (!isPredict) {
            if (match.goalPending) {
                match.goalDelayTimer -= dt;
                if (match.goalDelayTimer <= 0) {
                    match.goalPending = false;
                    match.goalActive = true;
                    match.goalTimer = 0;
                    emit(match, 'goalBanner', {});
                }
            }

            if (match.goalActive) {
                match.goalTimer += dt;
                if (match.goalTimer >= GOAL_DURATION) resetAfterGoal(match);
            }

            if (match.started && !match.finished && !match.goalActive && !match.goalPending) {
                match.time += dt;
                if (match.timeLimit > 0 && match.time >= match.timeLimit) {
                    match.finished = true;
                    const a = match.score[0], b2 = match.score[1];
                    match.winner = a === b2 ? null : (a > b2 ? 0 : 1);
                    emit(match, 'finished', { winner: match.winner, score: [a, b2], timeUp: true });
                }
            }
        }
    }

    // ============================================================
    //  SNAPSHOT
    // ============================================================
    function buildSnapshot(match) {
        const b = match.ball;
        return {
            v: VERSION,
            tick: match.tick,
            t: match.time,
            s: [match.score[0], match.score[1]],
            phase: match.goalActive ? 'goal' : (match.goalPending ? 'pending' : 'play'),
            gt: match.goalTimer,
            pt: match.goalDelayTimer,
            gtimer: match.goalTimer,
            finished: match.finished,
            winner: match.winner,
            started: match.started,
            ball: {
                x: round(b.x),
                y: round(b.y),
                vx: round(b.vx),
                vy: round(b.vy),
                a: round(b.angle),
            },
            players: match.players.map(function (p) {
                return {
                    id: p.id,
                    n: p.name,
                    tm: p.team,
                    x: round(p.x),
                    y: round(p.y),
                    vx: round(p.vx),
                    vy: round(p.vy),
                    ax: round(p.aimX),
                    ay: round(p.aimY),
                    armed: p.powerArmed,
                    cd: round(p.powerCooldown),
                    ch: p.superCharging,
                    cdx: round(p.superChargeDirX),
                    cdy: round(p.superChargeDirY),
                    csp: round(p.superChargeSpeed),
                    crown: round(p.crownTimer),
                };
            }),
        };
    }

    function round(n) {
        return Math.round(n * 100) / 100;
    }

    // ============================================================
    //  API PÚBLICA
    // ============================================================
    return {
        VERSION: VERSION,
        WORLD: WORLD,
        COURT: COURT,
        GOAL: GOAL,
        PLAYER: PLAYER,
        BALL: BALL,
        KICK: KICK,
        POWER: POWER,
        SUPER_CHARGE_DURATION: SUPER_CHARGE_DURATION,
        CROWN_DURATION: CROWN_DURATION,
        GOAL_DURATION: GOAL_DURATION,
        GOAL_DELAY: GOAL_DELAY,
        MAX_PLAYERS: MAX_PLAYERS,
        TEAM_COLORS: TEAM_COLORS,
        TEAM_NAMES: TEAM_NAMES,
        createMatch: createMatch,
        predictPlayerMovement: predictPlayerMovement,
        _internals: {
            step: step,
            buildSnapshot: buildSnapshot,
            scoreGoal: scoreGoal,
            resetAfterGoal: resetAfterGoal,
            collidePair: collidePair,
            collidePlayerBallCore: collidePlayerBallCore,
        },
    };
});
