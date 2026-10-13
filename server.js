
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = "social_watch_session";
const SESSION_DURATION = 12 * 60 * 60 * 1000;

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

const requiredVariables = [
  "DATABASE_URL",
  "DASHBOARD_USERNAME",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_INGEST_KEY",
  "SESSION_SECRET",
];

for (const name of requiredVariables) {
  if (!process.env[name]) {
    console.error("Missing required environment variable: " + name);
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

const DEFAULT_TERMS = [
  { term: "social watch", priority: "medium", action: "record_only", enabled: true },
  { term: "project update", priority: "normal", action: "discord", enabled: true },
  { term: "event announcement", priority: "medium", action: "nest", enabled: true },
  { term: "urgent", priority: "high", action: "discord_nest", enabled: true },
  { term: "launch", priority: "normal", action: "discord_nest", enabled: true },
  { term: "settings", priority: "normal", action: "record_only", enabled: true },
  { term: "owner info", priority: "normal", action: "discord", enabled: true },
];

function defaultKeywordAction(term) {
  const defaults = DEFAULT_TERMS.find((rule) => rule.term === String(term || "").toLowerCase());
  return defaults?.action || "discord_nest";
}

function buildDefaultConfig() {
  const envWords = (process.env.WATCH_KEYWORDS || "")
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);

  const keywords = envWords.length
    ? envWords.map((term) => ({
        id: crypto.randomUUID(),
        term,
        priority: /\b(urgent|emergency|critical|immediate)\b/.test(term)
          ? "high"
          : /\b(announcement|important|warning)\b/.test(term)
            ? "medium"
            : "normal",
        action: defaultKeywordAction(term),
        enabled: true,
      }))
    : DEFAULT_TERMS.map((rule) => ({
        id: crypto.randomUUID(),
        ...rule,
      }));

  return {
    keywords,
    automations: {
      discordChannelAlertsEnabled: true,
      homeAssistantAnnouncementsEnabled: true,
      nestAnnouncementMode: "all",
      quietHoursEnabled: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      timezone: "America/New_York",
    },
    preferences: {
      refreshSeconds: 5,
      browserNotificationsEnabled: false,
    },
  };
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sign(value) {
  return crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(value)
    .digest("hex");
}

function createSession(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expires: Date.now() + SESSION_DURATION,
  })).toString("base64url");

  return payload + "." + sign(payload);
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  if (!safeEqual(signature, sign(payload))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      !data.username ||
      data.username !== process.env.DASHBOARD_USERNAME ||
      !Number.isFinite(data.expires) ||
      data.expires <= Date.now()
    ) return null;

    return data;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function requireLogin(req, res, next) {
  const session = verifySession(getCookie(req, SESSION_COOKIE));
  if (!session) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Please log in to access the dashboard." });
    }
    return res.redirect("/login");
  }
  req.user = session;
  next();
}

function requireIngestKey(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !safeEqual(match[1], process.env.DASHBOARD_INGEST_KEY)) {
    return res.status(401).json({ error: "Invalid ingestion credentials." });
  }
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get("host")) {
      return res.status(403).json({ error: "Cross-origin request blocked." });
    }
  } catch {
    return res.status(403).json({ error: "Invalid request origin." });
  }
  next();
}

function isValidTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimezone(value) {
  if (typeof value !== "string" || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizeConfig(input, previous) {
  const source = input && typeof input === "object" ? input : {};
  const current = previous && typeof previous === "object"
    ? previous
    : buildDefaultConfig();

  const incomingKeywords = Array.isArray(source.keywords)
    ? source.keywords.slice(0, 100)
    : current.keywords;
  const seen = new Set();
  const keywords = [];

  for (const rule of incomingKeywords) {
    if (!rule || typeof rule !== "object") continue;
    const term = typeof rule.term === "string"
      ? rule.term.trim().toLowerCase().slice(0, 80)
      : "";
    if (!term || seen.has(term)) continue;
    seen.add(term);

    const priority = ["normal", "medium", "high"].includes(rule.priority)
      ? rule.priority
      : "normal";

    const matchMode = ["contains", "whole_word"].includes(rule.matchMode)
      ? rule.matchMode
      : "contains";
    const action = ["record_only", "discord", "nest", "discord_nest"].includes(rule.action)
      ? rule.action
      : defaultKeywordAction(term);
    const exclude = Array.isArray(rule.exclude)
      ? rule.exclude.map((item) => String(item).trim().toLowerCase().slice(0, 80)).filter(Boolean).slice(0, 20)
      : typeof rule.exclude === "string"
        ? rule.exclude.split(",").map((item) => item.trim().toLowerCase().slice(0, 80)).filter(Boolean).slice(0, 20)
        : [];

    keywords.push({
      id: typeof rule.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(rule.id)
        ? rule.id
        : crypto.randomUUID(),
      term,
      priority,
      action,
      enabled: rule.enabled !== false,
      matchMode,
      exclude: [...new Set(exclude)],
    });
  }

  const incomingAutomation = source.automations && typeof source.automations === "object"
    ? source.automations
    : {};
  const oldAutomation = current.automations || {};
  const mode = ["all", "medium_high", "high_only", "off"].includes(
    incomingAutomation.nestAnnouncementMode
  )
    ? incomingAutomation.nestAnnouncementMode
    : (oldAutomation.nestAnnouncementMode || "all");
  const timezone = validTimezone(incomingAutomation.timezone)
    ? incomingAutomation.timezone
    : (oldAutomation.timezone || "America/New_York");

  const automations = {
    discordChannelAlertsEnabled:
      typeof incomingAutomation.discordChannelAlertsEnabled === "boolean"
        ? incomingAutomation.discordChannelAlertsEnabled
        : oldAutomation.discordChannelAlertsEnabled !== false,
    homeAssistantAnnouncementsEnabled:
      typeof incomingAutomation.homeAssistantAnnouncementsEnabled === "boolean"
        ? incomingAutomation.homeAssistantAnnouncementsEnabled
        : oldAutomation.homeAssistantAnnouncementsEnabled !== false,
    nestAnnouncementMode: mode,
    quietHoursEnabled:
      typeof incomingAutomation.quietHoursEnabled === "boolean"
        ? incomingAutomation.quietHoursEnabled
        : !!oldAutomation.quietHoursEnabled,
    quietHoursStart: isValidTime(incomingAutomation.quietHoursStart)
      ? incomingAutomation.quietHoursStart
      : (oldAutomation.quietHoursStart || "22:00"),
    quietHoursEnd: isValidTime(incomingAutomation.quietHoursEnd)
      ? incomingAutomation.quietHoursEnd
      : (oldAutomation.quietHoursEnd || "07:00"),
    timezone,
  };

  const incomingPreferences = source.preferences && typeof source.preferences === "object"
    ? source.preferences
    : {};
  const oldPreferences = current.preferences || {};
  const candidateRefresh = Number(incomingPreferences.refreshSeconds);
  const refreshSeconds = [5, 10, 15, 30].includes(candidateRefresh)
    ? candidateRefresh
    : ([5, 10, 15, 30].includes(Number(oldPreferences.refreshSeconds))
      ? Number(oldPreferences.refreshSeconds)
      : 5);

  return {
    keywords,
    automations,
    preferences: {
      refreshSeconds,
      browserNotificationsEnabled:
        typeof incomingPreferences.browserNotificationsEnabled === "boolean"
          ? incomingPreferences.browserNotificationsEnabled
          : !!oldPreferences.browserNotificationsEnabled,
      accentIntensity: clampPreference(incomingPreferences.accentIntensity, oldPreferences.accentIntensity, 75, 20, 100),
      glowIntensity: clampPreference(incomingPreferences.glowIntensity, oldPreferences.glowIntensity, 25, 0, 100),
      motionIntensity: clampPreference(incomingPreferences.motionIntensity, oldPreferences.motionIntensity, 30, 0, 100),
    },
  };
}

function clampPreference(incoming, previous, fallback, min, max) {
  const value = Number(incoming);
  if (Number.isFinite(value)) return Math.min(max, Math.max(min, Math.round(value)));
  const old = Number(previous);
  return Number.isFinite(old) ? Math.min(max, Math.max(min, Math.round(old))) : fallback;
}

function inferPriority(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(urgent|emergency|critical|immediate)\b/.test(lower)) return "high";
  if (/\b(announcement|important|warning)\b/.test(lower)) return "medium";
  return "normal";
}

async function getConfig() {
  const result = await pool.query(
    "SELECT config, updated_at FROM social_watch_settings WHERE id = 1"
  );
  if (result.rows.length) return result.rows[0];

  const config = buildDefaultConfig();
  const inserted = await pool.query(
    "INSERT INTO social_watch_settings (id, config) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING config, updated_at",
    [JSON.stringify(config)]
  );
  return inserted.rows[0];
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
    ALTER TABLE social_watch_alerts
    ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS social_watch_alerts_created_at_idx
    ON social_watch_alerts (created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS social_watch_alerts_priority_created_idx
    ON social_watch_alerts (priority, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_watch_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_watch_integrations (
      service_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_seen TIMESTAMPTZ,
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_watch_logs (
      id BIGSERIAL PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'info',
      source TEXT NOT NULL DEFAULT 'social-watch',
      message TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS social_watch_logs_created_at_idx
    ON social_watch_logs (created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS social_watch_logs_level_created_idx
    ON social_watch_logs (level, created_at DESC)
  `);

  const defaults = buildDefaultConfig();
  await pool.query(
    `INSERT INTO social_watch_settings (id, config)
      VALUES (1, $1::jsonb)
      ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(defaults)]
  );

  await pool.query(
    `INSERT INTO social_watch_integrations
       (service_key, display_name, status, last_seen, details)
     VALUES ('dashboard', 'Dashboard API + PostgreSQL', 'connected', NOW(), '{}'::jsonb)
     ON CONFLICT (service_key)
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   status = 'connected',
                   last_seen = NOW()`
  );

  console.log("PostgreSQL alert storage, settings, and integration tracking are ready.");
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected", service: "Social Watch Dashboard" });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.get("/login", (req, res) => {
  if (verifySession(getCookie(req, SESSION_COOKIE))) return res.redirect("/");
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Social Watch — Login</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(700px 340px at 80% 0,#1c2a4a 0,transparent 70%),#0b1120;color:#edf3ff;font-family:Arial,sans-serif;padding:20px}.card{width:100%;max-width:410px;background:#111a2d;padding:32px;border:1px solid #263550;border-radius:18px;box-shadow:0 25px 70px #0003}.brand{font-size:23px;font-weight:800;margin-bottom:6px}.muted{color:#91a3bd;line-height:1.6;font-size:13px}label{display:block;font-size:12px;margin-top:18px}input,button{width:100%;padding:13px;margin-top:8px;border-radius:9px;font-size:14px}input{background:#0b1322;color:white;border:1px solid #34445f}button{border:0;background:#8591f5;color:#0b1120;font-weight:bold;cursor:pointer;margin-top:22px}#error{color:#ff9292}</style></head><body><main class="card"><div class="brand">◎ Social Watch</div><p class="muted">Sign in to open your monitoring control center.</p><form method="POST" action="/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button><p id="error" role="alert"></p></form></main><script>if(new URLSearchParams(location.search).has("error"))document.getElementById("error").textContent="Login failed. Check your credentials."</script></body></html>`);
});

app.post("/login", (req, res) => {
  const username = String(req.body.username || "");
  const password = String(req.body.password || "");
  if (
    !safeEqual(username, process.env.DASHBOARD_USERNAME) ||
    !safeEqual(password, process.env.DASHBOARD_PASSWORD)
  ) return res.redirect(303, "/login?error=1");

  const token = createSession(username);
  const secure = process.env.COOKIE_SECURE === "false" ? "" : "; Secure";
  res.setHeader(
    "Set-Cookie",
    SESSION_COOKIE + "=" + encodeURIComponent(token) +
    "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + (SESSION_DURATION / 1000) + secure
  );
  res.redirect(303, "/");
});

app.post("/logout", requireLogin, (req, res) => {
  const secure = process.env.COOKIE_SECURE === "false" ? "" : "; Secure";
  res.setHeader(
    "Set-Cookie",
    SESSION_COOKIE + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" + secure
  );
  res.redirect(303, "/login");
});

app.get("/", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/dashboard/summary", requireLogin, async (req, res) => {
  try {
    const [counts, activity, connections] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_read = FALSE)::int AS unread,
          COUNT(*) FILTER (
            WHERE priority = 'high'
            AND created_at >= NOW() - INTERVAL '24 hours'
          )::int AS high_priority_24h
        FROM social_watch_alerts
      `),
      pool.query(`
        SELECT
          day::date AS day,
          TO_CHAR(day, 'Dy') AS label,
          COUNT(a.id)::int AS count
        FROM generate_series(
          CURRENT_DATE - INTERVAL '6 days',
          CURRENT_DATE,
          INTERVAL '1 day'
        ) AS day
        LEFT JOIN social_watch_alerts a
          ON a.created_at >= day
         AND a.created_at < day + INTERVAL '1 day'
        GROUP BY day
        ORDER BY day
      `),
      pool.query(`
        SELECT COUNT(*)::int AS connected
        FROM social_watch_integrations
        WHERE status = 'connected'
          AND (
            service_key = 'dashboard'
            OR last_seen >= NOW() - INTERVAL '3 minutes'
          )
      `),
    ]);

    res.json({
      ...counts.rows[0],
      highPriority24h: counts.rows[0].high_priority_24h,
      connectedServices: connections.rows[0].connected,
      activity: activity.rows.map((row) => ({
        day: row.day,
        label: row.label,
        count: row.count,
      })),
    });
  } catch (error) {
    console.error("Dashboard summary failed:", error.message);
    res.status(500).json({ error: "Unable to load dashboard summary." });
  }
});

app.get("/api/settings", requireLogin, async (req, res) => {
  try {
    const row = await getConfig();
    res.json({ config: row.config, updatedAt: row.updated_at });
  } catch (error) {
    console.error("Could not load settings:", error.message);
    res.status(500).json({ error: "Unable to load settings." });
  }
});

app.put("/api/settings", requireLogin, requireSameOrigin, async (req, res) => {
  try {
    if (!req.body || !req.body.config || typeof req.body.config !== "object") {
      return res.status(400).json({ error: "A config object is required." });
    }

    const row = await getConfig();
    const config = normalizeConfig(req.body.config, row.config);
    const result = await pool.query(
      `UPDATE social_watch_settings
       SET config = $1::jsonb, updated_at = NOW()
       WHERE id = 1
       RETURNING config, updated_at`,
      [JSON.stringify(config)]
    );

    res.json({
      success: true,
      config: result.rows[0].config,
      updatedAt: result.rows[0].updated_at,
    });
  } catch (error) {
    console.error("Could not save settings:", error.message);
    res.status(500).json({ error: "Unable to save settings." });
  }
});

// Authenticated bot endpoint: returns rules and automation preferences, never secrets.
app.get("/api/bot-config", requireIngestKey, async (req, res) => {
  try {
    const row = await getConfig();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      keywords: (row.config.keywords || [])
        .filter((rule) => rule.enabled)
        .map(({ term, priority, action, matchMode, exclude }) => ({ term, priority, action, matchMode, exclude })),
      automations: row.config.automations,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    console.error("Bot config request failed:", error.message);
    res.status(500).json({ error: "Unable to load bot configuration." });
  }
});

app.post("/api/integrations/heartbeat", requireIngestKey, async (req, res) => {
  const service = String(req.body?.service || "");
  const status = String(req.body?.status || "connected");
  const services = {
    discord_bot: "Discord monitoring bot",
    home_assistant: "Home Assistant / Google Nest",
  };

  if (!services[service]) {
    return res.status(400).json({ error: "Unsupported integration service." });
  }
  if (!["connected", "error", "configured"].includes(status)) {
    return res.status(400).json({ error: "Invalid integration status." });
  }

  try {
    await pool.query(
      `INSERT INTO social_watch_integrations
        (service_key, display_name, status, last_seen, details)
       VALUES ($1, $2, $3, NOW(), '{}'::jsonb)
       ON CONFLICT (service_key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         status = EXCLUDED.status,
         last_seen = NOW()`,
      [service, services[service], status]
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Integration heartbeat failed:", error.message);
    res.status(500).json({ error: "Unable to record integration status." });
  }
});

app.get("/api/integrations", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT service_key, display_name, status, last_seen
       FROM social_watch_integrations
       ORDER BY CASE service_key
         WHEN 'dashboard' THEN 1
         WHEN 'discord_bot' THEN 2
         WHEN 'home_assistant' THEN 3
         ELSE 4
       END`
    );

    const existing = new Map(result.rows.map((row) => [row.service_key, row]));
    const tracked = [
      { key: "dashboard", name: "Dashboard API + PostgreSQL", type: "Core service", description: "Dashboard, settings API, and PostgreSQL alert storage." },
      { key: "discord_bot", name: "Discord monitoring bot", type: "Alert source", description: "Keyword monitoring and Discord alert delivery." },
      { key: "home_assistant", name: "Home Assistant / Google Nest", type: "Announcement route", description: "Home Assistant webhook and Google Assistant SDK announcement route." },
    ];

    res.json({
      integrations: tracked.map((item) => {
        const found = existing.get(item.key);
        return {
          ...item,
          status: found ? found.status : "not_connected",
          last_seen: found ? found.last_seen : null,
        };
      }),
    });
  } catch (error) {
    console.error("Integration status failed:", error.message);
    res.status(500).json({ error: "Unable to load integrations." });
  }
});

app.post("/api/logs", requireIngestKey, async (req, res) => {
  try {
    const level = String(req.body?.level || "info").toLowerCase();
    const source = String(req.body?.source || "social-watch").trim().slice(0, 120) || "social-watch";
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const details = req.body?.details && typeof req.body.details === "object" && !Array.isArray(req.body.details)
      ? req.body.details
      : {};

    if (!["debug", "info", "warning", "error", "critical"].includes(level)) {
      return res.status(400).json({ error: "Invalid log level." });
    }
    if (!message || message.length > 10000) {
      return res.status(400).json({ error: "Log message is required and must be at most 10000 characters." });
    }

    const result = await pool.query(
      `INSERT INTO social_watch_logs (level, source, message, details)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, level, source, message, details, created_at`,
      [level, source, message, JSON.stringify(details)]
    );
    res.status(201).json({ success: true, log: result.rows[0] });
  } catch (error) {
    console.error("Failed to save system log:", error.message);
    res.status(500).json({ error: "Unable to save system log." });
  }
});

app.get("/api/logs", requireLogin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const offset = Math.min(1000000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
    const level = String(req.query.level || "").toLowerCase();
    const search = String(req.query.search || "").trim().slice(0, 200);
    const clauses = [];
    const values = [];
    if (["debug", "info", "warning", "error", "critical"].includes(level)) {
      values.push(level);
      clauses.push(`level = ${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      clauses.push(`(message ILIKE ${values.length} OR source ILIKE ${values.length})`);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM social_watch_logs ${where}`,
      values
    );
    const result = await pool.query(
      `SELECT id, level, source, message, details, created_at
       FROM social_watch_logs ${where}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      values
    );
    res.json({ logs: result.rows, total: countResult.rows[0].total, limit, offset });
  } catch (error) {
    console.error("Failed to read system logs:", error.message);
    res.status(500).json({ error: "Unable to load system logs." });
  }
});

app.get("/api/alerts/sources", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT DISTINCT source FROM social_watch_alerts ORDER BY source LIMIT 100"
    );
    res.json({ sources: result.rows.map((row) => row.source).filter(Boolean) });
  } catch (error) {
    console.error("Could not load alert sources:", error.message);
    res.status(500).json({ error: "Unable to load alert sources." });
  }
});

app.get("/api/alerts", requireLogin, async (req, res) => {
  try {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
    const parsedOffset = Number.parseInt(req.query.offset, 10);
    const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.min(parsedOffset, 1000000)) : 0;
    const where = [];
    const values = [];

    if (typeof req.query.search === "string" && req.query.search.trim()) {
      values.push("%" + req.query.search.trim().slice(0, 120) + "%");
      const p = "$" + values.length;
      where.push("(message ILIKE " + p + " OR source ILIKE " + p + " OR COALESCE(keyword, '') ILIKE " + p + ")");
    }
    if (["high", "medium", "normal"].includes(String(req.query.priority || ""))) {
      values.push(String(req.query.priority));
      where.push("priority = $" + values.length);
    }
    if (typeof req.query.source === "string" && req.query.source.trim()) {
      values.push(req.query.source.trim().slice(0, 150));
      where.push("source = $" + values.length);
    }
    if (req.query.status === "unread") where.push("is_read = FALSE");
    if (req.query.status === "read") where.push("is_read = TRUE");

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const countResult = await pool.query(
      "SELECT COUNT(*)::int AS total FROM social_watch_alerts " + whereSql,
      values
    );
    const pageValues = [...values, limit, offset];
    const result = await pool.query(
      `SELECT id, message, source, priority, keyword, created_at, is_read
       FROM social_watch_alerts
       ` + whereSql + `
       ORDER BY created_at DESC, id DESC
       LIMIT $` + (values.length + 1) + ` OFFSET $` + (values.length + 2),
      pageValues
    );

    res.json({ alerts: result.rows, total: countResult.rows[0].total, limit, offset });
  } catch (error) {
    console.error("Failed to read alerts:", error.message);
    res.status(500).json({ error: "Unable to load alerts." });
  }
});

app.patch("/api/alerts/:id/read", requireLogin, requireSameOrigin, async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^\d{1,18}$/.test(id)) return res.status(400).json({ error: "Invalid alert ID." });

  try {
    const result = await pool.query(
      "UPDATE social_watch_alerts SET is_read = TRUE WHERE id = $1 RETURNING id",
      [id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Alert not found." });
    res.json({ success: true });
  } catch (error) {
    console.error("Mark read failed:", error.message);
    res.status(500).json({ error: "Unable to update alert." });
  }
});

app.post("/api/alerts/bulk-read", requireLogin, requireSameOrigin, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE social_watch_alerts SET is_read = TRUE WHERE is_read = FALSE"
    );
    res.json({ success: true, updated: result.rowCount });
  } catch (error) {
    console.error("Bulk mark read failed:", error.message);
    res.status(500).json({ error: "Unable to update alerts." });
  }
});

app.delete("/api/alerts/:id", requireLogin, requireSameOrigin, async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^\d{1,18}$/.test(id)) return res.status(400).json({ error: "Invalid alert ID." });

  try {
    const result = await pool.query("DELETE FROM social_watch_alerts WHERE id = $1 RETURNING id", [id]);
    if (!result.rowCount) return res.status(404).json({ error: "Alert not found." });
    res.json({ success: true });
  } catch (error) {
    console.error("Delete alert failed:", error.message);
    res.status(500).json({ error: "Unable to delete alert." });
  }
});



app.post("/api/alerts/test", requireLogin, requireSameOrigin, async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO social_watch_alerts
        (message, source, priority, keyword, is_read)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING id, message, source, priority, keyword, created_at, is_read`,
      [
        "This is a dashboard storage test. It does not send a Google Nest announcement.",
        "Dashboard Test",
        "normal",
        "test",
      ]
    );
    res.status(201).json({ success: true, alert: result.rows[0] });
  } catch (error) {
    console.error("Test alert failed:", error.message);
    res.status(500).json({ error: "Unable to create test alert." });
  }
});

app.get("/api/config", requireLogin, async (req, res) => {
  try {
    const row = await getConfig();
    res.json({
      keywords: (row.config.keywords || [])
        .filter((rule) => rule.enabled)
        .map((rule) => rule.term),
    });
  } catch (error) {
    res.status(500).json({ error: "Unable to load configuration." });
  }
});

app.post("/api/alerts", requireIngestKey, async (req, res) => {
  try {
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    const source = typeof req.body.source === "string" ? req.body.source.trim().slice(0, 150) : "Unknown";
    const keyword = typeof req.body.keyword === "string" ? req.body.keyword.trim().slice(0, 150) : "";

    if (!message || message.length > 10000) {
      return res.status(400).json({ error: "Message is required and must be at most 10000 characters." });
    }

    const suppliedPriority = String(req.body.priority || "").toLowerCase();
    const priority = ["high", "medium", "normal"].includes(suppliedPriority)
      ? suppliedPriority
      : inferPriority(message);

    const result = await pool.query(
      `INSERT INTO social_watch_alerts
        (message, source, priority, keyword, is_read)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING id, message, source, priority, keyword, created_at, is_read`,
      [message, source || "Unknown", priority, keyword || null]
    );

    await pool.query(
      `INSERT INTO social_watch_integrations
        (service_key, display_name, status, last_seen, details)
       VALUES ('discord_bot', 'Discord monitoring bot', 'connected', NOW(), '{}'::jsonb)
       ON CONFLICT (service_key) DO UPDATE SET
         status = 'connected', last_seen = NOW()`
    ).catch((error) => console.error("Integration update failed:", error.message));

    res.status(201).json({ success: true, alert: result.rows[0] });
  } catch (error) {
    console.error("Failed to save alert:", error.message);
    res.status(500).json({ error: "Unable to save alert." });
  }
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
  res.status(404).send("Page not found.");
});

async function start() {
  await initializeDatabase();
  app.listen(PORT, "0.0.0.0", () => {
    console.log("Social Watch dashboard listening on port " + PORT);
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
