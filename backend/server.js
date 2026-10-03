const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8787);
const ADMIN_KEY = process.env.ADMIN_KEY || 'CHANGE_ME_ADMIN_KEY';

/*
  Render:
  If DB_FILE is set, use it.
  Otherwise use local SQLite file.
*/
const DB_FILE = process.env.DB_FILE || './mk_earnings.sqlite';

/*
  Make sure the database directory exists.
  This fixes:
  "Error: unable to open database file"
*/
const dbDir = path.dirname(DB_FILE);

if (dbDir && dbDir !== '.') {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (e) {
    console.error('Database directory creation failed:', e);
  }
}

const db = new DatabaseSync(DB_FILE);

/* =========================
   DATABASE TABLES
========================= */

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

/* =========================
   JSON RESPONSE
========================= */

function json(res, status, obj) {
  const body = JSON.stringify(obj);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Methods':
      'GET,POST,PUT,OPTIONS'
  });

  res.end(body);
}

/* =========================
   REQUEST BODY
========================= */

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';

    req.on('data', c => {
      s += c;
    });

    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

/* =========================
   PASSWORD
========================= */

function hash(
  p,
  salt = crypto.randomBytes(16).toString('hex')
) {
  return `${salt}:${crypto
    .scryptSync(String(p), salt, 64)
    .toString('hex')}`;
}

function verify(p, stored) {
  try {
    const [salt, h] = String(stored).split(':');

    return crypto.timingSafeEqual(
      Buffer.from(h, 'hex'),
      crypto.scryptSync(String(p), salt, 64)
    );
  } catch {
    return false;
  }
}

/* =========================
   TOKEN
========================= */

function token() {
  return crypto.randomBytes(32).toString('hex');
}

/* =========================
   AUTH
========================= */

function auth(req) {
  const t = String(
    req.headers.authorization || ''
  ).replace(/^Bearer\s+/i, '');

  if (!t) return null;

  return (
    db
      .prepare(
        'SELECT game_id FROM sessions WHERE token=?'
      )
      .get(t)?.game_id || null
  );
}

function admin(req) {
  return (
    String(req.headers['x-admin-key'] || '') ===
    ADMIN_KEY
  );
}

/* =========================
   NEXT GAME ID
========================= */

function nextGameId() {
  const r = db
    .prepare(
      'SELECT MAX(CAST(game_id AS INTEGER)) AS m FROM users'
    )
    .get();

  let n = Number(r?.m || 202600);

  return String(n + 1);
}

/* =========================
   WALLET
========================= */

function wallet(id) {
  let w = db
    .prepare(
      'SELECT * FROM wallets WHERE game_id=?'
    )
    .get(id);

  if (!w) {
    const u = db
      .prepare(
        'SELECT mobile,created_at FROM users WHERE game_id=?'
      )
      .get(id);

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
      id,
      u?.mobile || '',
      0,
      0,
      0,
      now
    );

    w = db
      .prepare(
        'SELECT * FROM wallets WHERE game_id=?'
      )
      .get(id);
  }

  return w;
}

/* =========================
   LEDGER
========================= */

function record(id, entry) {
  const e = {
    id:
      entry.id ||
      crypto.randomUUID(),

    game_id: id,

    type: entry.type,

    amount: Number(
      entry.amount || 0
    ),

    balance_before:
      entry.balanceBefore ??
      entry.balance_before ??
      null,

    balance_after:
      entry.balanceAfter ??
      entry.balance_after ??
      null,

    wagering_before:
      entry.wageringBefore ??
      entry.wagering_before ??
      null,

    wagering_after:
      entry.wageringAfter ??
      entry.wagering_after ??
      null,

    meta_json: JSON.stringify(
      entry.meta || entry
    ),

    created_at:
      entry.timestamp ||
      Date.now()
  };

  try {
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
      e.id,
      id,
      e.type,
      e.amount,
      e.balance_before,
      e.balance_after,
      e.wagering_before,
      e.wagering_after,
      e.meta_json,
      e.created_at
    );
  } catch {}

  return e.id;
}

/* =========================
   DEMO SEQUENCE
   1000 TOTAL
   BIG   = 425
   SMALL = 425
   TIE   = 150
========================= */

function getSequence() {
  let s = db
    .prepare(
      "SELECT value FROM settings WHERE key='sequence'"
    )
    .get()?.value;

  if (s) {
    try {
      const a = JSON.parse(s);

      if (
        Array.isArray(a) &&
        a.length === 1000
      ) {
        return a;
      }
    } catch {}
  }

  const a = [];

  for (let i = 0; i < 425; i++) {
    a.push('BIG');
  }

  for (let i = 0; i < 425; i++) {
    a.push('SMALL');
  }

  for (let i = 0; i < 150; i++) {
    a.push('TIE');
  }

  db.prepare(`
    INSERT OR REPLACE INTO settings(key,value)
    VALUES('sequence',?)
  `).run(JSON.stringify(a));

  return a;
}

/* =========================
   STATE
========================= */

function sendState(id) {
  const w = wallet(id);

  const rows = db
    .prepare(`
      SELECT *
      FROM ledger
      WHERE game_id=?
      ORDER BY created_at DESC
    `)
    .all(id)
    .map(x => ({
      id: x.id,
      type: x.type,
      amount: x.amount,
      balanceBefore: x.balance_before,
      balanceAfter: x.balance_after,
      wageringBefore: x.wagering_before,
      wageringAfter: x.wagering_after,
      timestamp: x.created_at,
      meta: JSON.parse(
        x.meta_json || '{}'
      )
    }));

  const round =
    db
      .prepare(
        'SELECT round FROM player_rounds WHERE game_id=?'
      )
      .get(id)?.round || 1;

  return {
    user: db
      .prepare(`
        SELECT
          game_id AS gameId,
          mobile,
          created_at AS createdAt
        FROM users
        WHERE game_id=?
      `)
      .get(id),

    wallet: {
      ...w
    },

    ledger: rows,

    round,

    sequence: getSequence()
  };
}

/* =========================
   SERVER
========================= */

const server = http.createServer(
  async (req, res) => {

    if (req.method === 'OPTIONS') {
      return json(res, 204, {});
    }

    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    const pathName = url.pathname;

    try {

      /* =========================
         HEALTH
      ========================= */

      if (
        req.method === 'GET' &&
        pathName === '/api/health'
      ) {
        return json(
          res,
          200,
          {
            ok: true,
            app: 'MK Earnings Demo Backend'
          }
        );
      }

      /* =========================
         REGISTER
      ========================= */

      if (
        req.method === 'POST' &&
        pathName === '/api/register'
      ) {

        const b = await body(req);

        const mobile =
          String(
            b.mobile || ''
          ).trim();

        const password =
          String(
            b.password || ''
          );

        if (
          !/^\d{10}$/.test(mobile) ||
          password.length < 8
        ) {
          return json(
            res,
            400,
            {
              error:
                'Invalid mobile or password'
            }
          );
        }

        if (
          db
            .prepare(
              'SELECT 1 FROM users WHERE mobile=?'
            )
            .get(mobile)
        ) {
          return json(
            res,
            409,
            {
              error:
                'Mobile already registered'
            }
          );
        }

        const id = nextGameId();
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
          id,
          mobile,
          hash(password),
          now
        );

        wallet(id);

        return json(
          res,
          200,
          {
            ok: true,
            gameId: id,
            mobile,
            createdAt: now
          }
        );
      }

      /* =========================
         LOGIN
      ========================= */

      if (
        req.method === 'POST' &&
        pathName === '/api/login'
      ) {

        const b = await body(req);

        const u = db
          .prepare(
            'SELECT * FROM users WHERE mobile=?'
          )
          .get(
            String(
              b.mobile || ''
            ).trim()
          );

        if (
          !u ||
          !verify(
            String(b.password || ''),
            u.password_hash
          )
        ) {
          return json(
            res,
            401,
            {
              error:
                'Wrong mobile number or password'
            }
          );
        }

        const t = token();

        db.prepare(`
          INSERT INTO sessions(
            token,
            game_id,
            created_at
          )
          VALUES(?,?,?)
        `).run(
          t,
          u.game_id,
          Date.now()
        );

        return json(
          res,
          200,
          {
            ok: true,
            token: t,
            gameId: u.game_id,
            mobile: u.mobile
          }
        );
      }

      /* =========================
         AUTH USER
      ========================= */

      const id = auth(req);

      /* =========================
         STATE
      ========================= */

      if (
        pathName === '/api/state' &&
        req.method === 'GET'
      ) {

        if (!id) {
          return json(
            res,
            401,
            {
              error:
                'Login required'
            }
          );
        }

        return json(
          res,
          200,
          sendState(id)
        );
      }

      /* =========================
         SYNC
      ========================= */

      if (
        pathName === '/api/sync' &&
        req.method === 'POST'
      ) {

        if (!id) {
          return json(
            res,
            401,
            {
              error:
                'Login required'
            }
          );
        }

        const b = await body(req);

        const w =
          b.wallet || {};

        const current =
          wallet(id);

        const incoming = {
          balance:
            Number(
              w.balance || 0
            ),

          wagering:
            Number(
              w.wagering || 0
            ),

          wagering_completed:
            Number(
              w.wagering_completed ||
              w.wageringCompleted ||
              0
            )
        };

        if (
          Number.isFinite(
            incoming.balance
          ) &&
          Number.isFinite(
            incoming.wagering
          )
        ) {

          db.prepare(`
            UPDATE wallets
            SET
              balance=?,
              wagering=?,
              wagering_completed=?,
              updated_at=?
            WHERE game_id=?
          `).run(
            Math.max(
              0,
              incoming.balance
            ),

            Math.max(
              0,
              incoming.wagering
            ),

            Math.max(
              0,
              incoming.wagering_completed
            ),

            Date.now(),

            id
          );
        }

        for (
          const e of Array.isArray(
            b.ledger
          )
            ? b.ledger.slice(0, 200)
            : []
        ) {
          record(id, e);
        }

        if (
          Number.isFinite(
            Number(b.round)
          )
        ) {

          db.prepare(`
            INSERT OR REPLACE INTO player_rounds(
              game_id,
              round
            )
            VALUES(?,?)
          `).run(
            id,
            Math.max(
              1,
              Math.floor(
                Number(b.round)
              )
            )
          );
        }

        return json(
          res,
          200,
          sendState(id)
        );
      }

      /* =========================
         SPIN
      ========================= */

      if (
        pathName === '/api/spin' &&
        req.method === 'POST'
      ) {

        if (!id) {
          return json(
            res,
            401,
            {
              error:
                'Login required'
            }
          );
        }

        const b =
          await body(req);

        const choice =
          String(
            b.choice || ''
          );

        const amount =
          Number(b.amount);

        if (
          ![
            'BIG',
            'SMALL',
            'TIE'
          ].includes(choice) ||
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          return json(
            res,
            400,
            {
              error:
                'Invalid bet'
            }
          );
        }

        const w =
          wallet(id);

        if (
          w.balance < amount
        ) {
          return json(
            res,
            400,
            {
              error:
                `Insufficient virtual balance. Available: ₹${Number(
                  w.balance
                ).toFixed(2)}`
            }
          );
        }

        if (
          w.wagering < amount
        ) {
          return json(
            res,
            400,
            {
              error:
                `Insufficient wagering remaining. Available: ₹${Number(
                  w.wagering
                ).toFixed(2)}`
            }
          );
        }

        const seq =
          getSequence();

        const round =
          db
            .prepare(
              'SELECT round FROM player_rounds WHERE game_id=?'
            )
            .get(id)?.round || 1;

        const result =
          seq[
            (round - 1) %
            seq.length
          ] || 'SMALL';

        /* Deduct bet */

        const afterBet =
          Number(
            (
              w.balance -
              amount
            ).toFixed(2)
          );

        const afterWager =
          Number(
            Math.max(
              0,
              w.wagering -
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
          afterBet,
          afterWager,
          amount,
          Date.now(),
          id
        );

        record(id, {
          id:
            'BET-' +
            crypto.randomUUID(),

          type: 'BET',

          amount:
            -amount,

          balanceBefore:
            w.balance,

          balanceAfter:
            afterBet,

          wageringBefore:
            w.wagering,

          wageringAfter:
            afterWager,

          timestamp:
            Date.now(),

          meta: {
            choice,
            betAmount:
              amount,
            name:
              b.name || '',
            player:
              b.player || ''
          }
        });

        /* =========================
           WIN PAYOUT
        ========================= */

        let payout = 0;

        const win =
          result === choice;

        if (win) {

          /*
            BIG / SMALL = 1.9x
            TIE = 9x
          */

          const mult =
            choice === 'TIE'
              ? 9
              : 1.9;

          payout =
            Number(
              (
                amount *
                mult
              ).toFixed(2)
            );

          const cur =
            wallet(id);

          const nb =
            Number(
              (
                cur.balance +
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
            nb,
            Date.now(),
            id
          );

          record(id, {
            id:
              'WIN-' +
              crypto.randomUUID(),

            type: 'WIN',

            amount:
              payout,

            balanceBefore:
              cur.balance,

            balanceAfter:
              nb,

            wageringAfter:
              cur.wagering,

            timestamp:
              Date.now(),

            meta: {
              choice,
              result,
              betAmount:
                amount,
              payout
            }
          });
        }

        /* Next round */

        db.prepare(`
          INSERT OR REPLACE INTO player_rounds(
            game_id,
            round
          )
          VALUES(?,?)
        `).run(
          id,
          round + 1
        );

        const nw =
          wallet(id);

        return json(
          res,
          200,
          {
            ok: true,
            result,
            win,
            payout,
            wallet: nw,
            round:
              round + 1
          }
        );
      }

      /* =========================
         WITHDRAW
         DEMO ONLY
      ========================= */

      if (
        pathName === '/api/withdraw' &&
        req.method === 'POST'
      ) {

        if (!id) {
          return json(
            res,
            401,
            {
              error:
                'Login required'
            }
          );
        }

        const b =
          await body(req);

        const amount =
          Number(b.amount);

        const upi =
          String(
            b.upi || ''
          ).trim();

        const w =
          wallet(id);

        if (
          !Number.isFinite(amount) ||
          amount < 100 ||
          amount > 1000
        ) {
          return json(
            res,
            400,
            {
              error:
                'Withdraw amount must be ₹100-₹1000'
            }
          );
        }

        if (
          w.wagering > 0
        ) {
          return json(
            res,
            400,
            {
              error:
                `Withdrawal locked. Wagering left ₹${Number(
                  w.wagering
                ).toFixed(2)}`
            }
          );
        }

        if (
          w.balance < amount
        ) {
          return json(
            res,
            400,
            {
              error:
                'Insufficient virtual balance'
            }
          );
        }

        const fee =
          Number(
            (
              amount *
              0.05
            ).toFixed(2)
          );

        const net =
          Number(
            (
              amount -
              fee
            ).toFixed(2)
          );

        const nb =
          Number(
            (
              w.balance -
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
          nb,
          Date.now(),
          id
        );

        record(id, {
          id:
            'WD-' +
            crypto.randomUUID(),

          type:
            'WITHDRAW',

          amount:
            -amount,

          balanceBefore:
            w.balance,

          balanceAfter:
            nb,

          wageringAfter:
            w.wagering,

          timestamp:
            Date.now(),

          meta: {
            upi,
            fee,
            net,
            grossAmount:
              amount,

            status:
              'Demo withdrawal request'
          }
        });

        return json(
          res,
          200,
          {
            ok: true,
            fee,
            net,
            wallet:
              wallet(id)
          }
        );
      }

      /* =========================
         ADMIN DEPOSIT
         DEMO ONLY
      ========================= */

      if (
        pathName === '/api/admin/deposit' &&
        req.method === 'POST'
      ) {

        if (!admin(req)) {
          return json(
            res,
            403,
            {
              error:
                'Admin key required'
            }
          );
        }

        const b =
          await body(req);

        const gid =
          String(
            b.gameId || ''
          );

        const amt =
          Number(b.amount);

        if (
          !gid ||
          !Number.isFinite(amt) ||
          amt <= 0
        ) {
          return json(
            res,
            400,
            {
              error:
                'Invalid Game ID or amount'
            }
          );
        }

        const w =
          wallet(gid);

        const nb =
          Number(
            (
              w.balance +
              amt
            ).toFixed(2)
          );

        const nw =
          Number(
            (
              w.wagering +
              amt
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
          nb,
          nw,
          Date.now(),
          gid
        );

        record(gid, {
          id:
            'DEP-' +
            crypto.randomUUID(),

          type:
            'ADMIN_DEPOSIT',

          amount:
            amt,

          balanceBefore:
            w.balance,

          balanceAfter:
            nb,

          wageringAfter:
            nw,

          timestamp:
            Date.now(),

          meta: {
            source:
              'admin'
          }
        });

        return json(
          res,
          200,
          sendState(gid)
        );
      }

      /* =========================
         ADMIN USERS
      ========================= */

      if (
        pathName === '/api/admin/users' &&
        req.method === 'GET'
      ) {

        if (!admin(req)) {
          return json(
            res,
            403,
            {
              error:
                'Admin key required'
            }
          );
        }

        const users =
          db
            .prepare(`
              SELECT
                game_id AS gameId,
                mobile,
                created_at AS createdAt
              FROM users
              ORDER BY
                CAST(game_id AS INTEGER)
            `)
            .all();

        return json(
          res,
          200,
          {
            users:
              users.map(
                u => ({
                  ...u,
                  wallet:
                    wallet(
                      u.gameId
                    )
                })
              )
          }
        );
      }

      /* =========================
         ADMIN LEDGER
      ========================= */

      if (
        pathName === '/api/admin/ledger' &&
        req.method === 'GET'
      ) {

        if (!admin(req)) {
          return json(
            res,
            403,
            {
              error:
                'Admin key required'
            }
          );
        }

        const rows =
          db
            .prepare(`
              SELECT *
              FROM ledger
              ORDER BY
                created_at DESC
              LIMIT 20000
            `)
            .all();

        return json(
          res,
          200,
          {
            ledger:
              rows
          }
        );
      }

      /* =========================
         ADMIN SEQUENCE
      ========================= */

      if (
        pathName === '/api/admin/sequence' &&
        req.method === 'GET'
      ) {

        if (!admin(req)) {
          return json(
            res,
            403,
            {
              error:
                'Admin key required'
            }
          );
        }

        const s =
          getSequence();

        const last =
          Number(
            db
              .prepare(
                "SELECT value FROM settings WHERE key='shuffle_at'"
              )
              .get()?.value || 0
          );

        return json(
          res,
          200,
          {
            sequence:
              s,

            shuffleAt:
              last
          }
        );
      }

      /* =========================
         ADMIN SHUFFLE
         20 HOUR COOLDOWN
      ========================= */

      if (
        pathName === '/api/admin/shuffle' &&
        req.method === 'POST'
      ) {

        if (!admin(req)) {
          return json(
            res,
            403,
            {
              error:
                'Admin key required'
            }
          );
        }

        const last =
          Number(
            db
              .prepare(
                "SELECT value FROM settings WHERE key='shuffle_at'"
              )
              .get()?.value || 0
          );

        if (
          Date.now() -
            last <
          20 * 60 * 60 * 1000
        ) {
          return json(
            res,
            429,
            {
              error:
                'Shuffle cooldown active',

              availableAt:
                last +
                20 *
                  60 *
                  60 *
                  1000
            }
          );
        }

        const s =
          getSequence();

        for (
          let i =
            s.length - 1;
          i > 0;
          i--
        ) {

          const j =
            Math.floor(
              Math.random() *
                (i + 1)
            );

          [
            s[i],
            s[j]
          ] = [
            s[j],
            s[i]
          ];
        }

        db.prepare(`
          INSERT OR REPLACE INTO settings(
            key,
            value
          )
          VALUES('sequence',?)
        `).run(
          JSON.stringify(s)
        );

        db.prepare(`
          INSERT OR REPLACE INTO settings(
            key,
            value
          )
          VALUES('shuffle_at',?)
        `).run(
          String(
            Date.now()
          )
        );

        return json(
          res,
          200,
          {
            ok: true,
            sequence:
              s,
            shuffleAt:
              Date.now()
          }
        );
      }

      /* =========================
         ADMIN BACKUP
      ========================= */

      if (
        pathName === '/api/admin/backup' &&
        req.method === 'GET'
      ) {

        if (!admin(req)) {
          return json(
            res,
            403,
            {
              error:
                'Admin key required'
            }
          );
        }

        return json(
          res,
          200,
          {
            users:
              db
                .prepare(
                  'SELECT * FROM users'
                )
                .all(),

            wallets:
              db
                .prepare(
                  'SELECT * FROM wallets'
                )
                .all(),

            ledger:
              db
                .prepare(
                  'SELECT * FROM ledger'
                )
                .all(),

            settings:
              db
                .prepare(
                  'SELECT * FROM settings'
                )
                .all()
          }
        );
      }

      /* =========================
         NOT FOUND
      ========================= */

      return json(
        res,
        404,
        {
          error:
            'Not found'
        }
      );

    } catch (e) {

      console.error(e);

      return json(
        res,
        500,
        {
          error:
            'Server error',

          detail:
            e.message
        }
      );
    }
  }
);

/* =========================
   START SERVER
========================= */

server.listen(
  PORT,
  () => {
    console.log(
      `MK Earnings backend listening on http://localhost:${PORT}`
    );

    console.log(
      `Database file: ${DB_FILE}`
    );
  }
);
