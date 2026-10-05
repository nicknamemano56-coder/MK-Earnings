const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8787);

const ADMIN_KEY =
  process.env.ADMIN_KEY || 'CHANGE_ME_ADMIN_KEY';

const DB_FILE =
  process.env.DB_FILE || './mk_earnings.sqlite';


/* =========================
   DATABASE DIRECTORY
========================= */

const dbDir = path.dirname(DB_FILE);

if (dbDir && dbDir !== '.') {
  try {
    fs.mkdirSync(dbDir, {
      recursive: true
    });
  } catch (e) {
    console.error(
      'Database directory creation failed:',
      e
    );
  }
}


const db =
  new DatabaseSync(DB_FILE);


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

  const body =
    JSON.stringify(obj);

  res.writeHead(status, {

    'Content-Type':
      'application/json; charset=utf-8',

    'Access-Control-Allow-Origin':
      '*',

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

  return new Promise(
    (resolve, reject) => {

      let s = '';

      req.on(
        'data',
        c => {
          s += c;
        }
      );

      req.on(
        'end',
        () => {

          try {

            resolve(
              s
                ? JSON.parse(s)
                : {}
            );

          } catch (e) {

            reject(e);

          }

        }
      );

    }
  );

}


/* =========================
   PASSWORD HASH
========================= */

function hash(
  p,
  salt =
    crypto
      .randomBytes(16)
      .toString('hex')
) {

  return `${salt}:${crypto
    .scryptSync(
      String(p),
      salt,
      64
    )
    .toString('hex')}`;

}


function verify(
  p,
  stored
) {

  try {

    const [
      salt,
      h
    ] =
      String(stored)
        .split(':');

    return crypto.timingSafeEqual(

      Buffer.from(
        h,
        'hex'
      ),

      crypto.scryptSync(
        String(p),
        salt,
        64
      )

    );

  } catch {

    return false;

  }

}


/* =========================
   TOKEN
========================= */

function token() {

  return crypto
    .randomBytes(32)
    .toString('hex');

}


/* =========================
   USER AUTH
========================= */

function auth(req) {

  const t =
    String(
      req.headers.authorization ||
      ''
    )
    .replace(
      /^Bearer\s+/i,
      ''
    );

  if (!t)
    return null;

  return (

    db
      .prepare(
        'SELECT game_id FROM sessions WHERE token=?'
      )
      .get(t)
      ?.game_id || null

  );

}


/* =========================
   ADMIN AUTH
========================= */

function admin(req) {

  return (
    String(
      req.headers[
        'x-admin-key'
      ] || ''
    ) === ADMIN_KEY
  );

}


/* =========================
   NEXT UNIQUE GAME ID
========================= */

function nextGameId() {

  let highest = 202600;

  const rows =
    db
      .prepare(
        'SELECT game_id FROM users'
      )
      .all();


  for (const row of rows) {

    const id =
      String(
        row.game_id || ''
      );

    if (
      /^2026\d+$/.test(id)
    ) {

      highest =
        Math.max(
          highest,
          Number(id)
        );

    }

  }


  let next =
    highest + 1;


  while (

    db
      .prepare(
        'SELECT 1 FROM users WHERE game_id=?'
      )
      .get(
        String(next)
      )

  ) {

    next++;

  }


  return String(next);

}


/* =========================
   WALLET
========================= */

function wallet(id) {

  let w =
    db
      .prepare(
        'SELECT * FROM wallets WHERE game_id=?'
      )
      .get(id);


  if (!w) {

    const u =
      db
        .prepare(
          'SELECT mobile,created_at FROM users WHERE game_id=?'
        )
        .get(id);


    const now =
      Date.now();


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


    w =
      db
        .prepare(
          'SELECT * FROM wallets WHERE game_id=?'
        )
        .get(id);

  }


  return w;

}
/* =========================
   DEMO SEQUENCE
   2880 TOTAL / 24 HOURS

   30 seconds × 2880
   = 24 hours

   BIG   = 1200
   SMALL = 1200
   TIE   = 480
========================= */

const SEQUENCE_KEY = 'sequence_v2880';
const SEQUENCE_SHUFFLE_KEY = 'sequence_shuffled_at';

function buildSequence2880() {

  const a = [];

  for (let i = 0; i < 1200; i++) {
    a.push('BIG');
  }

  for (let i = 0; i < 1200; i++) {
    a.push('SMALL');
  }

  for (let i = 0; i < 480; i++) {
    a.push('TIE');
  }

  shuffleArray(a);

  return a;
}


/* =========================
   SHUFFLE
========================= */

function shuffleArray(a) {

  for (
    let i = a.length - 1;
    i > 0;
    i--
  ) {

    const j =
      Math.floor(
        Math.random() *
        (i + 1)
      );

    [
      a[i],
      a[j]
    ] = [
      a[j],
      a[i]
    ];

  }

  return a;
}


/* =========================
   GET 2880 SEQUENCE
========================= */

function getSequence() {

  let raw =
    db
      .prepare(
        `SELECT value
         FROM settings
         WHERE key=?`
      )
      .get(
        SEQUENCE_KEY
      )
      ?.value;


  let sequence = null;


  if (raw) {

    try {

      const parsed =
        JSON.parse(raw);

      if (
        Array.isArray(parsed) &&
        parsed.length === 2880
      ) {

        sequence = parsed;

      }

    } catch {}

  }


  /*
    If sequence doesn't exist,
    create first 2880 sequence.
  */

  if (!sequence) {

    sequence =
      buildSequence2880();

    db.prepare(`
      INSERT OR REPLACE INTO settings(
        key,
        value
      )
      VALUES(?,?)
    `).run(

      SEQUENCE_KEY,

      JSON.stringify(
        sequence
      )

    );


    db.prepare(`
      INSERT OR REPLACE INTO settings(
        key,
        value
      )
      VALUES(?,?)
    `).run(

      SEQUENCE_SHUFFLE_KEY,

      String(
        Date.now()
      )

    );

  }


  return sequence;

}


/* =========================
   AUTO 24 HOUR SHUFFLE
========================= */

function autoShuffleIfNeeded() {

  const row =
    db
      .prepare(`
        SELECT value
        FROM settings
        WHERE key=?
      `)
      .get(
        SEQUENCE_SHUFFLE_KEY
      );


  const last =
    Number(
      row?.value || 0
    );


  const now =
    Date.now();


  const twentyFourHours =
    24 * 60 * 60 * 1000;


  if (
    !last ||
    now - last >=
      twentyFourHours
  ) {

    const sequence =
      buildSequence2880();


    db.prepare(`
      INSERT OR REPLACE INTO settings(
        key,
        value
      )
      VALUES(?,?)
    `).run(

      SEQUENCE_KEY,

      JSON.stringify(
        sequence
      )

    );


    db.prepare(`
      INSERT OR REPLACE INTO settings(
        key,
        value
      )
      VALUES(?,?)
    `).run(

      SEQUENCE_SHUFFLE_KEY,

      String(now)

    );


    return {
      shuffled: true,
      timestamp: now
    };

  }


  return {
    shuffled: false,
    timestamp: last
  };

}


/* =========================
   PLAYER ROUND
========================= */

function getPlayerRound(id) {

  const row =
    db
      .prepare(`
        SELECT round
        FROM player_rounds
        WHERE game_id=?
      `)
      .get(id);


  return Number(
    row?.round || 1
  );

}


function setPlayerRound(
  id,
  round
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
        Number(round)
      )
    )

  );

}


/* =========================
   CURRENT RESULT
========================= */

function getNextResult(id) {

  /*
    Check whether 24-hour
    automatic shuffle is due.
  */

  autoShuffleIfNeeded();


  const sequence =
    getSequence();


  const round =
    getPlayerRound(id);


  const index =
    (round - 1) %
    sequence.length;


  const result =
    sequence[index] ||
    'SMALL';


  setPlayerRound(
    id,
    round + 1
  );


  return {
    result,
    round,
    index
  };

}


/* =========================
   STATE
========================= */

function sendState(id) {

  const w =
    wallet(id);


  const rows =
    db
      .prepare(`
        SELECT *
        FROM ledger
        WHERE game_id=?
        ORDER BY created_at DESC
      `)
      .all(id)
      .map(x => ({

        id:
          x.id,

        type:
          x.type,

        amount:
          x.amount,

        balanceBefore:
          x.balance_before,

        balanceAfter:
          x.balance_after,

        wageringBefore:
          x.wagering_before,

        wageringAfter:
          x.wagering_after,

        timestamp:
          x.created_at,

        meta:
          JSON.parse(
            x.meta_json ||
            '{}'
          )

      }));


  const round =
    getPlayerRound(id);


  return {

    user:
      db
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


    ledger:
      rows,


    round,


    sequence:
      getSequence()

  };

}


/* =========================
   SPIN ROUTE
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
    ).toUpperCase();


  const amount =
    Number(
      b.amount
    );


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


  /*
    IMPORTANT:

    WAGERING DOES NOT BLOCK SPIN.

    Only balance is checked.

    Wagering is controlled separately
    during withdrawal.
  */

  if (
    Number(w.balance) <
    amount
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


  /*
    Get next 30-second result
    from the 2880-result sequence.
  */

  const next =
    getNextResult(id);


  const result =
    next.result;


  /*
    Deduct bet amount.
  */

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

    id

  );


  record(id, {

    id:
      'BET-' +
      crypto.randomUUID(),

    type:
      'BET',

    amount:
      -amount,

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

      betAmount:
        amount,

      round:
        next.round,

      name:
        b.name || '',

      player:
        b.player || ''

    }

  });


  /* =========================
     PAYOUT
  ========================= */

  const win =
    result === choice;


  let payout = 0;


  if (win) {

    /*
      BIG / SMALL = 1.9x
      TIE = 9x
    */

    const multiplier =
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
      wallet(id);


    const payoutBalance =
      Number(
        (
          current.balance +
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

      id

    );


    record(id, {

      id:
        'WIN-' +
        crypto.randomUUID(),

      type:
        'WIN',

      amount:
        payout,

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

        betAmount:
          amount,

        payout,

        round:
          next.round

      }

    });

  }


  const finalWallet =
    wallet(id);


  return json(
    res,
    200,
    {

      ok: true,

      win,

      result,

      choice,

      amount,

      payout,

      multiplier:
        win
          ? (
              choice === 'TIE'
                ? 9
                : 1.9
            )
          : 0,

      round:
        next.round,

      wallet: {
        balance:
          finalWallet.balance,

        wagering:
          finalWallet.wagering,

        wageringCompleted:
          finalWallet.wagering_completed

      }

    }
  );

}
/* =========================
   WITHDRAW
========================= */

if (
  pathName === '/api/withdraw' &&
  req.method === 'POST'
) {

  if (!id) {
    return json(res, 401, {
      error: 'Login required'
    });
  }

  const b = await body(req);

  const amount = Number(b.amount);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return json(res, 400, {
      error: 'Invalid withdrawal amount'
    });
  }

  const w = wallet(id);

  /*
    WITHDRAWAL IS LOCKED WHILE
    WAGERING IS REMAINING.
  */

  if (Number(w.wagering) > 0) {
    return json(res, 400, {
      error:
        `Withdrawal locked. Wagering remaining: ₹${Number(
          w.wagering
        ).toFixed(2)}`
    });
  }

  if (Number(w.balance) < amount) {
    return json(res, 400, {
      error:
        `Insufficient virtual balance. Available: ₹${Number(
          w.balance
        ).toFixed(2)}`
    });
  }

  const before = Number(w.balance);

  const after = Number(
    (before - amount).toFixed(2)
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
    id
  );

  record(id, {
    id:
      'WITHDRAW-' +
      crypto.randomUUID(),

    type:
      'WITHDRAW',

    amount:
      -amount,

    balanceBefore:
      before,

    balanceAfter:
      after,

    wageringBefore:
      w.wagering,

    wageringAfter:
      w.wagering,

    timestamp:
      Date.now(),

    meta: {
      upi:
        b.upi || '',

      name:
        b.name || '',

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


/* =========================
   ADMIN DEPOSIT
========================= */

if (
  pathName === '/api/admin/deposit' &&
  req.method === 'POST'
) {

  if (!admin(req)) {
    return json(res, 403, {
      error: 'Admin access denied'
    });
  }

  const b = await body(req);

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
    db
      .prepare(
        'SELECT * FROM users WHERE game_id=?'
      )
      .get(gameId);


  if (!user) {

    return json(res, 404, {
      error:
        'User not found'
    });

  }


  const w =
    wallet(gameId);


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


  /*
    Admin deposit adds the same
    amount to wagering.
  */

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


  record(gameId, {

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
      source:
        'admin',

      status:
        'Demo deposit'
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


/* =========================
   ADMIN USERS
========================= */

if (
  pathName === '/api/admin/users' &&
  req.method === 'GET'
) {

  if (!admin(req)) {

    return json(res, 403, {
      error:
        'Admin access denied'
    });

  }


  const users =
    db
      .prepare(`
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
          ON w.game_id =
             u.game_id

        ORDER BY
          u.created_at DESC
      `)
      .all();


  return json(res, 200, {
    ok: true,
    users
  });

}


/* =========================
   ADMIN LEDGER
========================= */

if (
  pathName === '/api/admin/ledger' &&
  req.method === 'GET'
) {

  if (!admin(req)) {

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

    rows =
      db
        .prepare(`
          SELECT *
          FROM ledger
          WHERE game_id=?
          ORDER BY
            created_at DESC
        `)
        .all(gameId);

  } else {

    rows =
      db
        .prepare(`
          SELECT *
          FROM ledger
          ORDER BY
            created_at DESC
        `)
        .all();

  }


  const ledger =
    rows.map(x => ({

      id:
        x.id,

      gameId:
        x.game_id,

      type:
        x.type,

      amount:
        x.amount,

      balanceBefore:
        x.balance_before,

      balanceAfter:
        x.balance_after,

      wageringBefore:
        x.wagering_before,

      wageringAfter:
        x.wagering_after,

      timestamp:
        x.created_at,

      meta:
        JSON.parse(
          x.meta_json ||
          '{}'
        )

    }));


  return json(res, 200, {

    ok: true,

    ledger

  });

}


/* =========================
   ADMIN SEQUENCE
========================= */

if (
  pathName === '/api/admin/sequence' &&
  req.method === 'GET'
) {

  if (!admin(req)) {

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
      db
        .prepare(`
          SELECT value
          FROM settings
          WHERE key=?
        `)
        .get(
          SEQUENCE_SHUFFLE_KEY
        )?.value || 0
    );


  return json(res, 200, {

    ok: true,

    total:
      sequence.length,

    counts,

    shuffledAt,

    sequence

  });

}


/* =========================
   ADMIN MANUAL SHUFFLE
========================= */

if (
  pathName === '/api/admin/shuffle' &&
  req.method === 'POST'
) {

  if (!admin(req)) {

    return json(res, 403, {
      error:
        'Admin access denied'
    });

  }


  const sequence =
    buildSequence2880();


  const now =
    Date.now();


  db.prepare(`
    INSERT OR REPLACE INTO settings(
      key,
      value
    )
    VALUES(?,?)
  `).run(

    SEQUENCE_KEY,

    JSON.stringify(
      sequence
    )

  );


  db.prepare(`
    INSERT OR REPLACE INTO settings(
      key,
      value
    )
    VALUES(?,?)
  `).run(

    SEQUENCE_SHUFFLE_KEY,

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

    shuffledAt:
      now,

    sequence

  });

}


/* =========================
   ADMIN BACKUP
========================= */

if (
  pathName === '/api/admin/backup' &&
  req.method === 'GET'
) {

  if (!admin(req)) {

    return json(res, 403, {
      error:
        'Admin access denied'
    });

  }


  const users =
    db
      .prepare(`
        SELECT
          game_id,
          mobile,
          created_at
        FROM users
        ORDER BY
          created_at ASC
      `)
      .all();


  const wallets =
    db
      .prepare(`
        SELECT *
        FROM wallets
      `)
      .all();


  const ledger =
    db
      .prepare(`
        SELECT *
        FROM ledger
        ORDER BY
          created_at ASC
      `)
      .all();


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


/* =========================
   404
========================= */

return json(res, 404, {
  error:
    'Not found'
});


    } catch (err) {

      console.error(
        'SERVER ERROR:',
        err
      );

      return json(
        res,
        500,
        {
          error:
            err.message ||
            'Internal server error'
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
  '0.0.0.0',
  () => {

    console.log(
      `MK Earnings Demo Backend running on port ${PORT}`
    );

    console.log(
      `Database: ${DB_FILE}`
    );

    console.log(
      `Sequence: 2880 rounds / 24 hours`
    );

    console.log(
      `BIG: 1200`
    );

    console.log(
      `SMALL: 1200`
    );

    console.log(
      `TIE: 480`
    );

    console.log(
      `Round interval: 30 seconds`
    );

  }
);
