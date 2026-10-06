# Admin dashboard — setup on Railway

These files add the admin dashboard (`/admin`) to the existing site.
Your pages, images and catalogue stay as they are.

## 1. Add the files to GitHub

In the repo on github.com: **Add file → Upload files**, drag in everything from this zip
(the `admin` and `lib` folders plus the files), then **Commit changes**.

| File | |
|------|---|
| `admin/` | new — the dashboard pages |
| `lib/` | new — database, shop, Paymob, email, login and admin logic |
| `server.js` | replaces the old one (the old one had copies of every page built in) |
| `package.json` | replaces — uses Node 22 (needed for the built-in database) |
| `railway.json` | replaces — health check now waits for the database to be ready |
| `shop.html`, `payment-result.html` | replace — small fixes for stock messages and new order statuses |

Railway redeploys automatically when the commit lands.

## 2. Add a Volume (one-time, required)

The dashboard keeps orders, staff accounts and product photos in a small database
file that comes built into Node. You don't need a database service. But Railway wipes
its disk on every deploy, so that file needs a permanent place:

1. In Railway, open your **website** service → **Settings** → **Volumes** → **+ Add Volume**
   (or right-click the service → **Attach Volume**).
2. Mount path: `/app/data`
3. Redeploy.

The app finds the Volume by itself. On first start it creates the database and imports the
products from `catalog.json`. If the Volume is missing, the dashboard shows a red warning
that data will be lost on the next deploy.

## 3. Create your owner login

Add two more variables to the website service:

| Variable | Value |
|----------|-------|
| `ADMIN_EMAIL` | your email |
| `ADMIN_PASSWORD` | a temporary password — you choose your own at first sign-in |

Open `https://<your-railway-domain>/admin`, sign in, and set your own password.
Then **delete `ADMIN_PASSWORD`** from Railway, and turn on two-step sign-in under **My account**.

## 4. Email and Paymob

These are the same variables as before; the full list is in `README.md` and `PAYMENTS.md`:
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `ORDER_NOTIFY_TO`,
`CONTACT_NOTIFY_TO`, `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET`,
`PAYMOB_INTEGRATION_IDS`, and `SITE_URL` (your Railway or custom domain, `https://…`, no trailing slash).

## 5. Try it

Place an order in the shop. In the dashboard, open it and click **Simulate payment (demo)**,
then walk it through Preparing → Shipped → Delivered.

**Forgot the owner password?** Set `ADMIN_PASSWORD` to a new temporary password and
`ADMIN_PASSWORD_RESET` to `yes`, then redeploy. Sign in, then remove both variables.
