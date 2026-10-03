# MK Earnings — Multi-device Demo Backend

Demo-only virtual wallet backend. No real-money payment/payout processing.

## Run
1. Install Node.js 22+.
2. Copy `.env.example` values into your environment.
3. Set a strong `ADMIN_KEY`.
4. Run `node server.js`.
5. Backend health: `GET /api/health`.

The server uses Node 22's built-in `node:sqlite`, so no npm database dependency is required.

## Important
- Use HTTPS when hosted publicly.
- Do not expose the ADMIN_KEY in the User app.
- Existing browser localStorage data is not deleted by the backend.
- The first cloud login/register creates cloud accounts. Existing local demo accounts remain local until explicitly migrated.
