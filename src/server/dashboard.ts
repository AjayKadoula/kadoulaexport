/**
 * Self-contained dashboard page (inline CSS + JS, no external assets). Polls
 * /api/state and renders the live monitoring view described in
 * docs/04-ux-design.md §3.1. Served by the headless web-UI server.
 */

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stock Sentinel</title>
<style>
  :root{
    --bg:#0d1117;--panel:#161b22;--panel2:#1c2230;--border:#2b3240;--text:#e6edf3;--muted:#8b949e;
    --green:#2ea043;--grey:#6e7681;--amber:#d29922;--purple:#8957e5;--blue:#388bfd;--teal:#26a69a;
    --yellow:#d4a72c;--red:#da3633;--accent:#388bfd;
  }
  @media (prefers-color-scheme: light){
    :root{--bg:#f6f8fa;--panel:#fff;--panel2:#f0f3f6;--border:#d0d7de;--text:#1f2328;--muted:#636c76;}
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text)}
  header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border);background:var(--panel);position:sticky;top:0;z-index:2}
  header h1{font-size:16px;margin:0;font-weight:650}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 25%,transparent)}
  .dot.off{background:var(--red);box-shadow:0 0 0 3px color-mix(in srgb,var(--red) 25%,transparent)}
  .muted{color:var(--muted)}
  main{max-width:1100px;margin:0 auto;padding:20px;display:grid;gap:16px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:820px){.grid{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px}
  .panel h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);font-size:13px}
  th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  .tablewrap{overflow-x:auto}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:20px;font-size:12px;font-weight:600;white-space:nowrap}
  .s-AVAILABLE{background:color-mix(in srgb,var(--green) 20%,transparent);color:var(--green)}
  .s-OUT_OF_STOCK{background:color-mix(in srgb,var(--grey) 22%,transparent);color:var(--muted)}
  .s-UNAVAILABLE_IN_AREA{background:color-mix(in srgb,var(--purple) 20%,transparent);color:var(--purple)}
  .s-COMING_SOON{background:color-mix(in srgb,var(--blue) 20%,transparent);color:var(--blue)}
  .s-PREORDER{background:color-mix(in srgb,var(--teal) 20%,transparent);color:var(--teal)}
  .s-TEMPORARILY_UNAVAILABLE{background:color-mix(in srgb,var(--amber) 20%,transparent);color:var(--amber)}
  .s-NOT_LISTED{background:color-mix(in srgb,var(--grey) 15%,transparent);color:var(--muted);border:1px dashed var(--border)}
  .s-UNKNOWN{background:color-mix(in srgb,var(--yellow) 20%,transparent);color:var(--yellow)}
  .s-ERROR{background:color-mix(in srgb,var(--red) 20%,transparent);color:var(--red)}
  .stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;background:var(--panel2);border-radius:8px}
  .stat b{font-size:20px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
  form{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  input,button{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text)}
  button{background:var(--accent);color:#fff;border:none;cursor:pointer;font-weight:600}
  button.sec{background:var(--panel2);color:var(--text);border:1px solid var(--border)}
  .pf{display:flex;flex-wrap:wrap;gap:8px}
  .pf label{display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:13px}
  .alert{padding:10px 12px;border-left:3px solid var(--green);background:var(--panel2);border-radius:6px;margin-bottom:8px}
  .alert small{color:var(--muted)}
  .banner{padding:10px 14px;border-radius:8px;background:color-mix(in srgb,var(--red) 15%,transparent);color:var(--red);font-weight:600;display:none}
  .banner.show{display:block}
  a{color:var(--accent)}
  .note{font-size:12px;color:var(--muted);margin-top:6px}
</style>
</head>
<body>
<header>
  <span class="dot" id="statusdot"></span>
  <h1>Stock Sentinel</h1>
  <span class="muted" id="statusline">connecting…</span>
</header>
<main>
  <div class="banner" id="offline">Offline — connectivity lost. Monitoring paused; it will resume automatically.</div>

  <div class="panel">
    <h2>Availability now</h2>
    <div class="stats" id="stats"></div>
  </div>

  <div class="grid">
    <div class="panel">
      <h2>Add a product to watch</h2>
      <form id="pform">
        <input name="name" placeholder="Name or keyword (e.g. iPhone 17 Pro Max)" style="flex:1;min-width:200px" required>
        <input name="url" placeholder="…or paste a product URL (optional)" style="flex:1;min-width:200px">
        <button type="submit">Watch</button>
      </form>
      <div class="note">URL mode is the most precise. Keyword mode discovers the product on each enabled platform.</div>
    </div>
    <div class="panel">
      <h2>Add a location</h2>
      <form id="lform">
        <input name="pincode" placeholder="Pincode (e.g. 122001)" pattern="[1-9][0-9]{5}" required>
        <input name="label" placeholder="Label (Home)">
        <button type="submit">Add</button>
      </form>
      <div class="note">Availability is location-specific, especially for quick-commerce.</div>
    </div>
  </div>

  <div class="panel">
    <h2>Platforms</h2>
    <div class="pf" id="platforms"></div>
  </div>

  <div class="panel">
    <h2>Targets</h2>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Product</th><th>Platform</th><th>Pincode</th><th>State</th><th>Price</th><th>Checked</th><th>Health</th></tr></thead>
        <tbody id="targets"><tr><td colspan="7" class="muted">No targets yet — add a product, a location, and enable a platform.</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>Recent alerts</h2>
    <div id="alerts"><div class="muted">No alerts yet.</div></div>
  </div>
</main>
<script>
const $=s=>document.querySelector(s);
function ago(ts,now){ if(!ts) return '—'; const s=Math.max(0,Math.round((now-ts)/1000)); if(s<60) return s+'s ago'; const m=Math.round(s/60); if(m<60) return m+'m ago'; return Math.round(m/60)+'h ago';}
function chip(state){return '<span class="chip s-'+state+'">'+state.replace(/_/g,' ')+'</span>';}

async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return r.json();}

$('#pform').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;const r=await post('/api/products',{name:f.name.value,url:f.url.value});if(r.error)alert(r.error);f.reset();refresh();});
$('#lform').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;const r=await post('/api/locations',{pincode:f.pincode.value,label:f.label.value});if(r.error)alert(r.error);f.reset();refresh();});

let platformsRendered=false;
function renderPlatforms(list,enabledSet){
  if(platformsRendered) return;
  platformsRendered=true;
  $('#platforms').innerHTML=list.map(p=>'<label><input type="checkbox" data-id="'+p.id+'"> '+p.name+' <span class="muted">·'+p.minSpacingS+'s</span></label>').join('');
  $('#platforms').querySelectorAll('input').forEach(cb=>{
    cb.addEventListener('change',async()=>{await post('/api/platforms',{id:cb.dataset.id,enabled:cb.checked});refresh();});
  });
}

async function refresh(){
  let d; try{d=await(await fetch('/api/state')).json();}catch(e){$('#statusline').textContent='disconnected';return;}
  const now=d.now;
  $('#statusdot').className='dot'+(d.offline?' off':'');
  $('#offline').className='banner'+(d.offline?' show':'');
  $('#statusline').textContent='Watching '+d.targets.length+' target'+(d.targets.length===1?'':'s')+(d.offline?' · offline':' · all systems go');
  renderPlatforms(d.platforms);
  // reflect enabled platforms from targets
  const enabled=new Set(d.targets.map(t=>t.platform));
  $('#platforms').querySelectorAll('input').forEach(cb=>{ if(document.activeElement!==cb) cb.checked=enabled.has(cb.dataset.id)||cb.checked; });

  // stats
  const counts={};d.targets.forEach(t=>counts[t.state]=(counts[t.state]||0)+1);
  const order=['AVAILABLE','OUT_OF_STOCK','UNAVAILABLE_IN_AREA','COMING_SOON','PREORDER','TEMPORARILY_UNAVAILABLE','NOT_LISTED','UNKNOWN','ERROR'];
  $('#stats').innerHTML=order.filter(s=>counts[s]).map(s=>'<div class="stat">'+chip(s)+'<b>'+counts[s]+'</b></div>').join('')||'<div class="muted">No targets yet.</div>';

  // targets
  $('#targets').innerHTML=d.targets.length?d.targets.map(t=>'<tr><td>'+esc(t.product)+'</td><td>'+t.platform+'</td><td>'+t.pincode+'</td><td>'+chip(t.state)+'</td><td>'+t.price+'</td><td class="muted">'+ago(t.lastChecked,now)+'</td><td class="muted">'+t.health+'</td></tr>').join(''):'<tr><td colspan="7" class="muted">No targets yet — add a product, a location, and enable a platform.</td></tr>';

  // alerts
  $('#alerts').innerHTML=d.alerts.length?d.alerts.map(a=>'<div class="alert">'+chip(a.state)+' <b>'+esc(a.product)+'</b> on '+a.platform+' @ '+a.pincode+' — '+a.price+' <small>('+a.confidence+' confidence · '+a.reason+' · '+ago(a.at,now)+')</small>'+(a.url?' <a href="'+esc(a.url)+'" target="_blank">open</a>':'')+'</div>').join(''):'<div class="muted">No alerts yet.</div>';
}
function esc(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
refresh();setInterval(refresh,2500);
</script>
</body>
</html>`;
}
