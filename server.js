import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 20 * 1024 * 1024
});

const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/gif", "image/webp",
      "video/mp4", "video/webm", "video/ogg", "video/quicktime"
    ];
    cb(null, allowed.includes(file.mimetype));
  }
});

// In-memory state: ideal for an academic/demo project.
const users = new Map();        // socketId -> { username, room }
const rooms = new Map();        // roomName -> Set(socketId)
const pendingPrivate = new Map(); // confirmationId -> message

let gemini = null;
if (process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes("PASTE_")) {
  gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 24);
}

function cleanRoom(value) {
  return String(value || "General")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 32) || "General";
}

function roomUsers(roomName) {
  const ids = rooms.get(roomName) || new Set();

  return [...ids]
    .map((id) => {
      const user = users.get(id);
      return user ? { id, username: user.username } : null;
    })
    .filter(Boolean);
}

function broadcastUserLists() {
  const all = [...users.entries()].map(([id, u]) => ({
    id,
    username: u.username,
    room: u.room
  }));

  io.emit("user-list", all);

  for (const roomName of rooms.keys()) {
    io.to(roomName).emit("room-users", {
      room: roomName,
      users: roomUsers(roomName)
    });
  }
}

function looksLikeOTP(text) {
  const patterns = [
    /\b(?:otp|one[- ]time password|verification code|security code)\b/i,
    /\b(?:code|otp)\s*(?:is|:|-)?\s*\d{4,8}\b/i,
    /\b\d{4,8}\b.*\b(?:otp|code)\b/i
  ];
  return patterns.some((p) => p.test(text));
}

function heuristicTrolling(text) {
  const signals = [
    /\b(idiot|stupid|moron|loser|shut up|kill yourself|hate you)\b/i,
    /\b(?:you are|you're)\s+(?:worthless|pathetic|useless)\b/i,
    /(?:fuck|f\*ck)\s+(?:you|off)/i
  ];
  return signals.some((p) => p.test(text));
}

async function detectTrollingWithGemini(text, roomName) {
  if (!gemini) {
    return {
      isTrolling: heuristicTrolling(text),
      reason: "Gemini API key not configured; local demo heuristic used.",
      soothingMessage: "Let's keep the conversation respectful. Take a breath and continue when you're ready."
    };
  }

  const prompt = `
You are the moderation assistant for a student multi-client chat application.
Analyze the following chat message for trolling, harassment, baiting, personal attacks,
or deliberately inflammatory behavior. Normal disagreement, jokes, criticism, or casual
slang should NOT automatically be marked as trolling.

Return ONLY valid JSON with exactly these fields:
{
  "isTrolling": true or false,
  "confidence": number from 0 to 1,
  "reason": "short reason",
  "soothingMessage": "short calm, non-judgmental message"
}

Do not threaten, shame, punish, or lecture the sender. If it is trolling, the soothing
message should de-escalate the situation and invite respectful communication.

Room: ${roomName}
Message: ${JSON.stringify(text)}
`;

  try {
    const response = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });

    const raw = (response.text || "").trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemini returned non-JSON output.");

    const parsed = JSON.parse(match[0]);
    return {
      isTrolling: Boolean(parsed.isTrolling),
      confidence: Number(parsed.confidence || 0),
      reason: String(parsed.reason || ""),
      soothingMessage: String(
        parsed.soothingMessage ||
        "Let's slow down and keep the conversation respectful."
      ).slice(0, 300)
    };
  } catch (error) {
    console.error("Gemini moderation error:", error.message);
    return {
      isTrolling: heuristicTrolling(text),
      reason: "Gemini request failed; safe local fallback was used.",
      soothingMessage: "Let's keep the conversation respectful and take a moment before replying."
    };
  }
}

function addToRoom(socketId, roomName) {
  if (!rooms.has(roomName)) rooms.set(roomName, new Set());
  rooms.get(roomName).add(socketId);
}

function removeFromRoom(socketId, roomName) {
  const set = rooms.get(roomName);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) rooms.delete(roomName);
}

function sendChatToRoom(socket, payload) {
  io.to(payload.room).emit("chat-message", {
    type: "text",
    from: socket.data.username,
    fromId: socket.id,
    room: payload.room,
    text: payload.text,
    timestamp: new Date().toISOString()
  });
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "multi-client-chat",
    geminiConfigured: Boolean(gemini),
    geminiModel: GEMINI_MODEL
  });
});

app.post("/upload", upload.single("media"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Only supported image/video files up to 20 MB are allowed." });
  }

  res.json({
    url: `/uploads/${req.file.filename}`,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size
  });
});

io.on("connection", (socket) => {
  socket.on("register", ({ username, room }) => {
    const safeUsername = cleanUsername(username);
    const safeRoom = cleanRoom(room);

    if (!safeUsername) {
      socket.emit("register-error", "Please enter a valid username.");
      return;
    }

    if ([...users.values()].some((u) => u.username.toLowerCase() === safeUsername.toLowerCase())) {
      socket.emit("register-error", "That username is already in use. Choose another one.");
      return;
    }

    users.set(socket.id, { username: safeUsername, room: safeRoom });
    socket.data.username = safeUsername;
    socket.data.room = safeRoom;

    socket.join(safeRoom);
    addToRoom(socket.id, safeRoom);

    socket.emit("registered", {
      username: safeUsername,
      room: safeRoom,
      geminiConfigured: Boolean(gemini)
    });

    io.to(safeRoom).emit("system-message", {
      text: `${safeUsername} joined #${safeRoom}`,
      timestamp: new Date().toISOString()
    });

    broadcastUserLists();
  });

  socket.on("join-room", ({ room }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const newRoom = cleanRoom(room);
    const oldRoom = user.room;

    if (newRoom === oldRoom) return;

    socket.leave(oldRoom);
    removeFromRoom(socket.id, oldRoom);

    user.room = newRoom;
    socket.data.room = newRoom;

    socket.join(newRoom);
    addToRoom(socket.id, newRoom);

    io.to(oldRoom).emit("system-message", {
      text: `${user.username} left #${oldRoom}`,
      timestamp: new Date().toISOString()
    });
    io.to(newRoom).emit("system-message", {
      text: `${user.username} joined #${newRoom}`,
      timestamp: new Date().toISOString()
    });

    socket.emit("room-changed", newRoom);
    broadcastUserLists();
  });

  socket.on("chat-message", async ({ text, room }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const message = String(text || "").trim().slice(0, 2000);
    const targetRoom = cleanRoom(room || user.room);

    if (!message) return;
    if (targetRoom !== user.room) {
      socket.emit("error-message", "You can only send a room message to your current room.");
      return;
    }

    // Assignment requirement: OTP/private information confirmation before group delivery.
    if (looksLikeOTP(message)) {
      const confirmationId = `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingPrivate.set(confirmationId, {
        socketId: socket.id,
        room: targetRoom,
        text: message,
        createdAt: Date.now()
      });

      socket.emit("private-info-warning", {
        confirmationId,
        text: message,
        warning: "This message appears to contain an OTP or verification code. Do you want to send it to the group?"
      });
      return;
    }

    const moderation = await detectTrollingWithGemini(message, targetRoom);

    if (moderation.isTrolling) {
      // Do not send the trolling text. Send a soothing message to the room.
      io.to(targetRoom).emit("moderation-message", {
        from: "Gemini Moderator",
        text: moderation.soothingMessage,
        reason: moderation.reason,
        confidence: moderation.confidence,
        timestamp: new Date().toISOString()
      });
      return;
    }

    sendChatToRoom(socket, { room: targetRoom, text: message });
  });

  socket.on("confirm-private-send", async ({ confirmationId, approved }) => {
    const pending = pendingPrivate.get(confirmationId);
    if (!pending || pending.socketId !== socket.id) return;

    pendingPrivate.delete(confirmationId);

    if (!approved) {
      socket.emit("private-info-cancelled", "Message was not sent.");
      return;
    }

    const user = users.get(socket.id);
    if (!user || user.room !== pending.room) return;

    // After explicit confirmation, run moderation before group broadcast.
    const moderation = await detectTrollingWithGemini(pending.text, pending.room);
    if (moderation.isTrolling) {
      io.to(pending.room).emit("moderation-message", {
        from: "Gemini Moderator",
        text: moderation.soothingMessage,
        reason: moderation.reason,
        confidence: moderation.confidence,
        timestamp: new Date().toISOString()
      });
      return;
    }

    sendChatToRoom(socket, {
      room: pending.room,
      text: pending.text
    });
  });

  socket.on("direct-message", ({ toId, text }) => {
    const user = users.get(socket.id);
    const target = users.get(toId);
    const message = String(text || "").trim().slice(0, 2000);

    if (!user || !target || !message) return;

    const payload = {
      type: "direct",
      from: user.username,
      fromId: socket.id,
      toId,
      text: message,
      timestamp: new Date().toISOString()
    };

    socket.emit("direct-message", payload);
    io.to(toId).emit("direct-message", payload);
  });

  socket.on("send-media", ({ room, url, mimeType, originalName }) => {
    const user = users.get(socket.id);
    if (!user || user.room !== cleanRoom(room)) return;

    io.to(user.room).emit("chat-media", {
      type: "media",
      from: user.username,
      fromId: socket.id,
      room: user.room,
      url,
      mimeType,
      originalName,
      timestamp: new Date().toISOString()
    });
  });

  socket.on("typing", ({ room, isTyping }) => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.to(user.room).emit("typing", {
      username: user.username,
      isTyping: Boolean(isTyping)
    });
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;

    removeFromRoom(socket.id, user.room);
    users.delete(socket.id);

    io.to(user.room).emit("system-message", {
      text: `${user.username} left #${user.room}`,
      timestamp: new Date().toISOString()
    });

    broadcastUserLists();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Gemini moderation: ${gemini ? "ENABLED" : "DISABLED (local fallback)"}`);
});
