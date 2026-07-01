// Termux control panel — a tiny zero-dependency web UI for the phone-camping workflow
// (install deps, build the Bad Pitches offline cache, start/stop JakeCrate) so it can
// be run by tapping buttons in a browser instead of typing commands into Termux.
//
// Run once per Termux session:
//     node termux-control.js
// then open the printed URL in the phone's browser. Deliberately has zero npm
// dependencies (only Node builtins) so it works even before `npm install` has run —
// that's one of the buttons.

const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.CONTROL_PORT) || 8081;
const ROOT = __dirname;

// ── LAN IP heuristic (mirrors jcLanIp in index.js / pickHostIp in Spawnpoint) ───
function lanIp() {
    const ifaces = os.networkInterfaces();
    let best = '127.0.0.1', bestScore = -1;
    for (const name of Object.keys(ifaces)) {
        for (const net of ifaces[name] || []) {
            if (net.family !== 'IPv4' || net.internal) continue;
            let s = 0;
            if (/^(ap|wlan1|swlan|softap|rndis|usb|tether)/i.test(name)) s += 4;
            if (net.address.endsWith('.1')) s += 3;
            if (net.address.startsWith('192.168.')) s += 2;
            else if (net.address.startsWith('10.') || net.address.startsWith('172.')) s += 1;
            if (s > bestScore) { bestScore = s; best = net.address; }
        }
    }
    return best;
}

// ── Job runner — one command at a time, rolling log buffer, killable ───────────
let job = null; // { name, proc, log: string[], startedAt, done, code }

function startJob(name, cmd, args, extraEnv) {
    if (job && !job.done) return false;
    // npm is a .cmd shim on Windows and needs a shell to resolve; node itself doesn't,
    // and running it without a shell keeps SIGTERM able to kill it directly (needed to
    // stop the long-running JakeCrate server job).
    const useShell = cmd === 'npm' && process.platform === 'win32';
    const proc = spawn(cmd, args, { cwd: ROOT, env: Object.assign({}, process.env, extraEnv || {}), shell: useShell });
    job = { name, proc, log: [], startedAt: Date.now(), done: false, code: null };
    const push = (buf) => {
        job.log.push.apply(job.log, String(buf).split('\n').filter(Boolean));
        if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
    };
    proc.stdout.on('data', push);
    proc.stderr.on('data', push);
    proc.on('close', (code) => { job.done = true; job.code = code; });
    proc.on('error', (e) => { push('ERROR: ' + e.message); job.done = true; job.code = -1; });
    return true;
}

function stopJob() {
    if (job && !job.done) { job.proc.kill('SIGTERM'); return true; }
    return false;
}

// ── Minimal HTTP plumbing (no deps) ─────────────────────────────────────────────
function send(res, status, body, type) {
    res.writeHead(status, { 'Content-Type': type || 'application/json' });
    res.end(body);
}
function readJsonBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
    });
}

const PAGE = '<!doctype html><html><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">' +
'<title>JakeCrate Control</title><style>' +
'body{background:#0b0b12;color:#eee;font-family:system-ui,sans-serif;margin:0;padding:16px;}' +
'h1{font-size:1.2rem;margin:0 0 4px;} .sub{color:#888;font-size:.85rem;margin-bottom:16px;}' +
'button{display:block;width:100%;padding:16px;margin:8px 0;font-size:1rem;font-weight:600;' +
'border:none;border-radius:10px;color:#fff;background:#3a3a55;}' +
'button:disabled{opacity:.4;} button.go{background:#2e7d32;} button.stop{background:#c62828;}' +
'#status{padding:10px 12px;border-radius:8px;background:#1a1a26;margin:12px 0;font-size:.9rem;}' +
'#joinbox{padding:10px 12px;border-radius:8px;background:#1b3a1b;margin:12px 0;font-size:.95rem;display:none;}' +
'#joinbox a{color:#8f8;} ' +
'#log{background:#000;color:#0f0;font-family:monospace;font-size:.75rem;padding:10px;' +
'border-radius:8px;height:260px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;}' +
'label{font-size:.85rem;color:#aaa;}' +
'input[type=number]{width:70px;padding:8px;border-radius:6px;border:1px solid #444;background:#111;color:#fff;}' +
'</style></head><body>' +
'<h1>🎛 JakeCrate Control</h1><div class="sub">Runs on this phone via Termux</div>' +
'<div id="status">loading…</div>' +
'<div id="joinbox"></div>' +
'<button id="b-install">📦 Install dependencies</button>' +
'<div><label>Jazz samples to cache: <input id="jazzcount" type="number" value="20" min="5" max="100"></label></div>' +
'<button id="b-cache">🎵 Build Bad Pitches offline cache</button>' +
'<button id="b-start" class="go">🚀 Start JakeCrate (local mode)</button>' +
'<button id="b-stop" class="stop">⏹ Stop</button>' +
'<div id="log"></div>' +
'<script>' +
'var logEl=document.getElementById("log"),statusEl=document.getElementById("status"),joinEl=document.getElementById("joinbox");' +
'var bInstall=document.getElementById("b-install"),bCache=document.getElementById("b-cache"),' +
'bStart=document.getElementById("b-start"),bStop=document.getElementById("b-stop");' +
'function post(url,body){return fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});}' +
'bInstall.onclick=function(){post("/api/install");};' +
'bCache.onclick=function(){post("/api/build-cache",{count:Number(document.getElementById("jazzcount").value)||20});};' +
'bStart.onclick=function(){post("/api/start");};' +
'bStop.onclick=function(){post("/api/stop");};' +
'function poll(){' +
'fetch("/api/status").then(function(r){return r.json();}).then(function(s){' +
'var running=s.job&&!s.job.done;' +
'var busy=running&&s.job.name!=="jakecrate";' +
'bInstall.disabled=busy||running&&s.job.name==="jakecrate";' +
'bCache.disabled=busy||running&&s.job.name==="jakecrate";' +
'bStart.disabled=busy||(running&&s.job.name==="jakecrate");' +
'bStop.disabled=!running;' +
'if(running&&s.job.name==="jakecrate"){' +
'statusEl.textContent="🟢 JakeCrate running on port 3000";' +
'joinEl.style.display="block";' +
'joinEl.innerHTML="Join link: <a href=\\"http://"+s.ip+":3000\\" target=_blank>http://"+s.ip+":3000</a>";' +
'}else if(running){statusEl.textContent="⏳ "+s.job.name+" running…";joinEl.style.display="none";}' +
'else if(s.job){statusEl.textContent=(s.job.name)+" finished (exit "+s.job.code+")";joinEl.style.display="none";}' +
'else{statusEl.textContent="Idle — pick an action below";joinEl.style.display="none";}' +
'if(s.job&&s.job.log){logEl.textContent=s.job.log.join("\\n");logEl.scrollTop=logEl.scrollHeight;}' +
'}).catch(function(){statusEl.textContent="(connection lost)";});' +
'}' +
'poll();setInterval(poll,1200);' +
'</script></body></html>';

const server = http.createServer(function (req, res) {
    if (req.method === 'GET' && req.url === '/') return send(res, 200, PAGE, 'text/html');
    if (req.method === 'GET' && req.url === '/api/status') {
        return send(res, 200, JSON.stringify({
            job: job ? { name: job.name, done: job.done, code: job.code, log: job.log } : null,
            ip: lanIp(),
        }));
    }
    if (req.method === 'POST' && req.url === '/api/install') {
        return send(res, 200, JSON.stringify({ ok: startJob('install', 'npm', ['install']) }));
    }
    if (req.method === 'POST' && req.url === '/api/build-cache') {
        return readJsonBody(req).then(function (body) {
            var count = Number(body.count) || 20;
            send(res, 200, JSON.stringify({ ok: startJob('build-cache', 'node', ['bb-cache-build.js'], { JAZZ_COUNT: String(count) }) }));
        });
    }
    if (req.method === 'POST' && req.url === '/api/start') {
        return send(res, 200, JSON.stringify({ ok: startJob('jakecrate', 'node', ['index.js'], { JC_LOCAL_MODE: '1' }) }));
    }
    if (req.method === 'POST' && req.url === '/api/stop') {
        return send(res, 200, JSON.stringify({ ok: stopJob() }));
    }
    send(res, 404, JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, function () {
    console.log('\n🎛  JakeCrate control panel:');
    console.log('   http://localhost:' + PORT + '  (on this phone)');
    console.log('   http://' + lanIp() + ':' + PORT + '  (from another device on the same network)\n');
});
