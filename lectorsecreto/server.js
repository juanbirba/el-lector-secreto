const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE, pass TEXT, name TEXT,
    role TEXT DEFAULT '', bio TEXT DEFAULT '',
    credits INTEGER DEFAULT 2
  );
  CREATE TABLE IF NOT EXISTS stories(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER, title TEXT, genre TEXT,
    length TEXT, body TEXT, created INTEGER
  );
  CREATE TABLE IF NOT EXISTS reviews(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER, reviewer_id INTEGER,
    good TEXT, improve TEXT, overall TEXT, created INTEGER
  );
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: 'lector-secreto-dev', resave: false, saveUninitialized: false }));

const auth = (req, res, next) => req.session.uid ? next() : res.status(401).json({ error: 'No autenticado' });
const me = (req) => db.prepare('SELECT id,email,name,role,bio,credits FROM users WHERE id=?').get(req.session.uid);

// --- Auth ---
app.post('/api/register', (req, res) => {
  const { email, pass, name } = req.body;
  if (!email || !pass || !name) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const hash = bcrypt.hashSync(pass, 8);
    const r = db.prepare('INSERT INTO users(email,pass,name) VALUES(?,?,?)').run(email.toLowerCase().trim(), hash, name.trim());
    req.session.uid = r.lastInsertRowid;
    res.json(me(req));
  } catch (e) {
    res.status(400).json({ error: 'Ese email ya está registrado' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, pass } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((email || '').toLowerCase().trim());
  if (!u || !bcrypt.compareSync(pass || '', u.pass)) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  req.session.uid = u.id;
  res.json(me(req));
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', auth, (req, res) => res.json(me(req)));

app.post('/api/profile', auth, (req, res) => {
  const { role, bio } = req.body;
  db.prepare('UPDATE users SET role=?, bio=? WHERE id=?').run(role || '', bio || '', req.session.uid);
  res.json(me(req));
});

// --- Créditos según extensión ---
const REWARD = { corto: 2, largo: 4 };   // ganás al reseñar
const COST_PER_READER = { corto: 1, largo: 2 }; // pagás al publicar, por lector

// --- Publicar cuento ---
app.post('/api/stories', auth, (req, res) => {
  const { title, genre, length, body, readers } = req.body;
  if (!title || !body || !['corto', 'largo'].includes(length)) return res.status(400).json({ error: 'Datos incompletos' });
  const n = Math.max(1, Math.min(10, parseInt(readers) || 2));
  const cost = COST_PER_READER[length] * n;
  const u = me(req);
  if (u.credits < cost) return res.status(400).json({ error: `Necesitás ${cost} créditos (${COST_PER_READER[length]} × ${n} lectores). Tenés ${u.credits}.` });
  db.prepare('UPDATE users SET credits=credits-? WHERE id=?').run(cost, u.id);
  db.prepare('INSERT INTO stories(author_id,title,genre,length,body,created) VALUES(?,?,?,?,?,?)')
    .run(u.id, title.trim(), genre || '', length, body, Date.now());
  res.json({ ok: true, spent: cost });
});

// --- Sala: cuentos de otros que aún no reseñé ---
app.get('/api/feed', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id,s.title,s.genre,s.length,s.body,s.created,u.name AS author
    FROM stories s JOIN users u ON u.id=s.author_id
    WHERE s.author_id != ?
      AND s.id NOT IN (SELECT story_id FROM reviews WHERE reviewer_id=?)
    ORDER BY s.created DESC
  `).all(req.session.uid, req.session.uid);
  res.json(rows);
});

// --- Enviar devolución (gana créditos) ---
app.post('/api/reviews', auth, (req, res) => {
  const { story_id, good, improve, overall } = req.body;
  const s = db.prepare('SELECT * FROM stories WHERE id=?').get(story_id);
  if (!s) return res.status(404).json({ error: 'Cuento no encontrado' });
  if (s.author_id === req.session.uid) return res.status(400).json({ error: 'No podés reseñar tu propio cuento' });
  const dup = db.prepare('SELECT 1 FROM reviews WHERE story_id=? AND reviewer_id=?').get(story_id, req.session.uid);
  if (dup) return res.status(400).json({ error: 'Ya reseñaste este cuento' });
  if (!good || !improve || !overall) return res.status(400).json({ error: 'Completá las tres partes de la devolución' });
  db.prepare('INSERT INTO reviews(story_id,reviewer_id,good,improve,overall,created) VALUES(?,?,?,?,?,?)')
    .run(story_id, req.session.uid, good.trim(), improve.trim(), overall.trim(), Date.now());
  const reward = REWARD[s.length];
  db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(reward, req.session.uid);
  res.json({ ok: true, reward });
});

// --- Mis cuentos + devoluciones recibidas ---
app.get('/api/mine', auth, (req, res) => {
  const stories = db.prepare('SELECT * FROM stories WHERE author_id=? ORDER BY created DESC').all(req.session.uid);
  const out = stories.map(s => ({
    ...s,
    reviews: db.prepare(`
      SELECT r.good,r.improve,r.overall,r.created,u.name AS reviewer
      FROM reviews r JOIN users u ON u.id=r.reviewer_id
      WHERE r.story_id=? ORDER BY r.created DESC`).all(s.id)
  }));
  res.json(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`El lector secreto escuchando en el puerto ${PORT}`));
