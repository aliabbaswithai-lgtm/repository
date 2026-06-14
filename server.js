require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode     = require('qrcode');
const low        = require('lowdb');
const FileSync   = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ──────────────────────────────────────────────
const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({
  orders:   [],
  medDict:  [],
  mrs:      [],
  sessions: [],
}).write();

// ── EMAIL (OTP) ───────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

const otpStore = {}; // { email: { otp, expiry } }

async function sendOTP(email) {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otpStore[email] = { otp, expiry: Date.now() + 5 * 60 * 1000 }; // 5 min expiry
  await transporter.sendMail({
    from: `"${process.env.PHARMACY_NAME}" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `${otp} — Your PharmaDesk Login OTP`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:32px;background:#f5f4f0;border-radius:16px;">
        <div style="background:#1a1916;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px;">
          <h2 style="color:#fff;margin:0;font-size:20px;">💊 ${process.env.PHARMACY_NAME}</h2>
          <p style="color:#888;margin:6px 0 0;font-size:13px;">PharmaDesk Login</p>
        </div>
        <p style="color:#1a1916;font-size:15px;">Your one-time password is:</p>
        <div style="background:#fff;border:2px solid #1a7a4a;border-radius:12px;padding:24px;text-align:center;margin:16px 0;">
          <span style="font-size:38px;font-weight:700;letter-spacing:10px;color:#1a1916;">${otp}</span>
        </div>
        <p style="color:#6b6860;font-size:13px;">This OTP expires in <strong>5 minutes</strong>. Do not share it with anyone.</p>
      </div>`,
  });
  return otp;
}

// ── AUTH ROUTES ───────────────────────────────────────────
app.post('/api/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email || email !== process.env.ADMIN_EMAIL) {
    return res.json({ success: false, message: 'Email not authorized.' });
  }
  try {
    await sendOTP(email);
    res.json({ success: true, message: 'OTP sent to your email.' });
  } catch (e) {
    res.json({ success: false, message: 'Failed to send OTP: ' + e.message });
  }
});

app.post('/api/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const record = otpStore[email];
  if (!record) return res.json({ success: false, message: 'No OTP found. Request a new one.' });
  if (Date.now() > record.expiry) {
    delete otpStore[email];
    return res.json({ success: false, message: 'OTP expired. Request a new one.' });
  }
  if (record.otp !== otp) return res.json({ success: false, message: 'Incorrect OTP.' });
  delete otpStore[email];
  const token = uuidv4();
  db.get('sessions').push({ token, email, createdAt: Date.now() }).write();
  res.json({ success: true, token });
});

function authMiddleware(req, res, next) {
  const token = req.headers['authorization'];
  const session = db.get('sessions').find({ token }).value();
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
}

// ── MEDICINE DICTIONARY ROUTES ────────────────────────────
app.get('/api/medicines', authMiddleware, (req, res) => {
  res.json(db.get('medDict').value());
});
app.post('/api/medicines', authMiddleware, (req, res) => {
  const med = { id: uuidv4(), createdAt: Date.now(), ...req.body };
  db.get('medDict').push(med).write();
  res.json({ success: true, med });
});
app.delete('/api/medicines/:id', authMiddleware, (req, res) => {
  db.get('medDict').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

// ── MR ROUTES ─────────────────────────────────────────────
app.get('/api/mrs', authMiddleware, (req, res) => {
  res.json(db.get('mrs').value());
});
app.post('/api/mrs', authMiddleware, (req, res) => {
  const mr = { id: uuidv4(), orders: 0, createdAt: Date.now(), ...req.body };
  db.get('mrs').push(mr).write();
  res.json({ success: true, mr });
});
app.delete('/api/mrs/:id', authMiddleware, (req, res) => {
  db.get('mrs').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

// ── ORDER ROUTES ──────────────────────────────────────────
app.get('/api/orders', authMiddleware, (req, res) => {
  const { filter, from, to } = req.query;
  let orders = db.get('orders').value();
  if (filter && filter !== 'all') orders = orders.filter(o => o.status === filter);
  if (from) orders = orders.filter(o => new Date(o.createdAt) >= new Date(from));
  if (to)   orders = orders.filter(o => new Date(o.createdAt) <= new Date(to + 'T23:59:59'));
  res.json(orders.reverse());
});
app.patch('/api/orders/:id/approve', authMiddleware, async (req, res) => {
  const order = db.get('orders').find({ id: req.params.id }).value();
  if (!order) return res.json({ success: false });
  const mr = db.get('mrs').find({ id: order.mrId }).value();
  db.get('orders').find({ id: req.params.id }).assign({ status: 'sent', sentAt: Date.now() }).write();
  // Send WhatsApp to MR
  if (mr && waClient && waReady) {
    const phone = mr.phone.replace(/\D/g, '') + '@c.us';
    const msg = `💊 *Order from ${process.env.PHARMACY_NAME}*\n\nMedicine: *${order.medicine}*\nQty: *${order.qty}*${order.note ? '\nNote: ' + order.note : ''}\n\nDate: ${new Date().toLocaleDateString('en-IN')}\n\n_Please confirm receipt._`;
    try { await waClient.sendMessage(phone, msg); } catch(e) { console.log('WA send error:', e.message); }
  }
  res.json({ success: true });
});
app.patch('/api/orders/:id/reject', authMiddleware, (req, res) => {
  db.get('orders').find({ id: req.params.id }).assign({ status: 'rejected' }).write();
  res.json({ success: true });
});
app.patch('/api/orders/approve-all', authMiddleware, async (req, res) => {
  const pending = db.get('orders').filter({ status: 'pending' }).value();
  for (const order of pending) {
    const mr = db.get('mrs').find({ id: order.mrId }).value();
    db.get('orders').find({ id: order.id }).assign({ status: 'sent', sentAt: Date.now() }).write();
    if (mr && waClient && waReady) {
      const phone = mr.phone.replace(/\D/g, '') + '@c.us';
      const msg = `💊 *Order from ${process.env.PHARMACY_NAME}*\n\nMedicine: *${order.medicine}*\nQty: *${order.qty}*${order.note ? '\nNote: ' + order.note : ''}\n\nDate: ${new Date().toLocaleDateString('en-IN')}`;
      try { await waClient.sendMessage(phone, msg); } catch(e) {}
    }
  }
  res.json({ success: true, count: pending.length });
});

// ── WHATSAPP BOT ──────────────────────────────────────────
let waClient  = null;
let waReady   = false;
let currentQR = null;
let orderMode = 'manual'; // 'auto' or 'manual'

app.get('/api/wa/qr', (req, res) => {
  if (waReady)      return res.json({ status: 'connected' });
  if (!currentQR)   return res.json({ status: 'loading' });
  res.json({ status: 'qr', qr: currentQR });
});
app.get('/api/wa/status', (req, res) => {
  res.json({ connected: waReady });
});
app.post('/api/settings/mode', authMiddleware, (req, res) => {
  orderMode = req.body.mode;
  res.json({ success: true, mode: orderMode });
});
app.get('/api/settings/mode', authMiddleware, (req, res) => {
  res.json({ mode: orderMode });
});

function initWhatsApp() {
  waClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    },
  });

  waClient.on('qr', async (qr) => {
    currentQR = await qrcode.toDataURL(qr);
    waReady = false;
    console.log('QR Code ready — open /api/wa/qr to scan');
  });

  waClient.on('ready', () => {
    waReady = true;
    currentQR = null;
    console.log('✅ WhatsApp connected!');
  });

  waClient.on('disconnected', () => {
    waReady = false;
    console.log('WhatsApp disconnected. Reconnecting...');
    setTimeout(initWhatsApp, 5000);
  });

  waClient.on('message', async (msg) => {
    const text = msg.body || '';
    const ltext = text.toLowerCase();

    // ── /add medicine trigger ──
    if (ltext.includes('/add medicine')) {
      const beforeTrigger = text.slice(0, ltext.indexOf('/add medicine')).trim();
      const parts = beforeTrigger.split(/[·|,]+/).map(s => s.trim()).filter(Boolean);
      const name = parts[0];
      if (name) {
        const exists = db.get('medDict').find(m => m.name.toLowerCase() === name.toLowerCase()).value();
        if (!exists) {
          const mrName  = parts[4] || '';
          const mr = db.get('mrs').find(r => r.name.toLowerCase().includes(mrName.toLowerCase())).value();
          db.get('medDict').push({
            id:         uuidv4(),
            name:       parts[0] || '',
            desc:       parts[1] || '',
            type:       (parts[2] || 'other').toLowerCase(),
            price:      parseInt((parts[3] || '0').replace(/[₹\s]/g, '')) || 0,
            defaultQty: parts[4] || '',
            mrId:       mr ? mr.id : null,
            createdAt:  Date.now(),
          }).write();
          console.log(`📖 Added to dictionary: ${name}`);
        }
      }
      return;
    }

    // ── /order trigger ──
    if (ltext.includes('/order')) {
      const orderIdx  = ltext.indexOf('/order');
      const medName   = text.slice(0, orderIdx).trim();
      if (!medName) return;

      // Parse qty and note from after /order
      let after = text.slice(orderIdx + 6).trim();
      let note  = '';
      const bracketMatch = after.match(/[\(\[](.*?)[\)\]]/);
      if (bracketMatch) { note = bracketMatch[1].trim(); after = after.replace(bracketMatch[0], '').trim(); }
      const hasQty = /\d/.test(after) || /strip|box|bottle|vial|tube|pack|pcs|tab|cap/i.test(after);
      const qty = hasQty && after ? after : null;

      // Match medicine in dictionary
      const dictMatch = db.get('medDict').find(m =>
        m.name.toLowerCase().includes(medName.toLowerCase()) ||
        medName.toLowerCase().includes(m.name.toLowerCase().split(' ')[0])
      ).value();

      const finalName   = dictMatch ? dictMatch.name : medName;
      const resolvedQty = qty || (dictMatch ? dictMatch.defaultQty : 'As needed');
      const mrId        = dictMatch ? dictMatch.mrId : null;

      // Deduplicate
      const exists = db.get('orders').find(o =>
        o.medicine.toLowerCase() === finalName.toLowerCase() && o.status !== 'rejected'
      ).value();
      if (exists) { console.log(`Duplicate skipped: ${finalName}`); return; }

      const order = {
        id:        uuidv4(),
        medicine:  finalName,
        mrId,
        qty:       resolvedQty,
        note,
        status:    orderMode === 'auto' ? 'sent' : 'pending',
        sender:    msg._data.notifyName || 'Unknown',
        createdAt: Date.now(),
        time:      new Date().toTimeString().slice(0, 5),
      };
      db.get('orders').push(order).write();
      console.log(`📋 Order: ${finalName} × ${resolvedQty} — ${orderMode}`);

      // Auto mode: send to MR immediately
      if (orderMode === 'auto' && mrId) {
        const mr = db.get('mrs').find({ id: mrId }).value();
        if (mr && waReady) {
          const phone = mr.phone.replace(/\D/g, '') + '@c.us';
          const waMsg = `💊 *Order from ${process.env.PHARMACY_NAME}*\n\nMedicine: *${finalName}*\nQty: *${resolvedQty}*${note ? '\nNote: ' + note : ''}\n\nDate: ${new Date().toLocaleDateString('en-IN')}`;
          try { await waClient.sendMessage(phone, waMsg); } catch(e) {}
        }
      }
    }
  });

  waClient.initialize();
}

// ── PING route (for UptimeRobot) ──────────────────────────
app.get('/ping', (req, res) => res.send('PharmaDesk is alive ✅'));

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 PharmaDesk backend running on port ${PORT}`);
  initWhatsApp();
});
