# Notes

## How to run

```bash
npm install
npm start            # http://localhost:3000
```

Open the page in two or more tabs with `?user=alice`, `?user=bob` to play different buyers.
Click **Buy now**, then **Pay now** (the payment is still simulated by the fake provider). The fake payment company calls `/webhooks/payments` back, late, twice, or out of order.

Useful env vars: `TOTAL_STOCK=20`, `HOLD_SECONDS=300` (use `20` to watch expiry and the waiting line quickly), `NO_CHAOS=1` (well-behaved payments), `PORT`, `DB_FILE`.
`npm run reset` deletes the database for a fresh sale. `npm test` runs the tests (rules, payment mess, 2000 simultaneous clicks).

## Requirements

Node 22.13+ (tested on 22 and 24). No external database and no native build tools: it uses the SQLite built into Node (`node:sqlite`), so you may see an "ExperimentalWarning" on start, which is harmless.

## How it works (for the recording)

- **No overselling:** stock is never a counter. It is `TOTAL - (active holds + paid)`, computed inside a `BEGIN IMMEDIATE` transaction together with the insert, so two clicks can never both see "1 left".
- **Rule 2:** a partial unique index (one active hold per user) enforces one hold at the database level; max 2 purchases is checked in the same transaction.
- **Holds and the line (rules 1 and 3):** holds expire lazily on every request plus a 250 ms background sweep. When a hold expires, the sweep gives the pair to the first person in the line with a fresh 5 minutes.
- **Payments (rule 4):** webhooks are HMAC-signed. Handling is idempotent: a processed event id is ignored, "succeeded" is terminal so repeats and late "processing"/"failed" events never downgrade it, and order does not matter.
- **Late payment after the hold expired:** if the user paid in time and the pair is still free, it is honoured; if the pair already went to the next person, the payment is refunded. Stock is never exceeded.

## Trade-offs

- SQLite with one Node process keeps this simple. For several servers, move to Postgres/MySQL and use `SELECT ... FOR UPDATE` on a stock row (the unique index and transaction logic carry over unchanged).
- Users are identified by a plain id (no login), as auth was out of scope.
- The page polls every second; websockets would be the upgrade. The UI lives in `public/` (`css/` and ES modules in `js/`), with no build step and no new dependencies.
