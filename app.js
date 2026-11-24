const bus = new BroadcastChannel("top_connect_channel");
let me = null;
let chatPeer = null;
let viewingProfileUser = null;
let activeTag = "ALL";
let feedSearchTerm = "";
let friendSearchTerm = "";
let chatListMode = "direct";
let stagedMedia = null;
let stagedAvatar = null;
let stagedAppBg = null;
let stagedChatBg = null;
let storyQueue = [];
let storyIdx = 0;
let storyTimer = null;
let vibesSoundOn = false;

// Active MoMo Tip State
let activeTipContext = null;

// Voice Note
let mediaRecorder = null;
let audioChunks = [];

// WebRTC
let pc = null;
let stream = null;
let callPeer = null;
let pendingOffer = null;
let videoEnabled = true;
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

document.addEventListener("DOMContentLoaded", async () => {
  await TopConnectDB.init();
  wireEvents();

  const saved = sessionStorage.getItem("tc_active_user");
  if (saved) {
    const u = await TopConnectDB.get("users", saved);
    if (u) startSession(u);
  }
});

function emit(type, data = {}) {
  bus.postMessage({ type, data, from: me?.username });
}

bus.onmessage = async (ev) => {
  if (!me) return;
  const { type, data } = ev.data;

  if (type === "SYNC") {
    const freshMe = await TopConnectDB.get("users", me.username);
    if (freshMe) me = freshMe;
    await deliverPendingMessages();
    if (chatPeer) await readActiveMessages(chatPeer);
    renderUI();
  }
  if (type === "OFFER" && data.to === me.username) onIncomingCall(data);
  if (type === "ANSWER" && data.to === me.username && pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    document.getElementById("call-status-msg").textContent = "Connected";
  }
  if (type === "CANDIDATE" && data.to === me.username && pc) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  }
  if (type === "HANGUP" && data.to === me.username) teardownCall();
};

function wireEvents() {
  // Auth tabs
  document.getElementById("tab-login").onclick = () => {
    document.getElementById("tab-login").classList.add("active");
    document.getElementById("tab-signup").classList.remove("active");
    document.getElementById("login-form").classList.remove("hidden");
    document.getElementById("signup-form").classList.add("hidden");
  };
  document.getElementById("tab-signup").onclick = () => {
    document.getElementById("tab-signup").classList.add("active");
    document.getElementById("tab-login").classList.remove("active");
    document.getElementById("signup-form").classList.remove("hidden");
    document.getElementById("login-form").classList.add("hidden");
  };

  document.getElementById("login-form").onsubmit = async (e) => {
    e.preventDefault();
    const u = document.getElementById("login-user").value.trim().toLowerCase();
    const p = document.getElementById("login-pass").value;
    const found = await TopConnectDB.get("users", u);
    if (!found || found.password !== p) return alert("Wrong username or password.");
    startSession(found);
  };

  document.getElementById("signup-form").onsubmit = async (e) => {
    e.preventDefault();
    const fullName = document.getElementById("reg-name").value.trim();
    const email = document.getElementById("reg-email").value.trim();
    const username = document.getElementById("reg-user").value.trim().toLowerCase().replace(/^@/, "");
    const city = document.getElementById("reg-city").value.trim();
    const momoNumber = document.getElementById("reg-phone").value.trim();
    const momoNetwork = document.getElementById("reg-momo-net").value;
    const password = document.getElementById("reg-pass").value;
    if (await TopConnectDB.get("users", username)) return alert("Username already exists.");

    const user = {
      username,
      fullName: fullName || username,
      email,
      city,
      password,
      wallet: 0,
      momoNetwork,
      momoNumber,
      momoAccountName: fullName || username,
      bio: `On Top Connect from ${city} ⚡`,
      friends: [],
      requests: [],
      blueTicks: true,
      avatar: null,
      appBgMode: "default",
      chatBgMode: "default",
      appBgImage: null,
      chatBgImage: null
    };
    await TopConnectDB.put("users", user);
    emit("SYNC");
    startSession(user);
  };

  document.getElementById("logout-btn").onclick = () => {
    sessionStorage.removeItem("tc_active_user");
    me = null;
    chatPeer = null;
    document.getElementById("app-shell").classList.add("hidden");
    document.getElementById("auth-screen").classList.remove("hidden");
  };

  // Bottom navigation
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.screen).classList.add("active");

      if (btn.dataset.screen === "screen-chat") {
        if (chatPeer) readActiveMessages(chatPeer);
        if (chatListMode === "sms") markSmsAsRead();
      }
      if (btn.dataset.screen === "screen-profile" && me) {
        if (!viewingProfileUser) viewingProfileUser = me.username;
        renderProfile();
      }
    };
  });

  // Data saver
  document.getElementById("saver-btn").onclick = (e) => {
    const on = document.body.classList.toggle("data-saver");
    e.target.textContent = `📶 Saver: ${on ? "ON" : "OFF"}`;
  };

  // Feed Search & Tag filters
  document.getElementById("feed-search").oninput = (e) => {
    feedSearchTerm = e.target.value.trim().toLowerCase();
    renderFeed();
  };

  document.querySelectorAll(".filter-pill[data-tag]").forEach((pill) => {
    pill.onclick = () => {
      document.querySelectorAll(".filter-pill[data-tag]").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      activeTag = pill.dataset.tag;
      renderFeed();
    };
  });

  // Friend Search
  document.getElementById("friend-search").oninput = (e) => {
    friendSearchTerm = e.target.value.trim().toLowerCase();
    renderFriends();
  };

  // AI Auto-News button
  document.getElementById("ai-auto-news-btn").onclick = async () => {
    const topics = [
      { tag: "Gist", city: "Accra", text: "🤖 AI Auto-News: Creator communities, local tech builders, and city meetups are trending across Ghana today." },
      { tag: "Vibes", city: "Kumasi", text: "🤖 AI Auto-News: Afrobeats clips, street style, and short video vibes are getting top engagement right now." },
      { tag: "Hustle", city: "Takoradi", text: "🤖 AI Auto-News: Small businesses sharing quick product demos & voice replies are seeing strong reach today." }
    ];
    const pick = topics[Math.floor(Math.random() * topics.length)];
    await TopConnectDB.put("posts", {
      id: "p_ai_" + Date.now(),
      author: "toppulse_ai",
      authorName: "TopPulse AI • Auto",
      city: pick.city,
      tag: pick.tag,
      isAI: true,
      text: pick.text,
      media: null,
      mediaType: null,
      likes: [],
      tips: 0,
      comments: [],
      time: Date.now()
    });
    emit("SYNC");
    renderUI();
  };

  // Story upload
  document.getElementById("story-upload").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const src = await toDataURL(file);
    await TopConnectDB.put("stories", {
      id: "st_" + Date.now(),
      author: me.username,
      authorName: me.fullName || me.username,
      src,
      type: file.type.startsWith("video") ? "video" : "image",
      createdAt: Date.now()
    });
    emit("SYNC");
    renderStories();
  };

  // Fullscreen story controls
  document.getElementById("close-story-btn").onclick = closeStoryModal;
  document.getElementById("story-next-zone").onclick = () => stepStory(1);
  document.getElementById("story-prev-zone").onclick = () => stepStory(-1);

  // Feed media & publish
  document.getElementById("feed-media").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const src = await toDataURL(file);
    stagedMedia = { src, type: file.type.startsWith("video") ? "video" : "image" };
    const box = document.getElementById("feed-preview");
    box.classList.remove("hidden");
    box.innerHTML = stagedMedia.type === "video"
      ? `<video src="${src}" controls></video>`
      : `<img src="${src}" alt="Preview" />`;
  };

  document.getElementById("post-btn").onclick = async () => {
    const text = document.getElementById("feed-caption").value.trim();
    const tag = document.getElementById("feed-tag").value;
    if (!text && !stagedMedia) return alert("Add text or a photo/video.");

    await TopConnectDB.put("posts", {
      id: "p_" + Date.now(),
      author: me.username,
      authorName: me.fullName || me.username,
      city: me.city,
      tag,
      text,
      media: stagedMedia?.src || null,
      mediaType: stagedMedia?.type || null,
      likes: [],
      tips: 0,
      comments: [],
      time: Date.now()
    });

    document.getElementById("feed-caption").value = "";
    document.getElementById("feed-preview").classList.add("hidden");
    stagedMedia = null;
    emit("SYNC");
    renderUI();
  };

  // Chat / SMS Mode Switch
  document.getElementById("mode-direct-btn").onclick = () => switchChatMode("direct");
  document.getElementById("mode-sms-btn").onclick = () => switchChatMode("sms");

  // SMS Composer
  document.getElementById("sms-body-input").oninput = (e) => {
    document.getElementById("sms-char-count").textContent = `${e.target.value.length} / 160`;
  };

  document.getElementById("sms-native-btn").onclick = () => {
    const target = document.getElementById("sms-to-input").value.trim();
    const body = document.getElementById("sms-body-input").value.trim();
    if (!target) return alert("Enter a phone number first.");
    const cleanPhone = target.replace(/[^0-9+]/g, "");
    window.location.href = `sms:${cleanPhone}?body=${encodeURIComponent(body)}`;
  };

  document.getElementById("sms-compose-form").onsubmit = async (e) => {
    e.preventDefault();
    const targetRaw = document.getElementById("sms-to-input").value.trim();
    const body = document.getElementById("sms-body-input").value.trim();
    if (!targetRaw || !body) return;

    const allUsers = await TopConnectDB.getAll("users");
    const cleanTarget = targetRaw.toLowerCase().replace(/^@/, "");
    const matchedUser = allUsers.find(
      (u) => u.username === cleanTarget || (u.momoNumber && u.momoNumber.replace(/\s+/g, "") === targetRaw.replace(/\s+/g, ""))
    );

    await TopConnectDB.put("sms_messages", {
      id: "sms_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5),
      fromUser: me.username,
      fromPhone: me.momoNumber || me.username,
      toUser: matchedUser ? matchedUser.username : "external",
      toPhone: matchedUser ? (matchedUser.momoNumber || `@${matchedUser.username}`) : targetRaw,
      body,
      read: false,
      at: Date.now()
    });

    document.getElementById("sms-body-input").value = "";
    document.getElementById("sms-char-count").textContent = "0 / 160";
    emit("SYNC");
    renderSmsCenter();
    alert(matchedUser ? `SMS delivered to ${matchedUser.fullName}!` : `SMS logged for ${targetRaw}.`);
  };

  // Chat room actions
  document.getElementById("back-to-chats").onclick = () => {
    document.getElementById("chat-room-pane").classList.add("hidden");
    document.getElementById("chat-list-pane").classList.remove("hidden");
  };

  document.getElementById("btn-room-sms").onclick = async () => {
    if (!chatPeer) return;
    const partner = await TopConnectDB.get("users", chatPeer);
    document.getElementById("chat-room-pane").classList.add("hidden");
    document.getElementById("chat-list-pane").classList.remove("hidden");
    switchChatMode("sms");
    document.getElementById("sms-to-input").value = partner?.momoNumber || `@${chatPeer}`;
    document.getElementById("sms-body-input").focus();
  };

  document.getElementById("room-form").onsubmit = async (e) => {
    e.preventDefault();
    const inp = document.getElementById("room-input");
    const text = inp.value.trim();
    if (!text || !chatPeer) return;
    await pushMessage({ text });
    inp.value = "";
  };

  document.getElementById("room-media").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file || !chatPeer) return;
    const src = await toDataURL(file);
    await pushMessage({
      text: "",
      media: src,
      mediaType: file.type.startsWith("video") ? "video" : "image"
    });
  };

  // Voice Note Recording
  document.getElementById("voice-note-btn").onclick = async (e) => {
    if (!chatPeer) return alert("Open a chat first.");

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(micStream);

        mediaRecorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) audioChunks.push(ev.data);
        };

        mediaRecorder.onstop = async () => {
          micStream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
          const audioDataUrl = await toDataURL(blob);
          await pushMessage({ text: "", audio: audioDataUrl });
        };

        mediaRecorder.start();
        e.currentTarget.classList.add("recording");
        e.currentTarget.textContent = "⏹";
      } catch {
        alert("Microphone permission denied or unavailable.");
      }
    } else {
      mediaRecorder.stop();
      e.currentTarget.classList.remove("recording");
      e.currentTarget.textContent = "🎤";
    }
  };

  // MoMo Tip Modal Events
  document.getElementById("close-momo-modal").onclick = closeMomoModal;

  document.querySelectorAll(".preset-amt").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".preset-amt").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("momo-tip-amount").value = btn.dataset.amt;
    };
  });

  document.getElementById("momo-sender-network").onchange = (e) => {
    const net = e.target.value;
    const code = net === "MTN MoMo" ? "*170#" : "*110#";
    document.getElementById("momo-ussd-direct-link").href = `tel:${encodeURIComponent(code)}`;
    document.getElementById("momo-ussd-direct-link").textContent = `📞 Dial ${code}`;
  };

  document.getElementById("momo-tip-form").onsubmit = (e) => {
    e.preventDefault();
    if (!activeTipContext) return;

    const amount = Number(document.getElementById("momo-tip-amount").value);
    const senderNetwork = document.getElementById("momo-sender-network").value;
    const senderNumber = document.getElementById("momo-sender-number").value.trim();
    const senderName = document.getElementById("momo-sender-name").value.trim();
    const reference = document.getElementById("momo-tip-ref").value.trim() || "Top Connect Creator Tip";

    if (!amount || amount <= 0) return alert("Enter a valid GHS amount.");
    if (!senderNumber || !senderName) return alert("Fill in your MoMo number and account name.");

    activeTipContext.pendingTx = { amount, senderNetwork, senderNumber, senderName, reference };

    document.getElementById("ussd-network-banner").textContent = `${senderNetwork} Authorization Prompt`;
    document.getElementById("ussd-prompt-text").innerHTML =
      `Transfer <strong>GHS ${amount.toFixed(2)}</strong> from <strong>${esc(senderNumber)}</strong> (${esc(senderName)}) ` +
      `to <strong>${esc(activeTipContext.recipientName)}</strong> (${esc(activeTipContext.recipientNumber)} • ${esc(activeTipContext.recipientNetwork)}).<br/>` +
      `Ref: <em>${esc(reference)}</em>`;

    document.getElementById("momo-pin-input").value = "";
    document.getElementById("momo-tip-form").classList.add("hidden");
    document.getElementById("momo-pin-step").classList.remove("hidden");
  };

  document.getElementById("cancel-momo-pin-btn").onclick = () => {
    document.getElementById("momo-pin-step").classList.add("hidden");
    document.getElementById("momo-tip-form").classList.remove("hidden");
  };

  document.getElementById("confirm-momo-pin-btn").onclick = async () => {
    const pin = document.getElementById("momo-pin-input").value.trim();
    if (pin.length < 4) return alert("Enter your 4-digit MoMo PIN to authorize.");
    if (!activeTipContext?.pendingTx) return;

    const { postId, recipientUsername, recipientName, recipientNumber, recipientNetwork, pendingTx } = activeTipContext;
    const txId = "MOMO-" + Date.now().toString().slice(-8);

    // 1. Update Post Tips
    const post = await TopConnectDB.get("posts", postId);
    if (post) {
      post.tips = Number(post.tips || 0) + pendingTx.amount;
      await TopConnectDB.put("posts", post);
    }

    // 2. Credit Recipient's Received Tips Total
    if (recipientUsername) {
      const recipientUser = await TopConnectDB.get("users", recipientUsername);
      if (recipientUser) {
        recipientUser.wallet = Number(recipientUser.wallet || 0) + pendingTx.amount;
        await TopConnectDB.put("users", recipientUser);
      }
    }

    // 3. Save Sender's MoMo details on profile for convenience next time
    me.momoNetwork = pendingTx.senderNetwork;
    me.momoNumber = pendingTx.senderNumber;
    me.momoAccountName = pendingTx.senderName;
    await TopConnectDB.put("users", me);

    // 4. Record MoMo Receipt in Local Ledger
    await TopConnectDB.put("momo_transactions", {
      id: txId,
      postId,
      fromUser: me.username,
      fromName: pendingTx.senderName,
      fromNumber: pendingTx.senderNumber,
      fromNetwork: pendingTx.senderNetwork,
      toUser: recipientUsername || "creator",
      toName: recipientName,
      toNumber: recipientNumber,
      toNetwork: recipientNetwork,
      amount: pendingTx.amount,
      reference: pendingTx.reference,
      status: "SUCCESS",
      at: Date.now()
    });

    // 5. Send Instant SMS Confirmation to Recipient & Sender
    await TopConnectDB.put("sms_messages", {
      id: "sms_momo_" + Date.now(),
      fromUser: "system",
      fromPhone: pendingTx.senderNetwork,
      toUser: recipientUsername || me.username,
      toPhone: recipientNumber,
      body: `MoMo Alert (${txId}): You received GHS ${pendingTx.amount.toFixed(2)} from ${pendingTx.senderName} (${pendingTx.senderNumber}) on Top Connect. Ref: ${pendingTx.reference}`,
      read: false,
      at: Date.now()
    });

    closeMomoModal();
    emit("SYNC");
    renderUI();
    alert(`✅ MoMo Payment Approved!\nRef ID: ${txId}\nSent GHS ${pendingTx.amount.toFixed(2)} to ${recipientName} (${recipientNumber}).`);
  };

  // Settings media staging
  document.getElementById("cfg-avatar-file").onchange = async (e) => {
    if (e.target.files[0]) stagedAvatar = await toDataURL(e.target.files[0]);
  };
  document.getElementById("cfg-app-bg-file").onchange = async (e) => {
    if (e.target.files[0]) {
      stagedAppBg = await toDataURL(e.target.files[0]);
      document.getElementById("cfg-app-bg").value = "custom";
    }
  };
  document.getElementById("cfg-chat-bg-file").onchange = async (e) => {
    if (e.target.files[0]) {
      stagedChatBg = await toDataURL(e.target.files[0]);
      document.getElementById("cfg-chat-bg").value = "custom";
    }
  };

  // Save Settings
  document.getElementById("save-cfg-btn").onclick = async () => {
    me.fullName = document.getElementById("cfg-name").value.trim() || me.fullName;
    me.city = document.getElementById("cfg-city").value.trim() || me.city;
    me.bio = document.getElementById("cfg-bio").value.trim();
    me.momoNetwork = document.getElementById("cfg-momo-net").value;
    me.momoNumber = document.getElementById("cfg-momo-num").value.trim();
    me.momoAccountName = document.getElementById("cfg-momo-acc-name").value.trim() || me.fullName;
    me.blueTicks = document.getElementById("cfg-blue-ticks").checked;
    me.appBgMode = document.getElementById("cfg-app-bg").value;
    me.chatBgMode = document.getElementById("cfg-chat-bg").value;
    if (stagedAvatar) me.avatar = stagedAvatar;
    if (stagedAppBg) me.appBgImage = stagedAppBg;
    if (stagedChatBg) me.chatBgImage = stagedChatBg;

    document.body.classList.toggle("light-mode", !document.getElementById("cfg-dark").checked);
    await TopConnectDB.put("users", me);
    stagedAvatar = null;
    stagedAppBg = null;
    stagedChatBg = null;
    emit("SYNC");
    renderUI();
    alert("Saved.");
  };

  document.getElementById("reset-db-btn").onclick = () => {
    indexedDB.deleteDatabase(TC_DB_NAME);
    sessionStorage.clear();
    location.reload();
  };

  // Calls
  document.getElementById("btn-voice-call").onclick = () => startCall(false);
  document.getElementById("btn-video-call").onclick = () => startCall(true);
  document.getElementById("answer-call-btn").onclick = answerCall;
  document.getElementById("hangup-call-btn").onclick = hangupCall;
  document.getElementById("mute-audio-btn").onclick = (e) => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.target.textContent = track.enabled ? "🎙️ Mute" : "🔇 Unmute";
  };
}

async function startSession(user) {
  me = user;
  viewingProfileUser = user.username;
  sessionStorage.setItem("tc_active_user", user.username);
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");

  await deliverPendingMessages();
  emit("SYNC");
  renderUI();
}

function applyCustomVisuals() {
  const screenBox = document.getElementById("screen-container");
  screenBox.classList.remove("bg-midnight", "bg-sunset");
  screenBox.style.backgroundImage = "";

  const appBgMode = me.appBgMode || "default";
  if (appBgMode === "midnight") screenBox.classList.add("bg-midnight");
  else if (appBgMode === "sunset") screenBox.classList.add("bg-sunset");
  else if (appBgMode === "custom" && me.appBgImage) {
    screenBox.style.backgroundImage = `url(${me.appBgImage})`;
    screenBox.style.backgroundSize = "cover";
    screenBox.style.backgroundPosition = "center";
  }

  const roomBox = document.getElementById("room-messages");
  roomBox.classList.remove("chat-bg-emerald", "chat-bg-warm");
  roomBox.style.backgroundImage = "";

  const chatBgMode = me.chatBgMode || "default";
  if (chatBgMode === "emerald") roomBox.classList.add("chat-bg-emerald");
  else if (chatBgMode === "warm") roomBox.classList.add("chat-bg-warm");
  else if (chatBgMode === "custom" && me.chatBgImage) {
    roomBox.style.backgroundImage = `url(${me.chatBgImage})`;
    roomBox.style.backgroundSize = "cover";
    roomBox.style.backgroundPosition = "center";
  }

  const avatarImg = me.avatar ? `<img src="${me.avatar}" class="avatar-sm" alt="" />` : "";
  document.getElementById("header-user-tag").innerHTML = `${avatarImg}@${esc(me.username)} • ${esc(me.city)}`;
}

function renderUI() {
  if (!me) return;
  document.getElementById("wallet-chip").textContent = `₵${Number(me.wallet || 0).toFixed(2)}`;

  document.getElementById("cfg-name").value = me.fullName || me.username;
  document.getElementById("cfg-city").value = me.city || "";
  document.getElementById("cfg-bio").value = me.bio || "";
  document.getElementById("cfg-momo-net").value = me.momoNetwork || "MTN MoMo";
  document.getElementById("cfg-momo-num").value = me.momoNumber || "";
  document.getElementById("cfg-momo-acc-name").value = me.momoAccountName || me.fullName || "";
  document.getElementById("cfg-blue-ticks").checked = me.blueTicks !== false;
  document.getElementById("cfg-app-bg").value = me.appBgMode || "default";
  document.getElementById("cfg-chat-bg").value = me.chatBgMode || "default";

  applyCustomVisuals();
  renderStories();
  renderFeed();
  renderVibes();
  renderFriends();
  renderChatThreads();
  renderSmsCenter();
  renderProfile();
  renderMomoLedger();
  if (chatPeer) renderRoomMessages();
}

/* STORIES */
async function renderStories() {
  const all = await TopConnectDB.getAll("stories");
  storyQueue = all.filter((s) => Date.now() - s.createdAt < 86400000);
  const strip = document.getElementById("stories-strip");

  strip.innerHTML = storyQueue.map((s, i) => `
    <div class="story-card" onclick="openStoryAt(${i})">
      <div class="story-ring">
        ${s.type === "video"
          ? `<div class="story-thumb">▶</div>`
          : `<img class="story-thumb" src="${s.src}" alt="" />`}
      </div>
      <span>${esc((s.authorName || s.author).split(" ")[0])}</span>
    </div>
  `).join("");
}

function openStoryAt(index) {
  if (!storyQueue[index]) return closeStoryModal();
  storyIdx = index;
  const s = storyQueue[storyIdx];
  document.getElementById("story-author-name").textContent = s.authorName || s.author;
  document.getElementById("story-time-ago").textContent = timeAgo(s.createdAt);
  document.getElementById("story-stage").innerHTML = s.type === "video"
    ? `<video src="${s.src}" autoplay controls playsinline></video>`
    : `<img src="${s.src}" alt="Story" />`;
  document.getElementById("story-modal").classList.remove("hidden");

  clearTimeout(storyTimer);
  const bar = document.getElementById("story-progress-bar");
  bar.style.transition = "none";
  bar.style.width = "0%";
  requestAnimationFrame(() => {
    bar.style.transition = "width 6s linear";
    bar.style.width = "100%";
  });
  storyTimer = setTimeout(() => stepStory(1), 6000);
}

function closeStoryModal() {
  clearTimeout(storyTimer);
  document.getElementById("story-modal").classList.add("hidden");
}

function stepStory(dir) {
  const next = storyIdx + dir;
  if (next >= 0 && next < storyQueue.length) openStoryAt(next);
  else closeStoryModal();
}

/* FEED */
async function renderFeed() {
  let posts = (await TopConnectDB.getAll("posts")).sort((a, b) => b.time - a.time);
  if (activeTag !== "ALL") posts = posts.filter((p) => p.tag === activeTag);
  if (feedSearchTerm) {
    posts = posts.filter((p) =>
      (p.text || "").toLowerCase().includes(feedSearchTerm) ||
      (p.authorName || "").toLowerCase().includes(feedSearchTerm) ||
      (p.author || "").toLowerCase().includes(feedSearchTerm) ||
      (p.city || "").toLowerCase().includes(feedSearchTerm)
    );
  }

  document.getElementById("posts-feed").innerHTML = posts.map((p) => {
    const likes = Array.isArray(p.likes) ? p.likes : [];
    const comments = Array.isArray(p.comments) ? p.comments : [];
    const liked = likes.includes(me.username);
    const isMine = p.author === me.username;

    return `
      <article class="surface-card">
        <div class="post-top">
          <div>
            <div class="post-author" onclick="openUserProfile('${esc(p.author)}')">${esc(p.authorName || p.author)}</div>
            <div class="post-sub">@${esc(p.author)} • ${esc(p.city)} • ${timeAgo(p.time)}</div>
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <span class="post-badge">${esc(p.tag)}</span>
            ${isMine ? `<button type="button" class="mini-action alt" style="padding:3px 8px;" onclick="deletePost('${p.id}')" title="Delete post">🗑️</button>` : ""}
          </div>
        </div>
        ${p.text ? `<p class="post-text">${esc(p.text)}</p>` : ""}
        ${p.media ? `<div class="post-media">${p.mediaType === "video"
          ? `<video src="${p.media}" controls playsinline></video>`
          : `<img src="${p.media}" alt="" />`}</div>` : ""}
        <div class="post-bar">
          <button type="button" onclick="likePost('${p.id}')">${liked ? "❤️" : "🤍"} ${likes.length}</button>
          <button type="button" onclick="openMomoTipModal('${p.id}')">📲 MoMo Tip (₵${Number(p.tips || 0).toFixed(2)})</button>
        </div>
        <div class="comments-wrap">
          ${comments.map((c) => `<div class="comment-line"><strong>${esc(c.by)}:</strong> ${esc(c.text)}</div>`).join("")}
          <form class="comment-add" onsubmit="commentPost(event, '${p.id}')">
            <input type="text" placeholder="Add a comment..." required />
            <button type="submit">Post</button>
          </form>
        </div>
      </article>
    `;
  }).join("");
}

async function deletePost(id) {
  if (!confirm("Delete this post?")) return;
  await TopConnectDB.delete("posts", id);
  emit("SYNC");
  renderUI();
}

/* MOMO REAL TIP CHECKOUT */
async function openMomoTipModal(postId) {
  const post = await TopConnectDB.get("posts", postId);
  if (!post) return;

  const recipient = post.author ? await TopConnectDB.get("users", post.author) : null;
  const recipientName = recipient?.momoAccountName || recipient?.fullName || post.authorName || post.author;
  const recipientNumber = recipient?.momoNumber || "Not set (Creator will receive via @username)";
  const recipientNetwork = recipient?.momoNetwork || "MTN MoMo";

  activeTipContext = {
    postId,
    recipientUsername: recipient?.username || post.author,
    recipientName,
    recipientNumber,
    recipientNetwork,
    pendingTx: null
  };

  document.getElementById("momo-recipient-title").textContent = `Tip ${recipientName}`;
  document.getElementById("momo-recipient-box").innerHTML = `
    <div class="momo-rec-row"><span>Recipient Name:</span><strong>${esc(recipientName)}</strong></div>
    <div class="momo-rec-row"><span>Network:</span><strong>${esc(recipientNetwork)}</strong></div>
    <div class="momo-rec-row"><span>MoMo Number:</span><strong>${esc(recipientNumber)}</strong></div>
  `;

  // Pre-fill sender's saved MoMo details
  document.getElementById("momo-sender-network").value = me.momoNetwork || "MTN MoMo";
  document.getElementById("momo-sender-number").value = me.momoNumber || "";
  document.getElementById("momo-sender-name").value = me.momoAccountName || me.fullName || "";
  document.getElementById("momo-tip-amount").value = "5";
  document.getElementById("momo-tip-ref").value = "";

  document.querySelectorAll(".preset-amt").forEach((b) => b.classList.toggle("active", b.dataset.amt === "5"));
  document.getElementById("momo-pin-step").classList.add("hidden");
  document.getElementById("momo-tip-form").classList.remove("hidden");
  document.getElementById("momo-tip-modal").classList.remove("hidden");
}

function closeMomoModal() {
  activeTipContext = null;
  document.getElementById("momo-tip-modal").classList.add("hidden");
}

async function renderMomoLedger() {
  const box = document.getElementById("momo-ledger-list");
  if (!box) return;
  const allTx = (await TopConnectDB.getAll("momo_transactions"))
    .filter((t) => t.fromUser === me.username || t.toUser === me.username)
    .sort((a, b) => b.at - a.at);

  box.innerHTML = allTx.length
    ? allTx.map((t) => {
        const isIncoming = t.toUser === me.username;
        return `
          <div class="friend-row" style="align-items:flex-start;">
            <div>
              <strong>${isIncoming ? `Received from ${esc(t.fromName)}` : `Sent to ${esc(t.toName)}`}</strong>
              <div class="post-sub">${esc(t.fromNetwork)} → ${esc(t.toNetwork)} (${esc(t.toNumber)})</div>
              <div class="post-sub">Ref: ${esc(t.id)} • ${new Date(t.at).toLocaleString()}</div>
            </div>
            <span class="post-badge" style="color:${isIncoming ? "var(--ok)" : "var(--brand)"};">
              ${isIncoming ? "+" : "-"}₵${Number(t.amount).toFixed(2)}
            </span>
          </div>
        `;
      }).join("")
    : `<p class="post-sub">No Mobile Money tip receipts yet.</p>`;
}

/* VIBES */
async function renderVibes() {
  const mediaPosts = (await TopConnectDB.getAll("posts"))
    .filter((p) => p.media)
    .sort((a, b) => b.time - a.time);

  const el = document.getElementById("vibes-stream");
  if (!mediaPosts.length) {
    el.innerHTML = `<div class="surface-card"><p class="post-sub">No photo or video vibes yet. Upload one in Feed!</p></div>`;
    return;
  }

  el.innerHTML = mediaPosts.map((p, idx) => `
    <div class="vibe-card">
      <div class="vibe-media-wrap">
        ${p.mediaType === "video"
          ? `<video src="${p.media}" autoplay loop playsinline ${vibesSoundOn ? "" : "muted"} onclick="toggleVibeSound()"></video>
             <button type="button" class="vibe-sound-btn" id="vibe-snd-btn-${idx}" onclick="toggleVibeSound()">${vibesSoundOn ? "🔊 Sound ON" : "🔇 Tap for Sound"}</button>`
          : `<img src="${p.media}" alt="" />`}
      </div>
      <div class="vibe-overlay">
        <strong>@${esc(p.author)}</strong> • <span class="post-sub">${esc(p.city)}</span>
        ${p.text ? `<p class="post-text" style="margin-top:4px;">${esc(p.text)}</p>` : ""}
        <div class="post-bar">
          <button type="button" onclick="likePost('${p.id}')">❤️ ${(p.likes || []).length}</button>
          <button type="button" onclick="openMomoTipModal('${p.id}')">📲 MoMo Tip</button>
        </div>
      </div>
    </div>
  `).join("");
}

function toggleVibeSound() {
  vibesSoundOn = !vibesSoundOn;
  document.querySelectorAll(".vibe-media-wrap video").forEach((vid) => {
    vid.muted = !vibesSoundOn;
    if (vibesSoundOn) vid.play().catch(() => {});
  });
  document.querySelectorAll(".vibe-sound-btn").forEach((btn) => {
    btn.textContent = vibesSoundOn ? "🔊 Sound ON" : "🔇 Tap for Sound";
  });
}

async function likePost(id) {
  const p = await TopConnectDB.get("posts", id);
  if (!p) return;
  p.likes = Array.isArray(p.likes) ? p.likes : [];
  const i = p.likes.indexOf(me.username);
  if (i > -1) p.likes.splice(i, 1);
  else p.likes.push(me.username);
  await TopConnectDB.put("posts", p);
  emit("SYNC");
  renderUI();
}

async function commentPost(e, id) {
  e.preventDefault();
  const input = e.target.querySelector("input");
  const p = await TopConnectDB.get("posts", id);
  if (!p) return;
  p.comments = Array.isArray(p.comments) ? p.comments : [];
  p.comments.push({ by: me.fullName || me.username, text: input.value.trim() });
  await TopConnectDB.put("posts", p);
  emit("SYNC");
  renderUI();
}

/* PROFILE */
async function openUserProfile(username) {
  viewingProfileUser = username;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.screen === "screen-profile");
  });
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById("screen-profile").classList.add("active");
  await renderProfile();
}

async function renderProfile() {
  if (!me) return;
  const targetName = viewingProfileUser || me.username;
  const profileUser = await TopConnectDB.get("users", targetName);
  if (!profileUser) return;

  const userPosts = (await TopConnectDB.getAll("posts"))
    .filter((p) => p.author === profileUser.username)
    .sort((a, b) => b.time - a.time);

  const avatarEl = profileUser.avatar
    ? `<img src="${profileUser.avatar}" class="avatar-lg" alt="" />`
    : `<div class="avatar-lg">👤</div>`;

  const isMe = profileUser.username === me.username;
  const isFriend = (me.friends || []).includes(profileUser.username);
  const hasIncoming = (me.requests || []).includes(profileUser.username);
  const hasSent = (profileUser.requests || []).includes(me.username);

  let actionBtn = "";
  if (!isMe) {
    if (isFriend) {
      actionBtn = `<button type="button" class="mini-action" onclick="openChatTab('${profileUser.username}')">Message</button>`;
    } else if (hasIncoming) {
      actionBtn = `<button type="button" class="mini-action" onclick="acceptReq('${profileUser.username}')">Accept Request</button>`;
    } else if (hasSent) {
      actionBtn = `<button type="button" class="mini-action alt" onclick="cancelReq('${profileUser.username}')">Cancel Request</button>`;
    } else {
      actionBtn = `<button type="button" class="mini-action" onclick="addReq('${profileUser.username}')">Add Friend</button>`;
    }
  }

  document.getElementById("profile-card").innerHTML = `
    <div class="profile-top">
      ${avatarEl}
      <div>
        <h2>${esc(profileUser.fullName || profileUser.username)}</h2>
        <div class="post-sub">@${esc(profileUser.username)} • ${esc(profileUser.city)}</div>
        ${profileUser.momoNumber ? `<div class="post-sub">📲 ${esc(profileUser.momoNetwork || "MoMo")}: ${esc(profileUser.momoNumber)}</div>` : ""}
      </div>
    </div>
    <p class="post-text">${esc(profileUser.bio || "")}</p>
    <div class="profile-stats">
      <span><strong>${userPosts.length}</strong> Posts</span>
      <span><strong>${(profileUser.friends || []).length}</strong> Friends</span>
      ${actionBtn}
      ${!isMe ? `<button type="button" class="mini-action alt" onclick="openUserProfile('${me.username}')">My Profile</button>` : ""}
    </div>
  `;

  const friends = profileUser.friends || [];
  document.getElementById("profile-friends-list").innerHTML = friends.length
    ? friends.map((f) => `
        <div class="friend-row">
          <span>@${esc(f)}</span>
          <button type="button" class="mini-action alt" onclick="openUserProfile('${esc(f)}')">View</button>
        </div>
      `).join("")
    : `<p class="post-sub">No friends listed yet.</p>`;

  document.getElementById("profile-posts-list").innerHTML = userPosts.length
    ? userPosts.map((p) => `
        <article class="surface-card">
          <div class="post-top">
            <span class="post-sub">${new Date(p.time).toLocaleDateString()}</span>
            <span class="post-badge">${esc(p.tag)}</span>
          </div>
          ${p.text ? `<p class="post-text">${esc(p.text)}</p>` : ""}
          ${p.media ? `<div class="post-media">${p.mediaType === "video"
            ? `<video src="${p.media}" controls playsinline></video>`
            : `<img src="${p.media}" alt="" />`}</div>` : ""}
        </article>
      `).join("")
    : `<div class="surface-card"><p class="post-sub">No posts from @${esc(profileUser.username)} yet.</p></div>`;
}

/* FRIENDS & REQUESTS */
async function renderFriends() {
  const users = await TopConnectDB.getAll("users");
  const reqs = me.requests || [];
  const friends = me.friends || [];

  const reqDot = document.getElementById("nav-req-dot");
  reqDot.textContent = reqs.length;
  reqDot.classList.toggle("hidden", reqs.length === 0);

  document.getElementById("requests-list").innerHTML = reqs.length
    ? reqs.map((u) => `
        <div class="friend-row">
          <span style="cursor:pointer;" onclick="openUserProfile('${esc(u)}')"><strong>@${esc(u)}</strong></span>
          <div style="display:flex; gap:6px;">
            <button type="button" class="mini-action" onclick="acceptReq('${u}')">Accept</button>
            <button type="button" class="mini-action alt" onclick="declineReq('${u}')">Decline</button>
          </div>
        </div>
      `).join("")
    : `<p class="post-sub">No pending requests.</p>`;

  const sentUsers = users.filter((u) => (u.requests || []).includes(me.username));
  document.getElementById("sent-requests-list").innerHTML = sentUsers.length
    ? sentUsers.map((u) => `
        <div class="friend-row">
          <div><strong>${esc(u.fullName || u.username)}</strong> <span class="post-sub">@${esc(u.username)}</span></div>
          <button type="button" class="mini-action alt" onclick="cancelReq('${u.username}')">Cancel</button>
        </div>
      `).join("")
    : `<p class="post-sub">No outgoing friend requests.</p>`;

  document.getElementById("friends-list").innerHTML = friends.length
    ? friends.map((u) => `
        <div class="friend-row">
          <span style="cursor:pointer;" onclick="openUserProfile('${esc(u)}')"><strong>@${esc(u)}</strong></span>
          <div style="display:flex; gap:6px;">
            <button type="button" class="mini-action alt" onclick="openChatTab('${u}')">Message</button>
            <button type="button" class="mini-action alt" onclick="removeFriend('${u}')">Unfriend</button>
          </div>
        </div>
      `).join("")
    : `<p class="post-sub">No friends added yet.</p>`;

  let others = users.filter((u) =>
    u.username !== me.username &&
    !friends.includes(u.username) &&
    !reqs.includes(u.username) &&
    !(u.requests || []).includes(me.username)
  );

  if (friendSearchTerm) {
    others = others.filter((u) =>
      (u.fullName || "").toLowerCase().includes(friendSearchTerm) ||
      u.username.toLowerCase().includes(friendSearchTerm) ||
      (u.city || "").toLowerCase().includes(friendSearchTerm)
    );
  }

  document.getElementById("suggestions-list").innerHTML = others.length
    ? others.map((u) => `
        <div class="friend-row">
          <div style="cursor:pointer;" onclick="openUserProfile('${esc(u.username)}')">
            <strong>${esc(u.fullName || u.username)}</strong>
            <div class="post-sub">@${esc(u.username)} • ${esc(u.city)}</div>
          </div>
          <button type="button" class="mini-action" onclick="addReq('${u.username}')">Add Friend</button>
        </div>
      `).join("")
    : `<p class="post-sub">No new people matching your search.</p>`;
}

async function addReq(targetName) {
  const t = await TopConnectDB.get("users", targetName);
  if (!t) return;
  t.requests = t.requests || [];
  if (!t.requests.includes(me.username)) {
    t.requests.push(me.username);
    await TopConnectDB.put("users", t);
    emit("SYNC");
    renderUI();
  }
}

async function cancelReq(targetName) {
  const t = await TopConnectDB.get("users", targetName);
  if (!t) return;
  t.requests = (t.requests || []).filter((x) => x !== me.username);
  await TopConnectDB.put("users", t);
  emit("SYNC");
  renderUI();
}

async function declineReq(fromName) {
  me.requests = (me.requests || []).filter((x) => x !== fromName);
  await TopConnectDB.put("users", me);
  emit("SYNC");
  renderUI();
}

async function acceptReq(fromName) {
  me.requests = (me.requests || []).filter((x) => x !== fromName);
  me.friends = me.friends || [];
  if (!me.friends.includes(fromName)) me.friends.push(fromName);
  await TopConnectDB.put("users", me);

  const other = await TopConnectDB.get("users", fromName);
  if (other) {
    other.friends = other.friends || [];
    if (!other.friends.includes(me.username)) {
      other.friends.push(me.username);
      await TopConnectDB.put("users", other);
    }
  }
  emit("SYNC");
  renderUI();
}

async function removeFriend(targetName) {
  if (!confirm(`Remove @${targetName} from your friends?`)) return;
  me.friends = (me.friends || []).filter((x) => x !== targetName);
  await TopConnectDB.put("users", me);

  const other = await TopConnectDB.get("users", targetName);
  if (other) {
    other.friends = (other.friends || []).filter((x) => x !== me.username);
    await TopConnectDB.put("users", other);
  }
  emit("SYNC");
  renderUI();
}

function openChatTab(username) {
  document.querySelector('[data-screen="screen-chat"]').click();
  switchChatMode("direct");
  enterRoom(username);
}

/* CHAT, SMS & TICKS */
function switchChatMode(mode) {
  chatListMode = mode;
  document.getElementById("mode-direct-btn").classList.toggle("active", mode === "direct");
  document.getElementById("mode-sms-btn").classList.toggle("active", mode === "sms");
  document.getElementById("direct-threads-wrap").classList.toggle("hidden", mode !== "direct");
  document.getElementById("sms-center-wrap").classList.toggle("hidden", mode !== "sms");
  if (mode === "sms") markSmsAsRead();
}

async function renderSmsCenter() {
  const allSms = await TopConnectDB.getAll("sms_messages");
  const mySms = allSms
    .filter((s) => s.toUser === me.username || s.fromUser === me.username)
    .sort((a, b) => b.at - a.at);

  const unreadSmsCount = mySms.filter((s) => s.toUser === me.username && !s.read).length;
  const pill = document.getElementById("sms-unread-pill");
  if (pill) {
    pill.textContent = unreadSmsCount;
    pill.classList.toggle("hidden", unreadSmsCount === 0);
  }

  const list = document.getElementById("sms-inbox-list");
  if (!list) return;

  list.innerHTML = mySms.length
    ? mySms.map((s) => {
        const isOutgoing = s.fromUser === me.username;
        return `
          <div class="surface-card" style="padding:11px;">
            <div class="post-top" style="margin-bottom:4px;">
              <strong>${isOutgoing ? `To: ${esc(s.toPhone)}` : `From: ${esc(s.fromPhone)}`}</strong>
              <span class="post-sub">${new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <p class="post-text" style="font-size:0.86rem;">${esc(s.body)}</p>
          </div>
        `;
      }).join("")
    : `<div class="surface-card"><p class="post-sub">No SMS messages yet.</p></div>`;
}

async function markSmsAsRead() {
  const allSms = await TopConnectDB.getAll("sms_messages");
  let changed = false;
  for (const s of allSms) {
    if (s.toUser === me.username && !s.read) {
      s.read = true;
      await TopConnectDB.put("sms_messages", s);
      changed = true;
    }
  }
  if (changed) {
    emit("SYNC");
    renderChatThreads();
    renderSmsCenter();
  }
}

async function renderChatThreads() {
  const users = (await TopConnectDB.getAll("users")).filter((u) => u.username !== me.username);
  const msgs = await TopConnectDB.getAll("messages");
  const allSms = await TopConnectDB.getAll("sms_messages");

  const unreadChat = msgs.filter((m) => m.to === me.username && m.status !== "read").length;
  const unreadSms = allSms.filter((s) => s.toUser === me.username && !s.read).length;
  const totalUnread = unreadChat + unreadSms;

  const msgDot = document.getElementById("nav-msg-dot");
  msgDot.textContent = totalUnread;
  msgDot.classList.toggle("hidden", totalUnread === 0);

  document.getElementById("chat-threads-list").innerHTML = users.map((u) => {
    const unread = msgs.filter((m) => m.from === u.username && m.to === me.username && m.status !== "read").length;
    return `
      <div class="thread-item" onclick="enterRoom('${u.username}')">
        <div>
          <strong>${esc(u.fullName || u.username)}</strong>
          <div class="post-sub">@${esc(u.username)} • ${esc(u.city)}${u.momoNumber ? ` • ${esc(u.momoNumber)}` : ""}</div>
        </div>
        ${unread ? `<span class="post-badge">${unread} new</span>` : ""}
      </div>
    `;
  }).join("");
}

async function enterRoom(username) {
  chatPeer = username;
  const partner = await TopConnectDB.get("users", username);
  if (!partner) return;
  document.getElementById("room-peer-name").textContent = partner.fullName || partner.username;
  document.getElementById("room-peer-sub").textContent = `@${partner.username} • ${partner.city}`;

  document.getElementById("chat-list-pane").classList.add("hidden");
  document.getElementById("chat-room-pane").classList.remove("hidden");

  await readActiveMessages(username);
  renderChatThreads();
  renderRoomMessages();
}

async function pushMessage({ text = "", media = null, mediaType = null, audio = null }) {
  await TopConnectDB.put("messages", {
    id: "m_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    from: me.username,
    to: chatPeer,
    text,
    media,
    mediaType,
    audio,
    status: "sent",
    at: Date.now()
  });
  emit("SYNC");
  renderRoomMessages();
}

async function deliverPendingMessages() {
  const msgs = await TopConnectDB.getAll("messages");
  let updated = false;
  for (const m of msgs) {
    if (m.to === me.username && m.status === "sent") {
      m.status = "delivered";
      await TopConnectDB.put("messages", m);
      updated = true;
    }
  }
  if (updated) emit("SYNC");
}

async function readActiveMessages(partnerName) {
  const onChatScreen = document.getElementById("screen-chat").classList.contains("active");
  const roomVisible = !document.getElementById("chat-room-pane").classList.contains("hidden");
  if (!onChatScreen || !roomVisible || me.blueTicks === false) return;

  const msgs = await TopConnectDB.getAll("messages");
  let updated = false;
  for (const m of msgs) {
    if (m.from === partnerName && m.to === me.username && m.status !== "read") {
      m.status = "read";
      await TopConnectDB.put("messages", m);
      updated = true;
    }
  }
  if (updated) emit("SYNC");
}

function tickHtml(status, mine) {
  if (!mine) return "";
  if (status === "read") return `<span class="tick read">✓✓</span>`;
  if (status === "delivered") return `<span class="tick">✓✓</span>`;
  return `<span class="tick">✓</span>`;
}

async function renderRoomMessages() {
  if (!chatPeer) return;
  const msgs = (await TopConnectDB.getAll("messages"))
    .filter((m) => (m.from === me.username && m.to === chatPeer) || (m.from === chatPeer && m.to === me.username))
    .sort((a, b) => a.at - b.at);

  const box = document.getElementById("room-messages");
  box.innerHTML = msgs.map((m) => {
    const mine = m.from === me.username;
    const t = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `
      <div class="bubble ${mine ? "mine" : ""}">
        ${m.media ? (m.mediaType === "video"
          ? `<video src="${m.media}" controls playsinline></video>`
          : `<img src="${m.media}" alt="" />`) : ""}
        ${m.audio ? `<audio src="${m.audio}" controls playsinline></audio>` : ""}
        ${m.text ? `<div>${esc(m.text)}</div>` : ""}
        <div class="bubble-foot">
          <span>${t}</span>
          ${tickHtml(m.status, mine)}
        </div>
      </div>
    `;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

/* CALLS */
async function initPeer(to) {
  pc = new RTCPeerConnection({ iceServers });
  stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
  pc.ontrack = (e) => { document.getElementById("remote-stream-video").srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => {
    if (e.candidate) emit("CANDIDATE", { to, candidate: e.candidate });
  };
}

async function startCall(withVideo) {
  if (!chatPeer) return;
  videoEnabled = withVideo;
  callPeer = chatPeer;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  } catch {
    return alert("Camera or mic permission blocked.");
  }

  document.getElementById("local-stream-video").srcObject = stream;
  document.getElementById("call-badge").textContent = withVideo ? "📹 Video Call" : "📞 Voice Call";
  document.getElementById("call-target").textContent = `@${callPeer}`;
  document.getElementById("call-status-msg").textContent = "Ringing...";
  document.getElementById("answer-call-btn").classList.add("hidden");
  document.getElementById("call-modal").classList.remove("hidden");

  await initPeer(callPeer);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  emit("OFFER", { to: callPeer, from: me.username, offer, withVideo });
}

function onIncomingCall(data) {
  callPeer = data.from;
  pendingOffer = data.offer;
  videoEnabled = data.withVideo;
  document.getElementById("call-badge").textContent = videoEnabled ? "📹 Incoming Video" : "📞 Incoming Voice";
  document.getElementById("call-target").textContent = `@${callPeer}`;
  document.getElementById("call-status-msg").textContent = "Incoming call...";
  document.getElementById("answer-call-btn").classList.remove("hidden");
  document.getElementById("call-modal").classList.remove("hidden");
}

async function answerCall() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: videoEnabled });
  } catch {
    return alert("Could not access mic/camera.");
  }
  document.getElementById("local-stream-video").srcObject = stream;
  document.getElementById("answer-call-btn").classList.add("hidden");
  document.getElementById("call-status-msg").textContent = "Connected";

  await initPeer(callPeer);
  await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  emit("ANSWER", { to: callPeer, answer });
}

function hangupCall() {
  if (callPeer) emit("HANGUP", { to: callPeer });
  teardownCall();
}

function teardownCall() {
  stream?.getTracks().forEach((t) => t.stop());
  pc?.close();
  stream = null;
  pc = null;
  callPeer = null;
  pendingOffer = null;
  document.getElementById("call-modal").classList.add("hidden");
}

function timeAgo(ts) {
  const diff = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function toDataURL(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}