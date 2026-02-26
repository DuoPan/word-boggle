const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { Server } = require("socket.io");
const wordListPath = require("word-list").default;
const { getWordsList } = require("most-common-words-by-language");

const PORT = process.env.PORT || 3000;
const ROUND_SECONDS = 120;
const MIN_PLAYERS = 1;
const BOARD_SIZE = 4;
const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 8;
const COMMON_ENGLISH_LIMIT = 12000;
const EXTRA_ALLOWED_WORDS = new Set(["fade", "fool"]);
const DISCONNECT_GRACE_MS = 60_000;
const WEIGHTED_LETTERS = "eeeeeeeeeeeeaaaaiiiioooonnnrrrtttllssudgpbcmfhvwykjxqz";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

const rooms = new Map();

const dictionary = loadDictionary();
const trie = buildTrie(dictionary);

function loadDictionary() {
  const commonWords = new Set(
    getWordsList("english", COMMON_ENGLISH_LIMIT)
      .map((w) => String(w).trim().toLowerCase())
      .filter((w) => /^[a-z]+$/.test(w)),
  );

  const raw = fs.readFileSync(wordListPath, "utf8");
  const out = new Set();
  for (const word of raw.split("\n")) {
    const w = word.trim().toLowerCase();
    if (!w) continue;
    if (w.length < MIN_WORD_LENGTH || w.length > MAX_WORD_LENGTH) continue;
    if (!/^[a-z]+$/.test(w)) continue;
    if (!commonWords.has(w) && !EXTRA_ALLOWED_WORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

function buildTrie(words) {
  const root = {};
  for (const word of words) {
    let node = root;
    for (const ch of word) {
      if (!node[ch]) node[ch] = {};
      node = node[ch];
    }
    node.$ = true;
  }
  return root;
}

function randomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function makePlayer(name, socket) {
  return {
    id: crypto.randomUUID(),
    sessionToken: crypto.randomUUID(),
    name: String(name || "").trim().slice(0, 20) || "player",
    socketId: socket.id,
    connected: true,
    disconnectTimer: null,
  };
}

function generateBoard() {
  const grid = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    const row = [];
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const idx = Math.floor(Math.random() * WEIGHTED_LETTERS.length);
      row.push(WEIGHTED_LETTERS[idx]);
    }
    grid.push(row);
  }
  return grid;
}

const NEIGHBORS = [];
for (let dy = -1; dy <= 1; dy += 1) {
  for (let dx = -1; dx <= 1; dx += 1) {
    if (dx === 0 && dy === 0) continue;
    NEIGHBORS.push([dx, dy]);
  }
}

function boardWords(board) {
  const found = new Set();
  const visited = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));

  function dfs(x, y, node, acc) {
    const ch = board[y][x];
    const next = node[ch];
    if (!next) return;

    visited[y][x] = true;
    const word = acc + ch;
    if (next.$ && word.length >= MIN_WORD_LENGTH) found.add(word);

    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
      if (visited[ny][nx]) continue;
      dfs(nx, ny, next, word);
    }
    visited[y][x] = false;
  }

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      dfs(x, y, trie, "");
    }
  }
  return found;
}

function hasBoardPath(word, board) {
  const visited = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));

  function dfs(i, x, y) {
    if (i === word.length) return true;
    if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) return false;
    if (visited[y][x]) return false;
    if (board[y][x] !== word[i]) return false;
    visited[y][x] = true;
    for (const [dx, dy] of NEIGHBORS) {
      if (dfs(i + 1, x + dx, y + dy)) {
        visited[y][x] = false;
        return true;
      }
    }
    visited[y][x] = false;
    return i === word.length - 1;
  }

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (dfs(0, x, y)) return true;
    }
  }
  return false;
}

function getPoints(length) {
  if (length <= 4) return 1;
  if (length === 5) return 2;
  if (length === 6) return 3;
  if (length === 7) return 5;
  return 11;
}

function summarizeRoom(room) {
  const players = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.id === room.hostId,
    connected: p.connected !== false,
    liveScore: room.round?.liveScores.get(p.id) || 0,
    liveWordCount: room.round?.playerWords.get(p.id)?.size || 0,
  }));

  players.sort((a, b) => b.liveScore - a.liveScore || b.liveWordCount - a.liveWordCount || a.name.localeCompare(b.name));

  return {
    code: room.code,
    status: room.status,
    maxPlayers: null,
    players,
    round: room.round
      ? {
          board: room.round.board,
          secondsRemaining: room.round.secondsRemaining,
          totalPossibleWords: room.round.possibleWords.size,
          uniqueWordsFound: room.round.globalFound.size,
        }
      : null,
  };
}

function emitRoomState(room) {
  io.to(room.code).emit("room_state", summarizeRoom(room));
}

function sendSelfState(socket, room, player) {
  socket.emit("self_state", {
    words: [...(room.round?.playerWords.get(player.id) || [])].sort(),
  });
}

function groupByLength(words) {
  const groups = new Map();
  for (const word of words) {
    const len = word.length >= 8 ? "8+" : String(word.length);
    if (!groups.has(len)) groups.set(len, []);
    groups.get(len).push(word);
  }
  for (const arr of groups.values()) arr.sort();

  return [...groups.entries()]
    .sort((a, b) => {
      const pa = a[0] === "8+" ? 8 : Number(a[0]);
      const pb = b[0] === "8+" ? 8 : Number(b[0]);
      return pb - pa;
    })
    .map(([length, items]) => ({ length, items }));
}

function startRound(room) {
  const board = generateBoard();
  const possibleWords = boardWords(board);

  const round = {
    board,
    possibleWords,
    playerWords: new Map(),
    liveScores: new Map(),
    globalFound: new Set(),
    secondsRemaining: ROUND_SECONDS,
    timer: null,
  };

  for (const playerId of room.players.keys()) {
    round.playerWords.set(playerId, new Set());
    round.liveScores.set(playerId, 0);
  }

  room.round = round;
  room.status = "ACTIVE_ROUND";
  emitRoomState(room);

  round.timer = setInterval(() => {
    if (!rooms.has(room.code) || room.status !== "ACTIVE_ROUND") {
      clearInterval(round.timer);
      return;
    }

    round.secondsRemaining -= 1;
    emitRoomState(room);
    if (round.secondsRemaining <= 0) endRound(room);
  }, 1000);
}

function endRound(room) {
  if (room.status !== "ACTIVE_ROUND" || !room.round) return;
  clearInterval(room.round.timer);
  room.status = "ROUND_END";

  const frequency = new Map();
  for (const set of room.round.playerWords.values()) {
    for (const word of set) frequency.set(word, (frequency.get(word) || 0) + 1);
  }

  const rankings = [...room.players.values()].map((player) => {
    const words = [...(room.round.playerWords.get(player.id) || new Set())].sort();
    let score = 0;
    let uniqueCount = 0;
    for (const word of words) {
      if (frequency.get(word) === 1) {
        score += getPoints(word.length);
        uniqueCount += 1;
      }
    }
    return {
      playerId: player.id,
      name: player.name,
      score,
      uniqueWordsCount: uniqueCount,
      allWords: words,
    };
  });

  rankings.sort((a, b) => b.score - a.score || b.uniqueWordsCount - a.uniqueWordsCount || a.name.localeCompare(b.name));
  rankings.forEach((r, i) => {
    r.rank = i + 1;
  });

  const submitted = new Set();
  for (const row of rankings) {
    for (const word of row.allWords) submitted.add(word);
  }

  const missed = [...room.round.possibleWords].filter((word) => !submitted.has(word));
  const resultPayload = {
    rankings,
    submittedGroups: groupByLength([...submitted]),
    missedGroups: groupByLength(missed),
    totalPossibleWords: room.round.possibleWords.size,
  };

  io.to(room.code).emit("round_ended", resultPayload);
  emitRoomState(room);
}

function removePlayer(room, playerId) {
  const existing = room.players.get(playerId);
  if (!existing) return;
  if (existing.disconnectTimer) {
    clearTimeout(existing.disconnectTimer);
    existing.disconnectTimer = null;
  }

  room.players.delete(playerId);
  if (room.round) {
    room.round.playerWords.delete(playerId);
    room.round.liveScores.delete(playerId);
  }

  if (room.players.size === 0) {
    if (room.round?.timer) clearInterval(room.round.timer);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === playerId) {
    room.hostId = room.players.values().next().value.id;
  }

  emitRoomState(room);
}

function getSocketRoom(socket) {
  const code = socket.data.roomCode;
  const playerId = socket.data.playerId;
  if (!code || !playerId) return {};
  const room = rooms.get(code);
  if (!room) return {};
  const player = room.players.get(playerId);
  return { room, player };
}

io.on("connection", (socket) => {
  socket.on("create_room", ({ name } = {}) => {
    const player = makePlayer(name, socket);
    let code = randomRoomCode();
    while (rooms.has(code)) code = randomRoomCode();

    const room = {
      code,
      hostId: player.id,
      status: "LOBBY",
      players: new Map([[player.id, player]]),
      round: null,
    };

    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;
    socket.join(code);
    socket.emit("joined", {
      roomCode: code,
      playerId: player.id,
      sessionToken: player.sessionToken,
      name: player.name,
    });
    sendSelfState(socket, room, player);
    emitRoomState(room);
  });

  socket.on("join_room", ({ roomCode, name } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit("op_error", "Room not found.");
      return;
    }
    if (room.status === "ACTIVE_ROUND") {
      socket.emit("op_error", "Round in progress. Try again later.");
      return;
    }

    const player = makePlayer(name, socket);
    room.players.set(player.id, player);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;
    socket.join(code);
    socket.emit("joined", {
      roomCode: code,
      playerId: player.id,
      sessionToken: player.sessionToken,
      name: player.name,
    });
    sendSelfState(socket, room, player);
    emitRoomState(room);
  });

  socket.on("rejoin_room", ({ roomCode, sessionToken } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const token = String(sessionToken || "").trim();
    if (!code || !token) return;

    const room = rooms.get(code);
    if (!room) {
      socket.emit("op_error", "Room not found.");
      return;
    }

    const player = [...room.players.values()].find((p) => p.sessionToken === token);
    if (!player) {
      socket.emit("op_error", "Rejoin failed.");
      return;
    }

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.connected = true;
    player.socketId = socket.id;

    socket.data.roomCode = code;
    socket.data.playerId = player.id;
    socket.join(code);
    socket.emit("joined", {
      roomCode: code,
      playerId: player.id,
      sessionToken: player.sessionToken,
      name: player.name,
    });
    emitRoomState(room);
    sendSelfState(socket, room, player);
  });

  socket.on("start_round", () => {
    const { room, player } = getSocketRoom(socket);
    if (!room || !player) return;
    if (room.hostId !== player.id) {
      socket.emit("op_error", "Only host can start.");
      return;
    }
    if (room.players.size < MIN_PLAYERS) {
      socket.emit("op_error", "Need at least 1 player.");
      return;
    }
    if (room.status === "ACTIVE_ROUND") return;
    startRound(room);
  });

  socket.on("submit_word", ({ word } = {}) => {
    const { room, player } = getSocketRoom(socket);
    if (!room || !player || room.status !== "ACTIVE_ROUND" || !room.round) return;

    const input = String(word || "").trim().toLowerCase();
    if (!/^[a-z]+$/.test(input)) {
      socket.emit("submit_result", { ok: false, word: input, message: "Only English letters." });
      return;
    }
    if (input.length < MIN_WORD_LENGTH) {
      socket.emit("submit_result", { ok: false, word: input, message: "Word too short." });
      return;
    }
    if (!dictionary.has(input)) {
      socket.emit("submit_result", { ok: false, word: input, message: "Not in dictionary." });
      return;
    }
    const set = room.round.playerWords.get(player.id);
    if (set.has(input)) {
      socket.emit("submit_result", { ok: false, word: input, message: "Already submitted." });
      return;
    }
    if (!hasBoardPath(input, room.round.board)) {
      socket.emit("submit_result", { ok: false, word: input, message: "Word not on board." });
      return;
    }

    set.add(input);
    room.round.globalFound.add(input);
    const nextScore = (room.round.liveScores.get(player.id) || 0) + getPoints(input.length);
    room.round.liveScores.set(player.id, nextScore);

    socket.emit("submit_result", { ok: true, word: input, message: "Accepted." });
    sendSelfState(socket, room, player);
    emitRoomState(room);
  });

  socket.on("end_round", () => {
    const { room, player } = getSocketRoom(socket);
    if (!room || !player) return;
    if (room.hostId !== player.id) return;
    endRound(room);
  });

  socket.on("new_round", () => {
    const { room, player } = getSocketRoom(socket);
    if (!room || !player) return;
    if (room.hostId !== player.id) return;
    if (room.status === "ACTIVE_ROUND") return;
    startRound(room);
  });

  socket.on("leave_room", () => {
    const { room, player } = getSocketRoom(socket);
    if (!room || !player) return;
    socket.leave(room.code);
    removePlayer(room, player.id);
    socket.data.roomCode = null;
    socket.data.playerId = null;
  });

  socket.on("disconnect", () => {
    const { room, player } = getSocketRoom(socket);
    if (!room || !player) return;
    if (player.socketId !== socket.id) return;

    player.connected = false;
    player.socketId = null;
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = setTimeout(() => {
      const targetRoom = rooms.get(room.code);
      if (!targetRoom) return;
      const targetPlayer = targetRoom.players.get(player.id);
      if (!targetPlayer || targetPlayer.connected) return;
      removePlayer(targetRoom, player.id);
    }, DISCONNECT_GRACE_MS);

    emitRoomState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Boggle server running on http://localhost:${PORT}`);
});
