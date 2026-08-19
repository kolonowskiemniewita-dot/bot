// DASHBOARD DO HOSTOWANIA BOTÓW DISCORD
// Każdy bot ma swój własny folder w /bots/<nazwa_bota>/ z własnym kodem
// i własnym plikiem zależności (requirements.txt dla Pythona, package.json dla Node.js)

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const pidusage = require('pidusage');

const app = express();
const PORT = process.env.PORT || 3000;
const BOTS_DIR = path.join(__dirname, 'bots');

// Limit RAM na jednego bota (w MB). Darmowy plan Render ma tylko 512 MB RAM na WSZYSTKO,
// więc pilnujemy, żeby jeden bot nie zjadł całego serwera.
const MAX_MEMORY_MB = parseInt(process.env.MAX_BOT_MEMORY_MB || '256', 10);

// Upewnij się, że folder na boty istnieje
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR);

// Trzymamy tu uruchomione procesy botów: { nazwaBota: { process, logs: [], stats: { memMB, cpu }, startedAt } }
const runningBots = {};

// --- Monitorowanie zużycia RAM/CPU każdego działającego bota co 3 sekundy ---
// Jeśli bot przekroczy limit MAX_MEMORY_MB, zostaje automatycznie zatrzymany.
setInterval(async () => {
  for (const [name, bot] of Object.entries(runningBots)) {
    if (!bot.process || !bot.process.pid) continue;
    try {
      const stat = await pidusage(bot.process.pid);
      bot.stats = { memMB: Math.round(stat.memory / 1024 / 1024 * 10) / 10, cpu: Math.round(stat.cpu * 10) / 10 };

      if (bot.stats.memMB > MAX_MEMORY_MB) {
        bot.logs.push(`[LIMIT] Bot przekroczył limit RAM (${bot.stats.memMB} MB > ${MAX_MEMORY_MB} MB). Zatrzymuję.`);
        bot.process.kill();
        delete runningBots[name];
      }
    } catch (err) {
      // proces mógł się już zakończyć między sprawdzeniami - ignorujemy
    }
  }
}, 3000);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Prosta ochrona hasłem (zmień w zmiennych środowiskowych na Render!) ---
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'zmien-to-haslo';
app.use((req, res, next) => {
  if (req.query.password === DASHBOARD_PASSWORD || req.cookies_password === DASHBOARD_PASSWORD) {
    return next();
  }
  if (req.path === '/login' || req.path.startsWith('/api') && req.headers['x-dashboard-password'] === DASHBOARD_PASSWORD) {
    return next();
  }
  next(); // uproszczone na start - patrz sekcja "Bezpieczeństwo" w README
});

// --- Upload nowego bota (plik .zip zawierający kod + requirements.txt/package.json) ---
const upload = multer({ dest: '/tmp/uploads' });

app.post('/api/bots/upload', upload.single('botzip'), (req, res) => {
  try {
    const botName = (req.body.name || '').trim().replace(/[^a-zA-Z0-9-_]/g, '');
    const botType = req.body.type; // "python" albo "node"

    if (!botName) return res.status(400).json({ error: 'Podaj nazwę bota (tylko litery, cyfry, - i _)' });
    if (!['python', 'node'].includes(botType)) return res.status(400).json({ error: 'Wybierz typ bota: python lub node' });
    if (!req.file) return res.status(400).json({ error: 'Brak pliku .zip' });

    const botDir = path.join(BOTS_DIR, botName);
    if (fs.existsSync(botDir)) return res.status(400).json({ error: 'Bot o tej nazwie już istnieje' });

    fs.mkdirSync(botDir);
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(botDir, true);
    fs.unlinkSync(req.file.path);

    // Zapisz metadane bota (typ, token itd.)
    const meta = { type: botType, env: {} };
    if (req.body.token) meta.env.DISCORD_TOKEN = req.body.token;
    fs.writeFileSync(path.join(botDir, '__meta.json'), JSON.stringify(meta, null, 2));

    res.json({ ok: true, message: `Bot "${botName}" wgrany.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Utwórz nowego bota z edytora (pliki wysyłane jako tekst, nie zip) ---
app.post('/api/bots/create', (req, res) => {
  try {
    const botName = (req.body.name || '').trim().replace(/[^a-zA-Z0-9-_]/g, '');
    const botType = req.body.type; // "python" albo "node"
    const files = req.body.files || {}; // { "main.py": "kod...", "requirements.txt": "..." }
    const token = req.body.token || '';

    if (!botName) return res.status(400).json({ error: 'Podaj nazwę bota (tylko litery, cyfry, - i _)' });
    if (!['python', 'node'].includes(botType)) return res.status(400).json({ error: 'Wybierz typ bota' });

    const botDir = path.join(BOTS_DIR, botName);
    if (fs.existsSync(botDir)) return res.status(400).json({ error: 'Bot o tej nazwie już istnieje' });

    fs.mkdirSync(botDir);
    for (const [filename, content] of Object.entries(files)) {
      const safeName = path.basename(filename); // zabezpieczenie przed wyjściem poza folder
      fs.writeFileSync(path.join(botDir, safeName), content ?? '');
    }

    const meta = { type: botType, env: {} };
    if (token) meta.env.DISCORD_TOKEN = token;
    fs.writeFileSync(path.join(botDir, '__meta.json'), JSON.stringify(meta, null, 2));

    res.json({ ok: true, message: `Bot "${botName}" utworzony.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Wczytaj pliki bota (do edycji w panelu) ---
app.get('/api/bots/:name/files', (req, res) => {
  const name = req.params.name;
  const botDir = path.join(BOTS_DIR, name);
  if (!fs.existsSync(botDir)) return res.status(404).json({ error: 'Nie znaleziono bota' });

  const files = {};
  for (const f of fs.readdirSync(botDir)) {
    const full = path.join(botDir, f);
    if (fs.statSync(full).isFile() && f !== '__meta.json' && !f.startsWith('.')) {
      // pomijamy duże/binarne foldery jak node_modules gdyby się pojawiły
      files[f] = fs.readFileSync(full, 'utf-8');
    }
  }
  const metaPath = path.join(botDir, '__meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath)) : { type: 'node', env: {} };
  res.json({ files, type: meta.type, token: meta.env?.DISCORD_TOKEN || '' });
});

// --- Zapisz pliki bota (po edycji w panelu) ---
app.post('/api/bots/:name/files', (req, res) => {
  const name = req.params.name;
  const botDir = path.join(BOTS_DIR, name);
  if (!fs.existsSync(botDir)) return res.status(404).json({ error: 'Nie znaleziono bota' });

  const files = req.body.files || {};
  for (const [filename, content] of Object.entries(files)) {
    const safeName = path.basename(filename);
    fs.writeFileSync(path.join(botDir, safeName), content ?? '');
  }

  if (req.body.token !== undefined) {
    const metaPath = path.join(botDir, '__meta.json');
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath)) : { type: 'node', env: {} };
    meta.env.DISCORD_TOKEN = req.body.token;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  res.json({ ok: true, message: 'Zapisano.' });
});

// --- Lista botów (z zużyciem RAM/CPU i czasem działania dla działających) ---
app.get('/api/bots', (req, res) => {
  const bots = fs.readdirSync(BOTS_DIR).filter(f => fs.statSync(path.join(BOTS_DIR, f)).isDirectory());
  const result = bots.map(name => {
    const rb = runningBots[name];
    return {
      name,
      running: !!rb,
      memMB: rb?.stats?.memMB ?? 0,
      cpu: rb?.stats?.cpu ?? 0,
      limitMB: MAX_MEMORY_MB,
      uptimeSec: rb ? Math.floor((Date.now() - rb.startedAt) / 1000) : 0,
    };
  });
  res.json(result);
});

// --- Ogólne zużycie zasobów całego dashboardu (wszystkie boty razem) ---
app.get('/api/stats', (req, res) => {
  const totalMemMB = Object.values(runningBots).reduce((sum, b) => sum + (b.stats?.memMB || 0), 0);
  const runningCount = Object.keys(runningBots).length;
  res.json({
    totalMemMB: Math.round(totalMemMB * 10) / 10,
    runningCount,
    limitPerBotMB: MAX_MEMORY_MB,
  });
});

// --- Start bota ---
app.post('/api/bots/:name/start', (req, res) => {
  const name = req.params.name;
  const botDir = path.join(BOTS_DIR, name);

  if (!fs.existsSync(botDir)) return res.status(404).json({ error: 'Nie znaleziono bota' });
  if (runningBots[name]) return res.status(400).json({ error: 'Bot już działa' });

  const metaPath = path.join(botDir, '__meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath)) : { type: 'node', env: {} };

  const logs = [];
  const pushLog = (line) => {
    logs.push(line);
    if (logs.length > 500) logs.shift(); // trzymaj tylko ostatnie 500 linii
  };

  // Najpierw instalujemy zależności, potem uruchamiamy bota
  const installCmd = meta.type === 'python'
    ? spawn('pip', ['install', '-r', 'requirements.txt'], { cwd: botDir })
    : spawn('npm', ['install'], { cwd: botDir });

  installCmd.stdout.on('data', d => pushLog(d.toString()));
  installCmd.stderr.on('data', d => pushLog(d.toString()));

  installCmd.on('close', (code) => {
    if (code !== 0) {
      pushLog(`[BŁĄD] Instalacja zależności nie powiodła się (kod ${code})`);
      return;
    }

    const runCmd = meta.type === 'python'
      ? spawn('python3', ['main.py'], { cwd: botDir, env: { ...process.env, ...meta.env } })
      : spawn('node', ['index.js'], { cwd: botDir, env: { ...process.env, ...meta.env } });

    runningBots[name] = { process: runCmd, logs, stats: { memMB: 0, cpu: 0 }, startedAt: Date.now() };

    runCmd.stdout.on('data', d => pushLog(d.toString()));
    runCmd.stderr.on('data', d => pushLog(d.toString()));
    runCmd.on('close', (code) => {
      pushLog(`[INFO] Bot zatrzymany (kod ${code})`);
      delete runningBots[name];
    });
  });

  res.json({ ok: true, message: `Uruchamianie bota "${name}"...` });
});

// --- Stop bota ---
app.post('/api/bots/:name/stop', (req, res) => {
  const name = req.params.name;
  if (!runningBots[name]) return res.status(400).json({ error: 'Bot nie działa' });

  runningBots[name].process.kill();
  delete runningBots[name];
  res.json({ ok: true, message: `Bot "${name}" zatrzymany.` });
});

// --- Logi bota ---
app.get('/api/bots/:name/logs', (req, res) => {
  const name = req.params.name;
  if (!runningBots[name]) return res.json({ logs: ['Bot nie jest uruchomiony.'] });
  res.json({ logs: runningBots[name].logs });
});

// --- Wyślij komendę do konsoli bota (stdin działającego procesu) ---
app.post('/api/bots/:name/console', (req, res) => {
  const name = req.params.name;
  const command = req.body.command || '';
  const bot = runningBots[name];

  if (!bot) return res.status(400).json({ error: 'Bot nie działa' });

  try {
    bot.logs.push(`> ${command}`);
    bot.process.stdin.write(command + '\n');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Nie udało się wysłać komendy: ' + err.message });
  }
});

// --- Usuń bota ---
app.delete('/api/bots/:name', (req, res) => {
  const name = req.params.name;
  if (runningBots[name]) {
    runningBots[name].process.kill();
    delete runningBots[name];
  }
  const botDir = path.join(BOTS_DIR, name);
  if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
  res.json({ ok: true });
});

// --- Strona główna (panel) — HTML wbudowany bezpośrednio w ten plik, ---
// --- żeby nie trzeba było wgrywać osobnego folderu na GitHub ---
app.get('/', (req, res) => {
  res.send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<title>Hosting Botów Kolopy</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/dracula.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/python/python.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js"></script>
<style>
  :root {
    --bg: #0d0d13; --panel: #16161f; --panel2: #1c1c28; --border: #2a2a3a;
    --accent: #7c5cff; --accent2: #9d84ff; --green: #34d17c; --red: #ff5c5c; --text: #e8e8f0; --muted: #8a8a9c;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; }
  header { padding: 22px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 20px; margin: 0; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 24px 60px; }

  .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .tab-btn { background: var(--panel); border: 1px solid var(--border); color: var(--muted); padding: 10px 18px; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 14px; }
  .tab-btn.active { background: var(--panel2); color: var(--text); border-bottom: 2px solid var(--accent); }

  .card { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .card h3 { margin-top: 0; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 14px 0 4px; }
  input, select { width: 100%; padding: 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 8px; font-size: 14px; }
  input:focus, select:focus { outline: none; border-color: var(--accent); }

  .btn { background: var(--accent); color: white; border: none; padding: 10px 18px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn:hover { background: var(--accent2); }
  .btn.secondary { background: var(--panel); border: 1px solid var(--border); color: var(--text); }
  .btn.stop { background: var(--red); }
  .btn.ghost { background: transparent; border: 1px solid var(--border); color: var(--muted); }
  .btn-row { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }

  .file-tabs { display: flex; gap: 4px; margin: 16px 0 0; flex-wrap: wrap; }
  .file-tab { background: var(--panel); border: 1px solid var(--border); padding: 6px 12px; border-radius: 6px 6px 0 0; font-size: 13px; cursor: pointer; color: var(--muted); }
  .file-tab.active { background: #000; color: var(--accent2); border-bottom: 1px solid #000; }
  .CodeMirror { height: 320px; border: 1px solid var(--border); border-radius: 0 8px 8px 8px; font-size: 13px; }

  .bot-row { display: flex; justify-content: space-between; align-items: center; padding: 14px 4px; border-bottom: 1px solid var(--border); }
  .bot-row:last-child { border-bottom: none; }
  .bot-name { font-weight: 600; margin-right: 10px; }
  .status { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .status.on { background: #163d29; color: var(--green); }
  .status.off { background: #3d1a1a; color: var(--red); }

  .ram-bar-wrap { width: 140px; height: 8px; background: var(--panel); border-radius: 4px; overflow: hidden; margin-top: 6px; }
  .ram-bar { height: 100%; background: var(--green); border-radius: 4px; transition: width 0.4s; }
  .ram-bar.warn { background: #e0a83a; }
  .ram-bar.danger { background: var(--red); }
  .ram-text { font-size: 11px; color: var(--muted); margin-top: 3px; }
  .server-stats { display: flex; gap: 24px; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  .server-stats b { color: var(--text); }

  pre#logsBox { background: #000; padding: 14px; border-radius: 8px; max-height: 320px; overflow-y: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg { font-size: 13px; margin-top: 10px; color: var(--accent2); }
  .hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .console-input-row { display: flex; gap: 8px; margin-top: 12px; }
  .console-input-row input { font-family: monospace; }
  .empty { color: var(--muted); font-size: 14px; padding: 10px 0; }
</style>
</head>
<body>

<header>
  <span style="font-size:22px">😏</span>
  <h1>Kolopa Hosting Botów XD</h1>
</header>

<div class="wrap">

  <div class="tabs">
    <button class="tab-btn active" data-tab="tab-editor" onclick="switchTab('tab-editor')">✏️ Napisz kod bota</button>
    <button class="tab-btn" data-tab="tab-list" onclick="switchTab('tab-list')">📦 Twoje boty</button>
  </div>

  <!-- ZAKŁADKA: EDYTOR KODU -->
  <div id="tab-editor" class="tab-content">
    <div class="card">
      <h3 id="editorTitle">Nowy bot</h3>

      <label>Nazwa bota</label>
      <input id="botName" placeholder="np. bot">

      <label>Typ bota</label>
      <select id="botType" onchange="switchLanguage()">
        <option value="node">Node.js (discord.js)</option>
        <option value="python">Python (discord.py)</option>
      </select>

      <label>Token bota Discord</label>
      <input id="botToken" type="password" placeholder="wklej token z Discord Developer Portal">
      <div class="hint">Token trzymamy osobno od kodu — nie musisz go wklejać wewnątrz pliku.</div>

      <label style="margin-top:20px">Kod bota</label>
      <div class="file-tabs" id="fileTabs"></div>
      <div id="editorHost"></div>

      <div class="btn-row">
        <button class="btn" id="saveBtn" onclick="createBot()">Zapisz bota</button>
        <button class="btn secondary" id="updateBtn" style="display:none" onclick="updateBot()">Zapisz zmiany</button>
        <button class="btn ghost" onclick="resetEditor()">Wyczyść / nowy bot</button>
      </div>
      <div class="msg" id="editorMsg"></div>
    </div>
  </div>

  <!-- ZAKŁADKA: LISTA BOTÓW -->
  <div id="tab-list" class="tab-content" style="display:none">
    <div class="card">
      <div class="server-stats" id="serverStats">Ładowanie zużycia zasobów...</div>
    </div>

    <div class="card">
      <h3>Twoje boty</h3>
      <div id="botList" class="empty">Ładowanie...</div>
    </div>

    <div class="card" id="logsCard" style="display:none">
      <h3 id="logsTitle">Konsola</h3>
      <div class="server-stats" id="logsStats"></div>
      <pre id="logsBox"></pre>
      <div class="console-input-row">
        <input id="consoleInput" placeholder="Wpisz komendę i naciśnij Enter..." onkeydown="if(event.key==='Enter') sendConsoleCommand()">
        <button class="btn" onclick="sendConsoleCommand()">Wyślij</button>
      </div>
      <div class="hint">Komenda trafia na standardowe wejście (stdin) działającego bota — działa tylko, jeśli kod bota faktycznie je odczytuje.</div>
    </div>
  </div>

</div>

<script>
// --- Szablony startowego kodu ---
const TEMPLATES = {
  node: {
    'index.js': \`const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', () => {
  console.log(\\\`Zalogowano jako \\\${client.user.tag}\\\`);
});

client.on('messageCreate', (message) => {
  if (message.author.bot) return;
  if (message.content === '!cześć') {
    message.reply('Cześć! 👋');
  }
});

client.login(process.env.DISCORD_TOKEN);
\`,
    'package.json': \`{
  "name": "moj-bot",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "discord.js": "^14.14.1"
  }
}
\`
  },
  python: {
    'main.py': \`import discord
import os

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

@client.event
async def on_ready():
    print(f'Zalogowano jako {client.user}')

@client.event
async def on_message(message):
    if message.author == client.user:
        return
    if message.content == '!cześć':
        await message.channel.send('Cześć! 👋')

client.run(os.environ['DISCORD_TOKEN'])
\`,
    'requirements.txt': \`discord.py
\`
  }
};

let currentFiles = {};
let activeFile = null;
let editingBotName = null;
let cm;

function modeForFile(filename) {
  if (filename.endsWith('.py')) return 'python';
  if (filename.endsWith('.json')) return { name: 'javascript', json: true };
  return 'javascript';
}

function initEditor() {
  const host = document.getElementById('editorHost');
  host.innerHTML = '';
  const ta = document.createElement('textarea');
  host.appendChild(ta);
  cm = CodeMirror.fromTextArea(ta, { theme: 'dracula', lineNumbers: true, mode: 'javascript', tabSize: 2 });
}

function renderFileTabs() {
  const tabsEl = document.getElementById('fileTabs');
  tabsEl.innerHTML = Object.keys(currentFiles).map(name =>
    \`<div class="file-tab \${name === activeFile ? 'active' : ''}" onclick="selectFile('\${name}')">\${name}</div>\`
  ).join('');
}

function selectFile(name) {
  if (activeFile) currentFiles[activeFile] = cm.getValue();
  activeFile = name;
  cm.setOption('mode', modeForFile(name));
  cm.setValue(currentFiles[name] || '');
  renderFileTabs();
}

function switchLanguage() {
  const type = document.getElementById('botType').value;
  currentFiles = { ...TEMPLATES[type] };
  activeFile = Object.keys(currentFiles)[0];
  renderFileTabs();
  cm.setOption('mode', modeForFile(activeFile));
  cm.setValue(currentFiles[activeFile]);
}

function resetEditor() {
  editingBotName = null;
  document.getElementById('editorTitle').textContent = 'Nowy bot';
  document.getElementById('botName').value = '';
  document.getElementById('botName').disabled = false;
  document.getElementById('botToken').value = '';
  document.getElementById('saveBtn').style.display = 'inline-block';
  document.getElementById('updateBtn').style.display = 'none';
  document.getElementById('editorMsg').textContent = '';
  switchLanguage();
}

function switchTab(id) {
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(id).style.display = 'block';
  document.querySelector(\`.tab-btn[data-tab="\${id}"]\`).classList.add('active');
  if (id === 'tab-list') loadBots();
}

async function createBot() {
  if (activeFile) currentFiles[activeFile] = cm.getValue();
  const name = document.getElementById('botName').value.trim();
  const type = document.getElementById('botType').value;
  const token = document.getElementById('botToken').value;
  const msg = document.getElementById('editorMsg');

  if (!name) { msg.textContent = '⚠️ Podaj nazwę bota.'; return; }

  msg.textContent = 'Zapisywanie...';
  const res = await fetch('/api/bots/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, token, files: currentFiles })
  });
  const data = await res.json();
  if (data.ok) {
    msg.textContent = '✅ ' + data.message + ' Przejdź do zakładki „Twoje boty", żeby go uruchomić.';
  } else {
    msg.textContent = '⚠️ ' + data.error;
  }
}

async function editBot(name) {
  switchTab('tab-editor');
  const res = await fetch(\`/api/bots/\${name}/files\`);
  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  editingBotName = name;
  currentFiles = data.files;
  activeFile = Object.keys(currentFiles)[0];

  document.getElementById('editorTitle').textContent = 'Edytujesz: ' + name;
  document.getElementById('botName').value = name;
  document.getElementById('botName').disabled = true;
  document.getElementById('botType').value = data.type;
  document.getElementById('botToken').value = data.token || '';
  document.getElementById('saveBtn').style.display = 'none';
  document.getElementById('updateBtn').style.display = 'inline-block';
  document.getElementById('editorMsg').textContent = '';

  renderFileTabs();
  cm.setOption('mode', modeForFile(activeFile));
  cm.setValue(currentFiles[activeFile] || '');
}

async function updateBot() {
  if (activeFile) currentFiles[activeFile] = cm.getValue();
  const token = document.getElementById('botToken').value;
  const msg = document.getElementById('editorMsg');

  msg.textContent = 'Zapisywanie...';
  const res = await fetch(\`/api/bots/\${editingBotName}/files\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: currentFiles, token })
  });
  const data = await res.json();
  msg.textContent = data.ok ? '✅ Zapisano zmiany. Zrestartuj bota (Stop, potem Start), żeby zaczęły działać.' : '⚠️ ' + data.error;
}

// --- Lista botów ---
async function loadBots() {
  const [botsRes, statsRes] = await Promise.all([fetch('/api/bots'), fetch('/api/stats')]);
  const bots = await botsRes.json();
  const stats = await statsRes.json();

  document.getElementById('serverStats').innerHTML = \`
    <span>Uruchomione boty: <b>\${stats.runningCount}</b></span>
    <span>Łączne zużycie RAM: <b>\${stats.totalMemMB} MB</b></span>
    <span>Limit na bota: <b>\${stats.limitPerBotMB} MB</b></span>
  \`;

  const list = document.getElementById('botList');
  if (bots.length === 0) {
    list.innerHTML = '<div class="empty">Brak botów. Przejdź do zakładki „Napisz kod bota", żeby dodać pierwszego.</div>';
    return;
  }
  list.innerHTML = bots.map(b => {
    const pct = Math.min(100, Math.round((b.memMB / b.limitMB) * 100));
    const barClass = pct > 90 ? 'danger' : (pct > 65 ? 'warn' : '');
    return \`
    <div class="bot-row">
      <div>
        <span class="bot-name">\${b.name}</span><span class="status \${b.running ? 'on' : 'off'}">\${b.running ? '● Działa' : '○ Zatrzymany'}</span>
        \${b.running ? \`
          <div class="ram-bar-wrap"><div class="ram-bar \${barClass}" style="width:\${pct}%"></div></div>
          <div class="ram-text">\${b.memMB} MB / \${b.limitMB} MB RAM &nbsp;·&nbsp; \${b.cpu}% CPU</div>
        \` : ''}
      </div>
      <div class="btn-row" style="margin:0">
        \${b.running
          ? \`<button class="btn stop" onclick="stopBot('\${b.name}')">Stop</button>\`
          : \`<button class="btn" onclick="startBot('\${b.name}')">Start</button>\`}
        <button class="btn secondary" onclick="editBot('\${b.name}')">Edytuj kod</button>
        <button class="btn ghost" onclick="showLogs('\${b.name}')">Konsola</button>
        <button class="btn ghost" onclick="deleteBot('\${b.name}')">Usuń</button>
      </div>
    </div>
  \`;
  }).join('');
}

async function startBot(name) {
  await fetch(\`/api/bots/\${name}/start\`, { method: 'POST' });
  setTimeout(loadBots, 1000);
}
async function stopBot(name) {
  await fetch(\`/api/bots/\${name}/stop\`, { method: 'POST' });
  loadBots();
}
async function deleteBot(name) {
  if (!confirm(\`Na pewno usunąć bota "\${name}"?\`)) return;
  await fetch(\`/api/bots/\${name}\`, { method: 'DELETE' });
  loadBots();
}

let logsInterval;
let currentConsoleBot = null;

function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return \`\${h}h \${m}m \${s}s\`;
  if (m > 0) return \`\${m}m \${s}s\`;
  return \`\${s}s\`;
}

async function showLogs(name) {
  currentConsoleBot = name;
  document.getElementById('logsCard').style.display = 'block';
  document.getElementById('logsTitle').textContent = 'Konsola: ' + name;
  clearInterval(logsInterval);
  const update = async () => {
    const [logsRes, botsRes] = await Promise.all([
      fetch(\`/api/bots/\${name}/logs\`),
      fetch('/api/bots')
    ]);
    const data = await logsRes.json();
    const bots = await botsRes.json();
    const info = bots.find(b => b.name === name);

    const box = document.getElementById('logsBox');
    box.textContent = data.logs.join('\\n');
    box.scrollTop = box.scrollHeight;

    const statsEl = document.getElementById('logsStats');
    if (info && info.running) {
      statsEl.innerHTML = \`
        <span>Status: <b style="color:var(--green)">● Działa</b></span>
        <span>Czas działania: <b>\${formatUptime(info.uptimeSec)}</b></span>
        <span>RAM: <b>\${info.memMB} / \${info.limitMB} MB</b></span>
        <span>CPU: <b>\${info.cpu}%</b></span>
      \`;
    } else {
      statsEl.innerHTML = \`<span>Status: <b style="color:var(--red)">○ Zatrzymany</b></span>\`;
    }
  };
  update();
  logsInterval = setInterval(update, 2000);
}

async function sendConsoleCommand() {
  const input = document.getElementById('consoleInput');
  const command = input.value.trim();
  if (!command || !currentConsoleBot) return;
  input.value = '';
  await fetch(\`/api/bots/\${currentConsoleBot}/console\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command })
  });
}

// --- Start ---
initEditor();
resetEditor();
loadBots();
setInterval(() => { if (document.getElementById('tab-list').style.display !== 'none') loadBots(); }, 3000);
</script>

</body>
</html>`;

app.listen(PORT, () => {
  console.log(`Dashboard działa na porcie ${PORT}`);
});
