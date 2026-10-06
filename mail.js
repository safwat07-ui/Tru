'use strict';
const crypto = require('crypto');
const { esc, egp } = require('./util');

// ===========================================================================
//  EMAIL — paid order notifications
//
//  Two ways to send, pick whichever suits you:
//
//  A) SMTP (use your existing mailbox, e.g. info@trumanelectronics.com)
//       SMTP_HOST=mail.trumanelectronics.com
//       SMTP_PORT=587            (587 = STARTTLS, 465 = direct TLS)
//       SMTP_USER=info@trumanelectronics.com
//       SMTP_PASS=••••••
//
//  B) An email API (no mail server needed)
//       RESEND_API_KEY=re_...                 https://resend.com
//       BREVO_API_KEY=xkeysib-...             https://brevo.com
//       SENDGRID_API_KEY=SG....               https://sendgrid.com
//
//  Then, for either:
//       MAIL_FROM="Truman Electronics <orders@trumanelectronics.com>"
//       ORDER_NOTIFY_TO=sales@trumanelectronics.com,info@trumanelectronics.com
//
//  Nothing configured = orders are logged to the console instead, and the
//  payment still completes normally.
// ===========================================================================
const net = require('net');
const tls = require('tls');

const MAIL = {
  from:   process.env.MAIL_FROM || '',
  notify: (process.env.ORDER_NOTIFY_TO || '').split(',').map(s => s.trim()).filter(Boolean),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    // Direct TLS from the first byte. Defaults to the usual port-465 rule,
    // but set SMTP_SECURE=true/false if your provider uses another port.
    secure: process.env.SMTP_SECURE
              ? /^(1|true|yes)$/i.test(process.env.SMTP_SECURE)
              : parseInt(process.env.SMTP_PORT || '587', 10) === 465
  },
  resend:   process.env.RESEND_API_KEY   || '',
  brevo:    process.env.BREVO_API_KEY    || '',
  sendgrid: process.env.SENDGRID_API_KEY || ''
};
// Sender falls back to the SMTP username, which is almost always a valid address.
if (!MAIL.from && MAIL.smtp.user) MAIL.from = MAIL.smtp.user;

function mailTransport() {
  if (MAIL.smtp.host && MAIL.smtp.user) return 'smtp';
  if (MAIL.resend)   return 'resend';
  if (MAIL.brevo)    return 'brevo';
  if (MAIL.sendgrid) return 'sendgrid';
  return null;
}
const MAIL_READY = !!(mailTransport() && MAIL.from);

// --- address helpers -------------------------------------------------------
function addrOnly(s) {                       // "Name <a@b.com>" -> "a@b.com"
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : String(s)).trim();
}
function addrName(s) {
  const m = String(s).match(/^\s*"?([^"<]*?)"?\s*</);
  return m ? m[1].trim() : '';
}
// RFC 2047 so Arabic subjects survive every mail client
function encodeHeader(str) {
  return /^[\x20-\x7E]*$/.test(str)
    ? str
    : '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}

// --- minimal SMTP client (no dependencies) ---------------------------------
function smtpSend({ host, port, user, pass, secure, from, to, message }) {
  return new Promise((resolve, reject) => {
    const implicitTLS = !!secure;
    let socket = implicitTLS
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    let buf = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) {}
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('SMTP timeout')), 20000);

    // Waits for a complete reply. SMTP continuation lines look like "250-XYZ";
    // the final line of a reply uses a space: "250 XYZ".
    let waiter = null;
    function expect(codes) {
      return new Promise((res, rej) => {
        waiter = { codes: [].concat(codes), res, rej };
        pump();
      });
    }
    function pump() {
      if (!waiter) return;
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length >= 4 && line[3] === ' ') {           // final line of reply
          const code = parseInt(line.slice(0, 3), 10);
          const w = waiter; waiter = null;
          buf = lines.slice(i + 1).join('\r\n');
          if (w.codes.includes(code)) return w.res(line);
          return w.rej(new Error(`SMTP ${code}: ${line.slice(4)}`));
        }
      }
    }
    function attach(s) {
      s.setEncoding('utf8');
      s.on('data', d => { buf += d; pump(); });
      s.on('error', e => { clearTimeout(timer); finish(e); });
      s.on('close', () => { if (waiter) { const w = waiter; waiter = null; w.rej(new Error('SMTP connection closed')); } });
    }
    const say = (cmd) => new Promise(r => socket.write(cmd + '\r\n', r));

    attach(socket);

    (async () => {
      await expect(220);
      await say('EHLO truman-site');
      await expect(250);

      if (!implicitTLS) {                                   // upgrade 587 -> TLS
        await say('STARTTLS');
        await expect(220);
        const plain = socket;
        plain.removeAllListeners('data');
        plain.removeAllListeners('error');
        plain.removeAllListeners('close');
        socket = tls.connect({ socket: plain, servername: host });
        buf = '';
        attach(socket);
        await new Promise((r, j) => { socket.once('secureConnect', r); socket.once('error', j); });
        await say('EHLO truman-site');
        await expect(250);
      }

      await say('AUTH LOGIN');
      await expect(334);
      await say(Buffer.from(user, 'utf8').toString('base64'));
      await expect(334);
      await say(Buffer.from(pass, 'utf8').toString('base64'));
      await expect(235);

      await say(`MAIL FROM:<${addrOnly(from)}>`);
      await expect(250);
      for (const rcpt of to) { await say(`RCPT TO:<${addrOnly(rcpt)}>`); await expect([250, 251]); }

      await say('DATA');
      await expect(354);
      // Dot-stuffing: a line that is just "." would end the message early.
      const body = message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      await say(body + '\r\n.');
      await expect(250);

      await say('QUIT');
      clearTimeout(timer);
      finish();
    })().catch(e => { clearTimeout(timer); finish(e); });
  });
}

// --- build a MIME message (multipart/alternative, UTF-8 safe) --------------
function buildMime({ from, to, replyTo, subject, text, html }) {
  const b = 'truman_' + crypto.randomBytes(12).toString('hex');
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@trumanelectronics.com>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n'),
    '',
    `--${b}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n'),
    '',
    `--${b}--`,
    ''
  ].filter(l => l !== null);
  return lines.join('\r\n');
}

// --- one send, whichever transport is configured ---------------------------
async function sendMail({ to, subject, text, html, replyTo }) {
  const transport = mailTransport();
  if (!transport || !to.length) throw new Error('email_not_configured');

  if (transport === 'smtp') {
    return smtpSend({
      ...MAIL.smtp, from: MAIL.from, to,
      message: buildMime({ from: MAIL.from, to, replyTo, subject, text, html })
    });
  }

  let url, headers, body;
  if (transport === 'resend') {
    url = 'https://api.resend.com/emails';
    headers = { 'Authorization': `Bearer ${MAIL.resend}`, 'Content-Type': 'application/json' };
    body = { from: MAIL.from, to, subject, text, html, reply_to: replyTo || undefined };
  } else if (transport === 'brevo') {
    url = 'https://api.brevo.com/v3/smtp/email';
    headers = { 'api-key': MAIL.brevo, 'Content-Type': 'application/json', 'accept': 'application/json' };
    body = {
      sender: { email: addrOnly(MAIL.from), name: addrName(MAIL.from) || 'Truman Electronics' },
      to: to.map(e => ({ email: addrOnly(e) })),
      subject, textContent: text, htmlContent: html,
      replyTo: replyTo ? { email: addrOnly(replyTo) } : undefined
    };
  } else {
    url = 'https://api.sendgrid.com/v3/mail/send';
    headers = { 'Authorization': `Bearer ${MAIL.sendgrid}`, 'Content-Type': 'application/json' };
    body = {
      personalizations: [{ to: to.map(e => ({ email: addrOnly(e) })) }],
      from: { email: addrOnly(MAIL.from), name: addrName(MAIL.from) || 'Truman Electronics' },
      reply_to: replyTo ? { email: addrOnly(replyTo) } : undefined,
      subject,
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }]
    };
  }

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`${transport} ${r.status}: ${detail.slice(0, 300)}`);
  }
}

// Two attempts. A transient mail failure must never cost us the order.
async function sendMailRetrying(opts, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await sendMail(opts);
      console.log(`[mail] sent ${label} -> ${opts.to.join(', ')}`);
      return true;
    } catch (err) {
      const last = attempt === 2;
      console.error(`[mail] ${label} attempt ${attempt} failed: ${err.message}`);
      if (last) return false;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

function itemRows(order, useAr) {
  return order.lines.map(l => `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid #e6e0d4">
          <strong style="color:#12242f">${esc(useAr ? (l.name_ar || l.name) : l.name)}</strong><br>
          <span style="font-family:monospace;font-size:12px;color:#8a6a2f">${esc(l.sku)}</span>
          <span style="color:#68767f;font-size:13px"> &times; ${l.qty}</span>
        </td>
        <td style="padding:9px 0;border-bottom:1px solid #e6e0d4;text-align:right;white-space:nowrap;color:#12242f">
          ${egp(l.line_total_cents)}
        </td>
      </tr>`).join('');
}

function emailShell(order, heading, intro, extra, itemsHtml, rtl) {
  return `
<div dir="${rtl ? 'rtl' : 'ltr'}" style="background:#f4efe4;padding:26px 14px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e6e0d4;border-radius:8px;overflow:hidden">
    <div style="background:#081722;padding:18px 24px" dir="ltr">
      <span style="color:#f4efe4;font-size:19px;font-weight:800;letter-spacing:.14em">TRUMAN</span><span style="color:#e8a33d;font-size:19px;font-weight:800">.</span>
    </div>
    <div style="padding:24px">
      <h1 style="margin:0 0 6px;font-size:19px;color:#12242f">${heading}</h1>
      <p style="margin:0 0 18px;color:#68767f;font-size:14px;line-height:1.55">${intro}</p>
      <div style="font-family:monospace;font-size:13px;color:#8a6a2f;background:#fcf3e2;border:1px solid #f0dcb6;border-radius:4px;padding:9px 12px;display:inline-block;margin-bottom:16px">
        ${esc(order.ref)}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">${itemsHtml}
        <tr>
          <td style="padding:9px 0;color:#68767f">${rtl ? 'الشحن' : 'Shipping'}</td>
          <td style="padding:9px 0;text-align:right;color:#68767f">${order.shipping_cents ? egp(order.shipping_cents) : (rtl ? 'مجاني' : 'Free')}</td>
        </tr>
        <tr>
          <td style="padding:12px 0 0;font-weight:700;font-size:16px;color:#12242f">${rtl ? 'الإجمالي' : 'Total'}</td>
          <td style="padding:12px 0 0;text-align:right;font-weight:700;font-size:16px;color:#12242f">${egp(order.total_cents)}</td>
        </tr>
      </table>
      ${extra}
    </div>
    <div style="background:#faf7f1;padding:14px 24px;border-top:1px solid #e6e0d4;color:#8a949c;font-size:12px">
      Truman Electronics &middot; Hotline 19903 &middot; info@trumanelectronics.com
    </div>
  </div>
</div>`;
}

function orderEmails(order, isTest) {
  const b = order.billing || {};
  const customer = `${b.first_name || ''} ${b.last_name || ''}`.trim();
  const tag = isTest ? '[TEST] ' : '';
  const itemsText = order.lines.map(l => `  ${l.qty} x ${l.name} (${l.sku})  ${egp(l.line_total_cents)}`).join('\n');
  const rows = useAr => itemRows(order, useAr);
  const shell = (...args) => emailShell(order, ...args);

  // ---- to the shop ----
  const internal = {
    subject: `${tag}New paid order ${order.ref} — ${egp(order.total_cents)}`,
    replyTo: b.email,
    text:
`${isTest ? 'TEST ORDER (demo mode, no money taken)\n\n' : ''}New paid order: ${order.ref}
Paid at: ${order.paid_at || new Date().toISOString()}

CUSTOMER
  ${customer}
  ${b.email}
  ${b.phone}
  ${[b.street, b.city].filter(Boolean).join(', ') || '(no address given)'}

ITEMS
${itemsText}
  Shipping: ${order.shipping_cents ? egp(order.shipping_cents) : 'Free'}
  TOTAL:    ${egp(order.total_cents)}

PAYMENT
  Method: ${order.paymob?.method || 'n/a'}${order.paymob?.card_last4 ? ' ending ' + order.paymob.card_last4 : ''}
  Paymob transaction: ${order.paymob?.transaction_id || 'n/a'}
${order.amount_mismatch ? '\n*** AMOUNT MISMATCH — captured amount differs from the order total. Check before shipping. ***\n' : ''}
Reply to this email to reach the customer directly.`,
    html: shell(
      `${isTest ? 'Test order' : 'New paid order'}`,
      `${isTest ? 'Demo mode, so no money was taken. This confirms your email setup works.' : 'Payment confirmed by Paymob. Arrange delivery with the customer.'}`,
      `<div style="margin-top:22px;padding-top:18px;border-top:1px solid #e6e0d4">
         <h2 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8a949c">Customer</h2>
         <p style="margin:0;color:#12242f;font-size:14px;line-height:1.7">
           <strong>${esc(customer)}</strong><br>
           <a href="mailto:${esc(b.email)}" style="color:#a8710f">${esc(b.email)}</a><br>
           ${esc(b.phone || '')}<br>
           <span style="color:#68767f">${esc([b.street, b.city].filter(Boolean).join(', ') || 'No address given')}</span>
         </p>
         <p style="margin:14px 0 0;color:#8a949c;font-size:12.5px">
           Paid by ${esc(order.paymob?.method || 'n/a')}${order.paymob?.card_last4 ? ' ending ' + esc(order.paymob.card_last4) : ''}
           &middot; txn ${esc(String(order.paymob?.transaction_id || 'n/a'))}
         </p>
         ${order.amount_mismatch ? `<p style="margin:14px 0 0;padding:10px 12px;background:#fbeae4;border:1px solid #e8b9a7;border-radius:4px;color:#9c3d1c;font-size:13px"><strong>Amount mismatch.</strong> The captured amount differs from the order total. Check this before shipping.</p>` : ''}
         <p style="margin:14px 0 0;color:#8a949c;font-size:12.5px">Reply to this email to reach the customer.</p>
       </div>`,
      rows(false), false
    )
  };

  // ---- to the customer, in the language they shopped in ----
  const ar = order.lang === 'ar';
  const customerMail = {
    subject: ar ? `${tag}تأكيد طلبك من ترومان — ${order.ref}`
                : `${tag}Your Truman order is confirmed — ${order.ref}`,
    text: ar
      ? `شكرًا لك${customer ? '، ' + customer : ''}.

تم تأكيد طلبك ${order.ref} واستلمنا الدفع.

${order.lines.map(l => `  ${l.qty} × ${l.name_ar || l.name} — ${egp(l.line_total_cents)}`).join('\n')}
  الشحن: ${order.shipping_cents ? egp(order.shipping_cents) : 'مجاني'}
  الإجمالي: ${egp(order.total_cents)}

سيتواصل معك فريقنا قريبًا لترتيب التوصيل.
لأي استفسار اتصل بالخط الساخن 19903.

ترومان إلكترونيكس — شريك حياتك`
      : `Thank you${customer ? ', ' + customer : ''}.

Your order ${order.ref} is confirmed and payment has been received.

${itemsText}
  Shipping: ${order.shipping_cents ? egp(order.shipping_cents) : 'Free'}
  Total:    ${egp(order.total_cents)}

Our team will contact you shortly to arrange delivery.
Any questions, call our hotline on 19903.

Truman Electronics — your life partner`,
    html: shell(
      ar ? 'تم تأكيد طلبك' : 'Your order is confirmed',
      ar ? 'شكرًا لك. استلمنا الدفع، وسيتواصل معك فريقنا قريبًا لترتيب التوصيل.'
         : 'Thank you. We have received your payment and our team will contact you shortly to arrange delivery.',
      `<p style="margin:20px 0 0;color:#68767f;font-size:13.5px">
         ${ar ? 'لأي استفسار اتصل بالخط الساخن <strong style="color:#12242f">19903</strong>.'
              : 'Any questions, call our hotline on <strong style="color:#12242f">19903</strong>.'}
       </p>`,
      rows(ar), ar
    )
  };

  return { internal, customerMail };
}

// Fire-and-forget. Never blocks or fails the payment response.
function notifyPaidOrder(order, isTest) {
  const { internal, customerMail } = orderEmails(order, isTest);

  if (!MAIL_READY) {
    console.log('[mail] not configured — order details below so nothing is lost:');
    console.log(internal.text);
    return;
  }

  if (MAIL.notify.length) {
    sendMailRetrying({ to: MAIL.notify, ...internal }, `order ${order.ref} (internal)`)
      .then(ok => { if (!ok) console.error(`[mail] ORDER ${order.ref} NOT EMAILED. Details:\n${internal.text}`); });
  } else {
    console.warn('[mail] ORDER_NOTIFY_TO is empty — no internal notification sent');
  }

  const to = order.billing && order.billing.email;
  if (to) sendMailRetrying({ to: [to], ...customerMail }, `order ${order.ref} (customer)`);
}

// ===========================================================================
//  Customer updates when staff change an order's status
// ===========================================================================
const STATUS_COPY = {
  processing: {
    en: ['Your order is being prepared', 'Good news — we are preparing your order for delivery. We will let you know as soon as it is on its way.'],
    ar: ['جارٍ تجهيز طلبك', 'أخبار سارة — نقوم الآن بتجهيز طلبك للتوصيل، وسنبلغك فور خروجه للشحن.']
  },
  shipped: {
    en: ['Your order is on its way', 'Your order has left our warehouse and is on its way to you.'],
    ar: ['طلبك في الطريق إليك', 'خرج طلبك من مستودعنا وهو الآن في الطريق إليك.']
  },
  delivered: {
    en: ['Your order has been delivered', 'Your order has been delivered. Thank you for choosing Truman — we hope you enjoy it.'],
    ar: ['تم توصيل طلبك', 'تم توصيل طلبك. شكرًا لاختيارك ترومان، نتمنى أن ينال إعجابك.']
  },
  cancelled: {
    en: ['Your order has been cancelled', 'Your order has been cancelled. If you were charged, the amount will be refunded to your original payment method.'],
    ar: ['تم إلغاء طلبك', 'تم إلغاء طلبك. إذا تم خصم أي مبلغ فسيُرد إلى وسيلة الدفع الأصلية.']
  },
  refunded: {
    en: ['Your refund has been issued', 'We have issued a refund for your order. Depending on your bank it can take 5–14 working days to appear.'],
    ar: ['تم رد المبلغ', 'قمنا برد قيمة طلبك. قد يستغرق ظهور المبلغ من 5 إلى 14 يوم عمل حسب البنك.']
  }
};

function statusEmail(order, status) {
  const copy = STATUS_COPY[status];
  if (!copy) return null;
  const ar = order.lang === 'ar';
  const [heading, intro] = ar ? copy.ar : copy.en;
  const b = order.billing || {};
  const name = `${b.first_name || ''}`.trim();
  let extraText = '', extraHtml = '';
  if (status === 'shipped' && (order.courier || order.tracking_no)) {
    const label = ar ? 'شركة الشحن' : 'Courier', tlabel = ar ? 'رقم التتبع' : 'Tracking number';
    extraText = `\n${order.courier ? `${label}: ${order.courier}\n` : ''}${order.tracking_no ? `${tlabel}: ${order.tracking_no}\n` : ''}`;
    extraHtml = `<p style="margin:18px 0 0;color:#12242f;font-size:14px;line-height:1.7">
        ${order.courier ? `${label}: <strong>${esc(order.courier)}</strong><br>` : ''}
        ${order.tracking_no ? `${tlabel}: <strong style="font-family:monospace">${esc(order.tracking_no)}</strong>` : ''}</p>`;
  }
  const help = ar ? 'لأي استفسار اتصل بالخط الساخن 19903.' : 'Any questions, call our hotline on 19903.';
  extraHtml += `<p style="margin:20px 0 0;color:#68767f;font-size:13.5px">${help}</p>`;
  const subject = `${heading} — ${order.ref}`;
  const greeting = ar ? (name ? `مرحبًا ${name}،` : 'مرحبًا،') : (name ? `Hello ${name},` : 'Hello,');
  const text = `${greeting}\n\n${intro}\n${extraText}\n${ar ? 'رقم الطلب' : 'Order'}: ${order.ref}\n` +
    order.lines.map(l => `  ${l.qty} × ${ar ? (l.name_ar || l.name) : l.name}`).join('\n') +
    `\n\n${help}\n\n${ar ? 'ترومان إلكترونيكس' : 'Truman Electronics'}`;
  const html = emailShell(order, esc(heading), esc(intro), extraHtml, itemRows(order, ar), ar);
  return { subject, text, html };
}

// Returns a promise of true/false; never throws.
async function notifyStatus(order, status) {
  const to = order.billing && order.billing.email;
  const m = statusEmail(order, status);
  if (!m || !to) return false;
  if (!MAIL_READY) { console.log(`[mail] not configured — would have emailed ${to}: ${m.subject}`); return false; }
  return sendMailRetrying({ to: [to], ...m }, `order ${order.ref} (${status})`);
}

// Re-send the "order confirmed" email to the customer only.
async function resendConfirmation(order) {
  const to = order.billing && order.billing.email;
  if (!to) return false;
  const { customerMail } = orderEmails(order, !!order.demo);
  if (!MAIL_READY) { console.log(`[mail] not configured — would have emailed ${to}: ${customerMail.subject}`); return false; }
  return sendMailRetrying({ to: [to], ...customerMail }, `order ${order.ref} (confirmation resend)`);
}

function describe() {
  const t = mailTransport();
  return {
    ready: MAIL_READY, transport: t, from: MAIL.from, notify: MAIL.notify,
    host: t === 'smtp' ? `${MAIL.smtp.host}:${MAIL.smtp.port} (${MAIL.smtp.secure ? 'TLS' : 'STARTTLS'})` : null
  };
}

module.exports = {
  MAIL, MAIL_READY, mailTransport, sendMail, sendMailRetrying, orderEmails,
  notifyPaidOrder, notifyStatus, resendConfirmation, statusEmail, describe
};
