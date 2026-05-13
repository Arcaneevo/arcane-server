const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const app = express();
const httpServer = createServer(app);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: false },
  allowEIO3: true,
  transports: ['polling', 'websocket']
});

const supabase = createClient(
  'https://xjtjcwatsebrrgaogjdy.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqdGpjd2F0c2VicnJnYW9namR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyMDc4MTksImV4cCI6MjA5Mzc4MzgxOX0.X0af5J28Hed7qCwZiDH3QCqUa6qAl__Vu6zhN7KklSM',
  { realtime: { transport: ws } }
);

// ===== ESTADO EN MEMORIA =====
const pvpRooms  = new Map(); // battleId → { p1, p2, state }
const bossRooms = new Map(); // roomId   → { players, bossState }

// ===== HEALTH CHECK =====
app.get('/', (req, res) => res.json({ status: 'ok', server: 'Arcane Rift v1.0', time: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/test', (req, res) => res.send('<h1>✅ Servidor Arcane Rift funcionando</h1>'));

// ===== CONEXIÓN =====
io.on('connection', (socket) => {
  console.log(`✅ Conectado: ${socket.id}`);

  // ============================================================
  // PVP
  // ============================================================

  // Buscar oponente por username
  socket.on('pvp:search', async ({ username, myUsername, myId, goldBet }) => {
    if (!username) return socket.emit('pvp:search_result', { error: 'Escribe un nombre' });
    console.log(`🔍 pvp:search → username="${username}" myId="${myId}" goldBet=${goldBet}`);

    const { data: target, error } = await supabase.from('players')
      .select('id, username, last_seen, pvp_status, gold')
      .eq('username', username).maybeSingle();

    console.log(`🔍 resultado:`, target ? `encontrado id=${target.id}` : `no encontrado`, error?.message||'');

    if (!target) return socket.emit('pvp:search_result', { error: 'Usuario "' + username + '" no encontrado' });
    if (target.id === myId) return socket.emit('pvp:search_result', { error: 'No puedes desafiarte a ti mismo' });
    if (target.pvp_status === 'in_battle') return socket.emit('pvp:search_result', { error: username + ' está en batalla' });
    if ((target.gold || 0) < (goldBet || 0)) return socket.emit('pvp:search_result', { error: username + ' no tiene suficiente oro (' + goldBet + ' 🪙)' });

    socket.emit('pvp:search_result', { ok: true, targetId: target.id, targetUsername: target.username });
  });

  // Enviar desafío
  socket.on('pvp:challenge', async ({ challengerId, challengerUsername, challengedId, goldBet }) => {
    const { data: challenge } = await supabase.from('pvp_challenges').insert({
      challenger_id: challengerId,
      challenged_id: challengedId,
      challenger_username: challengerUsername,
      gold_bet: goldBet,
      status: 'pending'
    }).select().single();

    if (!challenge) return socket.emit('pvp:challenge_error', { error: 'Error enviando desafío' });

    // Notificar al desafiado via socket si está conectado
    const challengedSocket = [...io.sockets.sockets.values()]
      .find(s => s.playerId === challengedId);
    if (challengedSocket) {
      challengedSocket.emit('pvp:challenged', {
        challengeId: challenge.id,
        challengerUsername,
        challengerId,
        goldBet
      });
    }

    socket.emit('pvp:challenge_sent', { challengeId: challenge.id });

    // Expirar en 30s
    setTimeout(async () => {
      const { data: c } = await supabase.from('pvp_challenges')
        .select('status').eq('id', challenge.id).single();
      if (c?.status === 'pending') {
        await supabase.from('pvp_challenges').update({ status: 'expired' }).eq('id', challenge.id);
        socket.emit('pvp:challenge_expired');
      }
    }, 30000);
  });

  // Registrar playerId al conectar
  socket.on('pvp:register', ({ playerId }) => {
    socket.playerId = playerId;
    socket.join('player:' + playerId);
    console.log(`👤 Registrado: ${playerId}`);
  });

  // Aceptar desafío
  socket.on('pvp:accept', async ({ challengeId, challengedId, challengedUsername }) => {
    await supabase.from('pvp_challenges').update({ status: 'accepted' }).eq('id', challengeId);

    const { data: challenge } = await supabase.from('pvp_challenges')
      .select('*').eq('id', challengeId).single();
    if (!challenge) return;

    // Cargar stats de ambos
    const { data: p1 } = await supabase.from('players')
      .select('id, race, class, stat_vit, stat_ene, stat_atk, stat_def, stat_spd, level, username, equipped_weapon, class_chosen')
      .eq('id', challenge.challenger_id).single();
    const { data: p2 } = await supabase.from('players')
      .select('id, race, class, stat_vit, stat_ene, stat_atk, stat_def, stat_spd, level, username, equipped_weapon, class_chosen')
      .eq('id', challengedId).single();

    const calcStats = (p) => {
      const base = { tiger:{hp:100,sp:50}, dragon:{hp:110,sp:60}, wolf:{hp:95,sp:55} };
      const b = base[p.race] || { hp:100, sp:50 };
      return {
        hp: b.hp + (p.stat_vit||0)*10,
        sp: b.sp + (p.stat_ene||0)*8,
        atk: 10 + (p.stat_atk||0)*3
      };
    };

    const s1 = calcStats(p1), s2 = calcStats(p2);

    // Crear batalla en Supabase
    const { data: battle } = await supabase.from('pvp_battles').insert({
      player1_id: challenge.challenger_id,
      player2_id: challengedId,
      current_turn: challenge.challenger_id,
      player1_hp: s1.hp, player1_sp: s1.sp,
      player2_hp: s2.hp, player2_sp: s2.sp,
      gold_bet: challenge.gold_bet,
      status: 'active',
      last_action_type: 'start',
      last_attack_type: 'none'
    }).select().single();

    if (!battle) return;

    // Guardar en memoria
    pvpRooms.set(battle.id, {
      battleId: battle.id,
      p1: { id: p1.id, username: p1.username, ...s1,
            maxHp: s1.hp, maxSp: s1.sp,
            race: p1.race, class: p1.class,
            classChosen: p1.class_chosen, weapon: p1.equipped_weapon },
      p2: { id: p2.id, username: p2.username, ...s2,
            maxHp: s2.hp, maxSp: s2.sp,
            race: p2.race, class: p2.class,
            classChosen: p2.class_chosen, weapon: p2.equipped_weapon },
      currentTurn: challenge.challenger_id,
      goldBet: challenge.gold_bet,
      timer: null
    });

    // Notificar a ambos jugadores
    const room = 'pvp:' + battle.id;
    const p1Socket = [...io.sockets.sockets.values()].find(s=>s.playerId===p1.id);
    const p2Socket = [...io.sockets.sockets.values()].find(s=>s.playerId===p2.id);
    if (p1Socket) { p1Socket.join(room); p1Socket.pvpRoom = battle.id; }
    if (p2Socket) { p2Socket.join(room); p2Socket.pvpRoom = battle.id; }

    io.to(room).emit('pvp:battle_start', {
      battleId: battle.id,
      p1: pvpRooms.get(battle.id).p1,
      p2: pvpRooms.get(battle.id).p2,
      firstTurn: challenge.challenger_id
    });

    startPvpTimer(battle.id);
  });

  // Rechazar desafío
  socket.on('pvp:decline', async ({ challengeId, challengerId }) => {
    await supabase.from('pvp_challenges').update({ status: 'declined' }).eq('id', challengeId);
    io.to('player:' + challengerId).emit('pvp:declined', { challengeId });
  });

  // Acción PvP
  socket.on('pvp:action', async ({ battleId, playerId, action, attackType }) => {
    const room = pvpRooms.get(battleId);
    if (!room) return;
    if (room.currentTurn !== playerId) return;

    clearTimeout(room.timer);
    const isP1 = room.p1.id === playerId;
    const attacker = isP1 ? room.p1 : room.p2;
    const defender = isP1 ? room.p2 : room.p1;

    let dmg = 0, actionLog = '';

    if (action === 'attack') {
      const spCost = attackType === 'kick' ? 8 : 5;
      if (attacker.sp < spCost) {
        socket.emit('pvp:no_sp');
        room.currentTurn = room.currentTurn; // no cambiar turno
        return;
      }
      attacker.sp -= spCost;
      const crit = Math.random() < 0.15;
      dmg = Math.max(1, attacker.atk + Math.floor(Math.random()*6) - 2);
      if (crit) dmg = Math.floor(dmg * 1.5);
      defender.hp = Math.max(0, defender.hp - dmg);
      actionLog = `${attacker.username} atacó por ${dmg}${crit?' ¡CRÍTICO!':''}`;
    } else if (action === 'defend') {
      attacker.defending = true;
      actionLog = `${attacker.username} se defiende`;
    } else if (action === 'heal') {
      if (attacker.sp < 10) { socket.emit('pvp:no_sp'); return; }
      attacker.sp -= 10;
      const heal = Math.floor(attacker.maxHp * 0.2);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + heal);
      actionLog = `${attacker.username} se curó ${heal} HP`;
    }

    // Cambiar turno
    room.currentTurn = defender.id;
    attacker.defending = false;

    const state = {
      p1Hp: room.p1.hp, p1Sp: room.p1.sp,
      p2Hp: room.p2.hp, p2Sp: room.p2.sp,
      currentTurn: room.currentTurn,
      action, attackType, dmg, actionLog,
      attackerId: playerId
    };

    // Verificar fin
    if (defender.hp <= 0) {
      state.finished = true;
      state.winnerId = playerId;
      await finishPvpBattle(battleId, playerId, room);
    } else {
      startPvpTimer(battleId);
    }

    io.to('pvp:' + battleId).emit('pvp:state_update', state);
  });

  // Rendirse
  socket.on('pvp:flee', async ({ battleId, playerId }) => {
    const room = pvpRooms.get(battleId);
    if (!room) return;
    const winnerId = room.p1.id === playerId ? room.p2.id : room.p1.id;
    await finishPvpBattle(battleId, winnerId, room);
    io.to('pvp:' + battleId).emit('pvp:state_update', {
      finished: true, winnerId,
      p1Hp: room.p1.hp, p2Hp: room.p2.hp,
      p1Sp: room.p1.sp, p2Sp: room.p2.sp,
      actionLog: socket.playerId === playerId ?
        (room.p1.id===playerId?room.p1.username:room.p2.username) + ' se rindió' : ''
    });
  });

  // ============================================================
  // BOSS
  // ============================================================

  socket.on('boss:join', async ({ roomId, playerId, username, race, playerClass, hp, sp }) => {
    socket.join('boss:' + roomId);
    socket.bossRoom = roomId;
    socket.playerId = playerId;

    if (!bossRooms.has(roomId)) {
      bossRooms.set(roomId, {
        roomId, status: 'waiting',
        bossHp: 800, bossMaxHp: 800,
        players: [], currentTurnIndex: 0,
        skeletonAlive: false, skeletonHp: 0,
        groundTurns: 0, cursedPlayers: {},
        bossActionCount: 0, timer: null
      });
    }

    const room = bossRooms.get(roomId);
    const existing = room.players.find(p=>p.id===playerId);
    if (!existing) {
      room.players.push({ id:playerId, username, race, class:playerClass,
        hp, maxHp:hp, sp, maxSp:sp, isAlive:true,
        slot: room.players.length+1 });
    }

    io.to('boss:'+roomId).emit('boss:player_joined', { players: room.players });
    console.log(`Boss room ${roomId}: ${room.players.length} jugadores`);
  });

  socket.on('boss:start', ({ roomId, playerId }) => {
    const room = bossRooms.get(roomId);
    if (!room) return;
    room.status = 'active';
    room.currentTurnIndex = 0;
    io.to('boss:'+roomId).emit('boss:started', {
      players: room.players,
      bossHp: room.bossHp,
      firstTurnPlayerId: room.players[0]?.id
    });
    startBossTimer(roomId);
  });

  socket.on('boss:action', async ({ roomId, playerId, action, attackType, target }) => {
    const room = bossRooms.get(roomId);
    if (!room || room.status !== 'active') return;

    const alive = room.players.filter(p=>p.isAlive);
    const myIdx = alive.findIndex(p=>p.id===playerId);
    if (myIdx !== room.currentTurnIndex) return; // no es su turno

    clearTimeout(room.timer);
    const me = alive[myIdx];
    let actionLog = '', dmg = 0;

    if (action === 'attack') {
      const spCost = attackType === 'kick' ? 8 : 5;
      if (me.sp < spCost) { socket.emit('boss:no_sp'); return; }
      me.sp -= spCost;
      const crit = Math.random() < 0.15;
      dmg = Math.max(1, (me.atk||12) + Math.floor(Math.random()*6));
      if (crit) dmg = Math.floor(dmg*1.5);

      if (target === 'skeleton' && room.skeletonAlive) {
        room.skeletonHp = Math.max(0, room.skeletonHp - dmg);
        if (room.skeletonHp <= 0) room.skeletonAlive = false;
        actionLog = `${me.username} atacó al esqueleto: -${dmg}`;
      } else {
        room.bossHp = Math.max(0, room.bossHp - dmg);
        actionLog = `${me.username} atacó a la Necro: -${dmg}${crit?' ¡CRÍTICO!':''}`;
      }
    } else if (action === 'heal') {
      if (me.sp < 10) { socket.emit('boss:no_sp'); return; }
      me.sp -= 10;
      const heal = Math.floor(me.maxHp * 0.2);
      me.hp = Math.min(me.maxHp, me.hp + heal);
      actionLog = `${me.username} se curó ${heal} HP`;
    } else if (action === 'defend') {
      actionLog = `${me.username} se defiende`;
    }

    // Verificar victoria
    if (room.bossHp <= 0) {
      room.status = 'finished';
      await saveBossResult(roomId, true, room);
      io.to('boss:'+roomId).emit('boss:finished', { won: true, players: room.players });
      return;
    }

    // Siguiente turno
    room.currentTurnIndex = (room.currentTurnIndex + 1) % alive.length;
    const nextPlayer = alive[room.currentTurnIndex];

    // Si completó una ronda → turno del boss
    if (room.currentTurnIndex === 0) {
      io.to('boss:'+roomId).emit('boss:state_update', {
        players: room.players, bossHp: room.bossHp,
        skeletonAlive: room.skeletonAlive, skeletonHp: room.skeletonHp,
        groundTurns: room.groundTurns, cursedPlayers: room.cursedPlayers,
        currentTurnPlayerId: null, actionLog,
        bossTurn: true
      });
      setTimeout(() => doBossTurn(roomId), 2500);
    } else {
      io.to('boss:'+roomId).emit('boss:state_update', {
        players: room.players, bossHp: room.bossHp,
        skeletonAlive: room.skeletonAlive, skeletonHp: room.skeletonHp,
        groundTurns: room.groundTurns, cursedPlayers: room.cursedPlayers,
        currentTurnPlayerId: nextPlayer?.id, actionLog,
        bossTurn: false
      });
      startBossTimer(roomId);
    }
  });

  socket.on('boss:leave', ({ roomId, playerId }) => {
    const room = bossRooms.get(roomId);
    if (room) room.players = room.players.filter(p=>p.id!==playerId);
    socket.leave('boss:'+roomId);
  });

  socket.on('disconnect', () => {
    console.log(`❌ Desconectado: ${socket.id}`);
    // PvP — si estaba en batalla, el oponente gana
    if (socket.pvpRoom) {
      const room = pvpRooms.get(socket.pvpRoom);
      if (room && room.status !== 'finished') {
        const winnerId = room.p1.id === socket.playerId ? room.p2.id : room.p1.id;
        io.to('pvp:'+socket.pvpRoom).emit('pvp:state_update', {
          finished: true, winnerId,
          p1Hp: room.p1.hp, p2Hp: room.p2.hp,
          p1Sp: room.p1.sp, p2Sp: room.p2.sp,
          actionLog: 'Oponente desconectado'
        });
        finishPvpBattle(socket.pvpRoom, winnerId, room);
      }
    }
  });
});

// ============================================================
// FUNCIONES AUXILIARES
// ============================================================

function startPvpTimer(battleId) {
  const room = pvpRooms.get(battleId);
  if (!room) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    // Auto-ataque si se acaba el tiempo
    const currentPlayer = room.p1.id === room.currentTurn ? room.p1 : room.p2;
    io.to('pvp:'+battleId).emit('pvp:timeout', { playerId: room.currentTurn });
    // Simular puño automático
    const defender = room.p1.id === room.currentTurn ? room.p2 : room.p1;
    const dmg = Math.max(1, currentPlayer.atk + Math.floor(Math.random()*4));
    defender.hp = Math.max(0, defender.hp - dmg);
    room.currentTurn = defender.id;
    const state = {
      p1Hp: room.p1.hp, p1Sp: room.p1.sp,
      p2Hp: room.p2.hp, p2Sp: room.p2.sp,
      currentTurn: room.currentTurn,
      action: 'attack', attackType: 'punch', dmg,
      actionLog: 'Tiempo agotado — auto-ataque',
      attackerId: currentPlayer.id
    };
    if (defender.hp <= 0) {
      state.finished = true; state.winnerId = currentPlayer.id;
      finishPvpBattle(battleId, currentPlayer.id, room);
    } else {
      startPvpTimer(battleId);
    }
    io.to('pvp:'+battleId).emit('pvp:state_update', state);
  }, 30000);
}

async function finishPvpBattle(battleId, winnerId, room) {
  clearTimeout(room.timer);
  pvpRooms.delete(battleId);
  const loserId = room.p1.id === winnerId ? room.p2.id : room.p1.id;
  const goldBet = room.goldBet;
  const winnerData = room.p1.id === winnerId ? room.p1 : room.p2;
  const loserData  = room.p1.id === loserId  ? room.p1 : room.p2;

  await supabase.from('pvp_battles').update({
    status: 'finished', winner_id: winnerId,
    player1_hp: room.p1.hp, player2_hp: room.p2.hp
  }).eq('id', battleId);

  // Oro: ganador al buzón, perdedor pierde oro
  await supabase.from('mailbox').insert({
    player_id: winnerId, type: 'pvp_reward',
    gold_amount: goldBet,
    message: `⚔️ Victoria PvP contra ${loserData.username} (${loserData.race} Lv.?)`,
    claimed: false
  });
  const { data: loser } = await supabase.from('players').select('gold').eq('id', loserId).single();
  if (loser) {
    await supabase.from('players').update({
      gold: Math.max(0, loser.gold - goldBet),
      pvp_status: 'idle'
    }).eq('id', loserId);
  }
  await supabase.from('players').update({ pvp_status: 'idle' }).eq('id', winnerId);
}

function startBossTimer(roomId) {
  const room = bossRooms.get(roomId);
  if (!room) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    const alive = room.players.filter(p=>p.isAlive);
    const current = alive[room.currentTurnIndex];
    if (!current) return;
    io.to('boss:'+roomId).emit('boss:timeout', { playerId: current.id });
    // Auto puño
    room.bossHp = Math.max(0, room.bossHp - 8);
    room.currentTurnIndex = (room.currentTurnIndex+1) % alive.length;
    if (room.currentTurnIndex === 0) {
      setTimeout(()=>doBossTurn(roomId), 800);
    } else {
      io.to('boss:'+roomId).emit('boss:state_update', {
        players: room.players, bossHp: room.bossHp,
        skeletonAlive: room.skeletonAlive, skeletonHp: room.skeletonHp,
        groundTurns: room.groundTurns, cursedPlayers: room.cursedPlayers,
        currentTurnPlayerId: alive[room.currentTurnIndex]?.id,
        actionLog: 'Tiempo agotado', bossTurn: false
      });
      startBossTimer(roomId);
    }
  }, 30000);
}

const BOSS_ATTACKS = [
  { id:'curse',  name:'Maldición',        effect:'curse',  dmg:0  },
  { id:'summon', name:'Invocar Esqueleto', effect:'summon', dmg:10 },
  { id:'burial', name:'Entierro',          effect:'burial', dmg:15 },
];

function doBossTurn(roomId) {
  const room = bossRooms.get(roomId);
  if (!room || room.status !== 'active') return;

  const alive = room.players.filter(p=>p.isAlive);
  if (!alive.length) return;

  const n = room.bossActionCount || 0;
  const atkIdx = n === 0 ? 2 : Math.floor(Math.random()*3);
  room.bossActionCount = n + 1;
  const atk = BOSS_ATTACKS[atkIdx];
  const target = alive[Math.floor(Math.random()*alive.length)];

  let actionLog = '';

  if (atk.effect === 'curse') {
    room.cursedPlayers[target.id] = 2;
    actionLog = `💜 ¡${target.username} quedó maldito! -30HP los próximos 2 turnos`;
    // NO aplicar daño inmediato — empieza en el siguiente turno del boss
  } else if (atk.effect === 'summon') {
    if (!room.skeletonAlive) { room.skeletonAlive = true; room.skeletonHp = 30; }
    alive.forEach(p => { p.hp = Math.max(0, p.hp - atk.dmg); });
    actionLog = '🦴 ¡Esqueleto invocado! -' + atk.dmg + 'HP al equipo';
  } else if (atk.effect === 'burial') {
    room.groundTurns = 2;
    alive.forEach(p => { p.hp = Math.max(0, p.hp - atk.dmg); });
    actionLog = '💀 ¡Entierro! -' + atk.dmg + 'HP. Esqueletos en suelo 2 rondas';
  }

  // Aplicar maldiciones ACTIVAS (de turnos anteriores, no del actual)
  Object.keys(room.cursedPlayers).forEach(pid => {
    // Solo aplicar si la maldición ya existía antes de este turno
    if (atk.effect === 'curse' && room.cursedPlayers[pid] === 2) return; // recién aplicada
    if (room.cursedPlayers[pid] > 0) {
      const cp = room.players.find(p => p.id === pid);
      if (cp && cp.isAlive) cp.hp = Math.max(0, cp.hp - 30);
      room.cursedPlayers[pid]--;
      if (room.cursedPlayers[pid] <= 0) delete room.cursedPlayers[pid];
    }
  });

  // Daño del suelo — solo si ya estaba activo ANTES de este turno
  if (room.groundTurns > 0 && atk.effect !== 'burial') {
    alive.forEach(p => { p.hp = Math.max(0, p.hp - 10); });
    room.groundTurns = Math.max(0, room.groundTurns - 1);
  }

  // Verificar muertes
  room.players.forEach(p => { if (p.hp <= 0) p.isAlive = false; });
  const stillAlive = room.players.filter(p=>p.isAlive);

  if (stillAlive.length === 0) {
    room.status = 'finished';
    saveBossResult(roomId, false, room);
    io.to('boss:'+roomId).emit('boss:finished', { won: false, players: room.players });
    return;
  }

  room.currentTurnIndex = 0;
  io.to('boss:'+roomId).emit('boss:state_update', {
    players: room.players, bossHp: room.bossHp,
    skeletonAlive: room.skeletonAlive, skeletonHp: room.skeletonHp,
    groundTurns: room.groundTurns, cursedPlayers: room.cursedPlayers,
    currentTurnPlayerId: stillAlive[0]?.id,
    actionLog, bossAttack: atk.id, bossTurn: true
  });
  startBossTimer(roomId);
}

async function saveBossResult(roomId, won, room) {
  if (won) {
    for (const p of room.players) {
      await supabase.from('mailbox').insert({
        player_id: p.id, type: 'boss_reward',
        gold_amount: 200,
        message: '🏆 Victoria contra la Nigromante! +200 🪙',
        claimed: false
      });
    }
  }
  await supabase.from('boss_rooms').update({
    status: won ? 'finished' : 'failed',
    boss_hp: room.bossHp
  }).eq('id', roomId);
  bossRooms.delete(roomId);
}

// ============================================================
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`🎮 Arcane Rift Server corriendo en puerto ${PORT}`);
});
