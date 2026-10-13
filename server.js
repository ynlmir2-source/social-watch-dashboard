
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20kb" }));

const crypto = require("crypto");

function sameSecret(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireLogin(req, res, next) {
  const username = process.env.DASHBOARD_USER;
  const password = process.env.DASHBOARD_PASSWORD;

  if (!username || !password) {
    return res.status(503).send("Dashboard login is not configured.");
  }

  const header = req.headers.authorization || "";

  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Social Watch Dashboard"');
    return res.status(401).send("Login required.");
  }

  let credentials;

  try {
    credentials = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return res.status(401).send("Invalid login.");
  }

  const separator = credentials.indexOf(":");

  if (separator < 0) {
    return res.status(401).send("Invalid login.");
  }

  const suppliedUser = credentials.slice(0, separator);
  const suppliedPassword = credentials.slice(separator + 1);

  if (
    !sameSecret(suppliedUser, username) ||
    !sameSecret(suppliedPassword, password)
  ) {
    res.set("WWW-Authenticate", 'Basic realm="Social Watch Dashboard"');
    return res.status(401).send("Incorrect username or password.");
  }

  next();
}


const recentAlerts = [];

const priorities = {
  "urgent": "Critical",
  "event announcement": "High",
  "launch": "High",
  "project update": "Medium",
  "owner info": "Medium",
  "settings": "Low",
  "social watch": "Low"
};

app.get("/", requireLogin, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Social Watch Dashboard</title>
<style>
*{box-sizing:border-box}
body{font-family:Arial,sans-serif;background:#10131b;color:#f5f5f5;margin:0;padding:24px}
main{max-width:950px;margin:auto}
h1{margin-bottom:6px}
.muted{color:#aab2c5}
.card{background:#1c2230;border:1px solid #343d51;border-radius:12px;padding:16px;margin:14px 0}
select,button{padding:10px;border-radius:8px;border:1px solid #454f65;background:#171c28;color:white;margin:5px;cursor:pointer}
button:hover{background:#30394c}
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.alert{border-left:5px solid #709bff}
.priority{display:inline-block;padding:5px 9px;border-radius:6px;font-size:12px;font-weight:bold}
.critical{border-left-color:#ff4d5e}
.critical .priority{background:#57222b;color:#ff9ca5}
.high{border-left-color:#f0a340}
.high .priority{background:#49351b;color:#ffd18a}
.medium{border-left-color:#a78bfa}
.medium .priority{background:#352a55;color:#d3c4ff}
.low{border-left-color:#57c7a0}
.low .priority{background:#1d453b;color:#a4f0d5}
#notice{display:none;position:sticky;top:10px;z-index:5;background:#263a2d;border:1px solid #4d8961;padding:14px;border-radius:10px;margin:14px 0}
#notice.show{display:block;animation:appear .25s ease-out}
@keyframes appear{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>
<main>
<h1>Social Watch</h1>
<p class="muted">Live keyword monitoring and priority alerts</p>
<div id="notice" role="status" aria-live="polite"></div>
<div class="card">
<div class="controls">
<label for="filter">Filter keyword:</label>
<select id="filter">
<option value="">All keywords</option>
<option>social watch</option>
<option>project update</option>
<option>event announcement</option>
<option>urgent</option>
<option>launch</option>
<option>settings</option>
<option>owner info</option>
</select>
<button id="refresh">Refresh alerts</button>
<button id="enableNotifications">Enable browser notifications</button>
</div>
<p class="muted">Critical: red · High: orange · Medium: purple · Low: green</p>
<p id="notificationStatus" class="muted">Browser notifications are optional.</p>
</div>
<div id="alerts"></div>
</main>
<script>
let initialized = false;
let lastSeenId = null;
let noticeTimer = null;

function safe(value){
  return String(value ?? "").replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}

function showNotice(text){
  const notice = document.getElementById("notice");
  notice.textContent = text;
  notice.classList.add("show");
  if(noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(function(){
    notice.classList.remove("show");
  }, 5000);
}

async function loadAlerts(){
  try{
    const response = await fetch("/api/alerts", {cache:"no-store"});
    if(!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();

    if(data.length && initialized && data[0].id !== lastSeenId){
      showNotice("New " + data[0].priority + " alert: " + data[0].keyword);
      if("Notification" in window && Notification.permission === "granted"){
        new Notification("Social Watch: " + data[0].priority, {
          body: data[0].keyword + " — " + data[0].message
        });
      }
    }

    if(data.length) lastSeenId = data[0].id;
    initialized = true;

    const selected = document.getElementById("filter").value;
    const items = selected ? data.filter(function(a){
      return a.keyword === selected;
    }) : data;

    document.getElementById("alerts").innerHTML = items.map(function(a){
      const priority = a.priority || "Low";
      const cls = priority.toLowerCase();
      return '<div class="card alert ' + safe(cls) + '">' +
        '<strong>' + safe(a.keyword) + '</strong> ' +
        '<span class="priority">' + safe(priority) + '</span>' +
        '<p>' + safe(a.message) + '</p>' +
        '<small class="muted">' + safe(a.server) + ' / #' +
        safe(a.channel) + ' · ' + safe(a.time) + '</small></div>';
    }).join("") || '<p class="muted">No alerts yet.</p>';
  }catch(error){
    console.error("Could not load alerts:", error);
    document.getElementById("alerts").innerHTML =
      '<p class="muted">Could not load alerts. Check your connection and refresh.</p>';
  }
}

document.getElementById("refresh").addEventListener("click", loadAlerts);
document.getElementById("filter").addEventListener("change", loadAlerts);

document.getElementById("enableNotifications").addEventListener("click", async function(){
  if(!("Notification" in window)){
    document.getElementById("notificationStatus").textContent =
      "This browser does not support notifications.";
    return;
  }
  const permission = await Notification.requestPermission();
  document.getElementById("notificationStatus").textContent =
    permission === "granted" ? "Browser notifications enabled." :
    "Notifications not enabled. Check your browser's site permissions.";
});

if("Notification" in window && Notification.permission === "granted"){
  document.getElementById("notificationStatus").textContent =
    "Browser notifications are enabled.";
}

loadAlerts();
setInterval(loadAlerts, 5000);
</script>
</body>
</html>`);
});

app.get("/api/alerts", requireLogin, async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(recentAlerts);
});

app.post("/api/alerts", (req, res) => {
  const key = process.env.DASHBOARD_INGEST_KEY;

  if (!key || req.get("Authorization") !== "Bearer " + key) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { keyword, message, server, channel } = req.body || {};

  if (typeof keyword !== "string" || !keyword.trim() ||
      typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      error: "keyword and message are required"
    });
  }

  const normalizedKeyword = keyword.trim().toLowerCase();

  recentAlerts.unshift({
    id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
    keyword: normalizedKeyword.slice(0, 100),
    priority: priorities[normalizedKeyword] || "Low",
    message: message.slice(0, 1500),
    server: String(server || "Unknown server").slice(0, 100),
    channel: String(channel || "Unknown channel").slice(0, 100),
    time: new Date().toISOString()
  });

  recentAlerts.splice(100);
  res.status(201).json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Dashboard listening on " + PORT);
});
