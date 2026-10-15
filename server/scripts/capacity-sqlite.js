#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

const USER_COUNT = 100;
const BOOKINGS_PER_USER = 100;
const CONCURRENT_WRITES = 100;

if (!isMainThread) {
  const db = new Database(workerData.dbPath, { timeout: 5000 });
  db.pragma('busy_timeout = 5000');
  const insert = db.prepare(
    `INSERT INTO bookings (room_id, user_id, title, start_time, end_time, status)
     VALUES (1, ?, ?, datetime('now', ?), datetime('now', ?), 'confirmed')`
  );
  for (let index = workerData.start; index < workerData.end; index += 1) {
    insert.run(
      (index % USER_COUNT) + 1,
      `Concurrent ${index}`,
      `+${index + 1} minutes`,
      `+${index + 31} minutes`,
    );
  }
  db.close();
  parentPort.postMessage({ ok: true });
} else {
  const started = Date.now();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resy-capacity-'));
  const dbPath = path.join(tempDir, 'capacity.db');
  const schemaPath = path.join(__dirname, '..', 'src', 'config', 'schema-sqlite.sql');
  const db = new Database(dbPath, { timeout: 5000 });
  try {
    db.exec(fs.readFileSync(schemaPath, 'utf8'));
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.prepare("INSERT INTO rooms (name, building, floor, capacity) VALUES ('Capacity Room', 'Test', 1, 20)").run();
    const insertUser = db.prepare('INSERT INTO users (email, name) VALUES (?, ?)');
    const insertBooking = db.prepare(
      `INSERT INTO bookings (room_id, user_id, title, start_time, end_time, status)
       VALUES (1, ?, ?, datetime('now', ?), datetime(datetime('now', ?), '+1 hour'), 'confirmed')`
    );
    db.transaction(() => {
      for (let index = 0; index < USER_COUNT; index += 1) {
        insertUser.run(`capacity-${index}@example.test`, `Capacity User ${index}`);
      }
      for (let userId = 1; userId <= USER_COUNT; userId += 1) {
        for (let bookingIndex = 0; bookingIndex < BOOKINGS_PER_USER; bookingIndex += 1) {
          const modifier = `${bookingIndex - 50 >= 0 ? '+' : ''}${bookingIndex - 50} days`;
          insertBooking.run(userId, `Capacity booking ${bookingIndex}`, modifier, modifier);
        }
      }
    })();
    db.close();

    const workerCount = 20;
    const perWorker = CONCURRENT_WRITES / workerCount;
    const workers = Array.from({ length: workerCount }, (_, workerIndex) => new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { dbPath, start: workerIndex * perWorker, end: (workerIndex + 1) * perWorker },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exited with ${code}`)); });
    }));

    Promise.all(workers).then(() => {
      const verify = new Database(dbPath, { readonly: true });
      const users = verify.prepare('SELECT COUNT(*) AS count FROM users').get().count;
      const bookings = verify.prepare('SELECT COUNT(*) AS count FROM bookings').get().count;
      const integrity = verify.pragma('integrity_check', { simple: true });
      verify.close();
      const expected = USER_COUNT * BOOKINGS_PER_USER + CONCURRENT_WRITES;
      if (users !== USER_COUNT || bookings !== expected || integrity !== 'ok') {
        throw new Error(`users=${users} bookings=${bookings}/${expected} integrity=${integrity}`);
      }
      console.log(`[OK] users=${users} bookings=${bookings} concurrent_writes=${CONCURRENT_WRITES} integrity=${integrity} elapsed=${((Date.now() - started) / 1000).toFixed(2)}s`);
    }).catch(error => {
      console.error(`[FAIL] ${error.message}`);
      process.exitCode = 1;
    }).finally(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  } catch (error) {
    try { db.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(`[FAIL] ${error.message}`);
    process.exitCode = 1;
  }
}
