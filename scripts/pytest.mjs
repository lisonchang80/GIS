// npm run test:server：用後端的 venv 跑 pytest（server/tests，暫存 SQLite、不連外網）。
// Python 尋找順序：環境變數 PYTHON → server/.venv（Windows／Linux）→ PATH 上的 python。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = ['server/.venv/Scripts/python.exe', 'server/.venv/bin/python'].map((p) => join(ROOT, p));
const python = process.env.PYTHON || candidates.find((p) => existsSync(p)) || 'python';

const r = spawnSync(python, ['-m', 'pytest', 'server/tests', '-q', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (r.error) {
  console.error(`無法執行 ${python}：${r.error.message}（可用環境變數 PYTHON 指定）`);
  process.exit(1);
}
process.exit(r.status ?? 1);
