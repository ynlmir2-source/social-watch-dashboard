
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

// Required Railway environment variables:
// DATABASE_URL
// DASHBOARD_USERNAME
// DASHBOARD_PASSWORD
// DASHBOARD_INGEST_KEY
// SESSION_SECRET

const requiredVariables = [
  "DATABASE_URL",
  "DASHBOARD_USERNAME",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_INGEST_KEY",
  "SESSION_SECRET",
];

for (const name of requiredVariables) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable"
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const SESSION_COOKIE = "social_watch_session";
const SESSION_DURATION = 12 * 60 * 60 * 1000;

const KEYWORDS = (process.env.WATCH_KEYWORDS ||
  "social watch,urgent,announcement")
  .split(",")
  .map((word) => word.trim())
  .filter(Boolean);

const PRIORITIES = {
  urgent: "high",
  emergency: "high",
  critical: "high",
  announcement: "medium",
  "social watch": "medium",
};

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length &&
    crypto.timingSafeEqual(x, y);
}

function sign(value) {
  return crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(value)
    .digest("hex");
}

function createSession(username) {
  const payload = Buffer.from(
    JSON.stringify({
      username,
      expires: Date.now() + SESSION_DURATION,
    })
  ).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [payload, signature] = parts;

  if (!safeEqual(signature, sign(payload))) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (
      !data.username ||
      data.username !== process.env.DASHBOARD_USERNAME ||
      !Number.isFinite(data.expires) ||
      data.expires <= Date.now()
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");

    if (separator < 0) continue;

    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

function requireLogin(req, res, next) {
  const session = verifySession(
    getCookie(req, SESSION_COOKIE)
  );

  if (!session) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        error: "Please log in to access the dashboard.",
      });
    }

    return res.redirect("/login");
  }

  req.user = session;
  next();
}

function requireIngestKey(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (
    !match ||
    !safeEqual(match[1], process.env.DASHBOARD_INGEST_KEY)
  ) {
    return res.status(401).json({
      error: "Invalid ingestion credentials.",
    });
  }

  next();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function inferPriority(text) {
  const lower = text.toLowerCase();

  if (/\b(urgent|emergency|critical|immediate)\b/.test(lower)) {
    return "high";
  }

  if (/\b(announcement|important|warning)\b/.test(lower)) {
    return "medium";
  }

  return "normal";
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_watch_alerts (
      id BIGSERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'Unknown',
      priority TEXT NOT NULL DEFAULT 'normal',
      keyword TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    social_watch_alerts_created_at_idx
    ON social_watch_alerts (created_at DESC)
  `);

  console.log("PostgreSQL alert storage is ready.");
}

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
      service: "Social Watch Dashboard",
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
});

app.get("/login", (req, res) => {
  if (verifySession(getCookie(req, SESSION_COOKIE))) {
    return res.redirect("/");
  }

  res.setHeader("Cache-Control", "no-store");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Social Watch — Login</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#0b1020;color:#f3f4f6;font-family:Arial,sans-serif;padding:20px}
.card{width:100%;max-width:390px;background:#151c30;padding:30px;
border:1px solid #303b55;border-radius:18px}
h1{margin-top:0}p{color:#aeb9ce;line-height:1.5}
input,button{width:100%;padding:13px;margin-top:12px;border-radius:9px;
font-size:16px}
input{background:#0b1020;color:white;border:1px solid #3b4760}
button{border:0;background:#6d75f9;color:white;font-weight:bold;cursor:pointer}
#error{color:#ff9292}
</style>
</head>
<body>
<main class="card">
<h1>Social Watch</h1>
<p>Sign in to access your monitoring dashboard.</p>
<form method="POST" action="/login">
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" required>
<label for="password">Password</label>
<input id="password" name="password" type="password"
autocomplete="current-password" required>
<button type="submit">Sign in</button>
<p id="error" role="alert"></p>
</form>
</main>
<script>
if(new URLSearchParams(location.search).has("error")){
document.getElementById("error").textContent="Login failed. Check your credentials.";
}
</script>
</body>
</html>`);
});

app.post("/login", (req, res) => {
  const username = String(req.body.username || "");
  const password = String(req.body.password || "");

  if (
    !safeEqual(username, process.env.DASHBOARD_USERNAME) ||
    !safeEqual(password, process.env.DASHBOARD_PASSWORD)
  ) {
    return res.redirect(303, "/login?error=1");
  }

  const token = createSession(username);
  const secure = process.env.COOKIE_SECURE === "false"
    ? ""
    : "; Secure";

  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DURATION / 1000}${secure}`
  );

  res.redirect(303, "/");
});

app.post("/logout", requireLogin, (req, res) => {
  const secure = process.env.COOKIE_SECURE === "false"
    ? ""
    : "; Secure";

  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  );

  res.redirect(303, "/login");
});

app.get("/", requireLogin, (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Social Watch Dashboard</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b1020;color:#f3f4f6;
font-family:Arial,sans-serif}
header{padding:22px 5%;border-bottom:1px solid #283149;
display:flex;justify-content:space-between;align-items:center;gap:15px}
h1{margin:0;font-size:25px}
main{max-width:1100px;margin:auto;padding:25px 20px}
.muted{color:#9caac2}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
gap:14px;margin:22px 0}
.stat,.alert{background:#151c30;border:1px solid #2b3650;
border-radius:12px;padding:18px}
.stat strong{display:block;font-size:27px;margin-top:9px}
.alerts{display:grid;gap:12px}
.alert-top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.priority{font-size:12px;text-transform:uppercase;font-weight:bold}
.high{color:#ff8585}.medium{color:#ffd479}.normal{color:#8de5bb}
.message{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}
button{cursor:pointer;border:1px solid #3b4760;border-radius:8px;
background:#202a43;color:white;padding:10px 14px}
button:hover{background:#303d5b}
#status{min-height:22px}
@media(max-width:600px){.stats{grid-template-columns:1fr}header{align-items:flex-start}}
</style>
</head>
<body>
<header>
<div><h1>Social Watch</h1><p class="muted">Monitoring dashboard</p></div>
<form method="POST" action="/logout"><button type="submit">Log out</button></form>
</header>
<main>
<p id="status" class="muted">Connecting to alert storage…</p>
<div class="stats">
<div class="stat"><span class="muted">Total alerts</span><strong id="total">0</strong></div>
<div class="stat"><span class="muted">High priority</span><strong id="high">0</strong></div>
<div class="stat"><span class="muted">Last update</span><strong id="updated" style="font-size:17px">—</strong></div>
</div>
<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:15px">
<h2>Recent alerts</h2><button id="refresh" type="button">Refresh</button>
</div>
<div id="alerts" class="alerts"></div>
<p class="muted">The dashboard checks for new alerts every 5 seconds.</p>
</main>
<script>
const alertsNode=document.getElementById("alerts");
const statusNode=document.getElementById("status");
const escapeHtml=(value)=>String(value??"").replace(/[&<>"']/g,c=>({
"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
})[c]);

async function refreshAlerts(){
 try{
  const response=await fetch("/api/alerts?limit=100",{cache:"no-store"});
  if(response.status===401){location.href="/login";return}
  if(!response.ok)throw new Error("HTTP "+response.status);
  const data=await response.json();
  const alerts=data.alerts||[];
  document.getElementById("total").textContent=data.total??alerts.length;
  document.getElementById("high").textContent=alerts.filter(a=>a.priority==="high").length;
  document.getElementById("updated").textContent=new Date().toLocaleTimeString();
  alertsNode.innerHTML=alerts.length?alerts.map(a=>{
   const priority=["high","medium","normal"].includes(a.priority)?a.priority:"normal";
   return '<article class="alert"><div class="alert-top"><strong>'+
   escapeHtml(a.source)+'</strong><span class="priority '+priority+'">'+
   escapeHtml(priority)+'</span></div><p class="message">'+
   escapeHtml(a.message)+'</p><p class="muted">'+
   escapeHtml(a.keyword||"No keyword recorded")+' · '+
   escapeHtml(new Date(a.created_at).toLocaleString())+
   '</p></article>';
  }).join(""):'<div class="alert">No alerts yet. Social Watch is waiting for incoming alerts.</div>';
  statusNode.textContent="Connected · "+alerts.length+" recent alerts loaded";
 }catch(error){
  statusNode.textContent="Unable to load alerts. Retrying automatically.";
 }
}
document.getElementById("refresh").addEventListener("click",refreshAlerts);
refreshAlerts();
setInterval(refreshAlerts,5000);
</script>
</body>
</html>`);
});

// Dashboard API: only authenticated dashboard users can read alerts.
app.get("/api/alerts", requireLogin, async (req, res) => {
  try {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 50;

    const [alertsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT id, message, source, priority, keyword, created_at
         FROM social_watch_alerts
         ORDER BY created_at DESC, id DESC
         LIMIT $1`,
        [limit]
      ),
      pool.query(
        "SELECT COUNT(*)::int AS total FROM social_watch_alerts"
      ),
    ]);

    res.setHeader("Cache-Control", "no-store");
    res.json({
      alerts: alertsResult.rows,
      total: countResult.rows[0].total,
    });
  } catch (error) {
    console.error("Failed to read alerts:", error.message);
    res.status(500).json({ error: "Unable to load alerts." });
  }
});

// Alert ingestion: used by your bot or other trusted automation.
app.post(
  "/api/alerts",
  requireIngestKey,
  async (req, res) => {
    try {
      const message = typeof req.body.message === "string"
        ? req.body.message.trim()
        : "";

      const source = typeof req.body.source === "string"
        ? req.body.source.trim().slice(0, 150)
        : "Unknown";

      const keyword = typeof req.body.keyword === "string"
        ? req.body.keyword.trim().slice(0, 150)
        : "";

      if (!message || message.length > 10000) {
        return res.status(400).json({
          error: "Message is required and must be at most 10000 characters.",
        });
      }

      const suppliedPriority = String(req.body.priority || "").toLowerCase();

      const priority = ["high", "medium", "normal"].includes(suppliedPriority)
        ? suppliedPriority
        : inferPriority(message);

      const result = await pool.query(
        `INSERT INTO social_watch_alerts
         (message, source, priority, keyword)
         VALUES ($1, $2, $3, $4)
         RETURNING id, message, source, priority, keyword, created_at`,
        [message, source || "Unknown", priority, keyword || null]
      );

      res.status(201).json({
        success: true,
        alert: result.rows[0],
      });
    } catch (error) {
      console.error("Failed to save alert:", error.message);
      res.status(500).json({ error: "Unable to save alert." });
    }
  }
);

// Keep the keyword configuration available to the authenticated dashboard.
app.get("/api/config", requireLogin, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ keywords: KEYWORDS });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

async function start() {
  await initializeDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Social Watch dashboard listening on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start Social Watch:", error);
  process.exit(1);
});

async function shutdown() {
  console.log("Shutting down Social Watch...");
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
