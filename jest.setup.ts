import '@testing-library/jest-dom';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const testDbPath = path.join(__dirname, '.tmp', `jest-${process.env.JEST_WORKER_ID || '1'}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch {}
}
process.env.DB_PATH = testDbPath;

// src/lib/db.ts 는 worker 번들 회피용으로 (0,eval)('require') 로 './sqlite'·'./postgres'
// 를 지연 로드한다. jsdom 전역에는 require 가 없으므로 src/lib 기준 require 를 주입한다.
if (typeof (globalThis as { require?: unknown }).require === 'undefined') {
  (globalThis as { require?: unknown }).require = createRequire(
    path.join(__dirname, 'src/lib/db.ts'),
  );
}
