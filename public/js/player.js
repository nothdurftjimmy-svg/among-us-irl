const socket = io();

// Get stored data
const roomCode = sessionStorage.getItem('roomCode');
const playerName = sessionStorage.getItem('playerName');
let playerNumbers = JSON.parse(sessionStorage.getItem('playerNumbers') || '[]');

let myRole = null;
let myStatus = 'alive';
let tasksCompleted = 0;
let lastMeetingTime = 0;
let meetingTimer = null;
let alivePlayers = [];

if (!roomCode || !playerName) {
  window.location.href = 'index.html';
}

// Display initial info
document.getElementById('roomCode').textContent = roomCode;
document.getElementById('playerName').textContent = playerName;
if (playerNumbers.length > 0) {
  document.getElementById('playerNumbers').textContent = playerNumbers.join(', ');
}

// Join game on connect
socket.on('connect', () => {
  socket.emit('join-game', { roomCode, playerName });
});

// Joined successfully
socket.on('joined-game', ({ playerNumbers: numbers }) => {
  if (numbers) {
    playerNumbers = numbers;
    sessionStorage.setItem('playerNumbers', JSON.stringify(numbers));
    document.getElementById('playerNumbers').textContent = numbers.join(', ');
  }
});

// Game started
socket.on('game-started', ({ role, numbers, tasks }) => {
  myRole = role;
  if (numbers) {
    playerNumbers = numbers;
  }
  
  document.getElementById('waitingView').classList.add('hidden');
  document.getElementById('gameView').classList.remove('hidden');
  
  document.getElementById('playerInfo').textContent = `${playerName} [${playerNumbers.join(', ')}]`;
  
  const roleDisplay = document.getElementById('roleDisplay');
  roleDisplay.textContent = role.toUpperCase();
  roleDisplay.className = 'role-display ' + role;
  
  // Hide mark dead button for imposters
  if (role === 'imposter') {
    document.getElementById('markSelfDeadBtn').classList.add('hidden');
  }
});

// Complete task button
document.getElementById('completeTaskBtn').onclick = () => {
  socket.emit('complete-task');
};

// Mark self as dead button
document.getElementById('markSelfDeadBtn').onclick = () => {
  if (confirm('Are you sure you want to mark yourself as dead?')) {
    socket.emit('mark-self-dead');
  }
};

// Ghost complete task
document.getElementById('ghostCompleteTaskBtn').onclick = () => {
  if (myRole === 'crewmate') {
    socket.emit('complete-task');
  }
};

// Task completed
socket.on('task-completed', ({ completed, total }) => {
  tasksCompleted = completed;
  
  if (completed >= total) {
    document.getElementById('completeTaskBtn').disabled = true;
    document.getElementById('completeTaskBtn').textContent = 'ALL TASKS DONE!';
    document.getElementById('ghostCompleteTaskBtn').disabled = true;
    document.getElementById('ghostCompleteTaskBtn').textContent = 'ALL TASKS DONE!';
  }
});

// Task progress update
socket.on('task-progress', ({ progress }) => {
  const percent = Math.round(progress) + '%';
  document.getElementById('taskProgress').style.width = percent;
  document.getElementById('taskPercent').textContent = percent;
  document.getElementById('ghostTaskProgress').style.width = percent;
  document.getElementById('ghostTaskPercent').textContent = percent;
});

// Dead count update
socket.on('dead-count-updated', ({ deadCount }) => {
  document.getElementById('deadCount').textContent = deadCount;
  document.getElementById('ghostDeadCount').textContent = deadCount;
});

// Emergency meeting button
document.getElementById('emergencyBtn').onclick = () => {
  const now = Date.now();
  if (now - lastMeetingTime < 60000) {
    const remaining = Math.ceil((60000 - (now - lastMeetingTime)) / 1000);
    showError(`Cooldown: ${remaining}s remaining`);
    return;
  }
  
  socket.emit('call-meeting', { type: 'emergency' });
  lastMeetingTime = now;
  updateCooldowns();
};

// Report body button
document.getElementById('reportBodyBtn').onclick = () => {
  const now = Date.now();
  if (now - lastMeetingTime < 60000) {
    const remaining = Math.ceil((60000 - (now - lastMeetingTime)) / 1000);
    showError(`Cooldown: ${remaining}s remaining`);
    return;
  }
  
  socket.emit('call-meeting', { type: 'report' });
  lastMeetingTime = now;
  updateCooldowns();
};

// Update cooldown display
function updateCooldowns() {
  const updateDisplay = () => {
    const now = Date.now();
    const elapsed = now - lastMeetingTime;
    
    if (elapsed < 60000) {
      const remaining = Math.ceil((60000 - elapsed) / 1000);
      document.getElementById('emergencyCooldown').textContent = `(${remaining}s)`;
      document.getElementById('reportCooldown').textContent = `(${remaining}s)`;
      setTimeout(updateDisplay, 1000);
    } else {
      document.getElementById('emergencyCooldown').textContent = '';
      document.getElementById('reportCooldown').textContent = '';
    }
  };
  updateDisplay();
}

// Meeting started
socket.on('meeting-started', ({ type, calledBy, alivePlayers: alive, deadPlayers, discussionTime, voteTime }) => {
  alivePlayers = alive;
  
  // Play sound
  playMeetingSound();
  
  // Show alert first
  const alertTitle = type === 'emergency' ? '🚨 EMERGENCY MEETING' : '☠️ BODY REPORTED';
  document.getElementById('meetingAlertTitle').textContent = alertTitle;
  document.getElementById('meetingAlert').classList.remove('hidden');
  
  // After 2 seconds, show meeting overlay
  setTimeout(() => {
    document.getElementById('meetingAlert').classList.add('hidden');
    
    if (myStatus === 'alive') {
      // Show regular meeting view
      document.getElementById('meetingTitle').textContent = alertTitle;
      document.getElementById('meetingCaller').textContent = `Called by: ${calledBy}`;
      document.getElementById('meetingPhase').textContent = 'DISCUSSION - Talk it out!';
      document.getElementById('votingSection').classList.add('hidden');
      document.getElementById('voteConfirmed').classList.add('hidden');
      document.getElementById('meetingOverlay').classList.remove('hidden');
      
      // Show dead players
      if (deadPlayers && deadPlayers.length > 0) {
        document.getElementById('deadPlayersDisplay').classList.remove('hidden');
        document.getElementById('deadPlayersList').innerHTML = 
          deadPlayers.map(p => `<span>💀 ${p.name} [${(p.numbers || []).join(', ')}]</span>`).join('<br>');
      } else {
        document.getElementById('deadPlayersDisplay').classList.add('hidden');
      }
      
      // Start discussion timer
      startTimer(discussionTime, 'meetingTimer');
    } else {
      // Show ghost meeting view (skulls)
      document.getElementById('ghostMeetingOverlay').classList.remove('hidden');
      startTimer(discussionTime + voteTime, 'ghostMeetingTimer');
    }
  }, 2000);
});

// Voting started
socket.on('voting-started', ({ alivePlayers: alive, voteTime }) => {
  alivePlayers = alive;
  
  if (myStatus === 'alive') {
    document.getElementById('meetingPhase').textContent = 'VOTING - Choose who to eject!';
    document.getElementById('votingSection').classList.remove('hidden');
    
    // Create vote buttons
    const voteOptions = document.getElementById('voteOptions');
    voteOptions.innerHTML = alivePlayers
      .filter(p => p.name !== playerName) // Can't vote for self
      .map(p => `
        <button class="vote-btn" onclick="vote('${p.id}')">
          ${p.name} [${(p.numbers || []).join(', ')}]
        </button>
      `).join('');
    
    // Start vote timer
    startTimer(voteTime, 'meetingTimer');
  }
});

// Vote function
window.vote = (targetId) => {
  socket.emit('vote', { targetId });
  
  // Highlight selected
  document.querySelectorAll('.vote-btn').forEach(btn => {
    btn.classList.remove('selected');
    btn.disabled = true;
  });
  event.target.classList.add('selected');
  document.getElementById('skipVoteBtn').disabled = true;
};

// Skip vote
document.getElementById('skipVoteBtn').onclick = () => {
  socket.emit('vote', { targetId: 'skip' });
  document.querySelectorAll('.vote-btn').forEach(btn => btn.disabled = true);
  document.getElementById('skipVoteBtn').disabled = true;
  document.getElementById('voteConfirmed').classList.remove('hidden');
};

// Vote confirmed
socket.on('vote-confirmed', () => {
  document.getElementById('voteConfirmed').classList.remove('hidden');
});

// Voting results
socket.on('voting-results', ({ ejected, deadCount }) => {
  clearInterval(meetingTimer);
  
  document.getElementById('meetingOverlay').classList.add('hidden');
  document.getElementById('ghostMeetingOverlay').classList.add('hidden');
  
  // Show results
  const resultsOverlay = document.getElementById('resultsOverlay');
  if (ejected) {
    document.getElementById('resultsTitle').textContent = `${ejected.name} was ejected`;
    document.getElementById('resultsInfo').textContent = `They were ${ejected.role === 'imposter' ? 'an Imposter' : 'a Crewmate'}`;
  } else {
    document.getElementById('resultsTitle').textContent = 'No one was ejected';
    document.getElementById('resultsInfo').textContent = 'Tie vote or skipped';
  }
  resultsOverlay.classList.remove('hidden');
  
  // Update dead count
  document.getElementById('deadCount').textContent = deadCount;
  document.getElementById('ghostDeadCount').textContent = deadCount;
  
  // Hide results after 3 seconds
  setTimeout(() => {
    resultsOverlay.classList.add('hidden');
  }, 3000);
});

// You died
socket.on('you-died', () => {
  myStatus = 'dead';
  document.getElementById('gameView').classList.add('hidden');
  document.getElementById('ghostView').classList.remove('hidden');
  
  document.getElementById('ghostPlayerInfo').textContent = `${playerName} [${playerNumbers.join(', ')}] (GHOST)`;
  
  // Hide task section if imposter
  if (myRole === 'imposter') {
    document.getElementById('ghostTasksSection').classList.add('hidden');
  }
});

// You were ejected
socket.on('you-ejected', () => {
  myStatus = 'voted-out';
  document.getElementById('gameView').classList.add('hidden');
  document.getElementById('ghostView').classList.remove('hidden');
  
  document.getElementById('ghostPlayerInfo').textContent = `${playerName} [${playerNumbers.join(', ')}] (EJECTED)`;
});

// Photo upload
document.getElementById('photoBtn').onclick = () => {
  document.getElementById('photoInput').click();
};

document.getElementById('photoInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (event) => {
    // Resize image to reduce size
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxSize = 800;
      let width = img.width;
      let height = img.height;
      
      if (width > height && width > maxSize) {
        height = (height * maxSize) / width;
        width = maxSize;
      } else if (height > maxSize) {
        width = (width * maxSize) / height;
        height = maxSize;
      }
      
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      
      const photoData = canvas.toDataURL('image/jpeg', 0.7);
      socket.emit('upload-photo', { photoData });
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
};

socket.on('photo-sent', () => {
  showError('Photo sent to host!');
});

// Game over
socket.on('game-over', ({ winner, reason }) => {
  clearInterval(meetingTimer);
  
  const overlay = document.getElementById('gameOverOverlay');
  overlay.classList.remove('hidden');
  overlay.classList.add(winner);
  
  document.getElementById('gameOverTitle').textContent = 
    winner === 'crewmates' ? '🎉 CREWMATES WIN!' : '😈 IMPOSTERS WIN!';
  document.getElementById('gameOverReason').textContent = reason;
});

// Timer function
function startTimer(seconds, elementId) {
  let remaining = seconds;
  const element = document.getElementById(elementId);
  element.textContent = remaining;
  
  clearInterval(meetingTimer);
  meetingTimer = setInterval(() => {
    remaining--;
    element.textContent = remaining;
    
    if (remaining <= 0) {
      clearInterval(meetingTimer);
    }
  }, 1000);
}

// Play meeting sound - LOUD emergency alert!
function playMeetingSound() {
  // Vibrate phone aggressively
  if (navigator.vibrate) {
    navigator.vibrate([300, 100, 300, 100, 300, 100, 300]);
  }
  
  // Play loud emergency beeps using Web Audio API
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    
    // Play 4 loud beeps like Among Us
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
    
    // Emergency pattern: HIGH-LOW-HIGH-LOW repeated
    playBeep(0, 880);    // High
    playBeep(0.2, 440);  // Low
    playBeep(0.4, 880);  // High
    playBeep(0.6, 440);  // Low
    playBeep(0.8, 880);  // High
    playBeep(1.0, 440);  // Low
    playBeep(1.2, 988);  // Higher finish
    
    // Close context after sounds finish
    setTimeout(() => ctx.close(), 2000);
  } catch (e) {
    console.log('Audio not supported');
  }
}

// Error display
function showError(msg) {
  const err = document.getElementById('error');
  err.textContent = msg;
  err.classList.remove('hidden');
  setTimeout(() => err.classList.add('hidden'), 3000);
}

// Handle errors from server
socket.on('error', ({ message }) => {
  showError(message);
});
