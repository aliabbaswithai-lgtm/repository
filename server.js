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

const otpStore = {};

app.post('/api/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email || email !== process.env.ADMIN_EMAIL)
    return res.json({ success: false, message: 'Email not authorized.' });
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otpStore[email] = { otp, expiry: Date.now() + 5 * 60 * 1000 };
  await transporter.sendMail({
    from: `"${process.env.PHARMACY_NAME}" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `${otp} — Your PharmaDesk OTP`,
    html: `<h2>Your OTP: <b>${otp}</b></h2><p>Expires in 5 minutes.</p>`,
  });
  res.json({ success: true });
});

app.post('/api/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const record = otpStore[email];
  if (!record) return res.json({ success: false, message: 'No OTP found.' });
  if (Date.now() > record.expiry) return res.json({ success: false, message: 'OTP expired.' });
  if (record.otp !== otp) return res.json({ success: false, message: 'Incorrect OTP.' });
  delete otpStore[email];
  const token = uuidv4();
  db.get('sessions').push({ token, email, createdAt: Date.now() }).write();
  res.json({ success: true, token });
});

function auth(req, res, next) {
  const token = req.headers['authorization'];
  if (!db.get('sessions').find({ token }).value())
    return res.status(401).json({ success: false });
  next();
}

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

app.get('/ping', (req, res) => res.send('PharmaDesk is alive ✅'));

app.listen(PORT, () => console.log(`PharmaDesk running on port ${PORT}`));
