const TC_DB_NAME = "TopConnect_LocalDB";
const TC_DB_VER = 2;

const TopConnectDB = {
  db: null,

  init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(TC_DB_NAME, TC_DB_VER);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        ["users", "posts", "stories", "messages", "sms_messages", "momo_transactions"].forEach((store) => {
          if (!db.objectStoreNames.contains(store)) {
            const keyPath = store === "users" ? "username" : "id";
            db.createObjectStore(store, { keyPath });
          }
        });
      };

      req.onsuccess = async (e) => {
        this.db = e.target.result;
        await this.seed();
        resolve(this.db);
      };
      req.onerror = () => reject(req.error);
    });
  },

  store(name, mode = "readonly") {
    return this.db.transaction(name, mode).objectStore(name);
  },

  getAll(name) {
    return new Promise((resolve) => {
      const r = this.store(name).getAll();
      r.onsuccess = () => resolve(r.result || []);
    });
  },

  get(name, key) {
    return new Promise((resolve) => {
      const r = this.store(name).get(key);
      r.onsuccess = () => resolve(r.result);
    });
  },

  put(name, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(name, "readwrite");
      const r = tx.objectStore(name).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || r.error);
    });
  },

  delete(name, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(name, "readwrite");
      const r = tx.objectStore(name).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || r.error);
    });
  },

  async seed() {
    const existing = await this.getAll("users");
    if (existing.length > 0) return;

    const users = [
      {
        username: "kwame",
        fullName: "Kwame Mensah",
        city: "Accra",
        bio: "Building Top Connect & chasing big vibes ⚡",
        password: "123",
        wallet: 200,
        momoNetwork: "MTN MoMo",
        momoNumber: "0244000001",
        momoAccountName: "Kwame Mensah",
        friends: ["ama"],
        requests: [],
        blueTicks: true,
        avatar: null,
        appBgMode: "default",
        chatBgMode: "default",
        appBgImage: null,
        chatBgImage: null
      },
      {
        username: "ama",
        fullName: "Ama Serwaa",
        city: "Kumasi",
        bio: "Content creator & style plug ✨",
        password: "123",
        wallet: 250,
        momoNetwork: "Telecel Cash",
        momoNumber: "0204000002",
        momoAccountName: "Ama Serwaa",
        friends: ["kwame"],
        requests: [],
        blueTicks: true,
        avatar: null,
        appBgMode: "default",
        chatBgMode: "default",
        appBgImage: null,
        chatBgImage: null
      },
      {
        username: "kojo",
        fullName: "Kojo Boateng",
        city: "Takoradi",
        bio: "Visuals, beats & coastal life 🌊",
        password: "123",
        wallet: 120,
        momoNetwork: "AT Money",
        momoNumber: "0274000003",
        momoAccountName: "Kojo Boateng",
        friends: [],
        requests: [],
        blueTicks: true,
        avatar: null,
        appBgMode: "default",
        chatBgMode: "default",
        appBgImage: null,
        chatBgImage: null
      }
    ];
    for (const u of users) await this.put("users", u);

    await this.put("posts", {
      id: "p_seed_1",
      author: "ama",
      authorName: "Ama Serwaa",
      city: "Kumasi",
      tag: "Vibes",
      text: "Welcome to Top Connect! Tap Like or Tip via MoMo below and drop your city in the comments 🔥",
      media: null,
      mediaType: null,
      likes: ["kwame"],
      tips: 10,
      comments: [{ by: "Kwame Mensah", text: "Accra tapped in!" }],
      time: Date.now() - 1800000
    });

    await this.put("posts", {
      id: "p_ai_1",
      author: "toppulse_ai",
      authorName: "TopPulse AI • Trending",
      city: "Accra",
      tag: "Gist",
      isAI: true,
      text: "📰 AI Trend Digest: Top creators, campus updates, and weekend street vibes are trending across Ghana. Hit ⚡ AI Auto-News anytime for a fresh update!",
      media: null,
      mediaType: null,
      likes: [],
      tips: 0,
      comments: [],
      time: Date.now() - 900000
    });

    await this.put("sms_messages", {
      id: "sms_welcome_1",
      fromUser: "system",
      fromPhone: "TopConnect",
      toUser: "kwame",
      toPhone: "0244000001",
      body: "Welcome to Top Connect SMS! Send SMS alerts or tip creators directly via MTN MoMo, Telecel Cash & AT Money.",
      read: false,
      at: Date.now() - 600000
    });
  }
};