const socket = io();
const SESSION_KEY = "boggle_session_v1";

const state = {
  me: null,
  room: null,
  myWords: [],
  results: null,
};

const el = {
  homeView: document.getElementById("homeView"),
  lobbyView: document.getElementById("lobbyView"),
  gameView: document.getElementById("gameView"),
  resultView: document.getElementById("resultView"),
  nameInput: document.getElementById("nameInput"),
  roomCodeInput: document.getElementById("roomCodeInput"),
  joinPanel: document.getElementById("joinPanel"),
  lobbyRoomCode: document.getElementById("lobbyRoomCode"),
  playerList: document.getElementById("playerList"),
  startBtn: document.getElementById("startBtn"),
  gameRoomCode: document.getElementById("gameRoomCode"),
  timerText: document.getElementById("timerText"),
  board: document.getElementById("board"),
  progressText: document.getElementById("progressText"),
  feedback: document.getElementById("feedback"),
  wordInput: document.getElementById("wordInput"),
  myWords: document.getElementById("myWords"),
  livePlayers: document.getElementById("livePlayers"),
  rankings: document.getElementById("rankings"),
  submittedWords: document.getElementById("submittedWords"),
  missedWords: document.getElementById("missedWords"),
  newRoundBtn: document.getElementById("newRoundBtn"),
};

function myPlayer() {
  if (!state.room || !state.me) return null;
  return state.room.players.find((p) => p.id === state.me.playerId) || null;
}

function saveSession() {
  if (!state.me?.roomCode || !state.me?.sessionToken) return;
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      roomCode: state.me.roomCode,
      playerId: state.me.playerId,
      sessionToken: state.me.sessionToken,
      name: state.me.name,
    }),
  );
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function show(view) {
  el.homeView.classList.add("hidden");
  el.lobbyView.classList.add("hidden");
  el.gameView.classList.add("hidden");
  el.resultView.classList.add("hidden");
  view.classList.remove("hidden");
}

function formatTime(totalSec) {
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderGrouped(container, groups, total) {
  if (!groups || groups.length === 0) {
    container.innerHTML = "<p>None</p>";
    return;
  }
  container.innerHTML = `<p>Total: ${total}</p>${groups
    .map((g) => `<p><strong>${g.length} letters:</strong> ${g.items.map(escapeHtml).join(", ")}</p>`)
    .join("")}`;
}

function rankClass(rank) {
  if (rank === 1) return "rank-1";
  if (rank === 2) return "rank-2";
  if (rank === 3) return "rank-3";
  return "rank-other";
}

function render() {
  if (!state.room) {
    show(el.homeView);
    return;
  }

  if (state.room.status === "LOBBY") {
    show(el.lobbyView);
    el.lobbyRoomCode.textContent = state.room.code;
    el.playerList.innerHTML = state.room.players
      .map((p) => `<div class="playerCard">${escapeHtml(p.name)} ${p.isHost ? "(Host)" : ""} ${p.connected ? "" : "(Offline)"}</div>`)
      .join("");
    const me = myPlayer();
    const canStart = Boolean(me?.isHost) && state.room.players.length >= 1;
    el.startBtn.disabled = !canStart;
    return;
  }

  if (state.room.status === "ACTIVE_ROUND") {
    show(el.gameView);
    const r = state.room.round;
    el.gameRoomCode.textContent = state.room.code;
    el.timerText.textContent = `Time: ${formatTime(r.secondsRemaining)}`;
    el.timerText.classList.toggle("warn", r.secondsRemaining <= 15 && r.secondsRemaining > 5);
    el.timerText.classList.toggle("danger", r.secondsRemaining <= 5);

    el.board.innerHTML = r.board.flat().map((c) => `<div class="tile">${c}</div>`).join("");
    const pct = r.totalPossibleWords ? Math.floor((r.uniqueWordsFound / r.totalPossibleWords) * 100) : 0;
    el.progressText.textContent = `Words Found: ${r.uniqueWordsFound}/${r.totalPossibleWords} (${pct}%)`;
    el.myWords.textContent = `My words: ${state.myWords.join(", ")}`;
    el.livePlayers.innerHTML = state.room.players
      .map(
        (p, idx) =>
          `<div class="playerCard liveRank ${rankClass(idx + 1)} ${p.id === state.me?.playerId ? "me" : ""}">
            <strong>#${idx + 1}</strong> ${escapeHtml(p.name)} ${p.connected ? "" : "(Offline)"}<br/>
            <span>${p.liveScore} pts (${p.liveWordCount} words)</span>
          </div>`,
      )
      .join("");

    return;
  }

  if (state.room.status === "ROUND_END") {
    show(el.resultView);
    const me = myPlayer();
    el.newRoundBtn.classList.toggle("hidden", !me?.isHost);
    if (state.results) {
      const top3 = state.results.rankings.slice(0, 3);
      const others = state.results.rankings.slice(3);

      const podium = `
        <div class="podium">
          ${top3
            .map((r) => {
              const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : "🥉";
              return `<div class="podiumStep ${rankClass(r.rank)}">
                <div class="podiumLabel">${medal} #${r.rank}</div>
                <div class="podiumName">${escapeHtml(r.name)}</div>
                <div class="podiumScore">${r.score} pts</div>
                <div class="podiumMeta">${r.uniqueWordsCount} unique / ${r.allWords.length} total</div>
              </div>`;
            })
            .join("")}
        </div>
      `;

      const rest = others
        .map(
          (r) =>
            `<div class="playerCard rankingRow ${rankClass(r.rank)}">#${r.rank} ${escapeHtml(r.name)} - ${r.score} pts (${r.uniqueWordsCount} unique / ${r.allWords.length} total)</div>`,
        )
        .join("");

      el.rankings.innerHTML = podium + rest;
      renderGrouped(el.submittedWords, state.results.submittedGroups, state.results.submittedGroups.reduce((n, g) => n + g.items.length, 0));
      renderGrouped(el.missedWords, state.results.missedGroups, state.results.missedGroups.reduce((n, g) => n + g.items.length, 0));
    }
  }
}

socket.on("joined", (info) => {
  state.me = info;
  saveSession();
});

socket.on("room_state", (room) => {
  state.room = room;
  if (room.status !== "ROUND_END") state.results = null;
  if (room.status !== "ACTIVE_ROUND") state.myWords = [];
  render();
});

socket.on("self_state", (payload) => {
  state.myWords = Array.isArray(payload?.words) ? payload.words : [];
  render();
});

socket.on("submit_result", (res) => {
  el.feedback.className = `feedback ${res.ok ? "ok" : "err"}`;
  el.feedback.textContent = res.message;
  if (res.ok) {
    state.myWords.push(res.word);
    state.myWords.sort();
    el.wordInput.value = "";
  }
  render();
});

socket.on("round_ended", (payload) => {
  state.results = payload;
  render();
});

socket.on("op_error", (msg) => {
  if (msg === "Room not found." || msg === "Rejoin failed.") clearSession();
  alert(msg);
});

document.getElementById("showJoinBtn").addEventListener("click", () => {
  el.joinPanel.classList.toggle("hidden");
});

document.getElementById("createBtn").addEventListener("click", () => {
  const name = el.nameInput.value.trim();
  if (!name) return alert("Enter your name first.");
  socket.emit("create_room", { name });
});

document.getElementById("joinBtn").addEventListener("click", () => {
  const name = el.nameInput.value.trim();
  const roomCode = el.roomCodeInput.value.trim().toUpperCase();
  if (!name || !roomCode) return alert("Name and room code are required.");
  socket.emit("join_room", { name, roomCode });
});

document.getElementById("copyCodeBtn").addEventListener("click", async () => {
  if (!state.room?.code) return;
  await navigator.clipboard.writeText(state.room.code);
});

document.getElementById("leaveBtn").addEventListener("click", () => {
  socket.emit("leave_room");
  clearSession();
  state.room = null;
  state.me = null;
  state.results = null;
  state.myWords = [];
  render();
});

document.getElementById("resultsLeaveBtn").addEventListener("click", () => {
  socket.emit("leave_room");
  clearSession();
  state.room = null;
  state.me = null;
  state.results = null;
  state.myWords = [];
  render();
});

document.getElementById("startBtn").addEventListener("click", () => {
  socket.emit("start_round");
});

document.getElementById("endRoundBtn").addEventListener("click", () => {
  socket.emit("end_round");
});

document.getElementById("newRoundBtn").addEventListener("click", () => {
  socket.emit("new_round");
});

function submitWord() {
  const word = el.wordInput.value.trim();
  if (!word) return;
  socket.emit("submit_word", { word });
}

document.getElementById("submitWordBtn").addEventListener("click", submitWord);
el.wordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitWord();
});

socket.on("connect", () => {
  if (state.room) return;
  const session = loadSession();
  if (!session?.roomCode || !session?.sessionToken) return;
  socket.emit("rejoin_room", { roomCode: session.roomCode, sessionToken: session.sessionToken });
});

render();
