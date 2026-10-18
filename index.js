const fs = require("fs");
const path = require("path");

const API_URL = "https://ia.togehost.online/api/chat?message=";
const MAX_MESSAGE = 1500;   // caractères max pour le message utilisateur
const MAX_TOTAL = 3200;     // taille max du texte brut envoyé à l'API (limite d'URL)
const TIMEOUT_MS = 45000;

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

/** Extrait uniquement le texte utile du champ `result` renvoyé par l'API. */
function extractResult(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return String(raw || "").trim(); // réponse déjà en texte brut
  }
  let value = data && typeof data === "object" && "result" in data ? data.result : data;
  if (typeof value === "string") {
    // Parfois le résultat est lui-même un JSON sérialisé
    const t = value.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        const inner = JSON.parse(t);
        if (inner && typeof inner.result === "string") return inner.result.trim();
      } catch {}
    }
    return t;
  }
  if (value && typeof value === "object") {
    for (const k of ["response", "answer", "text", "message", "content", "result"]) {
      if (typeof value[k] === "string") return value[k].trim();
    }
  }
  return "";
}

/** Construit le prompt complet : consigne du mode + contexte récent + message. */
function buildPrompt(mode, message, history) {
  const system = PROMPTS[mode];
  const head = `${system}\n\n`;
  const tail = `Requête de l'utilisateur :\n${message}`;
  let budget = MAX_TOTAL - head.length - tail.length;
  const lines = [];
  for (const turn of Array.isArray(history) ? history.slice(-6).reverse() : []) {
    if (!turn || typeof turn.content !== "string") continue;
    const who = turn.role === "assistant" ? "NebulaAI" : "Utilisateur";
    const line = `${who} : ${turn.content.replace(/\s+/g, " ").slice(0, 400)}\n`;
    if (line.length > budget - 40) break;
    budget -= line.length;
    lines.unshift(line);
  }
  const ctx = lines.length ? `Contexte de la conversation :\n${lines.join("")}\n` : "";
  return head + ctx + tail;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 50_000) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function handleChat(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Méthode non autorisée." });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: "Requête invalide." });
  }

  const mode = Object.prototype.hasOwnProperty.call(PROMPTS, payload.mode) ? payload.mode : "normal"; // "general" → normal
  const message = String(payload.message || "").trim().slice(0, MAX_MESSAGE);
  if (!message) return send(res, 400, { error: "Le message est vide." });

  const attempts = [
    buildPrompt(mode, message, payload.history),
    // Variante compacte : une seule ligne, sans historique
    `${PROMPTS[mode]} Requête de l'utilisateur : ${message.replace(/\s+/g, " ")}`,
  ];
  let lastError = "L'API n'a renvoyé aucune réponse exploitable.";

  for (const prompt of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const upstream = await fetch(API_URL + encodeURIComponent(prompt), {
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      const raw = await upstream.text();
      if (!upstream.ok) { lastError = `L'API a répondu avec le code ${upstream.status}.`; continue; }
      const reply = extractResult(raw);
      if (!reply) continue;
      if (/^error\b/i.test(reply)) { lastError = `L'API externe a renvoyé une erreur : « ${reply.slice(0, 120)} ». Réessaie dans un instant.`; continue; }
      return send(res, 200, { reply, mode });
    } catch (err) {
      lastError = err && err.name === "AbortError" ? "L'API a mis trop de temps à répondre." : "Impossible de joindre l'API.";
    } finally {
      clearTimeout(timer);
    }
  }
  return send(res, 502, { error: lastError });
}


// ---------- Messages à l'admin (stockés dans Upstash Redis / Vercel KV) ----------
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const LIST_KEY = "nebulaai:messages";
const ADMIN_KEY = "nebula-ajMbzWjcZeQdTLw76yTIx4Z7"; // clé admin (peut être remplacée par la variable Vercel ADMIN_KEY)

async function kv(command) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error("kv_error");
  return (await r.json()).result;
}

async function handleContact(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Méthode non autorisée." });
  if (!KV_URL || !KV_TOKEN)
    return send(res, 503, { error: "Stockage non configuré : ajoute une base Upstash Redis dans Vercel." });
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "Requête invalide." }); }
  const message = String(payload.message || "").trim().slice(0, 1000);
  if (!message) return send(res, 400, { error: "Le message est vide." });
  try {
    await kv(["LPUSH", LIST_KEY, JSON.stringify({ message, date: new Date().toISOString() })]);
    await kv(["LTRIM", LIST_KEY, 0, 199]);
    return send(res, 200, { ok: true });
  } catch {
    return send(res, 502, { error: "Impossible d'enregistrer le message." });
  }
}

async function handleAdmin(req, res) {
  const expected = process.env.ADMIN_KEY || ADMIN_KEY;
  const given = String(req.headers["x-admin-key"] || "");
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length || !require("crypto").timingSafeEqual(a, b))
    return send(res, 401, { error: "Clé administrateur incorrecte." });
  if (!KV_URL || !KV_TOKEN) return send(res, 503, { error: "Stockage non configuré." });
  try {
    const rows = await kv(["LRANGE", LIST_KEY, 0, 99]);
    const messages = rows.map((r) => { try { return JSON.parse(r); } catch { return { message: String(r) }; } });
    return send(res, 200, { messages });
  } catch {
    return send(res, 502, { error: "Impossible de lire les messages." });
  }
}

module.exports = async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/api/chat") return handleChat(req, res);
  if (pathname === "/api/contact") return handleContact(req, res);
  if (pathname === "/api/admin/data") return handleAdmin(req, res);

  const entry = STATIC[pathname];
  if (entry && (req.method === "GET" || req.method === "HEAD")) {
    try {
      const file = fs.readFileSync(path.join(__dirname, entry[0]));
      res.setHeader("Cache-Control", "public, max-age=300");
      res.statusCode = 200;
      res.setHeader("Content-Type", entry[1]);
      return res.end(file);
    } catch {
      return send(res, 500, "Fichier introuvable.", "text/plain; charset=utf-8");
    }
  }
  return send(res, 404, "Page introuvable.", "text/plain; charset=utf-8");
};

// Serveur local : `node index.js` (http://localhost:3000)
if (require.main === module) {
  const port = process.env.PORT || 3000;
  require("http").createServer(module.exports).listen(port, () =>
    console.log(`NebulaAI → http://localhost:${port}`)
  );
}
