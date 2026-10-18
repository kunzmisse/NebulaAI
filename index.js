const fs = require("fs");
const path = require("path");

const API_URL = "https://ia.togehost.online/api/chat?message=";
const MAX_MESSAGE = 1500;
const MAX_TOTAL = 3200;
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

function extractResult(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return String(raw || "").trim();
  }
  let value = data && typeof data === "object" && "result" in data ? data.result : data;
  if (typeof value === "string") {
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

  const mode = Object.prototype.hasOwnProperty.call(PROMPTS, payload.mode) ? payload.mode : "normal";
  const message = String(payload.message || "").trim().slice(0, MAX_MESSAGE);
  if (!message) return send(res, 400, { error: "Le message est vide." });

  const prompt = buildPrompt(mode, message, payload.history);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(API_URL + encodeURIComponent(prompt), {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    const raw = await upstream.text();
    if (!upstream.ok) return send(res, 502, { error: `L'API a répondu avec le code ${upstream.status}.` });
    const reply = extractResult(raw);
    if (!reply) return send(res, 502, { error: "L'API n'a renvoyé aucune réponse exploitable." });
    return send(res, 200, { reply, mode });
  } catch (err) {
    const timeout = err && err.name === "AbortError";
    return send(res, timeout ? 504 : 502, {
      error: timeout ? "L'API a mis trop de temps à répondre." : "Impossible de joindre l'API.",
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/api/chat") return handleChat(req, res);

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

if (require.main === module) {
  const port = process.env.PORT || 3000;
  require("http").createServer(module.exports).listen(port, () =>
    console.log(`NebulaAI → http://localhost:${port}`)
  );
}
