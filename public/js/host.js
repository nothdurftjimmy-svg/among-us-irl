const socket = io();

// Get stored data
const roomCode = sessionStorage.getItem('roomCode');
let players = [];
let pendingMeeting = null;
let meetingTimer = null;

if (!roomCode) {
  window.location.href = 'index.html';
}

// Rejoin the existing game as host on connect
socket.on('connect', () => {
  socket.emit('rejoin-host', { roomCode });
});

// Display room code
document.getElementById('roomCode').textContent = roomCode;
document.getElementById('roomCodeGame').textContent = roomCode;

// Player joined
socket.on('player-joined', ({ players: playerList }) => {
  players = playerList;
  updatePlayerList();
});

function updatePlayerList() {
  const list = document.getElementById('playerList');
  document.getElementById('playerCount').textContent = players.length;
  
  list.innerHTML = players.map(p => `
    <div class="player-item">
      <span>${p.name} [${(p.numbers || []).join(', ')}]</span>
    </div>
  `).join('');
}

// Start game button
document.getElementById('startGameBtn').onclick = () => {
  socket.emit('start-game');
};

// Game started - show host dashboard
socket.on('game-started-host', ({ players: playerList }) => {
  players = playerList;
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('gameView').classList.remove('hidden');
  updateGamePlayerList();
});

function updateGamePlayerList() {
  const list = document.getElementById('gamePlayerList');
  
  list.innerHTML = players.map(p => `
    <div class="player-item ${p.status !== 'alive' ? 'dead' : ''}">
      <div>
        <span>${p.name} [${(p.numbers || []).join(', ')}]</span>
        <span class="role ${p.role}">${p.role.toUpperCase()}</span>
      </div>
      ${p.status === 'alive' ? `
        <button class="btn btn-kill" onclick="markDead('${p.id}')">MARK DEAD</button>
      ` : `<span>☠️ ${p.status.toUpperCase()}</span>`}
    </div>
  `).join('');
}

// Mark player as dead
window.markDead = (playerId) => {
  socket.emit('mark-dead', { playerId });
};

socket.on('player-status-updated', ({ playerId, status, deadCount }) => {
  const player = players.find(p => p.id === playerId);
  if (player) {
    player.status = status;
  }
  document.getElementById('deadCount').textContent = deadCount;
  updateGamePlayerList();
});

// Task progress
socket.on('task-progress', ({ progress }) => {
  document.getElementById('taskProgress').style.width = progress + '%';
  document.getElementById('taskPercent').textContent = Math.round(progress) + '%';
});

// Host pings/notifications
socket.on('host-ping', ({ type, message }) => {
  addPing(message);
});

function addPing(message) {
  const list = document.getElementById('pingList');
  const time = new Date().toLocaleTimeString();
  list.innerHTML = `<div class="ping-item">[${time}] ${message}</div>` + list.innerHTML;
}

// Meeting request
socket.on('meeting-request', ({ type, calledBy, playerId }) => {
  pendingMeeting = { type, calledBy };
  
  const title = type === 'emergency' ? '🚨 EMERGENCY MEETING' : '☠️ BODY REPORTED';
  document.getElementById('meetingRequestTitle').textContent = title;
  document.getElementById('meetingRequestInfo').textContent = `Called by: ${calledBy}`;
  document.getElementById('meetingRequest').classList.remove('hidden');
  
  // Play sound
  playMeetingSound();
  
  addPing(`${title} requested by ${calledBy}`);
});

// Start meeting button
document.getElementById('startMeetingBtn').onclick = () => {
  if (pendingMeeting) {
    socket.emit('start-meeting', pendingMeeting);
    document.getElementById('meetingRequest').classList.add('hidden');
    pendingMeeting = null;
  }
};

// Meeting started
socket.on('meeting-started', ({ type, calledBy, discussionTime, voteTime }) => {
  const title = type === 'emergency' ? 'EMERGENCY MEETING' : 'BODY REPORTED';
  document.getElementById('meetingTitle').textContent = title;
  document.getElementById('meetingCaller').textContent = `Called by: ${calledBy}`;
  document.getElementById('meetingPhase').textContent = 'DISCUSSION PHASE';
  document.getElementById('meetingOverlay').classList.remove('hidden');
  
  // Start timer
  startTimer(discussionTime, () => {
    document.getElementById('meetingPhase').textContent = 'VOTING PHASE';
    startTimer(voteTime, () => {});
  });
});

// Voting started
socket.on('voting-started', () => {
  document.getElementById('meetingPhase').textContent = 'VOTING PHASE';
});

// Voting results
socket.on('voting-results', ({ ejected, deadCount }) => {
  document.getElementById('meetingOverlay').classList.add('hidden');
  clearInterval(meetingTimer);
  
  document.getElementById('deadCount').textContent = deadCount;
  
  if (ejected) {
    const player = players.find(p => p.name === ejected.name);
    if (player) {
      player.status = 'voted-out';
    }
    addPing(`${ejected.name} was ejected (${ejected.role})`);
  } else {
    addPing('No one was ejected');
  }
  
  updateGamePlayerList();
});

// Photo received
let photoId = 0;
socket.on('photo-received', ({ from, data, playerId }) => {
  document.getElementById('photosArea').classList.remove('hidden');
  const list = document.getElementById('photoList');
  
  const currentPhotoId = photoId++;
  const div = document.createElement('div');
  div.className = 'photo-item';
  div.id = `photo-${currentPhotoId}`;
  div.innerHTML = `
    <img src="${data}" alt="Photo from ${from}">
    <p>From: ${from} - ${new Date().toLocaleTimeString()}</p>
    <div class="photo-buttons">
      <button class="btn btn-approve" onclick="approvePhoto('${playerId}', ${currentPhotoId})">✓ GOOD</button>
      <button class="btn btn-reject" onclick="rejectPhoto('${playerId}', ${currentPhotoId})">✗ BAD</button>
    </div>
  `;
  list.insertBefore(div, list.firstChild);
  
  addPing(`📷 Photo received from ${from}`);
});

// Approve photo
window.approvePhoto = (playerId, photoElementId) => {
  socket.emit('photo-response', { playerId, approved: true });
  const photoDiv = document.getElementById(`photo-${photoElementId}`);
  if (photoDiv) {
    photoDiv.querySelector('.photo-buttons').innerHTML = '<span class="approved">✓ APPROVED</span>';
  }
};

// Reject photo
window.rejectPhoto = (playerId, photoElementId) => {
  socket.emit('photo-response', { playerId, approved: false });
  const photoDiv = document.getElementById(`photo-${photoElementId}`);
  if (photoDiv) {
    photoDiv.querySelector('.photo-buttons').innerHTML = '<span class="rejected">✗ REJECTED</span>';
  }
};

// Game over
socket.on('game-over', ({ winner, reason }) => {
  const overlay = document.getElementById('gameOverOverlay');
  overlay.classList.remove('hidden');
  overlay.classList.add(winner);
  
  document.getElementById('gameOverTitle').textContent = 
    winner === 'crewmates' ? '🎉 CREWMATES WIN!' : '😈 IMPOSTERS WIN!';
  document.getElementById('gameOverReason').textContent = reason;
});

// Timer function
function startTimer(seconds, callback) {
  let remaining = seconds;
  document.getElementById('meetingTimer').textContent = remaining;
  
  clearInterval(meetingTimer);
  meetingTimer = setInterval(() => {
    remaining--;
    document.getElementById('meetingTimer').textContent = remaining;
    
    if (remaining <= 0) {
      clearInterval(meetingTimer);
      callback();
    }
  }, 1000);
}

// Play meeting sound - LOUD emergency alert!
function playMeetingSound() {
  // Play loud emergency beeps using Web Audio API
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    
    const playBeep = (startTime, frequency) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      
      oscillator.frequency.value = frequency;
      oscillator.type = 'square';
      gain.gain.value = 0.7; // LOUD
      
      oscillator.start(ctx.currentTime + startTime);
      oscillator.stop(ctx.currentTime + startTime + 0.15);
    };
    
    // Emergency pattern: HIGH-LOW-HIGH-LOW
    playBeep(0, 880);
    playBeep(0.2, 440);
    playBeep(0.4, 880);
    playBeep(0.6, 440);
    playBeep(0.8, 880);
    playBeep(1.0, 440);
    playBeep(1.2, 988);
    
    setTimeout(() => ctx.close(), 2000);
  } catch (e) {}
}

// Error handling
socket.on('error', ({ message }) => {
  alert(message);
});
