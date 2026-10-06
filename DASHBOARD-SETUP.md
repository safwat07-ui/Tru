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
| `package.json` | replaces — adds the MySQL driver, uses Node 22 |
| `railway.json` | replaces — health check now tests the database too |
| `shop.html`, `payment-result.html` | replace — small fixes for stock messages and new order statuses |

Railway redeploys automatically when the commit lands.

## 2. Add a database (required on Railway)

Railway wipes its disk on every deploy, so orders, staff accounts and photos must
live in a database.

1. In your Railway project: **+ New → Database → MySQL**.
2. Open your **website** service → **Variables** → **New Variable**:
   - Name: `MYSQL_URL`
   - Value: `${{MySQL.MYSQL_URL}}` (Railway fills in the real address)

The app creates its tables and imports the products from `catalog.json` on first start.
If this step is missing, the dashboard shows a red warning that data will be lost on the next deploy.

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
