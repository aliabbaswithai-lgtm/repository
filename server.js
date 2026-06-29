require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const low        = require('lowdb');
const FileSync   = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({ orders:[], medDict:[], mrs:[], sessions:[] }).write();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
});

// â”€â”€ ALLOWED EMAILS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Only these emails can receive an OTP and log in to the dashboard.
const ALLOWED_EMAILS = [
  'aliabbaswithai@gmail.com',
  'aliabbaskalwani.1224@gmail.com',
  'sadikabbas@gmail.com',
  'drmknztp@gmail.com',
];

const otpStore = {}; // { email: { otp, expiry } }

// â”€â”€ SEND OTP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/send-otp', async (req, res) => {
  const { email } = req.body;
  const cleanEmail = (email || '').trim().toLowerCase();

  if (!cleanEmail || !ALLOWED_EMAILS.includes(cleanEmail)) {
    return res.json({ success: false, message: 'This email is not authorized to log in.' });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otpStore[cleanEmail] = { otp, expiry: Date.now() + 5 * 60 * 1000 }; // 5 min

  try {
    await transporter.sendMail({
      from: `"${process.env.PHARMACY_NAME}" <${process.env.GMAIL_USER}>`,
      to: cleanEmail,
      subject: `${otp} â€” Your PharmaDesk Login OTP`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:32px;background:#f5f4f0;border-radius:16px;">
          <div style="background:#1a1916;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px;">
            <h2 style="color:#fff;margin:0;font-size:20px;">ðŸ’Š ${process.env.PHARMACY_NAME}</h2>
            <p style="color:#888;margin:6px 0 0;font-size:13px;">PharmaDesk Login</p>
          </div>
          <p style="color:#1a1916;font-size:15px;">Your one-time password is:</p>
          <div style="background:#fff;border:2px solid #1a7a4a;border-radius:12px;padding:24px;text-align:center;margin:16px 0;">
            <span style="font-size:38px;font-weight:700;letter-spacing:10px;color:#1a1916;">${otp}</span>
          </div>
          <p style="color:#6b6860;font-size:13px;">This OTP expires in <strong>5 minutes</strong>. Do not share it with anyone.</p>
        </div>`,
    });
    res.json({ success: true, message: 'OTP sent.' });
  } catch (e) {
    res.json({ success: false, message: 'Failed to send OTP: ' + e.message });
  }
});

// â”€â”€ VERIFY OTP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const cleanEmail = (email || '').trim().toLowerCase();
  const record = otpStore[cleanEmail];

  if (!record) return res.json({ success: false, message: 'No OTP found. Request a new one.' });
  if (Date.now() > record.expiry) {
    delete otpStore[cleanEmail];
    return res.json({ success: false, message: 'OTP expired. Request a new one.' });
  }
  if (record.otp !== otp) return res.json({ success: false, message: 'Incorrect OTP.' });

  delete otpStore[cleanEmail];
  const token = uuidv4();
  db.get('sessions').push({ token, email: cleanEmail, createdAt: Date.now() }).write();
  res.json({ success: true, token });
});

function auth(req, res, next) {
  const token = req.headers['authorization'];
  if (!db.get('sessions').find({ token }).value())
    return res.status(401).json({ success: false });
  next();
}

// â”€â”€ Relay secret check (for the PC WhatsApp relay) â”€â”€
function relayAuth(req, res, next) {
  const key = req.headers['x-relay-key'];
  if (key !== process.env.RELAY_SECRET) {
    return res.status(401).json({ success: false, message: 'Invalid relay key' });
  }
  next();
}

// â”€â”€ MEDICINES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/medicines', auth, (req, res) => res.json(db.get('medDict').value()));
app.post('/api/medicines', auth, (req, res) => {
  const med = { id: uuidv4(), createdAt: Date.now(), ...req.body };
  db.get('medDict').push(med).write();
  res.json({ success: true, med });
});
app.delete('/api/medicines/:id', auth, (req, res) => {
  db.get('medDict').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

// â”€â”€ MRs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/mrs', auth, (req, res) => res.json(db.get('mrs').value()));
app.post('/api/mrs', auth, (req, res) => {
  const mr = { id: uuidv4(), orders: 0, createdAt: Date.now(), ...req.body };
  db.get('mrs').push(mr).write();
  res.json({ success: true, mr });
});
app.delete('/api/mrs/:id', auth, (req, res) => {
  db.get('mrs').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

// â”€â”€ ORDERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/orders', auth, (req, res) => {
  let orders = db.get('orders').value();
  const { filter } = req.query;
  if (filter && filter !== 'all') orders = orders.filter(o => o.status === filter);
  res.json(orders.reverse());
});
app.patch('/api/orders/:id/approve', auth, (req, res) => {
  db.get('orders').find({ id: req.params.id }).assign({ status: 'sent', sentAt: Date.now() }).write();
  res.json({ success: true });
});
app.patch('/api/orders/:id/reject', auth, (req, res) => {
  db.get('orders').find({ id: req.params.id }).assign({ status: 'rejected' }).write();
  res.json({ success: true });
});

// â”€â”€ Endpoint the WhatsApp relay (PC) calls â€” protected by RELAY_SECRET â”€â”€
app.post('/api/orders/from-whatsapp', relayAuth, (req, res) => {
  const { medicine, qty, note, sender } = req.body;
  if (!medicine) return res.json({ success: false, message: 'No medicine name provided' });

  const medDict = db.get('medDict').value();
  const dictMatch = medDict.find(m =>
    m.name.toLowerCase().includes(medicine.toLowerCase()) ||
    medicine.toLowerCase().includes(m.name.toLowerCase().split(' ')[0])
  );

  const finalName   = dictMatch ? dictMatch.name : medicine;
  const resolvedQty = qty || (dictMatch ? dictMatch.defaultQty : 'As needed');
  const mrId        = dictMatch ? dictMatch.mrId : null;
  const unrecognized = !dictMatch;

  const exists = db.get('orders').find(o =>
    o.medicine.toLowerCase() === finalName.toLowerCase() && o.status !== 'rejected'
  ).value();
  if (exists) return res.json({ success: true, duplicate: true });

  const order = {
    id: uuidv4(),
    medicine: finalName,
    mrId,
    qty: resolvedQty,
    note: note || '',
    status: 'pending',
    sender: sender || 'Unknown',
    unrecognized,
    createdAt: Date.now(),
    time: new Date().toTimeString().slice(0, 5),
  };
  db.get('orders').push(order).write();
  res.json({ success: true, order });
});

app.get('/ping', (req, res) => res.send('PharmaDesk is alive âœ…'));

app.listen(PORT, () => console.log(`PharmaDesk running on port ${PORT}`));
