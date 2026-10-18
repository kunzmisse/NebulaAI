const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const API_URL = "https://ia.togehost.online/api/chat?message=";
const MAX_MESSAGE = 1500;
const MAX_URL = 6000;       // longueur max (encodée) de la requête vers l'API
const WINDOW = 8;           // nombre de messages récents réinjectés dans le contexte
const MAX_MSGS = 200;       // messages max par conversation
const MAX_CONVS = 50;       // conversations max par utilisateur
const TIMEOUT_MS = 45000;
const ADMIN_KEY = "nebula-ajMbzWjcZeQdTLw76yTIx4Z7"; // clé admin (peut être remplacée par la variable Vercel ADMIN_KEY)

const PROMPTS = {
  normal:
    "Tu es NebulaAI, une intelligence artificielle conversationnelle haut de gamme développée par DEV HACKERS. Réponds de manière intelligente, élégante, percutante et utile à la requête de l'utilisateur.",
  roast:
    "Agis en tant que développeur senior cynique, arrogant mais brillant de l'équipe DEV HACKERS. Fais un roast hilarant et piquant du contenu fourni par l'utilisateur.",
  fix:
    "Agis en tant qu'architecte logiciel expert de NebulaAI, créée par DEV HACKERS. Corrige et optimise le contenu fourni par l'utilisateur.",
};
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/main.css": ["main.css", "text/css; charset=utf-8"],
};

// =====================================================================
//  BASE DE DONNÉES JSON
//  - GitHub (persistant) : dépôt et token en dur ci-dessus (modifiables via variables Vercel)
//  - fichiers JSON locaux uniquement si la variable DISABLE_GITHUB=1 est définie
//  Organisation :  users/<id>.json · conversations/<id>.json · contact.json
// =====================================================================
const GH = {
  token: process.env.GITHUB_TOKEN || "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",
  owner: process.env.GITHUB_OWNER || "toge021",
  repo: process.env.GITHUB_REPO || "script-ban",
  branch: process.env.GITHUB_BRANCH || "main",
  dir: process.env.GITHUB_DATA_DIR || "nebulaai-data", // dossier créé automatiquement dans le dépôt
};
const useGH = !process.env.DISABLE_GITHUB && !!(GH.token && GH.owner && GH.repo);
const STORAGE_KIND = useGH ? "github" : process.env.VERCEL ? "temporaire" : "local";
const DATA_DIR = process.env.DATA_DIR ||
  (process.env.VERCEL ? path.join(os.tmpdir(), "nebulaai-data") : path.join(__dirname, "data"));

async function ghFetch(method, p, body) {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.dir}/${p}` +
    (method === "GET" ? `?ref=${encodeURIComponent(GH.branch)}` : "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    return await fetch(url, {
      method, signal: ctrl.signal,
      headers: { Authorization: `token ${GH.token}`, Accept: "application/vnd.github.v3+json",
        "User-Agent": "NebulaAI", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } finally { clearTimeout(t); }
}
async function ghGet(p) {
  const r = await ghFetch("GET", p);
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")), sha: j.sha };
}
async function ghPut(p, obj, msg) {
  for (let i = 0; i < 3; i++) {
    const { sha } = await ghGet(p);
    const body = { message: msg, branch: GH.branch, content: Buffer.from(JSON.stringify(obj, null, 1)).toString("base64") };
    if (sha) body.sha = sha;
    const r = await ghFetch("PUT", p, body);
    if (r.ok) return;
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub ${r.status}`);
  }
  throw new Error("GitHub conflit");
}
async function ghDel(p) {
  const { sha } = await ghGet(p);
  if (!sha) return;
  const r = await ghFetch("DELETE", p, { message: `delete ${p}`, branch: GH.branch, sha });
  if (!r.ok && r.status !== 404) throw new Error(`GitHub ${r.status}`);
}

const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  run.finally(() => { if (locks.get(key) === run) locks.delete(key); }).catch(() => {});
  return run;
}

const db = {
  async read(p) {
    if (useGH) return (await ghGet(p)).data;
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, p), "utf8")); } catch { return null; }
  },
  async write(p, obj) {
    if (useGH) return ghPut(p, obj, `update ${p}`);
    const file = path.join(DATA_DIR, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  },
  async remove(p) {
    if (useGH) return ghDel(p);
    try { fs.unlinkSync(path.join(DATA_DIR, p)); } catch {}
  },
  /** Lecture → modification → écriture, sérialisée par fichier. */
  update(p, fn, init) {
    return withLock(p, async () => {
      const cur = (await db.read(p)) || init();
      const next = (await fn(cur)) || cur;
      await db.write(p, next);
      return next;
    });
  },
};

// =====================================================================
//  UTILISATEURS
// =====================================================================
const ID_USER = /^u_[a-f0-9]{16}$/, ID_CONV = /^c_[a-f0-9]{16}$/;
const newId = (prefix) => prefix + "_" + crypto.randomBytes(8).toString("hex");
const sha = (s) => crypto.createHash("sha256").update(s).digest();
const userPath = (id) => `users/${id}.json`;
const convPath = (id) => `conversations/${id}.json`;

async function createUser(res) {
  const id = newId("u"), token = crypto.randomBytes(24).toString("base64url");
  await db.write(userPath(id), {
    id, tokenHash: sha(token).toString("hex"), createdAt: new Date().toISOString(),
    memory: { facts: {}, notes: [] }, conversations: [],
  });
  return send(res, 200, { userId: id, token });
}

async function auth(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer (u_[a-f0-9]{16})\.([\w-]{20,})$/);
  if (!m) return null;
  const user = await db.read(userPath(m[1]));
  if (!user) return null;
  const a = sha(m[2]), b = Buffer.from(user.tokenHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? user : null;
}

// =====================================================================
//  MÉMOIRE ET CONTEXTE
// =====================================================================
function learn(memory, text) {
  const m = { facts: { ...(memory?.facts || {}) }, notes: [...(memory?.notes || [])] };
  const t = text.slice(0, 600);
  let x;
  if ((x = t.match(/(?:je m'appelle|mon pr[ée]nom est|moi c'est)\s+([\p{L}][\p{L}'-]{1,29})/iu))) m.facts.nom = x[1];
  if ((x = t.match(/\bj'ai\s+(\d{1,2})\s+ans\b/i))) m.facts.age = x[1] + " ans";
  if ((x = t.match(/\bj'habite\s+(?:à|a|en|au|aux)\s+([^.,;!?\n]{2,40})/i))) m.facts.ville = x[1].trim();
  if ((x = t.match(/(?:retiens|souviens-toi|n'oublie pas)\s+(?:que\s+)?([^\n]{3,200})/i))) {
    const note = x[1].trim();
    if (!m.notes.includes(note)) m.notes.push(note);
    m.notes = m.notes.slice(-20);
  }
  return m;
}
const memoryText = (m) =>
  [...Object.entries(m?.facts || {}).map(([k, v]) => `${k} : ${v}`), ...(m?.notes || [])].join(" ; ");
const flat = (s, n) => s.replace(/\s+/g, " ").slice(0, n);
const summarize = (msgs) =>
  msgs.map((x) => `${x.role === "user" ? "U" : "N"}: ${flat(x.content, 120)}`).join(" | ").slice(-900);
const encLen = (s) => encodeURIComponent(s).length;

/** Prompt = consigne du mode + mémoire + résumé + derniers échanges + requête (borné en taille). */
function buildPrompt(mode, message, conv, memory) {
  const head = PROMPTS[mode] + "\n\n";
  const tail = `Requête de l'utilisateur :\n${message}`;
  let mem = memoryText(memory);
  let summary = conv.messages.length > WINDOW ? conv.summary || "" : "";
  let n = Math.min(WINDOW, conv.messages.length);
  for (;;) {
    const recent = n > 0
      ? conv.messages.slice(-n).map((x) => `${x.role === "assistant" ? "NebulaAI" : "Utilisateur"} : ${flat(x.content, 400)}`).join("\n")
      : "";
    const p = head + (mem ? `Ce que tu sais de l'utilisateur : ${mem}\n\n` : "") +
      (summary ? `Résumé du début de la discussion : ${summary}\n\n` : "") +
      (recent ? `Derniers échanges :\n${recent}\n\n` : "") + tail;
    if (encLen(p) <= MAX_URL || (n <= 0 && !mem && !summary)) return p;
    if (n > 0) n = Math.max(0, n - 2); else if (summary) summary = ""; else mem = "";
  }
}

// =====================================================================
//  API IA
// =====================================================================
function extractResult(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return String(raw || "").trim(); }
  let value = data && typeof data === "object" && "result" in data ? data.result : data;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try { const inner = JSON.parse(t); if (inner && typeof inner.result === "string") return inner.result.trim(); } catch {}
    }
    return t;
  }
  if (value && typeof value === "object")
    for (const k of ["response", "answer", "text", "message", "content", "result"])
      if (typeof value[k] === "string") return value[k].trim();
  return "";
}

async function askAI(prompts) {
  let lastError = "L'API n'a renvoyé aucune réponse exploitable.";
  for (const prompt of prompts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(API_URL + encodeURIComponent(prompt), { headers: { Accept: "application/json" }, signal: ctrl.signal });
      const raw = await r.text();
      if (!r.ok) { lastError = `L'API a répondu avec le code ${r.status}.`; continue; }
      const reply = extractResult(raw);
      if (!reply) continue;
      if (/^error\b/i.test(reply)) { lastError = `L'API externe a renvoyé une erreur : « ${reply.slice(0, 120)} ». Réessaie dans un instant.`; continue; }
      return { reply };
    } catch (e) {
      lastError = e && e.name === "AbortError" ? "L'API a mis trop de temps à répondre." : "Impossible de joindre l'API.";
    } finally { clearTimeout(timer); }
  }
  return { error: lastError };
}

// =====================================================================
//  ROUTES
// =====================================================================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 50000) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const readJSON = async (req) => { try { return JSON.parse((await readBody(req)) || "{}"); } catch { return null; } };
function send(res, status, body, type = "application/json; charset=utf-8") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function handleChat(req, res, user) {
  const payload = await readJSON(req);
  if (!payload) return send(res, 400, { error: "Requête invalide." });
  const mode = Object.prototype.hasOwnProperty.call(PROMPTS, payload.mode) ? payload.mode : "normal";
  let message = String(payload.message || "").trim().slice(0, MAX_MESSAGE);
  while (encLen(message) > 4000) message = message.slice(0, -100);
  if (!message) return send(res, 400, { error: "Le message est vide." });

  let conv = null;
  if (payload.conversationId) {
    if (!ID_CONV.test(payload.conversationId) || !user.conversations.some((c) => c.id === payload.conversationId))
      return send(res, 404, { error: "Conversation introuvable." });
    conv = await db.read(convPath(payload.conversationId));
  }
  if (!conv) {
    conv = { id: newId("c"), userId: user.id, title: flat(message, 48), createdAt: new Date().toISOString(), summary: "", messages: [] };
  }

  const memory = learn(user.memory, message);
  const full = buildPrompt(mode, message, conv, memory);
  const compact = `${PROMPTS[mode]} Requête de l'utilisateur : ${flat(message, MAX_MESSAGE)}`;
  const out = await askAI([full, compact]);
  if (out.error) return send(res, 502, { error: out.error });

  const now = new Date().toISOString();
  conv.messages.push({ role: "user", content: message, mode, at: now }, { role: "assistant", content: out.reply, mode, at: now });
  if (conv.messages.length > MAX_MSGS) conv.messages = conv.messages.slice(-MAX_MSGS);
  conv.summary = summarize(conv.messages.slice(0, -WINDOW));
  conv.updatedAt = now;
  await db.write(convPath(conv.id), conv);

  let dropped = [];
  await db.update(userPath(user.id), (u) => {
    u.memory = memory;
    u.lastSeen = now;
    u.conversations = u.conversations.filter((c) => c.id !== conv.id);
    u.conversations.unshift({ id: conv.id, title: conv.title, updatedAt: now, count: conv.messages.length });
    dropped = u.conversations.splice(MAX_CONVS);
  });
  for (const d of dropped) await db.remove(convPath(d.id));
  return send(res, 200, { reply: out.reply, mode, conversationId: conv.id, title: conv.title });
}

async function handleApi(req, res, p, user) {
  const m = req.method;
  if (p === "/api/chat") return m === "POST" ? handleChat(req, res, user) : send(res, 405, { error: "Méthode non autorisée." });
  if (p === "/api/conversations") {
    if (m === "GET") return send(res, 200, { conversations: user.conversations });
    if (m === "POST") return send(res, 200, { ok: true });
  }
  const c = p.match(/^\/api\/conversations\/(c_[a-f0-9]{16})$/);
  if (c) {
    if (!user.conversations.some((x) => x.id === c[1])) return send(res, 404, { error: "Conversation introuvable." });
    if (m === "GET") {
      const conv = await db.read(convPath(c[1]));
      return conv ? send(res, 200, { id: conv.id, title: conv.title, messages: conv.messages }) : send(res, 404, { error: "Conversation introuvable." });
    }
    if (m === "DELETE") {
      await db.remove(convPath(c[1]));
      await db.update(userPath(user.id), (u) => { u.conversations = u.conversations.filter((x) => x.id !== c[1]); });
      return send(res, 200, { ok: true });
    }
  }
  if (p === "/api/memory") {
    if (m === "GET") return send(res, 200, { memory: user.memory });
    if (m === "DELETE") {
      await db.update(userPath(user.id), (u) => { u.memory = { facts: {}, notes: [] }; });
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: "Route introuvable." });
}

async function handleContact(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Méthode non autorisée." });
  const payload = await readJSON(req);
  const message = String(payload?.message || "").trim().slice(0, 1000);
  if (!message) return send(res, 400, { error: "Le message est vide." });
  await db.update("contact.json", (c) => {
    c.messages.unshift({ message, date: new Date().toISOString() });
    c.messages = c.messages.slice(0, 200);
  }, () => ({ messages: [] }));
  return send(res, 200, { ok: true });
}

async function handleAdmin(req, res) {
  const expected = process.env.ADMIN_KEY || ADMIN_KEY;
  const a = sha(String(req.headers["x-admin-key"] || "")), b = sha(expected);
  if (!crypto.timingSafeEqual(a, b)) return send(res, 401, { error: "Clé administrateur incorrecte." });
  const data = (await db.read("contact.json")) || { messages: [] };
  return send(res, 200, { messages: data.messages });
}

module.exports = async (req, res) => {
  const p = new URL(req.url, "http://localhost").pathname;
  try {
    if (p === "/api/status") return send(res, 200, { storage: STORAGE_KIND });
    if (p === "/api/user" && req.method === "POST") return await createUser(res);
    if (p === "/api/contact") return await handleContact(req, res);
    if (p === "/api/admin/data") return await handleAdmin(req, res);
    if (p.startsWith("/api/")) {
      const user = await auth(req);
      if (!user) return send(res, 401, { error: "Session invalide." });
      return await handleApi(req, res, p, user);
    }
    const entry = STATIC[p];
    if (entry && (req.method === "GET" || req.method === "HEAD")) {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.statusCode = 200;
      res.setHeader("Content-Type", entry[1]);
      return res.end(fs.readFileSync(path.join(__dirname, entry[0])));
    }
    return send(res, 404, "Page introuvable.", "text/plain; charset=utf-8");
  } catch (e) {
    console.error("Erreur :", e && e.message);
    return send(res, 500, { error: "Erreur interne du serveur ou du stockage." });
  }
};

if (require.main === module) {
  const port = process.env.PORT || 3000;
  require("http").createServer(module.exports).listen(port, () => console.log(`NebulaAI → http://localhost:${port} (stockage : ${STORAGE_KIND})`));
}
