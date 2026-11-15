# Credit rewards: what changed

Flat awards paid the same for a 20-byte getter and a 4 KB function. Now that the easy
functions are done, the work that's left costs far more tokens for the same reward.
Awards now scale with the effort involved.

## 1. Size multiplier

Merges, submissions and reviews are multiplied by `sqrt(size / 64)`, clamped to 1..8
(reviews: 1..4). The square root keeps one huge function from outweighing a whole region.

| Size | x | Identical | Confirmed | Review |
|---|---|---|---|---|
| ≤64 B | 1 | 10 | 8 | 2 |
| 256 B | 2 | 20 | 16 | 4 |
| 1 KB | 4 | 40 | 32 | 8 |
| 4 KB+ | 8 | 80 | 64 | 8 |

## 2. Stale and hard bonus (merges only)

- +25% for each earlier attempt on the function that was sent back (returned,
  needs_cleanup, rejected, superseded, hard), capped at +100%.
- x1.5 if the function was ever marked hard or went through a cleanup cycle.

This pays for picking up functions that others gave up on.

## 3. Confirmed raised from 6 to 8

Large functions rarely come out byte-identical. A lower confirmed award pushed people
toward easy matches rather than faithful ports.

## 4. Reviews scale too

Reviewing a big function takes real effort. Without scaling, nobody wants to take those
reviews, and they're what's blocking merges.

## Unchanged

- Skip claims (3), bailout and games.
- Credits already booked: the ledger is idempotent per entry, so only new earnings use
  the new rates.
- Discord linked roles keep summing the same reasons, so they pick up the larger amounts
  automatically.

Constants: `AWARDS` and `SCALE` in `src/server/credits.js`.
