const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const recentAlerts = [];

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Social Watch Dashboard</title>
<style>
body{font-family:Arial,sans-serif;background:#10131b;color:#f5f5f5;margin:0;padding:24px}
main{max-width:900px;margin:auto}
h1{margin-bottom:6px}
.muted{color:#aab2c5}
.card{background:#1c2230;border:1px solid #343d51;border-radius:12px;padding:16px;margin:14px 0}
select,input,button{padding:10px;border-radius:8px;border:1px solid #454f65;background:#171c28;color:white}
.alert{border-left:4px solid #709bff}
.urgent{border-left-color:#ff6565}
.event{border-left-color:#e4b45e}
#notice{display:none;background:#263a2d;padding:12px;border-radius:8px}
</style>
</head>
<body>
<main>
<h1>Social Watch</h1>
<p class="muted">Keyword monitoring dashboard</p>
<div id="notice">New alert received</div>
<div class="card">
<label>Filter by keyword
<select id="filter">
<option value="">All keywords</option>
<option>social watch</option><option>project update</option>
<option>event announcement</option><option>urgent</option>
<option>launch</option><option>settings</option><option>owner info</option>
</select></label>
<button id="refresh">Refresh alerts</button>
</div>
<div id="alerts"></div>
</main>
<script>
let lastCount = 0;
async function loadAlerts(){
 try{
  const selected=document.getElementById('filter').value;
  const response=await fetch('/api/alerts');
  const data=await response.json();
  if(data.length>lastCount){
    document.getElementById('notice').style.display='block';
    setTimeout(()=>document.getElementById('notice').style.display='none',2500);
  }
  lastCount=data.length;
  const items=selected?data.filter(a=>a.keyword===selected):data;
  document.getElementById('alerts').innerHTML=items.map(a=>{
    const cls=a.keyword==='urgent'?'urgent':a.keyword==='event announcement'?'event':'';
    const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    return '<div class="card alert '+cls+'"><strong>'+safe(a.keyword)+'</strong><p>'+safe(a.message)+'</p><small class="muted">'+safe(a.server)+' / '+safe(a.channel)+' · '+safe(a.time)+'</small></div>';
  }).join('')||'<p class="muted">No alerts yet.</p>';
 }catch(e){console.error(e)}
}
document.getElementById('refresh').onclick=loadAlerts;
document.getElementById('filter').onchange=loadAlerts;
loadAlerts();
setInterval(loadAlerts,5000);
</script>
</body>
</html>`);
});

app.get("/api/alerts", (req, res) => res.json(recentAlerts));

app.post("/api/alerts", (req, res) => {
  const key = process.env.DASHBOARD_INGEST_KEY;
  if (!key || req.get("Authorization") !== "Bearer " + key) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { keyword, message, server, channel } = req.body || {};
  if (!keyword || !message) {
    return res.status(400).json({ error: "keyword and message are required" });
  }
  recentAlerts.unshift({
    keyword: String(keyword).slice(0,100),
    message: String(message).slice(0,1500),
    server: String(server || "Unknown server").slice(0,100),
    channel: String(channel || "Unknown channel").slice(0,100),
    time: new Date().toISOString()
  });
  recentAlerts.splice(100);
  res.status(201).json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => console.log("Dashboard listening on " + PORT));
