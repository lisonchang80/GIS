// 端對端重現：前端自動存檔會不會把雲端專案覆蓋掉（Playwright 驅動真實前端）。
//
//   node scripts/e2e/autosave.mjs            # 跑全部情境
//   node scripts/e2e/autosave.mjs switch     # 只跑某一個：load / switch / map
//
// 腳本自己起「隔離後端」（暫存 SQLite、GIS_DEV_LOGIN=1、隨機 port）與 vite dev server
// （/api proxy 指向隔離後端），不碰正式站 :8000、server/gis.db、dist/。外部底圖一律攔截
// 成本機假圖磚，不連外網。需要：server/.venv（或環境變數 PYTHON）＋ Playwright
// （`npm i -D playwright && npx playwright install chromium`，本 repo 不內建）。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
// 1x1 透明 PNG，代替外部底圖圖磚
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function pythonExe() {
  if (process.env.PYTHON) return process.env.PYTHON;
  for (const p of ['server/.venv/Scripts/python.exe', 'server/.venv/bin/python']) {
    if (existsSync(join(ROOT, p))) return join(ROOT, p);
  }
  return 'python';
}

const LAUNCHER = `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from server import db
db.DB_PATH = Path(sys.argv[2])
import uvicorn
uvicorn.run("server.main:app", host="127.0.0.1", port=int(sys.argv[3]), log_level="warning")
`;

async function startStack() {
  const tmp = mkdtempSync(join(tmpdir(), 'gis-e2e-'));
  const apiPort = await freePort();
  const backend = spawn(pythonExe(), ['-c', LAUNCHER, ROOT, join(tmp, 'gis.db'), String(apiPort)], {
    env: { ...process.env, GIS_DEV_LOGIN: '1', GIS_COOKIE_SECURE: '0' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/api/me`)).status === 401) break;
    } catch {
      /* backend still starting */
    }
    await sleep(200);
  }
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.ts'),
    root: ROOT,
    logLevel: 'error',
    server: {
      port: await freePort(),
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
    },
  });
  await vite.listen();
  const app = `http://127.0.0.1:${vite.config.server.port}`;
  return {
    app,
    async stop() {
      await vite.close();
      backend.kill();
      await sleep(300);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function layer(name) {
  return {
    id: `l-${name}`,
    name,
    visible: true,
    opacity: 0.85,
    color: '#ef4444',
    kind: 'point',
    featureCount: 1,
    data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [120.2, 23.0] }, properties: { 名稱: name } }],
    },
  };
}

function project(name) {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    basemapId: 'osm',
    projectName: name,
    layers: [layer(`${name}-layer`)],
    drawings: [
      {
        id: 'd1b2c3d4-0000-4000-8000-000000000001',
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [120.21, 23.01] },
        properties: { mode: 'point' },
      },
    ],
    mapView: { center: [120.2, 23.0], zoom: 12 },
  };
}

async function api(ctx, method, path, data) {
  const r = await ctx.request.fetch(`${ctx.app}${path}`, { method, data });
  if (r.status() === 204) return null;
  return r.json();
}

async function newContext(browser, app, { tiles = 'stub' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  ctx.app = app;
  await ctx.request.post(`${app}/api/auth/dev-login`);
  await ctx.addInitScript(() => localStorage.setItem('wt-seen:gis:v1', '1')); // 不自動播導覽
  await ctx.route((url) => url.hostname !== '127.0.0.1', (route) => {
    if (tiles === 'hang') return; // 不回應：模擬掛住的圖磚伺服器
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  return ctx;
}

async function newProject(ctx, name) {
  const { id } = await api(ctx, 'POST', '/api/projects', { name });
  await api(ctx, 'PUT', `/api/projects/${id}`, project(name));
  return id;
}

async function summary(ctx, id) {
  const p = await api(ctx, 'GET', `/api/projects/${id}`);
  if (!p) return 'EMPTY';
  return `name=${p.projectName} layers=[${p.layers.map((l) => l.name)}] drawings=${(p.drawings || []).length} mapView=${p.mapView ? 'yes' : 'no'}`;
}

const openAt = (ctx, id) => ctx.addInitScript((pid) => localStorage.setItem('gis-current-project-id', String(pid)), id);

// [load] 開頁時載入專案遇到暫時性錯誤（例如 tunnel 502）→ 不可把雲端專案存成空白
async function scenarioLoad(browser, app) {
  const ctx = await newContext(browser, app);
  const id = await newProject(ctx, `A-${RUN}`);
  await openAt(ctx, id);
  let failures = 0;
  await ctx.route(new RegExp(`/api/projects/${id}$`), (route) => {
    // dev 的 StrictMode 會把載入 effect 跑兩次；兩次都失敗才等同正式站的一次失敗
    if (route.request().method() === 'GET' && failures < 2) {
      failures += 1;
      return route.fulfill({ status: 502, body: 'Bad Gateway' });
    }
    return route.continue();
  });
  const before = await summary(ctx, id);
  const page = await ctx.newPage();
  await page.goto(app);
  await sleep(3000);
  const after = await summary(ctx, id);
  const toast = (await page.locator('.toast.error').allTextContents()).join(' ');
  console.log('[load] 載入 502 後', { before, after, toast });
  await ctx.close();
  return before === after && toast !== '';
}

// [switch] 切到 B 時 B 載入較慢 → 不可把 A 的內容存進 B
async function scenarioSwitch(browser, app) {
  const ctx = await newContext(browser, app);
  const nameA = `A-${RUN}`;
  const nameB = `B-${RUN}`;
  const a = await newProject(ctx, nameA);
  const b = await newProject(ctx, nameB);
  await openAt(ctx, a);
  const page = await ctx.newPage();
  await page.goto(app);
  await page.waitForSelector('.project-pick-btn');
  await sleep(1500);
  await ctx.route(new RegExp(`/api/projects/${b}$`), async (route) => {
    if (route.request().method() === 'GET') await sleep(2500);
    return route.continue();
  });
  const putB = page
    .waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/api/projects/${b}`), { timeout: 2400 })
    .catch(() => null);
  await page.click('.project-pick-btn');
  await page.locator('.project-option', { hasText: nameB }).click();
  const req = await putB;
  let during = 'B 載入完成前沒有任何 PUT B';
  let ui = '(切換中途關閉分頁)';
  if (req) {
    const body = JSON.parse(req.postData());
    during = `載入中就 PUT B，內容=${body.projectName}`;
    await sleep(300);
  } else {
    // 沒誤存：確認切換本身仍正常（畫面最後顯示 B 與 B 的圖層）
    await page
      .waitForFunction((n) => document.querySelector('.project-pick-name')?.textContent === n, nameB, { timeout: 8000 })
      .catch(() => {});
    ui = `${await page.locator('.project-pick-name').textContent()} / B 圖層=${(await page.getByText(`${nameB}-layer`).count()) > 0}`;
  }
  await page.close(); // 使用者這時關掉分頁
  await sleep(500);
  const after = await summary(ctx, b);
  console.log('[switch] 切換專案', { during, ui, after });
  await ctx.close();
  return after.startsWith(`name=${nameB} layers=[${nameB}-layer]`) && ui === `${nameB} / B 圖層=true`;
}

// [map] 底圖圖磚掛住、maplibre 一直沒觸發 load → 不可把繪圖與視角存成空的
async function scenarioMap(browser, app) {
  const ctx = await newContext(browser, app, { tiles: 'hang' });
  const id = await newProject(ctx, `D-${RUN}`);
  await openAt(ctx, id);
  const before = await summary(ctx, id);
  const page = await ctx.newPage();
  await page.goto(app);
  await sleep(3000);
  const after = await summary(ctx, id);
  console.log('[map] 地圖未 load 時自動存檔', { before, after });
  await ctx.close();
  return before === after;
}

const SCENARIOS = { load: scenarioLoad, switch: scenarioSwitch, map: scenarioMap };
const picked = process.argv.slice(2);
const stack = await startStack();
const browser = await chromium.launch();
let ok = true;
try {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (picked.length && !picked.includes(name)) continue;
    const pass = await run(browser, stack.app);
    console.log(`  => ${name}: ${pass ? 'PASS' : 'FAIL（雲端資料被覆蓋／未提示）'}`);
    ok &&= pass;
  }
} finally {
  await browser.close();
  await stack.stop();
}
process.exit(ok ? 0 : 1);
