const socket = io();

const $ = (id) => document.getElementById(id);

const loginPanel = $("loginPanel");
const chatPanel = $("chatPanel");
const usernameInput = $("usernameInput");
const roomInput = $("roomInput");
const connectBtn = $("connectBtn");
const loginError = $("loginError");

const messages = $("messages");
const messageForm = $("messageForm");
const messageInput = $("messageInput");
const mediaInput = $("mediaInput");
const mediaBtn = $("mediaBtn");
const uploadStatus = $("uploadStatus");

const roomChangeInput = $("roomChangeInput");
const joinRoomBtn = $("joinRoomBtn");
const roomList = $("roomList");
const userList = $("userList");
const onlineCount = $("onlineCount");

const myName = $("myName");
const myRoom = $("myRoom");
const myAvatar = $("myAvatar");
const chatTitle = $("chatTitle");
const chatSubtitle = $("chatSubtitle");
const connectionStatus = $("connectionStatus");
const geminiBadge = $("geminiBadge");
const typingIndicator = $("typingIndicator");
const disconnectBtn = $("disconnectBtn");

const confirmationModal = $("confirmationModal");
const confirmationText = $("confirmationText");
const confirmSendBtn = $("confirmSendBtn");
const cancelSendBtn = $("cancelSendBtn");

let currentUser = null;
let currentRoom = null;
let pendingConfirmationId = null;
let typingTimer = null;
let usersCache = [];

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function timeString(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function appendSystem(text, kind = "system") {
  const div = document.createElement("div");
  div.className = kind;
  div.innerHTML = escapeHtml(text);
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function appendTextMessage({ from, fromId, text, timestamp }) {
  const wrap = document.createElement("div");
  wrap.className = `message ${fromId === socket.id ? "mine" : ""}`;
  wrap.innerHTML = `
    <div class="meta">${escapeHtml(from)} · ${timeString(timestamp)}</div>
    <div class="bubble">${escapeHtml(text)}</div>
  `;
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}

function appendMediaMessage({ from, fromId, url, mimeType, originalName, timestamp }) {
  const wrap = document.createElement("div");
  wrap.className = `message media-message ${fromId === socket.id ? "mine" : ""}`;

  const media = mimeType.startsWith("video/")
    ? `<video controls src="${url}"></video>`
    : `<img src="${url}" alt="${escapeHtml(originalName || "shared image")}" />`;

  wrap.innerHTML = `
    <div class="meta">${escapeHtml(from)} · ${timeString(timestamp)}</div>
    <div class="bubble">${media}<div class="media-caption">${escapeHtml(originalName || "shared media")}</div></div>
  `;

  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}

function updateRoomUI(room) {
  currentRoom = room;
  myRoom.textContent = `#${room}`;
  chatTitle.textContent = `#${room}`;
  chatSubtitle.textContent = "Room chat · messages are distributed by the server";
}

function renderUsers(list) {
  usersCache = list;
  onlineCount.textContent = list.length;
  userList.innerHTML = "";

  list.forEach((u) => {
    const item = document.createElement("div");
    item.className = "user-item";
    item.title = "Click to send a one-to-one message";
    item.innerHTML = `<span class="dot"></span><span>${escapeHtml(u.username)}${u.id === socket.id ? " (you)" : ""}</span>`;
    if (u.id !== socket.id) {
      item.addEventListener("click", () => {
        const target = u.username;
        const text = prompt(`One-to-one message to ${target}:`);
        if (text && text.trim()) {
          const targetUser = usersCache.find(x => x.username === target);
          socket.emit("direct-message", { toId: targetUser.id, text: text.trim() });
        }
      });
    }
    userList.appendChild(item);
  });
}

function renderRooms(list) {
  const unique = [...new Set(list.map(u => u.room).filter(Boolean))];
  if (!unique.includes(currentRoom)) unique.push(currentRoom);

  roomList.innerHTML = "";
  unique.sort().forEach(room => {
    const item = document.createElement("div");
    item.className = `room-item ${room === currentRoom ? "active" : ""}`;
    item.textContent = `# ${room}`;
    item.addEventListener("click", () => socket.emit("join-room", { room }));
    roomList.appendChild(item);
  });
}

connectBtn.addEventListener("click", () => {
  loginError.textContent = "";
  socket.emit("register", {
    username: usernameInput.value,
    room: roomInput.value
  });
});

usernameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") connectBtn.click();
});
roomInput.addEventListener("keydown", e => {
  if (e.key === "Enter") connectBtn.click();
});

joinRoomBtn.addEventListener("click", () => {
  const room = roomChangeInput.value.trim();
  if (room) {
    socket.emit("join-room", { room });
    roomChangeInput.value = "";
  }
});

messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !currentRoom) return;

  socket.emit("chat-message", { text, room: currentRoom });
  messageInput.value = "";
  socket.emit("typing", { isTyping: false });
});

messageInput.addEventListener("input", () => {
  socket.emit("typing", { isTyping: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing", { isTyping: false }), 600);
});

mediaBtn.addEventListener("click", () => mediaInput.click());

mediaInput.addEventListener("change", async () => {
  const file = mediaInput.files[0];
  if (!file) return;

  uploadStatus.textContent = `Uploading ${file.name}…`;
  const formData = new FormData();
  formData.append("media", file);

  try {
    const response = await fetch("/upload", { method: "POST", body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed");

    socket.emit("send-media", {
      room: currentRoom,
      url: data.url,
      mimeType: data.mimeType,
      originalName: data.originalName
    });

    uploadStatus.textContent = "Media sent.";
  } catch (err) {
    uploadStatus.textContent = `Upload error: ${err.message}`;
  } finally {
    mediaInput.value = "";
    setTimeout(() => { uploadStatus.textContent = ""; }, 2500);
  }
});

disconnectBtn.addEventListener("click", () => {
  socket.disconnect();
  window.location.reload();
});

socket.on("connect", () => {
  connectionStatus.textContent = "Connected";
});

socket.on("disconnect", () => {
  connectionStatus.textContent = "Disconnected";
});

socket.on("register-error", (message) => {
  loginError.textContent = message;
});

socket.on("registered", ({ username, room, geminiConfigured }) => {
  currentUser = username;
  updateRoomUI(room);
  myName.textContent = username;
  myAvatar.textContent = username.charAt(0).toUpperCase();

  geminiBadge.textContent = geminiConfigured
    ? "Gemini: moderation ON"
    : "Gemini: key missing (fallback)";

  loginPanel.classList.add("hidden");
  chatPanel.classList.remove("hidden");
  appendSystem(`Connected as ${username}. Welcome to #${room}.`);
  if (!geminiConfigured) {
    appendSystem("Gemini API key is not configured. Trolling detection will use the local fallback until you add .env.");
  }
});

socket.on("user-list", (list) => {
  renderUsers(list);
  renderRooms(list);
});

socket.on("room-users", ({ room, users }) => {
  if (room === currentRoom) {
    renderUsers(users);
  }
});

socket.on("room-changed", (room) => {
  updateRoomUI(room);
  appendSystem(`You switched to #${room}.`);
});

socket.on("system-message", ({ text }) => appendSystem(text));

socket.on("chat-message", (payload) => appendTextMessage(payload));

socket.on("chat-media", (payload) => appendMediaMessage(payload));

socket.on("moderation-message", ({ from, text, confidence }) => {
  appendSystem(`${from}: ${text}${confidence ? ` (confidence ${(confidence * 100).toFixed(0)}%)` : ""}`, "moderation");
});

socket.on("direct-message", ({ from, fromId, text, timestamp }) => {
  const label = fromId === socket.id ? `To ${usersCache.find(u => u.id === currentUser)?.username || "client"}` : `Private from ${from}`;
  appendSystem(`${label}: ${text} · ${timeString(timestamp)}`, "moderation");
});

socket.on("typing", ({ username, isTyping }) => {
  typingIndicator.textContent = isTyping ? `${username} is typing…` : "";
});

socket.on("error-message", (message) => appendSystem(`Error: ${message}`, "moderation"));

socket.on("private-info-warning", ({ confirmationId, warning, text }) => {
  pendingConfirmationId = confirmationId;
  confirmationText.textContent = `${warning} Message preview: “${text}”`;
  confirmationModal.classList.remove("hidden");
});

confirmSendBtn.addEventListener("click", () => {
  if (!pendingConfirmationId) return;
  socket.emit("confirm-private-send", { confirmationId: pendingConfirmationId, approved: true });
  pendingConfirmationId = null;
  confirmationModal.classList.add("hidden");
});

cancelSendBtn.addEventListener("click", () => {
  if (!pendingConfirmationId) return;
  socket.emit("confirm-private-send", { confirmationId: pendingConfirmationId, approved: false });
  pendingConfirmationId = null;
  confirmationModal.classList.add("hidden");
});
