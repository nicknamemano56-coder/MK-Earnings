const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8787);
const ADMIN_KEY = process.env.ADMIN_KEY || 'CHANGE_ME_ADMIN_KEY';
const DB_FILE = process.env.DB_FILE || './mk_earnings.sqlite';

/* =========================================================
   DATABASE
========================================================= */

const dbDir = path.dirname(DB_FILE);

if (dbDir && dbDir !== '.') {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(DB_FILE);

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  game_id TEXT PRIMARY KEY,
  mobile TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets(
  game_id TEXT PRIMARY KEY,
  mobile TEXT,
  balance REAL NOT NULL DEFAULT 0,
  wagering REAL NOT NULL DEFAULT 0,
  wagering_completed REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger(
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  balance_before REAL,
  balance_after REAL,
  wagering_before REAL,
  wagering_after REAL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_rounds(
  game_id TEXT PRIMARY KEY,
  round INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* =========================================================
   HELPERS
========================================================= */

function json(res, status, obj) {
  const out = JSON.stringify(obj);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Methods':
      'GET,POST,PUT,OPTIONS'
  });

  res.end(out);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', chunk => {
      data += chunk;
    });

    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function hashPassword(password, salt) {
  const s = salt ||
    crypto.randomBytes(16).toString('hex');

  const h = crypto.scryptSync(
    String(password),
    s,
    64
  ).toString('hex');

  return `${s}:${h}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split(':');

    if (parts.length !== 2) {
      return false;
    }

    const salt = parts[0];
    const storedHash = Buffer.from(parts[1], 'hex');

    const calculated = crypto.scryptSync(
      String(password),
      salt,
      64
    );

    return (
      storedHash.length === calculated.length &&
      crypto.timingSafeEqual(
        storedHash,
        calculated
      )
    );
  } catch {
    return false;
  }
}

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeMobile(value) {
  return String(value || '')
    .replace(/\D/g, '');
}

/* =========================================================
   AUTH
========================================================= */

function getAuthUser(req) {
  const header =
    String(req.headers.authorization || '');

  const token =
    header.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return null;
  }

  const row = db.prepare(`
    SELECT game_id
    FROM sessions
    WHERE token=?
  `).get(token);

  return row?.game_id || null;
}

function isAdmin(req) {
  return (
    String(req.headers['x-admin-key'] || '') ===
    String(ADMIN_KEY)
  );
}

/* =========================================================
   UNIQUE GAME ID
========================================================= */

function nextGameId() {
  let highest = 202600;

  const rows = db.prepare(`
    SELECT game_id
    FROM users
  `).all();

  for (const row of rows) {
    const id = String(row.game_id || '');

    if (/^2026\d+$/.test(id)) {
      highest = Math.max(
        highest,
        Number(id)
      );
    }
  }

  let next = highest + 1;

  while (
    db.prepare(`
      SELECT 1
      FROM users
      WHERE game_id=?
    `).get(String(next))
  ) {
    next++;
  }

  return String(next);
}

/* =========================================================
   WALLET
========================================================= */

function getWallet(gameId) {
  let w = db.prepare(`
    SELECT *
    FROM wallets
    WHERE game_id=?
  `).get(gameId);

  if (!w) {
    const user = db.prepare(`
      SELECT mobile
      FROM users
      WHERE game_id=?
    `).get(gameId);

    const now = Date.now();

    db.prepare(`
      INSERT INTO wallets(
        game_id,
        mobile,
        balance,
        wagering,
        wagering_completed,
        updated_at
      )
      VALUES(?,?,?,?,?,?)
    `).run(
      gameId,
      user?.mobile || '',
      0,
      0,
      0,
      now
    );

    w = db.prepare(`
      SELECT *
      FROM wallets
      WHERE game_id=?
    `).get(gameId);
  }

  return w;
}

function recordLedger(gameId, data) {
  db.prepare(`
    INSERT INTO ledger(
      id,
      game_id,
      type,
      amount,
      balance_before,
      balance_after,
      wagering_before,
      wagering_after,
      meta_json,
      created_at
    )
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    data.id || crypto.randomUUID(),
    gameId,
    data.type || 'UNKNOWN',
    Number(data.amount || 0),
    data.balanceBefore ?? null,
    data.balanceAfter ?? null,
    data.wageringBefore ?? null,
    data.wageringAfter ?? null,
    JSON.stringify(data.meta || {}),
    data.timestamp || Date.now()
  );
}

/* =========================================================
   2880 RESULT SEQUENCE
========================================================= */

const SEQUENCE_KEY = 'sequence_v2880';
const SHUFFLE_KEY = 'sequence_shuffled_at';

function shuffleArray(arr) {
  for (
    let i = arr.length - 1;
    i > 0;
    i--
  ) {
    const j = Math.floor(
      Math.random() * (i + 1)
    );

    [arr[i], arr[j]] =
      [arr[j], arr[i]];
  }

  return arr;
}

function buildSequence2880() {
  const sequence = [];

  for (let i = 0; i < 1200; i++) {
    sequence.push('BIG');
  }

  for (let i = 0; i < 1200; i++) {
    sequence.push('SMALL');
  }

  for (let i = 0; i < 480; i++) {
    sequence.push('TIE');
  }

  return shuffleArray(sequence);
}

function saveSequence(sequence) {
  db.prepare(`
    INSERT OR REPLACE INTO settings(
      key,
      value
    )
    VALUES(?,?)
  `).run(
    SEQUENCE_KEY,
    JSON.stringify(sequence)
  );
}

function getSequence() {
  const row = db.prepare(`
    SELECT value
    FROM settings
    WHERE key=?
  `).get(SEQUENCE_KEY);

  if (row?.value) {
    try {
      const sequence = JSON.parse(row.value);

      if (
        Array.isArray(sequence) &&
        sequence.length === 2880
      ) {
        return sequence;
      }
    } catch {}
  }

  const sequence = buildSequence2880();

  saveSequence(sequence);

  db.prepare(`
    INSERT OR REPLACE INTO settings(
      key,
      value
    )
    VALUES(?,?)
  `).run(
    SHUFFLE_KEY,
    String(Date.now())
  );

  return sequence;
}

function autoShuffleIfNeeded() {
  const row = db.prepare(`
    SELECT value
    FROM settings
    WHERE key=?
  `).get(SHUFFLE_KEY);

  const last = Number(row?.value || 0);
  const now = Date.now();

  const DAY = 24 * 60 * 60 * 1000;

  if (!last || now - last >= DAY) {
    const sequence = buildSequence2880();

    saveSequence(sequence);

    db.prepare(`
      INSERT OR REPLACE INTO settings(
        key,
        value
      )
      VALUES(?,?)
    `).run(
      SHUFFLE_KEY,
      String(now)
    );

    return true;
  }

  return false;
}

/* =========================================================
   PLAYER ROUND
========================================================= */

function getPlayerRound(gameId) {
  const row = db.prepare(`
    SELECT round
    FROM player_rounds
    WHERE game_id=?
  `).get(gameId);

  return Number(row?.round || 1);
}

function setPlayerRound(gameId, round) {
  db.prepare(`
    INSERT OR REPLACE INTO player_rounds(
      game_id,
      round
    )
    VALUES(?,?)
  `).run(
    gameId,
    Math.max(
      1,
      Math.floor(Number(round))
    )
  );
}

function getNextResult(gameId) {
  autoShuffleIfNeeded();

  const sequence = getSequence();

  const round = getPlayerRound(gameId);

  const index =
    (round - 1) % sequence.length;

  const result =
    sequence[index] || 'SMALL';

  setPlayerRound(
    gameId,
    round + 1
  );

  return {
    result,
    round,
    index
  };
}

/* =========================================================
   STATE
========================================================= */

function getState(gameId) {
  const w = getWallet(gameId);

  const ledger = db.prepare(`
    SELECT *
    FROM ledger
    WHERE game_id=?
    ORDER BY created_at DESC
  `).all(gameId).map(row => ({
    id: row.id,
    type: row.type,
    amount: row.amount,
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    wageringBefore: row.wagering_before,
    wageringAfter: row.wagering_after,
    timestamp: row.created_at,
    meta: JSON.parse(
      row.meta_json || '{}'
    )
  }));

  const user = db.prepare(`
    SELECT
      game_id AS gameId,
      mobile,
      created_at AS createdAt
    FROM users
    WHERE game_id=?
  `).get(gameId);

  return {
    user,
    wallet: getWallet(gameId),
    ledger,
    round: getPlayerRound(gameId),
    sequence: getSequence()
  };
}

/* =========================================================
   SERVER
========================================================= */

const server = http.createServer(
  async (req, res) => {

    try {

      const url = new URL(
        req.url,
        `http://${req.headers.host || 'localhost'}`
      );

      const pathName = url.pathname;
      const method = req.method;

      /* -----------------------------------------------
         OPTIONS
      ----------------------------------------------- */

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, X-Admin-Key',
          'Access-Control-Allow-Methods':
            'GET,POST,PUT,OPTIONS'
        });

        res.end();
        return;
      }

      /* -----------------------------------------------
         HEALTH
      ----------------------------------------------- */

      if (
        pathName === '/api/health' &&
        method === 'GET'
      ) {
        return json(res, 200, {
          ok: true,
          service: 'MK Earnings Demo Backend',
          time: new Date().toISOString(),
          node: process.version,
          sequence: 2880,
          intervalSeconds: 30
        });
      }

      /* -----------------------------------------------
         REGISTER
      ----------------------------------------------- */

      if (
        pathName === '/api/register' &&
        method === 'POST'
      ) {

        const b = await readBody(req);

        const mobile =
          normalizeMobile(b.mobile);

        const password =
          String(b.password || '');

        if (!/^\d{10}$/.test(mobile)) {
          return json(res, 400, {
            error:
              'Enter valid 10 digit mobile number'
          });
        }

        if (password.length < 4) {
          return json(res, 400, {
            error:
              'Password must contain at least 4 characters'
          });
        }

        const exists = db.prepare(`
          SELECT game_id
          FROM users
          WHERE mobile=?
        `).get(mobile);

        if (exists) {
          return json(res, 409, {
            error: 'Mobile number already registered',
            gameId: exists.game_id
          });
        }

        const gameId = nextGameId();
        const now = Date.now();

        db.prepare(`
          INSERT INTO users(
            game_id,
            mobile,
            password_hash,
            created_at
          )
          VALUES(?,?,?,?)
        `).run(
          gameId,
          mobile,
          hashPassword(password),
          now
        );

        db.prepare(`
          INSERT INTO wallets(
            game_id,
            mobile,
            balance,
            wagering,
            wagering_completed,
            updated_at
          )
          VALUES(?,?,?,?,?,?)
        `).run(
          gameId,
          mobile,
          0,
          0,
          0,
          now
        );

        db.prepare(`
          INSERT INTO player_rounds(
            game_id,
            round
          )
          VALUES(?,?)
        `).run(
          gameId,
          1
        );

        return json(res, 200, {
          ok: true,
          gameId,
          mobile
        });
      }

      /* -----------------------------------------------
         LOGIN
      ----------------------------------------------- */

      if (
        pathName === '/api/login' &&
        method === 'POST'
      ) {

        const b = await readBody(req);

        const mobile =
          normalizeMobile(b.mobile);

        const password =
          String(b.password || '');

        const user = db.prepare(`
          SELECT *
          FROM users
          WHERE mobile=?
        `).get(mobile);

        if (
          !user ||
          !verifyPassword(
            password,
            user.password_hash
          )
        ) {
          return json(res, 401, {
            error:
              'Invalid mobile number or password'
          });
        }

        const sessionToken =
          createToken();

        db.prepare(`
          INSERT INTO sessions(
            token,
            game_id,
            created_at
          )
          VALUES(?,?,?)
        `).run(
          sessionToken,
          user.game_id,
          Date.now()
        );

        return json(res, 200, {
          ok: true,
          token: sessionToken,
          gameId: user.game_id,
          state: getState(user.game_id)
        });
      }

      /* -----------------------------------------------
         STATE
      ----------------------------------------------- */

      if (
        pathName === '/api/state' &&
        method === 'GET'
      ) {

        const gameId =
          getAuthUser(req);

        if (!gameId) {
          return json(res, 401, {
            error: 'Login required'
          });
        }

        return json(
          res,
          200,
          {
            ok: true,
            ...getState(gameId)
          }
        );
      }

      /* -----------------------------------------------
         SPIN
         WAGERING DOES NOT BLOCK SPIN
      ----------------------------------------------- */

      if (
        pathName === '/api/spin' &&
        method === 'POST'
      ) {

        const gameId =
          getAuthUser(req);

        if (!gameId) {
          return json(res, 401, {
            error: 'Login required'
          });
        }

        const b = await readBody(req);

        const choice =
          String(
            b.choice || ''
          ).toUpperCase();

        const amount =
          Number(b.amount);

        if (
          ![
            'BIG',
            'SMALL',
            'TIE'
          ].includes(choice)
        ) {
          return json(res, 400, {
            error: 'Invalid choice'
          });
        }

        if (
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          return json(res, 400, {
            error: 'Invalid bet amount'
          });
        }

        const w =
          getWallet(gameId);

        /* ONLY BALANCE CHECK */

        if (
          Number(w.balance) < amount
        ) {
          return json(res, 400, {
            error:
              `Insufficient virtual balance. Available: ₹${Number(
                w.balance
              ).toFixed(2)}`
          });
        }

        const next =
          getNextResult(gameId);

        const result =
          next.result;

        const balanceBefore =
          Number(w.balance);

        const wageringBefore =
          Number(w.wagering);

        const newBalance =
          Number(
            (
              balanceBefore -
              amount
            ).toFixed(2)
          );

        const newWagering =
          Number(
            Math.max(
              0,
              wageringBefore -
              amount
            ).toFixed(2)
          );

        db.prepare(`
          UPDATE wallets
          SET
            balance=?,
            wagering=?,
            wagering_completed=
              wagering_completed+?,
            updated_at=?
          WHERE game_id=?
        `).run(
          newBalance,
          newWagering,
          amount,
          Date.now(),
          gameId
        );

        recordLedger(gameId, {
          id:
            'BET-' +
            crypto.randomUUID(),

          type: 'BET',

          amount: -amount,

          balanceBefore,

          balanceAfter:
            newBalance,

          wageringBefore,

          wageringAfter:
            newWagering,

          timestamp:
            Date.now(),

          meta: {
            choice,
            result,
            betAmount: amount,
            round: next.round,
            name: b.name || '',
            player: b.player || ''
          }
        });

        const win =
          result === choice;

        let payout = 0;

        let multiplier = 0;

        if (win) {

          multiplier =
            choice === 'TIE'
              ? 9
              : 1.9;

          payout =
            Number(
              (
                amount *
                multiplier
              ).toFixed(2)
            );

          const current =
            getWallet(gameId);

          const payoutBalance =
            Number(
              (
                Number(current.balance) +
                payout
              ).toFixed(2)
            );

          db.prepare(`
            UPDATE wallets
            SET
              balance=?,
              updated_at=?
            WHERE game_id=?
          `).run(
            payoutBalance,
            Date.now(),
            gameId
          );

          recordLedger(gameId, {
            id:
              'WIN-' +
              crypto.randomUUID(),

            type: 'WIN',

            amount: payout,

            balanceBefore:
              current.balance,

            balanceAfter:
              payoutBalance,

            wageringBefore:
              current.wagering,

            wageringAfter:
              current.wagering,

            timestamp:
              Date.now(),

            meta: {
              choice,
              result,
              multiplier,
              betAmount: amount,
              payout,
              round: next.round
            }
          });
        }

        const finalWallet =
          getWallet(gameId);

        return json(res, 200, {
          ok: true,
          win,
          result,
          choice,
          amount,
          payout,
          multiplier,
          round: next.round,

          wallet: {
            balance:
              finalWallet.balance,

            wagering:
              finalWallet.wagering,

            wageringCompleted:
              finalWallet.wagering_completed
          }
        });
      }

      /* -----------------------------------------------
         WITHDRAW
         WAGERING LOCK ONLY
      ----------------------------------------------- */

      if (
        pathName === '/api/withdraw' &&
        method === 'POST'
      ) {

        const gameId =
          getAuthUser(req);

        if (!gameId) {
          return json(res, 401, {
            error: 'Login required'
          });
        }

        const b =
          await readBody(req);

        const amount =
          Number(b.amount);

        if (
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          return json(res, 400, {
            error:
              'Invalid withdrawal amount'
          });
        }

        const w =
          getWallet(gameId);

        if (
          Number(w.wagering) > 0
        ) {
          return json(res, 400, {
            error:
              `Withdrawal locked. Wagering remaining: ₹${Number(
                w.wagering
              ).toFixed(2)}`
          });
        }

        if (
          Number(w.balance) < amount
        ) {
          return json(res, 400, {
            error:
              `Insufficient virtual balance. Available: ₹${Number(
                w.balance
              ).toFixed(2)}`
          });
        }

        const before =
          Number(w.balance);

        const after =
          Number(
            (
              before -
              amount
            ).toFixed(2)
          );

        db.prepare(`
          UPDATE wallets
          SET
            balance=?,
            updated_at=?
          WHERE game_id=?
        `).run(
          after,
          Date.now(),
          gameId
        );

        recordLedger(gameId, {
          id:
            'WITHDRAW-' +
            crypto.randomUUID(),

          type: 'WITHDRAW',

          amount: -amount,

          balanceBefore: before,

          balanceAfter: after,

          wageringBefore:
            w.wagering,

          wageringAfter:
            w.wagering,

          timestamp:
            Date.now(),

          meta: {
            upi: b.upi || '',
            name: b.name || '',
            status:
              'Demo withdrawal request'
          }
        });

        return json(res, 200, {
          ok: true,

          status:
            'Demo withdrawal request created',

          wallet: {
            balance: after,
            wagering: w.wagering
          }
        });
      }

      /* -----------------------------------------------
         ADMIN DEPOSIT
      ----------------------------------------------- */

      if (
        pathName === '/api/admin/deposit' &&
        method === 'POST'
      ) {

        if (!isAdmin(req)) {
          return json(res, 403, {
            error:
              'Admin access denied'
          });
        }

        const b =
          await readBody(req);

        const gameId =
          String(
            b.gameId || ''
          ).trim();

        const amount =
          Number(b.amount);

        if (
          !gameId ||
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          return json(res, 400, {
            error:
              'Invalid game ID or amount'
          });
        }

        const user =
          db.prepare(`
            SELECT *
            FROM users
            WHERE game_id=?
          `).get(gameId);

        if (!user) {
          return json(res, 404, {
            error: 'User not found'
          });
        }

        const w =
          getWallet(gameId);

        const beforeBalance =
          Number(w.balance);

        const beforeWagering =
          Number(w.wagering);

        const newBalance =
          Number(
            (
              beforeBalance +
              amount
            ).toFixed(2)
          );

        const newWagering =
          Number(
            (
              beforeWagering +
              amount
            ).toFixed(2)
          );

        db.prepare(`
          UPDATE wallets
          SET
            balance=?,
            wagering=?,
            updated_at=?
          WHERE game_id=?
        `).run(
          newBalance,
          newWagering,
          Date.now(),
          gameId
        );

        recordLedger(gameId, {
          id:
            'ADMIN-DEPOSIT-' +
            crypto.randomUUID(),

          type:
            'ADMIN_DEPOSIT',

          amount,

          balanceBefore:
            beforeBalance,

          balanceAfter:
            newBalance,

          wageringBefore:
            beforeWagering,

          wageringAfter:
            newWagering,

          timestamp:
            Date.now(),

          meta: {
            source: 'admin',
            status: 'Demo deposit'
          }
        });

        return json(res, 200, {
          ok: true,
          gameId,
          amount,

          wallet: {
            balance:
              newBalance,

            wagering:
              newWagering
          }
        });
      }

      /* -----------------------------------------------
         ADMIN USERS
      ----------------------------------------------- */

      if (
        pathName === '/api/admin/users' &&
        method === 'GET'
      ) {

        if (!isAdmin(req)) {
          return json(res, 403, {
            error:
              'Admin access denied'
          });
        }

        const users =
          db.prepare(`
            SELECT
              u.game_id AS gameId,
              u.mobile,
              u.created_at AS createdAt,
              w.balance,
              w.wagering,
              w.wagering_completed,
              w.updated_at AS updatedAt
            FROM users u
            LEFT JOIN wallets w
              ON w.game_id=u.game_id
            ORDER BY
              u.created_at DESC
          `).all();

        return json(res, 200, {
          ok: true,
          users
        });
      }

      /* -----------------------------------------------
         ADMIN LEDGER
      ----------------------------------------------- */

      if (
        pathName === '/api/admin/ledger' &&
        method === 'GET'
      ) {

        if (!isAdmin(req)) {
          return json(res, 403, {
            error:
              'Admin access denied'
          });
        }

        const gameId =
          String(
            url.searchParams.get(
              'gameId'
            ) || ''
          ).trim();

        let rows;

        if (gameId) {
          rows = db.prepare(`
            SELECT *
            FROM ledger
            WHERE game_id=?
            ORDER BY created_at DESC
          `).all(gameId);
        } else {
          rows = db.prepare(`
            SELECT *
            FROM ledger
            ORDER BY created_at DESC
          `).all();
        }

        const ledger =
          rows.map(row => ({
            id: row.id,
            gameId: row.game_id,
            type: row.type,
            amount: row.amount,
            balanceBefore:
              row.balance_before,
            balanceAfter:
              row.balance_after,
            wageringBefore:
              row.wagering_before,
            wageringAfter:
              row.wagering_after,
            timestamp:
              row.created_at,
            meta:
              JSON.parse(
                row.meta_json || '{}'
              )
          }));

        return json(res, 200, {
          ok: true,
          ledger
        });
      }

      /* -----------------------------------------------
         ADMIN SEQUENCE
      ----------------------------------------------- */

      if (
        pathName === '/api/admin/sequence' &&
        method === 'GET'
      ) {

        if (!isAdmin(req)) {
          return json(res, 403, {
            error:
              'Admin access denied'
          });
        }

        autoShuffleIfNeeded();

        const sequence =
          getSequence();

        const counts = {
          BIG:
            sequence.filter(
              x => x === 'BIG'
            ).length,

          SMALL:
            sequence.filter(
              x => x === 'SMALL'
            ).length,

          TIE:
            sequence.filter(
              x => x === 'TIE'
            ).length
        };

        const shuffledAt =
          Number(
            db.prepare(`
              SELECT value
              FROM settings
              WHERE key=?
            `).get(
              SHUFFLE_KEY
            )?.value || 0
          );

        return json(res, 200, {
          ok: true,
          total: sequence.length,
          counts,
          shuffledAt,
          sequence
        });
      }

      /* -----------------------------------------------
         ADMIN MANUAL SHUFFLE
      ----------------------------------------------- */

      if (
        pathName === '/api/admin/shuffle' &&
        method === 'POST'
      ) {

        if (!isAdmin(req)) {
          return json(res, 403, {
            error:
              'Admin access denied'
          });
        }

        const sequence =
          buildSequence2880();

        const now =
          Date.now();

        saveSequence(sequence);

        db.prepare(`
          INSERT OR REPLACE INTO settings(
            key,
            value
          )
          VALUES(?,?)
        `).run(
          SHUFFLE_KEY,
          String(now)
        );

        return json(res, 200, {
          ok: true,

          message:
            '2880-result sequence shuffled',

          total:
            sequence.length,

          counts: {
            BIG:
              sequence.filter(
                x => x === 'BIG'
              ).length,

            SMALL:
              sequence.filter(
                x => x === 'SMALL'
              ).length,

            TIE:
              sequence.filter(
                x => x === 'TIE'
              ).length
          },

          shuffledAt: now,
          sequence
        });
      }

      /* -----------------------------------------------
         ADMIN BACKUP
      ----------------------------------------------- */

      if (
        pathName === '/api/admin/backup' &&
        method === 'GET'
      ) {

        if (!isAdmin(req)) {
          return json(res, 403, {
            error:
              'Admin access denied'
          });
        }

        const users =
          db.prepare(`
            SELECT
              game_id,
              mobile,
              created_at
            FROM users
            ORDER BY created_at ASC
          `).all();

        const wallets =
          db.prepare(`
            SELECT *
            FROM wallets
          `).all();

        const ledger =
          db.prepare(`
            SELECT *
            FROM ledger
            ORDER BY created_at ASC
          `).all();

        const sequence =
          getSequence();

        return json(res, 200, {
          ok: true,
          exportedAt:
            new Date().toISOString(),
          users,
          wallets,
          ledger,
          sequence
        });
      }

      /* -----------------------------------------------
         SYNC
      ----------------------------------------------- */

      if (
        pathName === '/api/sync' &&
        method === 'POST'
      ) {

        const gameId =
          getAuthUser(req);

        if (!gameId) {
          return json(res, 401, {
            error:
              'Login required'
          });
        }

        return json(res, 200, {
          ok: true,
          ...getState(gameId)
        });
      }

      /* -----------------------------------------------
         404
      ----------------------------------------------- */

      return json(res, 404, {
        error: 'Not found'
      });

    } catch (err) {

      console.error(
        'SERVER ERROR:',
        err
      );

      return json(res, 500, {
        error:
          err.message ||
          'Internal server error'
      });
    }
  }
);

/* =========================================================
   START
========================================================= */

server.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `MK Earnings Demo Backend running on port ${PORT}`
    );

    console.log(
      `Database: ${DB_FILE}`
    );

    console.log(
      'Sequence: 2880 rounds / 24 hours'
    );

    console.log(
      'BIG: 1200'
    );

    console.log(
      'SMALL: 1200'
    );

    console.log(
      'TIE: 480'
    );

    console.log(
      'Round interval: 30 seconds'
    );
  }
);
