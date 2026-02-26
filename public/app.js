const socket = io();
const SESSION_KEY = "boggle_session_v1";

const state = {
  me: null,
  room: null,
  myWords: [],
  results: null,
  selection: {
    dragging: false,
    pointerId: null,
    path: [],
  },
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
  longestBoards: document.getElementById("longestBoards"),
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

function isAdjacent(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

function pathWord(path) {
  const board = state.room?.round?.board;
  if (!board || !Array.isArray(path) || path.length === 0) return "";
  return path.map((p) => board[p.y]?.[p.x] || "").join("");
}

function collectAllAnswerWords(results) {
  const out = new Set();
  for (const group of results?.submittedGroups || []) {
    for (const word of group.items || []) out.add(word);
  }
  for (const group of results?.missedGroups || []) {
    for (const word of group.items || []) out.add(word);
  }
  return [...out];
}

function findBoardPathForWord(word, board) {
  if (!word || !Array.isArray(board) || board.length === 0 || !Array.isArray(board[0])) return null;
  const height = board.length;
  const width = board[0].length;
  const visited = Array.from({ length: height }, () => Array(width).fill(false));

  function dfs(i, x, y, path) {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    if (visited[y][x]) return null;
    if (board[y][x] !== word[i]) return null;

    const nextPath = [...path, { x, y }];
    if (i === word.length - 1) return nextPath;

    visited[y][x] = true;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const hit = dfs(i + 1, x + dx, y + dy, nextPath);
        if (hit) {
          visited[y][x] = false;
          return hit;
        }
      }
    }
    visited[y][x] = false;
    return null;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const foundPath = dfs(0, x, y, []);
      if (foundPath) return foundPath;
    }
  }
  return null;
}

function buildAnswerBoardHtml(board, path) {
  const selected = new Set((path || []).map((p) => `${p.x},${p.y}`));
  let html = '<div class="answerBoard">';
  for (let y = 0; y < board.length; y += 1) {
    for (let x = 0; x < board[y].length; x += 1) {
      const key = `${x},${y}`;
      html += `<div class="answerTile ${selected.has(key) ? "onPath" : ""}">${board[y][x]}</div>`;
    }
  }
  html += "</div>";
  return html;
}

function renderLongestBoards() {
  const board = state.room?.round?.board;
  const answers = collectAllAnswerWords(state.results);
  if (!board || answers.length === 0) {
    el.longestBoards.innerHTML = "<p>None</p>";
    return;
  }

  const maxLen = Math.max(...answers.map((w) => w.length));
  const longestWords = answers.filter((w) => w.length === maxLen).sort();

  const cards = longestWords
    .map((word) => {
      const path = findBoardPathForWord(word, board);
      return `<div class="longestCard">
        <p class="longestWord">${escapeHtml(word)} (${word.length})</p>
        ${buildAnswerBoardHtml(board, path)}
      </div>`;
    })
    .join("");

  el.longestBoards.innerHTML = `<p class="longestMeta">${longestWords.length} word(s), ${maxLen} letters</p><div class="longestGrid">${cards}</div>`;
}

function hasPoint(path, point) {
  return path.some((p) => p.x === point.x && p.y === point.y);
}

function updateWordInputFromSelection() {
  const word = pathWord(state.selection.path);
  el.wordInput.value = word;
}

function clearSelection() {
  state.selection.dragging = false;
  state.selection.pointerId = null;
  state.selection.path = [];
}

function startSelection(point, pointerId) {
  state.selection.dragging = true;
  state.selection.pointerId = pointerId;
  state.selection.path = [point];
  updateWordInputFromSelection();
  render();
}

function extendSelection(point) {
  if (!state.selection.dragging || !state.selection.path.length) return;

  const path = state.selection.path;
  const last = path[path.length - 1];
  if (last.x === point.x && last.y === point.y) return;

  if (path.length >= 2) {
    const prev = path[path.length - 2];
    if (prev.x === point.x && prev.y === point.y) {
      path.pop();
      updateWordInputFromSelection();
      render();
      return;
    }
  }

  if (!isAdjacent(last, point)) return;
  if (hasPoint(path, point)) return;

  path.push(point);
  updateWordInputFromSelection();
  render();
}

function endSelection(pointerId) {
  if (!state.selection.dragging) return;
  if (state.selection.pointerId !== null && pointerId !== undefined && pointerId !== state.selection.pointerId) return;
  state.selection.dragging = false;
  state.selection.pointerId = null;
  render();
}

function extendSelectionFromEvent(e) {
  if (!state.selection.dragging) return;
  if (state.selection.pointerId !== null && e.pointerId !== state.selection.pointerId) return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  const tile = target?.closest?.(".tile");
  if (!tile || !el.board.contains(tile)) return;
  const point = { x: Number(tile.dataset.x), y: Number(tile.dataset.y) };
  extendSelection(point);
}

function buildBoardHtml(board) {
  const selected = new Set(state.selection.path.map((p) => `${p.x},${p.y}`));
  const tail = state.selection.path[state.selection.path.length - 1];

  let html = "";
  for (let y = 0; y < board.length; y += 1) {
    for (let x = 0; x < board[y].length; x += 1) {
      const key = `${x},${y}`;
      const isSelected = selected.has(key);
      const isCurrent = tail && tail.x === x && tail.y === y;
      html += `<div class="tile ${isSelected ? "tileSelected" : ""} ${isCurrent ? "tileCurrent" : ""}" data-x="${x}" data-y="${y}">${
        board[y][x]
      }</div>`;
    }
  }
  return html;
}

function renderSelectionLinks() {
  const old = el.board.querySelectorAll(".pathLine");
  old.forEach((n) => n.remove());

  if (!state.selection.path || state.selection.path.length < 2) return;

  for (let i = 1; i < state.selection.path.length; i += 1) {
    const a = state.selection.path[i - 1];
    const b = state.selection.path[i];
    const tileA = el.board.querySelector(`.tile[data-x="${a.x}"][data-y="${a.y}"]`);
    const tileB = el.board.querySelector(`.tile[data-x="${b.x}"][data-y="${b.y}"]`);
    if (!tileA || !tileB) continue;

    const ax = tileA.offsetLeft + tileA.offsetWidth / 2;
    const ay = tileA.offsetTop + tileA.offsetHeight / 2;
    const bx = tileB.offsetLeft + tileB.offsetWidth / 2;
    const by = tileB.offsetTop + tileB.offsetHeight / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

    const line = document.createElement("div");
    line.className = "pathLine";
    line.style.left = `${ax}px`;
    line.style.top = `${ay}px`;
    line.style.width = `${len}px`;
    line.style.transform = `rotate(${angle}deg)`;
    el.board.appendChild(line);
  }
}

function render() {
  if (!state.room) {
    show(el.homeView);
    return;
  }

  if (state.room.status === "LOBBY") {
    clearSelection();
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

    el.board.innerHTML = buildBoardHtml(r.board);
    renderSelectionLinks();
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
    clearSelection();
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
      renderLongestBoards();
    }
  }
}

socket.on("joined", (info) => {
  state.me = info;
  saveSession();
});

socket.on("room_state", (room) => {
  const prevStatus = state.room?.status;
  state.room = room;
  if (room.status !== "ROUND_END") state.results = null;
  if (room.status !== "ACTIVE_ROUND") state.myWords = [];
  if (prevStatus !== "ACTIVE_ROUND" && room.status === "ACTIVE_ROUND") clearSelection();
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
    clearSelection();
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

function submitWord(wordOverride, options = {}) {
  const word = String(wordOverride ?? el.wordInput.value).trim();
  if (!word) return;
  socket.emit("submit_word", { word });
  if (options.clearAfter) {
    el.wordInput.value = "";
    clearSelection();
    render();
  }
}

document.getElementById("submitWordBtn").addEventListener("click", submitWord);
el.wordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitWord();
});

el.wordInput.addEventListener("input", () => {
  if (state.selection.path.length > 0) {
    clearSelection();
    render();
  }
});

el.board.addEventListener("pointerdown", (e) => {
  if (state.room?.status !== "ACTIVE_ROUND") return;
  const tile = e.target.closest(".tile");
  if (!tile) return;
  e.preventDefault();
  const point = { x: Number(tile.dataset.x), y: Number(tile.dataset.y) };
  startSelection(point, e.pointerId);
  if (el.board.setPointerCapture) {
    try {
      el.board.setPointerCapture(e.pointerId);
    } catch {}
  }
});

window.addEventListener("pointermove", (e) => {
  extendSelectionFromEvent(e);
});

window.addEventListener("pointerup", (e) => {
  extendSelectionFromEvent(e);
  if (state.selection.dragging) {
    const selectedWord = pathWord(state.selection.path);
    submitWord(selectedWord, { clearAfter: true });
  }
  endSelection(e.pointerId);
});

window.addEventListener("pointercancel", (e) => {
  endSelection(e.pointerId);
});

socket.on("connect", () => {
  if (state.room) return;
  const session = loadSession();
  if (!session?.roomCode || !session?.sessionToken) return;
  socket.emit("rejoin_room", { roomCode: session.roomCode, sessionToken: session.sessionToken });
});

render();
