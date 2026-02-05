const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

// Game storage
const games = {};

// Generate random room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Generate 6 unique random numbers from 1-15 for a single player
function generatePlayerNumbers() {
  const numbers = [];
  while (numbers.length < 6) {
    const num = Math.floor(Math.random() * 15) + 1;
    if (!numbers.includes(num)) numbers.push(num);
  }
  return numbers;
}

// Assign imposters randomly
function assignRoles(players, imposterCount) {
  const playerIds = Object.keys(players);
  const shuffled = playerIds.sort(() => Math.random() - 0.5);
  const imposters = shuffled.slice(0, imposterCount);
  
  playerIds.forEach(id => {
    players[id].role = imposters.includes(id) ? 'imposter' : 'crewmate';
  });
}

// Calculate task progress
function calculateTaskProgress(game) {
  let totalTasks = 0;
  let completedTasks = 0;
  
  Object.values(game.players).forEach(player => {
    if (player.role === 'crewmate') {
      totalTasks += 6;
      completedTasks += player.tasksCompleted || 0;
    }
  });
  
  return totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
}

// Count dead players
function countDeadPlayers(game) {
  return Object.values(game.players).filter(p => p.status === 'dead' || p.status === 'voted-out').length;
}

// Get alive players
function getAlivePlayers(game) {
  return Object.entries(game.players)
    .filter(([id, p]) => p.status === 'alive')
    .map(([id, p]) => ({ id, name: p.name, numbers: p.numbers }));
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Check if room exists (without joining)
  socket.on('check-room', ({ roomCode }) => {
    const game = games[roomCode.toUpperCase()];
    if (!game) {
      socket.emit('room-check-result', { exists: false, message: 'Game not found' });
    } else if (game.started) {
      socket.emit('room-check-result', { exists: false, message: 'Game already started' });
    } else {
      socket.emit('room-check-result', { exists: true });
    }
  });

  // Host creates a game
  socket.on('create-game', ({ imposterCount }) => {
    const roomCode = generateRoomCode();
    games[roomCode] = {
      hostId: socket.id,
      imposterCount: Math.min(imposterCount || 1, 3),
      players: {},
      started: false,
      meeting: null,
      votes: {},
      photos: []
    };
    
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;
    
    socket.emit('game-created', { roomCode });
    console.log('Game created:', roomCode);
  });
  
  // Host rejoins existing game
  socket.on('rejoin-host', ({ roomCode }) => {
    const game = games[roomCode];
    
    if (!game) {
      socket.emit('error', { message: 'Game not found' });
      return;
    }
    
    // Update host socket ID
    game.hostId = socket.id;
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;
    
    // Send current player list
    const playerList = Object.entries(game.players).map(([id, p]) => ({
      id,
      name: p.name,
      numbers: p.numbers || []
    }));
    
    socket.emit('player-joined', { players: playerList });
    console.log('Host rejoined game:', roomCode);
  });

  // Player joins a game
  socket.on('join-game', ({ roomCode, playerName }) => {
    const game = games[roomCode.toUpperCase()];
    
    if (!game) {
      socket.emit('error', { message: 'Game not found' });
      return;
    }
    
    // Check if player with this name already exists (reconnection)
    const existingPlayer = Object.entries(game.players).find(([id, p]) => p.name === playerName);
    
    // Handle reconnection during started game
    if (game.started) {
      if (existingPlayer) {
        // Allow reconnection - update socket ID
        const [oldId, playerData] = existingPlayer;
        delete game.players[oldId];
        game.players[socket.id] = playerData;
        
        socket.join(roomCode.toUpperCase());
        socket.roomCode = roomCode.toUpperCase();
        socket.isHost = false;
        
        // Send current game state to reconnected player
        socket.emit('game-started', {
          role: playerData.role,
          numbers: playerData.numbers,
          tasks: 6
        });
        
        if (playerData.status === 'dead' || playerData.status === 'voted-out') {
          socket.emit('you-died');
        }
        
        socket.emit('task-completed', { 
          completed: playerData.tasksCompleted,
          total: 6
        });
        socket.emit('task-progress', { progress: calculateTaskProgress(game) });
        socket.emit('dead-count-updated', { deadCount: countDeadPlayers(game) });
        return;
      }
      socket.emit('error', { message: 'Game already started' });
      return;
    }
    
    if (existingPlayer) {
      // Player is reconnecting - remove old entry and add with new socket ID
      const [oldId, playerData] = existingPlayer;
      delete game.players[oldId];
      game.players[socket.id] = playerData;
    } else {
      // New player - generate 6 numbers for them
      game.players[socket.id] = {
        name: playerName,
        numbers: generatePlayerNumbers(),
        role: null,
        status: 'alive',
        tasksCompleted: 0,
        lastMeetingTime: 0
      };
    }
    
    socket.join(roomCode.toUpperCase());
    socket.roomCode = roomCode.toUpperCase();
    socket.isHost = false;
    
    socket.emit('joined-game', { 
      roomCode: roomCode.toUpperCase(),
      playerName,
      playerNumbers: game.players[socket.id].numbers
    });
    
    // Notify host
    io.to(game.hostId).emit('player-joined', {
      players: Object.entries(game.players).map(([id, p]) => ({
        id,
        name: p.name,
        numbers: p.numbers
      }))
    });
    
    console.log(`${playerName} joined game ${roomCode}`);
  });

  // Host starts the game
  socket.on('start-game', () => {
    const game = games[socket.roomCode];
    if (!game || !socket.isHost) return;
    
    if (Object.keys(game.players).length < 2) {
      socket.emit('error', { message: 'Need at least 2 players' });
      return;
    }
    
    assignRoles(game.players, game.imposterCount);
    game.started = true;
    
    // Send role info to each player
    Object.entries(game.players).forEach(([playerId, player]) => {
      io.to(playerId).emit('game-started', {
        role: player.role,
        numbers: player.numbers,
        tasks: 6
      });
    });
    
    // Send all roles to host
    socket.emit('game-started-host', {
      players: Object.entries(game.players).map(([id, p]) => ({
        id,
        name: p.name,
        numbers: p.numbers,
        role: p.role,
        status: p.status
      }))
    });
    
    console.log('Game started:', socket.roomCode);
  });

  // Player completes a task
  socket.on('complete-task', () => {
    const game = games[socket.roomCode];
    if (!game || !game.started) return;
    
    const player = game.players[socket.id];
    if (!player || player.role !== 'crewmate') return;
    if (player.tasksCompleted >= 6) return;
    
    player.tasksCompleted++;
    const progress = calculateTaskProgress(game);
    
    // Notify all players of task progress
    io.to(socket.roomCode).emit('task-progress', { progress });
    
    // Notify host
    io.to(game.hostId).emit('host-ping', {
      type: 'task',
      message: `${player.name} completed a task`,
      progress
    });
    
    socket.emit('task-completed', { 
      completed: player.tasksCompleted,
      total: 6
    });
    
    // Check win condition (75%)
    if (progress >= 75) {
      io.to(socket.roomCode).emit('game-over', { winner: 'crewmates', reason: 'Tasks completed!' });
      io.to(game.hostId).emit('game-over', { winner: 'crewmates', reason: 'Tasks completed!' });
    }
  });

  // Player calls emergency meeting
  socket.on('call-meeting', ({ type }) => {
    const game = games[socket.roomCode];
    if (!game || !game.started || game.meeting) return;
    
    const player = game.players[socket.id];
    if (!player || player.status !== 'alive') return;
    
    // Check cooldown (60 seconds)
    const now = Date.now();
    if (now - player.lastMeetingTime < 60000) {
      const remaining = Math.ceil((60000 - (now - player.lastMeetingTime)) / 1000);
      socket.emit('error', { message: `Cooldown: ${remaining}s remaining` });
      return;
    }
    
    player.lastMeetingTime = now;
    
    // Request host to start meeting
    io.to(game.hostId).emit('meeting-request', {
      type,
      calledBy: player.name,
      playerId: socket.id
    });
  });

  // Host approves and starts meeting
  socket.on('start-meeting', ({ type, calledBy }) => {
    const game = games[socket.roomCode];
    if (!game || !socket.isHost) return;
    
    game.meeting = {
      type,
      calledBy,
      phase: 'discussion',
      startTime: Date.now()
    };
    game.votes = {};
    
    const deadPlayers = Object.entries(game.players)
      .filter(([id, p]) => p.status === 'dead' || p.status === 'voted-out')
      .map(([id, p]) => ({ id, name: p.name, numbers: p.numbers }));
    
    const alivePlayers = getAlivePlayers(game);
    
    // Notify all players
    io.to(socket.roomCode).emit('meeting-started', {
      type,
      calledBy,
      alivePlayers,
      deadPlayers,
      discussionTime: 60,
      voteTime: 15
    });
    
    // Start discussion timer (60 seconds)
    setTimeout(() => {
      if (game.meeting && game.meeting.phase === 'discussion') {
        game.meeting.phase = 'voting';
        io.to(socket.roomCode).emit('voting-started', {
          alivePlayers,
          voteTime: 15
        });
        
        // Start vote timer (15 seconds)
        setTimeout(() => {
          if (game.meeting && game.meeting.phase === 'voting') {
            endVoting(socket.roomCode);
          }
        }, 15000);
      }
    }, 60000);
  });

  // Player votes
  socket.on('vote', ({ targetId }) => {
    const game = games[socket.roomCode];
    if (!game || !game.meeting || game.meeting.phase !== 'voting') return;
    
    const player = game.players[socket.id];
    if (!player || player.status !== 'alive') return;
    
    game.votes[socket.id] = targetId; // targetId can be null for skip
    
    // Notify host of vote
    io.to(game.hostId).emit('host-ping', {
      type: 'vote',
      message: `${player.name} voted`
    });
    
    socket.emit('vote-confirmed');
  });

  // Host marks player as dead (killed IRL)
  socket.on('mark-dead', ({ playerId }) => {
    const game = games[socket.roomCode];
    if (!game || !socket.isHost) return;
    
    const player = game.players[playerId];
    if (!player) return;
    
    player.status = 'dead';
    
    const deadCount = countDeadPlayers(game);
    
    // Notify the killed player
    io.to(playerId).emit('you-died');
    
    // Notify all players of dead count
    io.to(socket.roomCode).emit('dead-count-updated', { deadCount });
    
    // Update host
    socket.emit('player-status-updated', {
      playerId,
      status: 'dead',
      deadCount
    });
  });
  
  // Player marks themselves as dead
  socket.on('mark-self-dead', () => {
    const game = games[socket.roomCode];
    if (!game || !game.started) return;
    
    const player = game.players[socket.id];
    if (!player || player.status !== 'alive') return;
    
    player.status = 'dead';
    const deadCount = countDeadPlayers(game);
    
    // Notify the player
    socket.emit('you-died');
    
    // Notify all players of dead count
    io.to(socket.roomCode).emit('dead-count-updated', { deadCount });
    
    // Notify host
    io.to(game.hostId).emit('host-ping', {
      type: 'death',
      message: `${player.name} marked themselves as dead`
    });
    io.to(game.hostId).emit('player-status-updated', {
      playerId: socket.id,
      status: 'dead',
      deadCount
    });
  });

  // Photo upload
  socket.on('upload-photo', ({ photoData }) => {
    const game = games[socket.roomCode];
    if (!game) return;
    
    const player = game.players[socket.id];
    if (!player) return;
    
    game.photos.push({
      from: player.name,
      data: photoData,
      time: Date.now()
    });
    
    // Notify host
    io.to(game.hostId).emit('photo-received', {
      from: player.name,
      data: photoData
    });
    
    socket.emit('photo-sent');
  });

  // Get game state (for reconnection)
  socket.on('get-state', () => {
    const game = games[socket.roomCode];
    if (!game) return;
    
    const player = game.players[socket.id];
    if (!player) return;
    
    socket.emit('state-update', {
      started: game.started,
      role: player.role,
      status: player.status,
      tasksCompleted: player.tasksCompleted,
      taskProgress: calculateTaskProgress(game),
      deadCount: countDeadPlayers(game),
      meeting: game.meeting
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Keep player in game for potential reconnection
  });
});

function endVoting(roomCode) {
  const game = games[roomCode];
  if (!game) return;
  
  // Count votes
  const voteCounts = {};
  let skipVotes = 0;
  
  Object.values(game.votes).forEach(targetId => {
    if (targetId === null || targetId === 'skip') {
      skipVotes++;
    } else {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
  });
  
  // Find max votes
  let maxVotes = skipVotes;
  let ejectedId = null;
  
  Object.entries(voteCounts).forEach(([id, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      ejectedId = id;
    } else if (count === maxVotes) {
      ejectedId = null; // Tie = no ejection
    }
  });
  
  let ejectedPlayer = null;
  if (ejectedId && game.players[ejectedId]) {
    game.players[ejectedId].status = 'voted-out';
    ejectedPlayer = {
      name: game.players[ejectedId].name,
      role: game.players[ejectedId].role
    };
    
    // Notify ejected player
    io.to(ejectedId).emit('you-ejected');
  }
  
  const deadCount = countDeadPlayers(game);
  
  // End meeting
  game.meeting = null;
  game.votes = {};
  
  // Send results to all
  io.to(roomCode).emit('voting-results', {
    ejected: ejectedPlayer,
    deadCount,
    voteCounts
  });
  
  // Check win conditions
  const alivePlayers = Object.values(game.players).filter(p => p.status === 'alive');
  const aliveImposters = alivePlayers.filter(p => p.role === 'imposter').length;
  const aliveCrewmates = alivePlayers.filter(p => p.role === 'crewmate').length;
  
  if (aliveImposters === 0) {
    io.to(roomCode).emit('game-over', { winner: 'crewmates', reason: 'All imposters ejected!' });
    io.to(game.hostId).emit('game-over', { winner: 'crewmates', reason: 'All imposters ejected!' });
  } else if (aliveImposters >= aliveCrewmates) {
    io.to(roomCode).emit('game-over', { winner: 'imposters', reason: 'Imposters win!' });
    io.to(game.hostId).emit('game-over', { winner: 'imposters', reason: 'Imposters win!' });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
