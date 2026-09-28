# Online payments — setup guide (Paymob)

The shop is built and working. It runs in **demo mode** until you add Paymob keys:
orders are created and the whole flow is testable, but no money moves.

---

## 1. What was added

| File | Purpose |
|------|---------|
| `shop.html` | Product grid, cart drawer, checkout form (EN + AR) |
| `payment-result.html` | Order confirmation / failure page |
| `catalog.json` | **Prices live here.** The server reads them; the browser never sets them |
| `server.js` | Checkout API, Paymob Intention call, HMAC-verified webhook |
| `orders.json` | Created at runtime. Order records. Never served over HTTP |

---

## 2. Get your Paymob credentials

Sign up at **paymob.com** (hotline 19079). Once your merchant account is approved,
from the dashboard collect four things:

| Value | Where in the dashboard | Looks like |
|-------|------------------------|-----------|
| Secret key | Settings → Account Info | `egy_sk_live_…` |
| Public key | Settings → Account Info | `egy_pk_live_…` |
| HMAC secret | Settings → Account Info | long hex string |
| Integration IDs | Developers → Payment Integrations | numbers, e.g. `4097558` |

You get one integration ID **per payment method** — card, mobile wallet, kiosk.
Enable the ones you want and list them all.

---

## 3. Set the environment variables

On Railway: service → **Variables**.

```
PAYMOB_SECRET_KEY       = egy_sk_live_xxxxxxxx
PAYMOB_PUBLIC_KEY       = egy_pk_live_xxxxxxxx
PAYMOB_HMAC_SECRET      = xxxxxxxxxxxxxxxxxxxx
PAYMOB_INTEGRATION_IDS  = 4097558,4097559
SITE_URL                = https://your-live-domain.com
```

`SITE_URL` must be the real public URL — Paymob calls back to it. Get it wrong and
payments will succeed at the gateway while your orders stay unconfirmed.

Nothing is hardcoded; the keys exist only as environment variables.

---

## 4. Point Paymob's callbacks at the site

In the dashboard, on **each** integration ID you listed, set both callbacks:

- **Transaction processed callback** → `https://your-domain.com/api/paymob/webhook`
- **Transaction response callback** → `https://your-domain.com/payment-result`

The first is the one that actually marks an order paid.

---

## 5. Test before going live

Use Paymob's sandbox keys first. Their published test card:

```
Card    5123 4567 8901 2346
Expiry  12/25      CVV 123
Name    Test Account
OTP     123456
```

Run through: add to cart → checkout → pay → confirm the order shows **paid**.

---

## 6. Set your real prices

`catalog.json` ships with **placeholder prices** — replace them before launch.

Prices are in **piastres** (1 EGP = 100), which avoids decimal rounding errors:

```json
{ "sku": "TM-G200", "price_cents": 145000 }   // = EGP 1,450.00
```

Shipping is also there:

```json
"shipping": { "flat_rate_cents": 15000, "free_over_cents": 2000000 }
```
That's EGP 150 flat, free over EGP 20,000. Set `free_over_cents` to `null` to always charge.

To hide a product, set `"in_stock": false`. It disappears from the shop and is
rejected at checkout.

---

## 7. How the money is protected

These are deliberate decisions, not defaults:

**Prices are never taken from the browser.** The checkout request sends only SKUs and
quantities. The server looks up each price in `catalog.json` and recomputes the total.
A customer editing the page and claiming a 26,500 EGP TV costs 1 EGP is still charged
26,500 — verified by test.

**An order is only marked paid by a signed webhook.** The browser redirect after payment
is treated as a hint for the UI, never as proof. The confirmation page asks the server
what really happened.

**Every webhook is HMAC-verified.** Paymob signs callbacks with HMAC-SHA512 over 20
fields in a fixed order. Forged signatures, missing signatures and tampered amounts are
all rejected with 401 — verified by test.

**Replays are safe.** Paymob may send the same webhook more than once; an order that is
already paid is not processed twice.

**Amount mismatches are flagged.** If the captured amount ever differs from the priced
total, the order is marked and the discrepancy logged.

**Quantities are clamped** to 1–20 per line, so a negative or absurd quantity can't
produce a strange total.

---

## 8. Where orders go

Orders are written to `orders.json` next to the server, and the file is blocked from
being served over HTTP. That is deliberate simplicity for launch volume.

Two things to know:

- **On Railway, the filesystem is ephemeral.** A redeploy can wipe `orders.json`.
  Before you take real money, either attach a persistent volume or send each paid
  order somewhere durable — an email, a Slack webhook, or a database. The place to
  hook that in is `handleWebhook` in `server.js`, right where the status becomes `paid`.
- There is no admin screen yet. Orders are readable in the file, or per-order at
  `/api/order?ref=TRM-…`.

---

## 9. Still to decide

- **Cash on delivery.** Still how a large share of Egyptian customers buy. Worth adding
  as a checkout option alongside cards.
- **Fawry kiosk payments.** Reaches customers without cards. Available through Paymob as
  another integration ID — the code already accepts a list, so it's mostly dashboard work.
- **Stock control.** Nothing decrements on sale; `in_stock` is a manual switch.
- **Order confirmation email** to the customer.
- **Refunds** — currently done from the Paymob dashboard, not the site.
