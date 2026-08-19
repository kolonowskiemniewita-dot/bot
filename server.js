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

// Trzymamy tu uruchomione procesy botów: { nazwaBota: { process, logs: [], stats: { memMB, cpu } } }
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

// --- Lista botów (z zużyciem RAM/CPU dla działających) ---
app.get('/api/bots', (req, res) => {
  const bots = fs.readdirSync(BOTS_DIR).filter(f => fs.statSync(path.join(BOTS_DIR, f)).isDirectory());
  const result = bots.map(name => ({
    name,
    running: !!runningBots[name],
    memMB: runningBots[name]?.stats?.memMB ?? 0,
    cpu: runningBots[name]?.stats?.cpu ?? 0,
    limitMB: MAX_MEMORY_MB,
  }));
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

    runningBots[name] = { process: runCmd, logs, stats: { memMB: 0, cpu: 0 } };

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

// --- Strona główna (panel) ---
app.get('/', (req, res) => {
  res.send(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8'));
});

app.listen(PORT, () => {
  console.log(`Dashboard działa na porcie ${PORT}`);
});
