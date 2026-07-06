const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// La base vive en el disco persistente si existe DATA_DIR (Railway); si no, local.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ya existe */ }
const db = new DatabaseSync(path.join(DATA_DIR, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE, pass TEXT, name TEXT,
    role TEXT DEFAULT '', bio TEXT DEFAULT '', avatar TEXT DEFAULT '',
    credits INTEGER DEFAULT 4
  );
  CREATE TABLE IF NOT EXISTS stories(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER, title TEXT, genre TEXT, type TEXT DEFAULT 'Cuento',
    length TEXT, body TEXT, created INTEGER,
    featured_status TEXT DEFAULT 'none'
  );
  CREATE TABLE IF NOT EXISTS reviews(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER, reviewer_id INTEGER,
    good TEXT, improve TEXT, overall TEXT, rating REAL DEFAULT 0,
    reveal_status TEXT DEFAULT 'none', created INTEGER
  );
  CREATE TABLE IF NOT EXISTS likes(
    story_id INTEGER, user_id INTEGER, created INTEGER,
    PRIMARY KEY (story_id, user_id)
  );
`);
// Migracion segura: agrega columnas nuevas si la base ya existia sin ellas.
for (const [col, def] of [['rating', 'REAL DEFAULT 0'], ['reveal_status', "TEXT DEFAULT 'none'"]]) {
  try { db.exec(`ALTER TABLE reviews ADD COLUMN ${col} ${def}`); } catch (e) { /* ya existe */ }
}
for (const [col, def] of [['type', "TEXT DEFAULT 'Cuento'"], ['featured_status', "TEXT DEFAULT 'none'"]]) {
  try { db.exec(`ALTER TABLE stories ADD COLUMN ${col} ${def}`); } catch (e) { /* ya existe */ }
}
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''"); } catch (e) { /* ya existe */ }

// Semilla: un cuento de ejemplo para que el "Texto de la semana" no arranque vacío.
// Solo corre si no hay ningún cuento todavía.
const storyCount = db.prepare('SELECT COUNT(*) AS c FROM stories').get().c;
if (storyCount === 0) {
  const seedHash = bcrypt.hashSync('ejemplo-lector-secreto', 8);
  const author = db.prepare('INSERT INTO users(email,pass,name,role,bio,credits) VALUES(?,?,?,?,?,?)')
    .run('ejemplo@ellectorsecreto.app', seedHash, 'Camila Ferreyra',
      'Escritora en talleres', 'Escribo cuentos breves. Me interesa lo que queda sin decir.', 0);
  const reader = db.prepare('INSERT INTO users(email,pass,name,role,bio,credits) VALUES(?,?,?,?,?,?)')
    .run('lectora@ellectorsecreto.app', seedHash, 'Lectora invitada', 'Lectora apasionada', '', 0);
  const body = `Mi abuela guardaba las cartas en una lata de galletas escocesas, de esas azules con un castillo dibujado. Nunca me dejo leerlas. "Cuando yo no este", decia, y seguia pelando papas como si eso zanjara el asunto.

El dia que no estuvo, abri la lata. Adentro no habia cartas: habia semillas. Docenas de sobrecitos de papel, cada uno con una letra distinta, cada uno con una fecha. La mas vieja era de 1961. La mas nueva, de la primavera pasada.

Tarde en entender que mi abuela no coleccionaba palabras. Coleccionaba primaveras que todavia no habian pasado. Cada vez que alguien le hacia dano, en lugar de guardar rencor, guardaba una semilla, y anotaba el dia en que pensaba plantarla.

Este otono plante todas juntas en el fondo de casa. No se que va a crecer. Pero cuando salga el sol, voy a saber exactamente a quien perdono, y cuando.`;
  const story = db.prepare('INSERT INTO stories(author_id,title,genre,type,length,body,created,featured_status) VALUES(?,?,?,?,?,?,?,?)')
    .run(author.lastInsertRowid, 'La lata de galletas', 'Realismo', 'Cuento', 'corto', body, Date.now(), 'approved');
  db.prepare('INSERT INTO reviews(story_id,reviewer_id,good,improve,overall,rating,reveal_status,created) VALUES(?,?,?,?,?,?,?,?)')
    .run(story.lastInsertRowid, reader.lastInsertRowid,
      'La imagen de las semillas como primaveras guardadas es preciosa y original.',
      'El segundo parrafo podria respirar un poco mas antes del giro.',
      'Me dejo pensando un buen rato. Un cierre que ilumina todo lo anterior.',
      4.5, 'none', Date.now());
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: 'lector-secreto-dev', resave: false, saveUninitialized: false }));

const ADMIN_EMAIL = 'juanbirba@gmail.com';
const auth = (req, res, next) => req.session.uid ? next() : res.status(401).json({ error: 'No autenticado' });
const me = (req) => {
  const u = db.prepare('SELECT id,email,name,role,bio,avatar,credits FROM users WHERE id=?').get(req.session.uid);
  if (u) u.is_admin = (u.email === ADMIN_EMAIL);
  return u;
};
const adminOnly = (req, res, next) => {
  const u = db.prepare('SELECT email FROM users WHERE id=?').get(req.session.uid);
  if (!u || u.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Solo el administrador puede ver esto' });
  next();
};

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
  const { role, bio, avatar } = req.body;
  // avatar es un data URL (imagen). Limitamos tamaño para no llenar la base.
  let av = typeof avatar === 'string' ? avatar : '';
  if (av && av.length > 700000) return res.status(400).json({ error: 'La imagen es muy pesada. Probá con una más chica.' });
  if (av && !/^data:image\//.test(av)) av = '';
  if (avatar === undefined) {
    db.prepare('UPDATE users SET role=?, bio=? WHERE id=?').run(role || '', bio || '', req.session.uid);
  } else {
    db.prepare('UPDATE users SET role=?, bio=?, avatar=? WHERE id=?').run(role || '', bio || '', av, req.session.uid);
  }
  res.json(me(req));
});

// --- Escritores: comunidad visible para todos ---
app.get('/api/writers', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.role, u.bio, u.avatar,
           (SELECT COUNT(*) FROM stories s WHERE s.author_id=u.id) AS stories_count,
           (SELECT COUNT(*) FROM reviews r WHERE r.reviewer_id=u.id) AS reviews_count
    FROM users u
    WHERE u.email NOT LIKE '%@ellectorsecreto.app'
    ORDER BY (stories_count + reviews_count) DESC, u.name ASC
  `).all();
  res.json(rows);
});

// --- Panel de admin (solo juanbirba@gmail.com) ---
app.get('/api/admin/overview', auth, adminOnly, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.credits,
           (SELECT COUNT(*) FROM stories s WHERE s.author_id=u.id) AS stories_count,
           (SELECT COUNT(*) FROM reviews r WHERE r.reviewer_id=u.id) AS reviews_count
    FROM users u ORDER BY u.id ASC
  `).all();
  const stories = db.prepare(`
    SELECT s.id, s.title, s.genre, s.type, s.length, s.created, u.name AS author,
           (SELECT COUNT(*) FROM reviews r WHERE r.story_id=s.id) AS reviews_count,
           (SELECT AVG(rating) FROM reviews r WHERE r.story_id=s.id AND r.rating>0) AS avg_rating
    FROM stories s JOIN users u ON u.id=s.author_id ORDER BY s.created DESC
  `).all();
  const reviews = db.prepare(`
    SELECT r.id, r.good, r.improve, r.overall, r.rating, r.created,
           s.title AS story_title, ur.name AS reviewer_name, ua.name AS author_name
    FROM reviews r
    JOIN stories s ON s.id=r.story_id
    JOIN users ur ON ur.id=r.reviewer_id
    JOIN users ua ON ua.id=s.author_id
    ORDER BY r.created DESC
  `).all();
  const stats = {
    total_users: users.length,
    total_stories: stories.length,
    total_reviews: reviews.length
  };
  res.json({ stats, users, stories, reviews });
});

// --- Créditos según extensión ---
const REWARD = { corto: 2, largo: 4 };   // ganás al reseñar
const COST_PER_READER = { corto: 1, largo: 2 }; // pagás al publicar, por lector

// --- Publicar texto ---
const TIPOS = ['Relato', 'Cuento', 'Reseña', 'Capítulo de novela', 'Guión', 'Otro'];
app.post('/api/stories', auth, (req, res) => {
  const { title, genre, type, length, body, readers } = req.body;
  if (!title || !body || !['corto', 'largo'].includes(length)) return res.status(400).json({ error: 'Datos incompletos' });
  const tipo = TIPOS.includes(type) ? type : 'Cuento';
  const n = Math.max(1, Math.min(10, parseInt(readers) || 2));
  const cost = COST_PER_READER[length] * n;
  const u = me(req);
  if (u.credits < cost) return res.status(400).json({ error: `Necesitás ${cost} créditos (${COST_PER_READER[length]} × ${n} lectores). Tenés ${u.credits}.` });
  db.prepare('UPDATE users SET credits=credits-? WHERE id=?').run(cost, u.id);
  db.prepare('INSERT INTO stories(author_id,title,genre,type,length,body,created) VALUES(?,?,?,?,?,?,?)')
    .run(u.id, title.trim(), genre || '', tipo, length, body, Date.now());
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

// --- Lógica del Texto de la semana ---
// El mejor puntuado (no rechazado) es siempre el candidato. Si supera al destacado
// actual, se le ofrece el puesto a su autor (queda 'pending' hasta que apruebe).
function refreshFeatured() {
  const pending = db.prepare("SELECT id FROM stories WHERE featured_status='pending'").get();
  if (pending) return; // ya hay uno esperando respuesta de su autor

  // Mejor candidato global que no haya sido rechazado
  const cand = db.prepare(`
    SELECT s.id, s.featured_status, AVG(r.rating) AS avg_rating, COUNT(r.id) AS votes
    FROM stories s
    JOIN reviews r ON r.story_id = s.id AND r.rating > 0
    WHERE s.featured_status != 'declined'
    GROUP BY s.id
    HAVING votes >= 1
    ORDER BY avg_rating DESC, votes DESC, s.created DESC
    LIMIT 1
  `).get();
  if (!cand) return;
  // Si el mejor candidato ya es el aprobado, no hay nada que hacer
  if (cand.featured_status === 'approved') return;
  // Si hay un aprobado actual, solo lo destronamos si el candidato tiene mejor promedio
  const current = db.prepare("SELECT id, (SELECT AVG(rating) FROM reviews r WHERE r.story_id=stories.id AND r.rating>0) AS avg_rating FROM stories WHERE featured_status='approved'").get();
  if (current && cand.avg_rating <= current.avg_rating) return; // el actual sigue siendo el mejor o igual
  // El candidato merece el puesto: se lo ofrecemos a su autor
  db.prepare("UPDATE stories SET featured_status='pending' WHERE id=?").run(cand.id);
}

// El texto de la semana PÚBLICO (solo si el autor lo aprobó)
app.get('/api/featured', auth, (req, res) => {
  refreshFeatured();
  const row = db.prepare(`
    SELECT s.id, s.title, s.genre, s.type, s.length, s.body, u.name AS author,
           (SELECT AVG(rating) FROM reviews r WHERE r.story_id=s.id AND r.rating>0) AS avg_rating,
           (SELECT COUNT(*) FROM likes l WHERE l.story_id=s.id) AS likes,
           EXISTS(SELECT 1 FROM likes l WHERE l.story_id=s.id AND l.user_id=?) AS liked_by_me
    FROM stories s JOIN users u ON u.id=s.author_id
    WHERE s.featured_status='approved'
    LIMIT 1
  `).get(req.session.uid);
  res.json(row || null);
});

// ¿Tengo un texto elegido esperando mi aprobación como autor?
app.get('/api/featured/pending', auth, (req, res) => {
  refreshFeatured();
  const row = db.prepare(`
    SELECT id, title FROM stories
    WHERE featured_status='pending' AND author_id=?
    LIMIT 1
  `).get(req.session.uid);
  res.json(row || null);
});

// El autor aprueba o rechaza que su texto sea el destacado público
app.post('/api/featured/respond', auth, (req, res) => {
  const { story_id, accept } = req.body;
  const s = db.prepare('SELECT * FROM stories WHERE id=?').get(story_id);
  if (!s) return res.status(404).json({ error: 'Texto no encontrado' });
  if (s.author_id !== req.session.uid) return res.status(403).json({ error: 'No es tu texto' });
  if (s.featured_status !== 'pending') return res.status(400).json({ error: 'Este texto ya no está pendiente' });
  if (accept) {
    // El nuevo destacado reemplaza al anterior
    db.prepare("UPDATE stories SET featured_status='past' WHERE featured_status='approved'").run();
    db.prepare("UPDATE stories SET featured_status='approved' WHERE id=?").run(story_id);
  } else {
    db.prepare("UPDATE stories SET featured_status='declined' WHERE id=?").run(story_id);
    refreshFeatured(); // ofrecer el puesto al siguiente mejor
  }
  res.json({ ok: true });
});

// Like / unlike al texto de la semana (público)
app.post('/api/like', auth, (req, res) => {
  const { story_id } = req.body;
  const s = db.prepare("SELECT id FROM stories WHERE id=? AND featured_status='approved'").get(story_id);
  if (!s) return res.status(404).json({ error: 'Texto no disponible' });
  const has = db.prepare('SELECT 1 FROM likes WHERE story_id=? AND user_id=?').get(story_id, req.session.uid);
  if (has) db.prepare('DELETE FROM likes WHERE story_id=? AND user_id=?').run(story_id, req.session.uid);
  else db.prepare('INSERT INTO likes(story_id,user_id,created) VALUES(?,?,?)').run(story_id, req.session.uid, Date.now());
  const likes = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE story_id=?').get(story_id).c;
  res.json({ ok: true, likes, liked_by_me: !has });
});

// --- Enviar devolución (gana créditos) ---
app.post('/api/reviews', auth, (req, res) => {
  const { story_id, good, improve, overall, rating } = req.body;
  const s = db.prepare('SELECT * FROM stories WHERE id=?').get(story_id);
  if (!s) return res.status(404).json({ error: 'Cuento no encontrado' });
  if (s.author_id === req.session.uid) return res.status(400).json({ error: 'No podés reseñar tu propio cuento' });
  const dup = db.prepare('SELECT 1 FROM reviews WHERE story_id=? AND reviewer_id=?').get(story_id, req.session.uid);
  if (dup) return res.status(400).json({ error: 'Ya reseñaste este cuento' });
  if (!good || !improve || !overall) return res.status(400).json({ error: 'Completá las tres partes de la devolución' });
  let r = parseFloat(rating);
  if (isNaN(r) || r < 0.5 || r > 5) return res.status(400).json({ error: 'Elegí una puntuación de estrellas' });
  r = Math.round(r * 2) / 2; // redondea a media estrella
  db.prepare('INSERT INTO reviews(story_id,reviewer_id,good,improve,overall,rating,created) VALUES(?,?,?,?,?,?,?)')
    .run(story_id, req.session.uid, good.trim(), improve.trim(), overall.trim(), r, Date.now());
  const reward = REWARD[s.length];
  db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(reward, req.session.uid);
  res.json({ ok: true, reward });
});

// --- Mis cuentos + devoluciones recibidas (anónimas, con opción de descubrir) ---
app.get('/api/mine', auth, (req, res) => {
  const stories = db.prepare('SELECT * FROM stories WHERE author_id=? ORDER BY created DESC').all(req.session.uid);
  const out = stories.map(s => {
    const raw = db.prepare(`
      SELECT r.id,r.good,r.improve,r.overall,r.rating,r.reveal_status,r.created,u.name AS reviewer_name
      FROM reviews r JOIN users u ON u.id=r.reviewer_id
      WHERE r.story_id=? ORDER BY r.created DESC`).all(s.id);
    const reviews = raw.map((r, i) => ({
      id: r.id,
      good: r.good, improve: r.improve, overall: r.overall, rating: r.rating, created: r.created,
      reveal_status: r.reveal_status,
      // El nombre solo se muestra si el lector aceptó descubrirse.
      alias: `Lector secreto #${raw.length - i}`,
      reviewer_name: r.reveal_status === 'accepted' ? r.reviewer_name : null
    }));
    const rated = reviews.filter(r => r.rating > 0);
    const avg = rated.length ? (rated.reduce((a, r) => a + r.rating, 0) / rated.length) : null;
    return { ...s, reviews, avg_rating: avg, rating_count: rated.length };
  });
  res.json(out);
});

// --- El escritor pide descubrir a un lector secreto ---
app.post('/api/reveal/request', auth, (req, res) => {
  const { review_id } = req.body;
  const r = db.prepare('SELECT r.*, s.author_id FROM reviews r JOIN stories s ON s.id=r.story_id WHERE r.id=?').get(review_id);
  if (!r) return res.status(404).json({ error: 'Devolución no encontrada' });
  if (r.author_id !== req.session.uid) return res.status(403).json({ error: 'No es tu cuento' });
  if (r.reveal_status === 'accepted') return res.status(400).json({ error: 'Ya se descubrió' });
  db.prepare("UPDATE reviews SET reveal_status='requested' WHERE id=?").run(review_id);
  res.json({ ok: true });
});

// --- Pedidos de descubrimiento que me llegaron como lector ---
app.get('/api/reveal/pending', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, s.title, u.name AS author_name
    FROM reviews r JOIN stories s ON s.id=r.story_id JOIN users u ON u.id=s.author_id
    WHERE r.reviewer_id=? AND r.reveal_status='requested'
    ORDER BY r.created DESC`).all(req.session.uid);
  res.json(rows);
});

// --- El lector acepta o rechaza descubrirse ---
app.post('/api/reveal/respond', auth, (req, res) => {
  const { review_id, accept } = req.body;
  const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(review_id);
  if (!r) return res.status(404).json({ error: 'Devolución no encontrada' });
  if (r.reviewer_id !== req.session.uid) return res.status(403).json({ error: 'No es tu devolución' });
  db.prepare('UPDATE reviews SET reveal_status=? WHERE id=?').run(accept ? 'accepted' : 'declined', review_id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`El lector secreto escuchando en el puerto ${PORT}`));
