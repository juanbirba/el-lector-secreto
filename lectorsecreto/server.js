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
    featured_status TEXT DEFAULT 'none',
    group_id INTEGER DEFAULT 0,
    featured_status_group TEXT DEFAULT 'none'
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
  CREATE TABLE IF NOT EXISTS editorial(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT DEFAULT 'nota', title TEXT, body TEXT,
    link TEXT DEFAULT '', created INTEGER
  );
  CREATE TABLE IF NOT EXISTS groups(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, pass TEXT, created INTEGER
  );
  CREATE TABLE IF NOT EXISTS group_members(
    group_id INTEGER, user_id INTEGER, joined INTEGER,
    PRIMARY KEY (group_id, user_id)
  );
`);
// Migracion segura: agrega columnas nuevas si la base ya existia sin ellas.
for (const [col, def] of [['rating', 'REAL DEFAULT 0'], ['reveal_status', "TEXT DEFAULT 'none'"]]) {
  try { db.exec(`ALTER TABLE reviews ADD COLUMN ${col} ${def}`); } catch (e) { /* ya existe */ }
}
for (const [col, def] of [['type', "TEXT DEFAULT 'Cuento'"], ['featured_status', "TEXT DEFAULT 'none'"], ['group_id', 'INTEGER DEFAULT 0'], ['featured_status_group', "TEXT DEFAULT 'none'"]]) {
  try { db.exec(`ALTER TABLE stories ADD COLUMN ${col} ${def}`); } catch (e) { /* ya existe */ }
}
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''"); } catch (e) { /* ya existe */ }
for (const [col, def] of [['sec_question', "TEXT DEFAULT ''"], ['sec_answer', "TEXT DEFAULT ''"]]) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`); } catch (e) { /* ya existe */ }
}

// Seed: grupo "Taller de los jueves - Miguel Bruno" con su contraseña, si no existe.
{
  const exists = db.prepare('SELECT id FROM groups WHERE name=?').get('Taller de los jueves - Miguel Bruno');
  if (!exists) {
    db.prepare('INSERT INTO groups(name,pass,created) VALUES(?,?,?)')
      .run('Taller de los jueves - Miguel Bruno', bcrypt.hashSync('abelardo', 8), Date.now());
  }
}

// --- Créditos: cálculo automático por carillas ---
const WORDS_PER_PAGE = 275; // ~275 palabras = 1 carilla
function countPages(body) {
  const words = (body || '').trim().split(/\s+/).filter(Boolean).length;
  return words / WORDS_PER_PAGE;
}
// Tramo de 5 carillas: 5.0 -> tramo 1; 5.1 -> tramo 2; 10.0 -> tramo 2; 10.1 -> tramo 3
function tier(pages) {
  const t = Math.ceil((pages - 1e-9) / 5);
  return Math.max(1, t);
}
const costPerReader = (pages) => tier(pages);        // créditos por lector al publicar
const rewardForReading = (pages) => tier(pages) * 2; // créditos al dar devolución


// Semilla: una nota editorial de bienvenida, solo si no hay ninguna.
const edCount = db.prepare('SELECT COUNT(*) AS c FROM editorial').get().c;
if (edCount === 0) {
  db.prepare('INSERT INTO editorial(kind,title,body,link,created) VALUES(?,?,?,?,?)')
    .run('nota', 'Bienvenidos a El lector secreto',
      'Este es un espacio hecho por escritores y para escritores. Acá compartimos nuestros textos, nos leemos con honestidad y cuidamos las obras de los demás como quisiéramos que cuidaran las nuestras. Que la lectura secreta los encuentre.',
      '', Date.now());
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/api/register', (req, res) => {
  const { email, pass, name, sec_question, sec_answer } = req.body;
  if (!email || !pass || !name) return res.status(400).json({ error: 'Faltan datos' });
  const mail = String(email).toLowerCase().trim();
  if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: 'Ingresá un email válido (ej: nombre@correo.com)' });
  if (String(pass).length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
  if (!sec_question || !sec_answer) return res.status(400).json({ error: 'Completá la pregunta y respuesta de seguridad para poder recuperar tu contraseña' });
  try {
    const hash = bcrypt.hashSync(pass, 8);
    const secHash = bcrypt.hashSync(String(sec_answer).toLowerCase().trim(), 8);
    const r = db.prepare('INSERT INTO users(email,pass,name,sec_question,sec_answer) VALUES(?,?,?,?,?)')
      .run(mail, hash, name.trim(), String(sec_question).trim(), secHash);
    req.session.uid = r.lastInsertRowid;
    res.json(me(req));
  } catch (e) {
    res.status(400).json({ error: 'Ese email ya está registrado' });
  }
});

// Recuperar contraseña: paso 1, obtener la pregunta de seguridad del email
app.post('/api/recover/question', (req, res) => {
  const mail = String(req.body.email || '').toLowerCase().trim();
  const u = db.prepare('SELECT sec_question FROM users WHERE email=?').get(mail);
  if (!u || !u.sec_question) return res.status(404).json({ error: 'No encontramos una cuenta con esa pregunta de seguridad para ese email' });
  res.json({ question: u.sec_question });
});

// Recuperar contraseña: paso 2, verificar respuesta y fijar nueva contraseña
app.post('/api/recover/reset', (req, res) => {
  const mail = String(req.body.email || '').toLowerCase().trim();
  const { answer, new_pass } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(mail);
  if (!u) return res.status(404).json({ error: 'Cuenta no encontrada' });
  if (!bcrypt.compareSync(String(answer || '').toLowerCase().trim(), u.sec_answer)) {
    return res.status(401).json({ error: 'La respuesta de seguridad no coincide' });
  }
  if (String(new_pass || '').length < 4) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres' });
  db.prepare('UPDATE users SET pass=? WHERE id=?').run(bcrypt.hashSync(new_pass, 8), u.id);
  res.json({ ok: true });
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

// --- Columna editorial (visible para todos, editable solo por el admin) ---
app.get('/api/editorial', auth, (req, res) => {
  const rows = db.prepare('SELECT id, kind, title, body, link, created FROM editorial ORDER BY created DESC LIMIT 20').all();
  res.json(rows);
});
app.post('/api/editorial', auth, adminOnly, (req, res) => {
  const { kind, title, body, link } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Falta título o contenido' });
  const k = ['nota', 'cuento', 'noticia'].includes(kind) ? kind : 'nota';
  db.prepare('INSERT INTO editorial(kind,title,body,link,created) VALUES(?,?,?,?,?)')
    .run(k, title.trim(), body.trim(), (link || '').trim(), Date.now());
  res.json({ ok: true });
});
app.delete('/api/editorial/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM editorial WHERE id=?').run(parseInt(req.params.id));
  res.json({ ok: true });
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

// --- Borrar un texto (cascada: devoluciones y likes; NO toca créditos de quien reseñó) ---
app.delete('/api/admin/story/:id', auth, adminOnly, (req, res) => {
  const id = parseInt(req.params.id);
  const s = db.prepare('SELECT id FROM stories WHERE id=?').get(id);
  if (!s) return res.status(404).json({ error: 'Texto no encontrado' });
  db.prepare('DELETE FROM reviews WHERE story_id=?').run(id);
  db.prepare('DELETE FROM likes WHERE story_id=?').run(id);
  db.prepare('DELETE FROM stories WHERE id=?').run(id);
  res.json({ ok: true });
});

// --- Borrar un usuario (cascada completa: sus textos, devoluciones y likes) ---
app.delete('/api/admin/user/:id', auth, adminOnly, (req, res) => {
  const id = parseInt(req.params.id);
  const u = db.prepare('SELECT id, email FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.email === ADMIN_EMAIL) return res.status(400).json({ error: 'No podés borrar la cuenta de administrador' });
  // Borrar reviews sobre los textos de este usuario, y sus textos
  const stories = db.prepare('SELECT id FROM stories WHERE author_id=?').all(id);
  for (const st of stories) {
    db.prepare('DELETE FROM reviews WHERE story_id=?').run(st.id);
    db.prepare('DELETE FROM likes WHERE story_id=?').run(st.id);
  }
  db.prepare('DELETE FROM stories WHERE author_id=?').run(id);
  // Borrar las reviews y likes que este usuario hizo sobre textos de otros
  db.prepare('DELETE FROM reviews WHERE reviewer_id=?').run(id);
  db.prepare('DELETE FROM likes WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

// --- Publicar texto ---
const TIPOS = ['Relato', 'Cuento', 'Reseña', 'Capítulo de novela', 'Guión', 'Otro'];
app.post('/api/stories', auth, (req, res) => {
  const { title, genre, type, body, readers, group_id, group_pass } = req.body;
  if (!title || !body || body.trim().length < 20) return res.status(400).json({ error: 'Datos incompletos' });
  const tipo = TIPOS.includes(type) ? type : 'Cuento';
  const n = Math.max(1, Math.min(10, parseInt(readers) || 2));
  const gid = parseInt(group_id) || 0;
  // Si publica en un grupo y no es miembro, intentar unirlo con la contraseña provista
  if (gid) {
    const g = db.prepare('SELECT * FROM groups WHERE id=?').get(gid);
    if (!g) return res.status(404).json({ error: 'Grupo no encontrado' });
    if (!isMember(req.session.uid, gid)) {
      if (!bcrypt.compareSync(String(group_pass || ''), g.pass)) {
        return res.status(401).json({ error: 'Para publicar en este grupo necesitás la contraseña correcta.' });
      }
      db.prepare('INSERT OR IGNORE INTO group_members(group_id,user_id,joined) VALUES(?,?,?)').run(gid, req.session.uid, Date.now());
    }
  }
  const pages = countPages(body);
  const per = costPerReader(pages);
  const cost = per * n;
  const u = me(req);
  if (u.credits < cost) {
    return res.status(400).json({ error: 'Necesitás más créditos. Conseguilos leyendo el material de un colega y dándole una devolución.' });
  }
  db.prepare('UPDATE users SET credits=credits-? WHERE id=?').run(cost, u.id);
  db.prepare('INSERT INTO stories(author_id,title,genre,type,length,body,created,group_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(u.id, title.trim(), genre || '', tipo, String(pages.toFixed(2)), body, Date.now(), gid);
  res.json({ ok: true, spent: cost });
});

// --- Sala: cuentos de otros que aún no reseñé ---
// --- Grupos (salas privadas) ---
function isMember(uid, gid) {
  if (!gid) return true; // la general (0) es de todos
  return !!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gid, uid);
}

// Listar grupos: cuáles existen y de cuáles soy miembro
app.get('/api/groups', auth, (req, res) => {
  const groups = db.prepare('SELECT id, name, created FROM groups ORDER BY created ASC').all();
  const out = groups.map(g => ({
    id: g.id, name: g.name,
    is_member: isMember(req.session.uid, g.id),
    members_count: db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id=?').get(g.id).c
  }));
  res.json(out);
});

// Unirse a un grupo con contraseña (queda como miembro para siempre)
app.post('/api/groups/join', auth, (req, res) => {
  const { group_id, pass } = req.body;
  const g = db.prepare('SELECT * FROM groups WHERE id=?').get(group_id);
  if (!g) return res.status(404).json({ error: 'Grupo no encontrado' });
  if (isMember(req.session.uid, g.id)) return res.json({ ok: true, already: true });
  if (!bcrypt.compareSync(String(pass || ''), g.pass)) return res.status(401).json({ error: 'Contraseña incorrecta' });
  db.prepare('INSERT OR IGNORE INTO group_members(group_id,user_id,joined) VALUES(?,?,?)').run(g.id, req.session.uid, Date.now());
  res.json({ ok: true });
});

// Miembros de un grupo (solo si soy miembro)
app.get('/api/groups/:id/members', auth, (req, res) => {
  const gid = parseInt(req.params.id);
  if (!isMember(req.session.uid, gid)) return res.status(403).json({ error: 'No sos miembro de este grupo' });
  const rows = db.prepare(`
    SELECT u.id, u.name, u.role, u.avatar
    FROM group_members gm JOIN users u ON u.id=gm.user_id
    WHERE gm.group_id=? ORDER BY gm.joined ASC
  `).all(gid);
  res.json(rows);
});

// --- Feed: textos por sala (general por defecto, o un grupo si soy miembro) ---
app.get('/api/feed', auth, (req, res) => {
  const gid = parseInt(req.query.group_id) || 0;
  if (gid && !isMember(req.session.uid, gid)) return res.status(403).json({ error: 'No sos miembro de este grupo' });
  const rows = db.prepare(`
    SELECT s.id,s.title,s.genre,s.type,s.length,s.body,s.created,u.name AS author
    FROM stories s JOIN users u ON u.id=s.author_id
    WHERE s.author_id != ?
      AND s.group_id = ?
      AND s.id NOT IN (SELECT story_id FROM reviews WHERE reviewer_id=?)
    ORDER BY s.created DESC
  `).all(req.session.uid, gid, req.session.uid);
  res.json(rows);
});

// --- Lógica del Texto de la semana (SALA GENERAL) ---
// Solo considera textos de la general (group_id=0). Requiere aprobación del autor.
function refreshFeatured() {
  const pending = db.prepare("SELECT id FROM stories WHERE featured_status='pending' AND group_id=0").get();
  if (pending) return;
  const cand = db.prepare(`
    SELECT s.id, s.featured_status, AVG(r.rating) AS avg_rating, COUNT(r.id) AS votes
    FROM stories s
    JOIN reviews r ON r.story_id = s.id AND r.rating > 0
    WHERE s.featured_status != 'declined' AND s.group_id=0
    GROUP BY s.id
    HAVING votes >= 1
    ORDER BY avg_rating DESC, votes DESC, s.created DESC
    LIMIT 1
  `).get();
  if (!cand) return;
  if (cand.featured_status === 'approved') return;
  const current = db.prepare("SELECT id, (SELECT AVG(rating) FROM reviews r WHERE r.story_id=stories.id AND r.rating>0) AS avg_rating FROM stories WHERE featured_status='approved' AND group_id=0").get();
  if (current && cand.avg_rating <= current.avg_rating) return;
  db.prepare("UPDATE stories SET featured_status='pending' WHERE id=?").run(cand.id);
}

// --- Texto de la semana de un GRUPO (auto-aprobado, sin pedir permiso) ---
function refreshFeaturedGroup(gid) {
  if (!gid) return;
  const cand = db.prepare(`
    SELECT s.id, AVG(r.rating) AS avg_rating, COUNT(r.id) AS votes
    FROM stories s
    JOIN reviews r ON r.story_id = s.id AND r.rating > 0
    WHERE s.group_id=?
    GROUP BY s.id
    HAVING votes >= 1
    ORDER BY avg_rating DESC, votes DESC, s.created DESC
    LIMIT 1
  `).get(gid);
  // Limpiar el destacado anterior del grupo y marcar el nuevo (auto-aprobado)
  db.prepare("UPDATE stories SET featured_status_group='none' WHERE group_id=? AND featured_status_group='approved'").run(gid);
  if (!cand) return;
  db.prepare("UPDATE stories SET featured_status_group='approved' WHERE id=?").run(cand.id);
  // ¿Este texto del grupo es mejor que el mejor de la general? -> ofrecer salto a la general
  const noPendingGeneral = !db.prepare("SELECT 1 FROM stories WHERE featured_status='pending' AND group_id=0").get();
  const alreadyOffered = db.prepare("SELECT featured_status FROM stories WHERE id=?").get(cand.id).featured_status;
  if (noPendingGeneral && alreadyOffered === 'none') {
    const generalBest = db.prepare("SELECT (SELECT AVG(rating) FROM reviews r WHERE r.story_id=stories.id AND r.rating>0) AS avg_rating FROM stories WHERE featured_status='approved' AND group_id=0").get();
    const bestAvg = generalBest ? generalBest.avg_rating : 0;
    if (cand.avg_rating > (bestAvg || 0)) {
      // Se ofrece al autor que aparezca TAMBIÉN en la general (queda pending en el canal general)
      db.prepare("UPDATE stories SET featured_status='pending' WHERE id=?").run(cand.id);
    }
  }
}

// El texto de la semana (general si group_id=0, o del grupo). Devuelve también si puede saltar a la general.
app.get('/api/featured', auth, (req, res) => {
  const gid = parseInt(req.query.group_id) || 0;
  if (gid && !isMember(req.session.uid, gid)) return res.status(403).json({ error: 'No sos miembro' });
  if (gid) {
    refreshFeaturedGroup(gid);
    const row = db.prepare(`
      SELECT s.id, s.title, s.genre, s.type, s.length, s.body, u.name AS author,
             (SELECT AVG(rating) FROM reviews r WHERE r.story_id=s.id AND r.rating>0) AS avg_rating,
             (SELECT COUNT(*) FROM likes l WHERE l.story_id=s.id) AS likes,
             EXISTS(SELECT 1 FROM likes l WHERE l.story_id=s.id AND l.user_id=?) AS liked_by_me
      FROM stories s JOIN users u ON u.id=s.author_id
      WHERE s.featured_status_group='approved' AND s.group_id=?
      LIMIT 1
    `).get(req.session.uid, gid);
    return res.json(row || null);
  }
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

// ¿Tengo un texto elegido esperando mi aprobación como autor? (solo general)
app.get('/api/featured/pending', auth, (req, res) => {
  refreshFeatured();
  const row = db.prepare(`
    SELECT id, title FROM stories
    WHERE featured_status='pending' AND author_id=? AND group_id=0
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
  const reward = rewardForReading(countPages(s.body));
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

// --- Notificaciones: junta todos los avisos pendientes del usuario ---
app.get('/api/notifications', auth, (req, res) => {
  refreshFeatured();
  const notes = [];
  // Pedidos de descubrimiento que me llegaron como lector
  const reveals = db.prepare(`
    SELECT r.id, s.title, u.name AS author_name, r.created
    FROM reviews r JOIN stories s ON s.id=r.story_id JOIN users u ON u.id=s.author_id
    WHERE r.reviewer_id=? AND r.reveal_status='requested'
    ORDER BY r.created DESC`).all(req.session.uid);
  reveals.forEach(x => notes.push({
    kind: 'reveal', id: x.id, title: x.title, author_name: x.author_name, created: x.created
  }));
  // ¿Mi texto fue elegido como texto de la semana y espera mi aprobación?
  // Si el texto pertenece a un grupo, es la oferta de "saltar a la general".
  const feat = db.prepare(`
    SELECT s.id, s.title, s.created, s.group_id, g.name AS group_name
    FROM stories s LEFT JOIN groups g ON g.id=s.group_id
    WHERE s.featured_status='pending' AND s.author_id=?`).all(req.session.uid);
  feat.forEach(x => notes.push({
    kind: 'featured', id: x.id, title: x.title, created: x.created,
    from_group: x.group_id ? true : false, group_name: x.group_name || null
  }));
  notes.sort((a, b) => b.created - a.created);
  res.json({ count: notes.length, notes });
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
