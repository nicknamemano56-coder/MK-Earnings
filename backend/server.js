const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 8787);

const ADMIN_KEY =
  process.env.ADMIN_KEY || "CHANGE_ME_ADMIN_KEY";

const DB_FILE =
  process.env.DB_FILE || "./mk_earnings.sqlite";


/* =========================
   DATABASE
========================= */

const dbDir = path.dirname(DB_FILE);

if (dbDir && dbDir !== ".") {
  fs.mkdirSync(dbDir, {
    recursive: true
  });
}

const db = new DatabaseSync(DB_FILE);


/* =========================
   TABLES
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

CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);


/* =========================
   GLOBAL GAME SETTINGS
========================= */

const SEQUENCE_KEY =
  "master_sequence_v1";

const SHUFFLE_KEY =
  "master_shuffle_at";

const ROUND_MS =
  30 * 1000;

const TOTAL_ROUNDS =
  2880;


/* =========================
   JSON RESPONSE
========================= */

function json(res, status, obj) {

  res.writeHead(status, {

    "Content-Type":
      "application/json; charset=utf-8",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Admin-Key",

    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS"

  });

  res.end(
    JSON.stringify(obj)
  );
}


/* =========================
   REQUEST BODY
========================= */

function readBody(req) {

  return new Promise(
    (resolve, reject) => {

      let data = "";

      req.on(
        "data",
        chunk => {
          data += chunk;
        }
      );

      req.on(
        "end",
        () => {

          if (!data) {
            resolve({});
            return;
          }

          try {

            resolve(
              JSON.parse(data)
            );

          } catch (e) {

            reject(
              new Error(
                "Invalid JSON"
              )
            );

          }

        }
      );

      req.on(
        "error",
        reject
      );

    }
  );
}


/* =========================
   MOBILE NORMALIZE
========================= */

function normalizeMobile(value) {

  return String(
    value || ""
  ).replace(
    /\D/g,
    ""
  );

}


/* =========================
   PASSWORD HASH
========================= */

function hashPassword(
  password,
  salt = crypto
    .randomBytes(16)
    .toString("hex")
) {

  const hash =
    crypto.scryptSync(
      String(password),
      salt,
      64
    ).toString("hex");

  return `${salt}:${hash}`;
}


/* =========================
   PASSWORD VERIFY
========================= */

function verifyPassword(
  password,
  stored
) {

  try {

    const parts =
      String(stored).split(":");

    if (
      parts.length !== 2
    ) {
      return false;
    }

    const salt =
      parts[0];

    const storedHash =
      Buffer.from(
        parts[1],
        "hex"
      );

    const calculated =
      crypto.scryptSync(
        String(password),
        salt,
        64
      );

    return (
      storedHash.length ===
        calculated.length &&
      crypto.timingSafeEqual(
        storedHash,
        calculated
      )
    );

  } catch {

    return false;

  }

}


/* =========================
   ADMIN AUTH
========================= */

function isAdmin(req) {

  return String(
    req.headers[
      "x-admin-key"
    ] || ""
  ) === String(
    ADMIN_KEY
  );

}


/* =========================
   USER AUTH
========================= */

function getAuthUser(req) {

  const header =
    String(
      req.headers.authorization ||
      ""
    );

  const token =
    header
      .replace(
        /^Bearer\s+/i,
        ""
      )
      .trim();

  if (!token) {
    return null;
  }

  const row =
    db.prepare(
      `
      SELECT game_id
      FROM sessions
      WHERE token=?
      `
    ).get(token);

  return row?.game_id || null;

}


/* =========================
   GAME ID
========================= */

function nextGameId() {

  let highest =
    202600;

  const rows =
    db.prepare(
      `
      SELECT game_id
      FROM users
      `
    ).all();

  for (
    const row of rows
  ) {

    const id =
      String(
        row.game_id || ""
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
    db.prepare(
      `
      SELECT 1
      FROM users
      WHERE game_id=?
      `
    ).get(
      String(next)
    )
  ) {

    next++;

  }

  return String(next);

}


/* =========================
   ARRAY SHUFFLE
========================= */

function shuffleArray(
  arr
) {

  for (
    let i =
      arr.length - 1;
    i > 0;
    i--
  ) {

    const j =
      Math.floor(
        Math.random() *
        (i + 1)
      );

    [
      arr[i],
      arr[j]
    ] = [
      arr[j],
      arr[i]
    ];

  }

  return arr;

}


/* =========================
   BUILD 2880 MASTER RECORDS
========================= */

function buildSequence2880() {

  const sequence = [];

  for (
    let i = 0;
    i < 1200;
    i++
  ) {

    sequence.push(
      "BIG"
    );

  }

  for (
    let i = 0;
    i < 1200;
    i++
  ) {

    sequence.push(
      "SMALL"
    );

  }

  for (
    let i = 0;
    i < 480;
    i++
  ) {

    sequence.push(
      "TIE"
    );

  }

  return shuffleArray(
    sequence
  );

}


/* =========================
   SAVE MASTER SEQUENCE
========================= */

function saveSequence(
  sequence
) {

  db.prepare(
    `
    INSERT OR REPLACE INTO
    settings(key,value)
    VALUES(?,?)
    `
  ).run(
    SEQUENCE_KEY,
    JSON.stringify(
      sequence
    )
  );

}


/* =========================
   GET MASTER SEQUENCE
========================= */

function getSequence() {

  const row =
    db.prepare(
      `
      SELECT value
      FROM settings
      WHERE key=?
      `
    ).get(
      SEQUENCE_KEY
    );

  if (
    row?.value
  ) {

    try {

      const sequence =
        JSON.parse(
          row.value
        );

      if (
        Array.isArray(
          sequence
        ) &&
        sequence.length ===
          TOTAL_ROUNDS
      ) {

        return sequence;

      }

    } catch {}

  }

  const sequence =
    buildSequence2880();

  saveSequence(
    sequence
  );

  db.prepare(
    `
    INSERT OR REPLACE INTO
    settings(key,value)
    VALUES(?,?)
    `
  ).run(
    SHUFFLE_KEY,
    String(
      Date.now()
    )
  );

  return sequence;

}


/* =========================
   AUTO SHUFFLE 24 HOURS
========================= */

function autoShuffleIfNeeded() {

  const row =
    db.prepare(
      `
      SELECT value
      FROM settings
      WHERE key=?
      `
    ).get(
      SHUFFLE_KEY
    );

  const last =
    Number(
      row?.value || 0
    );

  const now =
    Date.now();

  const DAY =
    24 * 60 * 60 * 1000;

  if (
    !last ||
    now - last >= DAY
  ) {

    const sequence =
      buildSequence2880();

    saveSequence(
      sequence
    );

    db.prepare(
      `
      INSERT OR REPLACE INTO
      settings(key,value)
      VALUES(?,?)
      `
    ).run(
      SHUFFLE_KEY,
      String(now)
    );

    return true;

  }

  return false;

}


/* =========================
   GLOBAL 30 SECOND ROUND
========================= */

function getGlobalRound() {

  autoShuffleIfNeeded();

  const now =
    Date.now();

  const epoch =
    Math.floor(
      now / ROUND_MS
    );

  const sequence =
    getSequence();

  const index =
    ((epoch % TOTAL_ROUNDS) +
      TOTAL_ROUNDS) %
    TOTAL_ROUNDS;

  const roundStart =
    epoch * ROUND_MS;

  const roundEnd =
    roundStart +
    ROUND_MS;

  return {

    round:
      epoch + 1,

    index,

    result:
      sequence[index],

    serverTime:
      now,

    roundStart,

    roundEnd,

    remainingMs:
      roundEnd - now

  };

}


/* =========================
   WALLET
========================= */

function getWallet(
  gameId
) {

  let wallet =
    db.prepare(
      `
      SELECT *
      FROM wallets
      WHERE game_id=?
      `
    ).get(
      gameId
    );

  if (!wallet) {

    const user =
      db.prepare(
        `
        SELECT mobile
        FROM users
        WHERE game_id=?
        `
      ).get(
        gameId
      );

    const now =
      Date.now();

    db.prepare(
      `
      INSERT INTO wallets(
        game_id,
        mobile,
        balance,
        wagering,
        wagering_completed,
        updated_at
      )
      VALUES(?,?,?,?,?,?)
      `
    ).run(
      gameId,
      user?.mobile || "",
      0,
      0,
      0,
      now
    );

    wallet =
      db.prepare(
        `
        SELECT *
        FROM wallets
        WHERE game_id=?
        `
      ).get(
        gameId
      );

  }

  return wallet;

}


/* =========================
   LEDGER
========================= */

function recordLedger(
  gameId,
  data
) {

  db.prepare(
    `
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
    VALUES(
      ?,?,?,?,?,?,?,?,?,?
    )
    `
  ).run(

    data.id ||
      crypto.randomUUID(),

    gameId,

    data.type ||
      "UNKNOWN",

    Number(
      data.amount || 0
    ),

    data.balanceBefore ??
      null,

    data.balanceAfter ??
      null,

    data.wageringBefore ??
      null,

    data.wageringAfter ??
      null,

    JSON.stringify(
      data.meta || {}
    ),

    data.timestamp ||
      Date.now()

  );

}


/* =========================
   USER STATE
========================= */

function getUserState(
  gameId
) {

  const user =
    db.prepare(
      `
      SELECT
        game_id AS gameId,
        mobile,
        created_at AS createdAt
      FROM users
      WHERE game_id=?
      `
    ).get(
      gameId
    );

  const wallet =
    getWallet(
      gameId
    );

  const rows =
    db.prepare(
      `
      SELECT
        id,
        type,
        amount,
        balance_before AS balanceBefore,
        balance_after AS balanceAfter,
        wagering_before AS wageringBefore,
        wagering_after AS wageringAfter,
        meta_json,
        created_at AS timestamp
      FROM ledger
      WHERE game_id=?
      ORDER BY created_at DESC
      `
    ).all(
      gameId
    );

  const ledger =
    rows.map(
      row => ({

        ...row,

        meta:
          JSON.parse(
            row.meta_json ||
            "{}"
          )

      })
    );

  /*
    IMPORTANT:
    Do NOT send the full
    2880 future sequence
    to users.
  */

  const round =
    getGlobalRound();

  return {

    user,

    wallet,

    ledger,

    round: {

      round:
        round.round,

      index:
        round.index,

      serverTime:
        round.serverTime,

      roundStart:
        round.roundStart,

      roundEnd:
        round.roundEnd,

      remainingMs:
        round.remainingMs

    }

  };

}
/* =========================
   HTTP SERVER
========================= */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${
              req.headers.host ||
              "localhost"
            }`
          );

        const pathName =
          url.pathname;

        const method =
          req.method;


        /* =========================
           CORS OPTIONS
        ========================= */

        if (
          method ===
          "OPTIONS"
        ) {

          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Headers":
                "Content-Type, Authorization, X-Admin-Key",

              "Access-Control-Allow-Methods":
                "GET,POST,OPTIONS"
            }
          );

          res.end();

          return;

        }


        /* =========================
           HEALTH
        ========================= */

        if (
          pathName ===
            "/api/health" &&
          method === "GET"
        ) {

          const round =
            getGlobalRound();

          return json(
            res,
            200,
            {

              ok:
                true,

              service:
                "MK Earnings Demo Backend",

              time:
                new Date()
                  .toISOString(),

              node:
                process.version,

              sequence:
                2880,

              intervalSeconds:
                30,

              globalRound:
                {

                  round:
                    round.round,

                  index:
                    round.index,

                  serverTime:
                    round.serverTime,

                  remainingMs:
                    round.remainingMs

                }

            }
          );

        }


        /* =========================
           REGISTER
        ========================= */

        if (
          pathName ===
            "/api/register" &&
          method === "POST"
        ) {

          const b =
            await readBody(
              req
            );

          const mobile =
            normalizeMobile(
              b.mobile
            );

          const password =
            String(
              b.password || ""
            );


          if (
            !/^\d{10}$/.test(
              mobile
            )
          ) {

            return json(
              res,
              400,
              {
                error:
                  "Enter valid 10 digit mobile number"
              }
            );

          }


          if (
            password.length <
            8
          ) {

            return json(
              res,
              400,
              {
                error:
                  "Password must contain at least 8 characters"
              }
            );

          }


          const exists =
            db.prepare(
              `
              SELECT game_id
              FROM users
              WHERE mobile=?
              `
            ).get(
              mobile
            );


          if (exists) {

            return json(
              res,
              409,
              {

                error:
                  "Mobile number already registered",

                gameId:
                  exists.game_id

              }
            );

          }


          const gameId =
            nextGameId();

          const now =
            Date.now();


          db.prepare(
            `
            INSERT INTO users(
              game_id,
              mobile,
              password_hash,
              created_at
            )
            VALUES(?,?,?,?)
            `
          ).run(

            gameId,

            mobile,

            hashPassword(
              password
            ),

            now

          );


          db.prepare(
            `
            INSERT INTO wallets(
              game_id,
              mobile,
              balance,
              wagering,
              wagering_completed,
              updated_at
            )
            VALUES(?,?,?,?,?,?)
            `
          ).run(

            gameId,

            mobile,

            0,

            0,

            0,

            now

          );


          return json(
            res,
            200,
            {

              ok:
                true,

              gameId,

              mobile

            }
          );

        }


        /* =========================
           LOGIN
        ========================= */

        if (
          pathName ===
            "/api/login" &&
          method === "POST"
        ) {

          const b =
            await readBody(
              req
            );

          const mobile =
            normalizeMobile(
              b.mobile
            );

          const password =
            String(
              b.password || ""
            );


          const user =
            db.prepare(
              `
              SELECT *
              FROM users
              WHERE mobile=?
              `
            ).get(
              mobile
            );


          if (
            !user ||
            !verifyPassword(
              password,
              user.password_hash
            )
          ) {

            return json(
              res,
              401,
              {

                error:
                  "Invalid mobile number or password"

              }
            );

          }


          const token =
            crypto
              .randomBytes(32)
              .toString("hex");


          db.prepare(
            `
            INSERT INTO sessions(
              token,
              game_id,
              created_at
            )
            VALUES(?,?,?)
            `
          ).run(

            token,

            user.game_id,

            Date.now()

          );


          return json(
            res,
            200,
            {

              ok:
                true,

              token,

              gameId:
                user.game_id,

              state:
                getUserState(
                  user.game_id
                )

            }
          );

        }


        /* =========================
           LOGOUT
        ========================= */

        if (
          pathName ===
            "/api/logout" &&
          method === "POST"
        ) {

          const header =
            String(
              req.headers
                .authorization ||
              ""
            );

          const token =
            header
              .replace(
                /^Bearer\s+/i,
                ""
              )
              .trim();


          if (token) {

            db.prepare(
              `
              DELETE FROM sessions
              WHERE token=?
              `
            ).run(
              token
            );

          }


          return json(
            res,
            200,
            {
              ok:
                true
            }
          );

        }


        /* =========================
           USER STATE
        ========================= */

        if (
          pathName ===
            "/api/state" &&
          method === "GET"
        ) {

          const gameId =
            getAuthUser(
              req
            );


          if (!gameId) {

            return json(
              res,
              401,
              {
                error:
                  "Login required"
              }
            );

          }


          return json(
            res,
            200,
            {

              ok:
                true,

              ...getUserState(
                gameId
              )

            }
          );

        }


        /* =========================
           CURRENT GLOBAL ROUND
        ========================= */

        if (
          pathName ===
            "/api/round" &&
          method === "GET"
        ) {

          const gameId =
            getAuthUser(
              req
            );


          if (!gameId) {

            return json(
              res,
              401,
              {
                error:
                  "Login required"
              }
            );

          }


          const round =
            getGlobalRound();


          return json(
            res,
            200,
            {

              ok:
                true,

              round:
                round.round,

              index:
                round.index,

              serverTime:
                round.serverTime,

              roundStart:
                round.roundStart,

              roundEnd:
                round.roundEnd,

              remainingMs:
                round.remainingMs

            }
          );

        }


        /* =========================
           SPIN / BET
        ========================= */

        if (
          pathName ===
            "/api/spin" &&
          method === "POST"
        ) {

          const gameId =
            getAuthUser(
              req
            );


          if (!gameId) {

            return json(
              res,
              401,
              {
                error:
                  "Login required"
              }
            );

          }


          const b =
            await readBody(
              req
            );


          const choice =
            String(
              b.choice || ""
            ).toUpperCase();


          const amount =
            Number(
              b.amount
            );


          if (
            ![
              "BIG",
              "SMALL",
              "TIE"
            ].includes(
              choice
            )
          ) {

            return json(
              res,
              400,
              {
                error:
                  "Invalid choice"
              }
            );

          }


          if (
            !Number.isFinite(
              amount
            ) ||
            amount <= 0
          ) {

            return json(
              res,
              400,
              {
                error:
                  "Invalid bet amount"
              }
            );

          }


          const w =
            getWallet(
              gameId
            );


          if (
            Number(
              w.balance
            ) < amount
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
            IMPORTANT:

            This result comes ONLY
            from the global master
            Admin sequence.

            Every user in this
            30-second round gets
            the SAME result.
          */

          const round =
            getGlobalRound();


          const result =
            round.result;


          const balanceBefore =
            Number(
              w.balance
            );

          const wageringBefore =
            Number(
              w.wagering
            );


          const balanceAfter =
            Number(
              (
                balanceBefore -
                amount
              ).toFixed(2)
            );


          const wageringAfter =
            Number(
              Math.max(
                0,
                wageringBefore -
                  amount
              ).toFixed(2)
            );


          db.prepare(
            `
            UPDATE wallets
            SET
              balance=?,
              wagering=?,
              wagering_completed=
                wagering_completed+?,
              updated_at=?
            WHERE game_id=?
            `
          ).run(

            balanceAfter,

            wageringAfter,

            amount,

            Date.now(),

            gameId

          );


          recordLedger(
            gameId,
            {

              id:
                "BET-" +
                crypto.randomUUID(),

              type:
                "BET",

              amount:
                -amount,

              balanceBefore,

              balanceAfter,

              wageringBefore,

              wageringAfter,

              timestamp:
                Date.now(),

              meta:
                {

                  choice,

                  result,

                  betAmount:
                    amount,

                  round:
                    round.round,

                  index:
                    round.index,

                  name:
                    b.name ||
                    "",

                  player:
                    b.player ||
                    ""

                }

            }
          );


          const win =
            result ===
            choice;


          let payout =
            0;

          let multiplier =
            0;


          if (win) {

            multiplier =
              choice ===
                "TIE"
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
              getWallet(
                gameId
              );


            const payoutBalance =
              Number(
                (
                  Number(
                    current.balance
                  ) +
                  payout
                ).toFixed(2)
              );


            db.prepare(
              `
              UPDATE wallets
              SET
                balance=?,
                updated_at=?
              WHERE game_id=?
              `
            ).run(

              payoutBalance,

              Date.now(),

              gameId

            );


            recordLedger(
              gameId,
              {

                id:
                  "WIN-" +
                  crypto.randomUUID(),

                type:
                  "WIN",

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

                meta:
                  {

                    choice,

                    result,

                    multiplier,

                    betAmount:
                      amount,

                    payout,

                    round:
                      round.round,

                    index:
                      round.index

                  }

              }
            );

          }


          const finalWallet =
            getWallet(
              gameId
            );


          return json(
            res,
            200,
            {

              ok:
                true,

              win,

              result,

              choice,

              amount,

              payout,

              multiplier,

              round:
                round.round,

              index:
                round.index,

              wallet:
                {

                  balance:
                    finalWallet.balance,

                  wagering:
                    finalWallet.wagering,

                  wageringCompleted:
                    finalWallet
                      .wagering_completed

                }

            }
          );

        }
                 /* =========================
           WITHDRAW
        ========================= */

        if (
          pathName ===
            "/api/withdraw" &&
          method === "POST"
        ) {

          const gameId =
            getAuthUser(
              req
            );


          if (!gameId) {

            return json(
              res,
              401,
              {
                error:
                  "Login required"
              }
            );

          }


          const b =
            await readBody(
              req
            );


          const amount =
            Number(
              b.amount
            );


          if (
            !Number.isFinite(
              amount
            ) ||
            amount <= 0
          ) {

            return json(
              res,
              400,
              {
                error:
                  "Invalid withdrawal amount"
              }
            );

          }


          const w =
            getWallet(
              gameId
            );


          if (
            Number(
              w.wagering
            ) > 0
          ) {

            return json(
              res,
              400,
              {

                error:
                  `Withdrawal locked. Wagering remaining: ₹${Number(
                    w.wagering
                  ).toFixed(2)}`

              }
            );

          }


          if (
            Number(
              w.balance
            ) < amount
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


          const balanceBefore =
            Number(
              w.balance
            );


          const balanceAfter =
            Number(
              (
                balanceBefore -
                amount
              ).toFixed(2)
            );


          db.prepare(
            `
            UPDATE wallets
            SET
              balance=?,
              updated_at=?
            WHERE game_id=?
            `
          ).run(

            balanceAfter,

            Date.now(),

            gameId

          );


          recordLedger(
            gameId,
            {

              id:
                "WITHDRAW-" +
                crypto.randomUUID(),

              type:
                "WITHDRAW",

              amount:
                -amount,

              balanceBefore,

              balanceAfter,

              wageringBefore:
                w.wagering,

              wageringAfter:
                w.wagering,

              timestamp:
                Date.now(),

              meta:
                {

                  upi:
                    b.upi ||
                    "",

                  name:
                    b.name ||
                    "",

                  status:
                    "Demo withdrawal request"

                }

            }
          );


          return json(
            res,
            200,
            {

              ok:
                true,

              status:
                "Demo withdrawal request created",

              wallet:
                {

                  balance:
                    balanceAfter,

                  wagering:
                    w.wagering

                }

            }
          );

        }


        /* =========================
           DELETE ACCOUNT
        ========================= */

        if (
          pathName ===
            "/api/account/delete" &&
          method === "POST"
        ) {

          const gameId =
            getAuthUser(
              req
            );


          if (!gameId) {

            return json(
              res,
              401,
              {
                error:
                  "Login required"
              }
            );

          }


          db.prepare(
            `
            DELETE FROM sessions
            WHERE game_id=?
            `
          ).run(
            gameId
          );


          db.prepare(
            `
            DELETE FROM ledger
            WHERE game_id=?
            `
          ).run(
            gameId
          );


          db.prepare(
            `
            DELETE FROM wallets
            WHERE game_id=?
            `
          ).run(
            gameId
          );


          db.prepare(
            `
            DELETE FROM users
            WHERE game_id=?
            `
          ).run(
            gameId
          );


          return json(
            res,
            200,
            {

              ok:
                true,

              message:
                "Demo account deleted"

            }
          );

        }


        /* =========================
           ADMIN DEPOSIT
        ========================= */

        if (
          pathName ===
            "/api/admin/deposit" &&
          method === "POST"
        ) {

          if (
            !isAdmin(req)
          ) {

            return json(
              res,
              403,
              {
                error:
                  "Admin access denied"
              }
            );

          }


          const b =
            await readBody(
              req
            );


          const gameId =
            String(
              b.gameId || ""
            ).trim();


          const amount =
            Number(
              b.amount
            );


          if (
            !gameId ||
            !Number.isFinite(
              amount
            ) ||
            amount <= 0
          ) {

            return json(
              res,
              400,
              {
                error:
                  "Invalid game ID or amount"
              }
            );

          }


          const user =
            db.prepare(
              `
              SELECT *
              FROM users
              WHERE game_id=?
              `
            ).get(
              gameId
            );


          if (!user) {

            return json(
              res,
              404,
              {
                error:
                  "User not found"
              }
            );

          }


          const w =
            getWallet(
              gameId
            );


          const balanceBefore =
            Number(
              w.balance
            );

          const wageringBefore =
            Number(
              w.wagering
            );


          const balanceAfter =
            Number(
              (
                balanceBefore +
                amount
              ).toFixed(2)
            );


          const wageringAfter =
            Number(
              (
                wageringBefore +
                amount
              ).toFixed(2)
            );


          db.prepare(
            `
            UPDATE wallets
            SET
              balance=?,
              wagering=?,
              updated_at=?
            WHERE game_id=?
            `
          ).run(

            balanceAfter,

            wageringAfter,

            Date.now(),

            gameId

          );


          recordLedger(
            gameId,
            {

              id:
                "ADMIN-DEPOSIT-" +
                crypto.randomUUID(),

              type:
                "ADMIN_DEPOSIT",

              amount,

              balanceBefore,

              balanceAfter,

              wageringBefore,

              wageringAfter,

              timestamp:
                Date.now(),

              meta:
                {

                  source:
                    "admin",

                  status:
                    "Demo deposit"

                }

            }
          );


          return json(
            res,
            200,
            {

              ok:
                true,

              gameId,

              amount,

              wallet:
                getWallet(
                  gameId
                )

            }
          );

        }


        /* =========================
           ADMIN USERS
        ========================= */

        if (
          pathName ===
            "/api/admin/users" &&
          method === "GET"
        ) {

          if (
            !isAdmin(req)
          ) {

            return json(
              res,
              403,
              {
                error:
                  "Admin access denied"
              }
            );

          }


          const users =
            db.prepare(
              `
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
              `
            ).all();


          return json(
            res,
            200,
            {

              ok:
                true,

              users

            }
          );

        }


        /* =========================
           ADMIN LEDGER
        ========================= */

        if (
          pathName ===
            "/api/admin/ledger" &&
          method === "GET"
        ) {

          if (
            !isAdmin(req)
          ) {

            return json(
              res,
              403,
              {
                error:
                  "Admin access denied"
              }
            );

          }


          const gameId =
            String(
              url.searchParams.get(
                "gameId"
              ) || ""
            ).trim();


          let rows;


          if (gameId) {

            rows =
              db.prepare(
                `
                SELECT *
                FROM ledger
                WHERE game_id=?
                ORDER BY
                  created_at DESC
                `
              ).all(
                gameId
              );

          } else {

            rows =
              db.prepare(
                `
                SELECT *
                FROM ledger
                ORDER BY
                  created_at DESC
                `
              ).all();

          }


          const ledger =
            rows.map(
              row => ({

                id:
                  row.id,

                gameId:
                  row.game_id,

                type:
                  row.type,

                amount:
                  row.amount,

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
                    row.meta_json ||
                    "{}"
                  )

              })
            );


          return json(
            res,
            200,
            {

              ok:
                true,

              ledger

            }
          );

        }


        /* =========================
           ADMIN MASTER SEQUENCE
        ========================= */

        if (
          pathName ===
            "/api/admin/sequence" &&
          method === "GET"
        ) {

          if (
            !isAdmin(req)
          ) {

            return json(
              res,
              403,
              {
                error:
                  "Admin access denied"
              }
            );

          }


          autoShuffleIfNeeded();


          const sequence =
            getSequence();


          const shuffledAt =
            Number(
              db.prepare(
                `
                SELECT value
                FROM settings
                WHERE key=?
                `
              ).get(
                SHUFFLE_KEY
              )?.value || 0
            );


          return json(
            res,
            200,
            {

              ok:
                true,

              total:
                sequence.length,

              counts:
                {

                  BIG:
                    sequence.filter(
                      x =>
                        x === "BIG"
                    ).length,

                  SMALL:
                    sequence.filter(
                      x =>
                        x === "SMALL"
                    ).length,

                  TIE:
                    sequence.filter(
                      x =>
                        x === "TIE"
                    ).length

                },

              shuffledAt,

              sequence

            }
          );

        }


        /* =========================
           ADMIN SHUFFLE
        ========================= */

        if (
          pathName ===
            "/api/admin/shuffle" &&
          method === "POST"
        ) {

          if (
            !isAdmin(req)
          ) {

            return json(
              res,
              403,
              {
                error:
                  "Admin access denied"
              }
            );

          }


          const sequence =
            buildSequence2880();


          const now =
            Date.now();


          saveSequence(
            sequence
          );


          db.prepare(
            `
            INSERT OR REPLACE INTO
            settings(key,value)
            VALUES(?,?)
            `
          ).run(

            SHUFFLE_KEY,

            String(now)

          );


          return json(
            res,
            200,
            {

              ok:
                true,

              message:
                "2880 master records shuffled",

              total:
                sequence.length,

              counts:
                {

                  BIG:
                    1200,

                  SMALL:
                    1200,

                  TIE:
                    480

                },

              shuffledAt:
                now,

              sequence

            }
          );

        }
                 /* =========================
           ADMIN BACKUP
        ========================= */

        if (
          pathName ===
            "/api/admin/backup" &&
          method === "GET"
        ) {

          if (
            !isAdmin(req)
          ) {

            return json(
              res,
              403,
              {
                error:
                  "Admin access denied"
              }
            );

          }


          const users =
            db.prepare(
              `
              SELECT
                game_id,
                mobile,
                created_at
              FROM users
              ORDER BY
                created_at ASC
              `
            ).all();


          const wallets =
            db.prepare(
              `
              SELECT *
              FROM wallets
              `
            ).all();


          const ledger =
            db.prepare(
              `
              SELECT *
              FROM ledger
              ORDER BY
                created_at ASC
              `
            ).all();


          const sequence =
            getSequence();


          return json(
            res,
            200,
            {

              ok:
                true,

              exportedAt:
                new Date()
                  .toISOString(),

              users,

              wallets,

              ledger,

              sequence

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
              "Not found"
          }
        );


      } catch (err) {

        console.error(
          "SERVER ERROR:",
          err
        );


        return json(
          res,
          500,
          {

            error:
              err.message ||
              "Internal server error"

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
  "0.0.0.0",
  () => {

    console.log(
      `MK Earnings backend running on port ${PORT}`
    );

    console.log(
      `Database: ${DB_FILE}`
    );

    console.log(
      "Global master sequence: 2880"
    );

    console.log(
      "BIG: 1200"
    );

    console.log(
      "SMALL: 1200"
    );

    console.log(
      "TIE: 480"
    );

    console.log(
      "Round interval: 30 seconds"
    );

  }
);
