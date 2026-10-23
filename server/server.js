'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('./db');
const crypto = require('node:crypto');
const { creerAuth, hacherMotDePasse, nouvelleVersion } = require('./auth');
const { creerTwoFactor } = require('./twofa');
const { creerCollecteur } = require('./collecte');
const { sonder, lireOpml, ecrireOpml, urlHttp, autoriserReseauPrive } = require('./feeds');
const { creerSauvegardes } = require('./sauvegardes');

const VERSION = require('../package.json').version;

/* ---------- Configuration ---------- */

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const entier = (k, d, min, max) => {
  const n = parseInt(env(k, d), 10);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : d));
};
const PORT = entier('PORT', 3000, 1, 65535);
const DATA_DIR = path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data')));
const ADMIN_USER = env('ADMIN_USER', 'admin');
const ADMIN_PASSWORD = env('ADMIN_PASSWORD', '');
const INTERVALLE = entier('FETCH_INTERVAL', 30, 5, 1440);
const SIMULTANES = entier('FETCH_CONCURRENCY', 6, 1, 20);
const RETENTION = entier('RETENTION_DAYS', 30, 2, 365);
const vrai = (k, d) => /^(1|true|oui|yes)$/i.test(env(k, d));
const ALLOW_PRIVATE_FEEDS = vrai('ALLOW_PRIVATE_FEEDS', '0'); // 1 : autorise les flux du réseau local (192.168.x…)
const MAX_FEEDS = entier('MAX_FEEDS_PER_USER', 300, 1, 5000);
const BACKUP_DAYS = entier('BACKUP_DAYS', 30, 1, 3650);   // copies quotidiennes conservées
const HOST_DIR = path.resolve(env('HOST_DIR', '/app/host')); // .env et docker-compose.yml montés en lecture seule
const COOKIE_SECURE = vrai('COOKIE_SECURE', '0');      // 1 si l'application est servie uniquement en HTTPS
const TRUST_PROXY = vrai('TRUST_PROXY', '0');          // 1 derrière Nginx Proxy Manager : vraie IP client
const SESSION_HOURS = entier('SESSION_HOURS', 720, 1, 24 * 365);
const TRUST_DAYS = entier('TRUST_DAYS', 30, 0, 365);   // « se souvenir de cet appareil » (0 = désactivé)
const ADMIN_REQUIRE_2FA = vrai('ADMIN_REQUIRE_2FA', '0');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BRANDING_DIR = path.resolve(env('BRANDING_DIR', path.join(__dirname, '..', 'branding')));

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.error(`Dossier de données ${DATA_DIR} non accessible en écriture (${e.code}).`);
  process.exit(1);
}

// SECRET_KEY : signe les cookies et chiffre les secrets de double authentification.
// Absente du .env → générée une fois et gardée dans data/secret.key.
let SECRET_KEY = env('SECRET_KEY', '');
if (!SECRET_KEY) {
  const f = path.join(DATA_DIR, 'secret.key');
  try { SECRET_KEY = fs.readFileSync(f, 'utf8').trim(); } catch {}
  if (!SECRET_KEY) {
    SECRET_KEY = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, SECRET_KEY + '\n', { mode: 0o600 });
    console.log('SECRET_KEY absente du .env : clé générée dans data/secret.key');
  }
} else if (SECRET_KEY.length < 32) {
  console.warn('SECRET_KEY trop courte — générer une valeur avec : openssl rand -hex 32');
}

const db = openDb(path.join(DATA_DIR, 'veille.db'));

// Premier démarrage : création du compte administrateur
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  if (ADMIN_PASSWORD.length < 8) {
    console.error('Aucun compte : définissez ADMIN_PASSWORD (8 caractères minimum) dans .env pour créer le compte administrateur.');
    process.exit(1);
  }
  db.prepare("INSERT INTO users (username, pass_hash, role, created, pv, require_2fa) VALUES (?, ?, 'admin', ?, ?, ?)")
    .run(ADMIN_USER, hacherMotDePasse(ADMIN_PASSWORD), Date.now(), nouvelleVersion(), ADMIN_REQUIRE_2FA ? 1 : 0);
  console.log(`Compte administrateur « ${ADMIN_USER} » créé${ADMIN_REQUIRE_2FA ? ' (double authentification à configurer à la première connexion)' : ''}.`);
}

autoriserReseauPrive(ALLOW_PRIVATE_FEEDS);
const auth = creerAuth(db, { cookieSecure: COOKIE_SECURE, trustProxy: TRUST_PROXY, sessionHeures: SESSION_HOURS, trustJours: TRUST_DAYS, secretKey: SECRET_KEY });
const twofa = creerTwoFactor(SECRET_KEY, 'Veille');
const sauvegardes = creerSauvegardes(db, { dataDir: DATA_DIR, brandingDir: BRANDING_DIR, hostDir: HOST_DIR, jours: BACKUP_DAYS, version: VERSION });
const collecteur = creerCollecteur(db, { intervalleMin: INTERVALLE, simultanes: SIMULTANES, retentionJours: RETENTION });

/* ---------- Outils HTTP ---------- */

class ErreurHttp extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, donnees) {
  const corps = JSON.stringify(donnees);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(corps);
}

function lireCorps(req, max = 16 * 1024 * 1024) {
  return new Promise((ok, ko) => {
    let taille = 0;
    const morceaux = [];
    req.on('data', (m) => {
      taille += m.length;
      if (taille > max) { ko(new ErreurHttp(413, 'Requête trop volumineuse')); req.destroy(); return; }
      morceaux.push(m);
    });
    req.on('end', () => ok(Buffer.concat(morceaux).toString('utf8')));
    req.on('error', ko);
  });
}

async function corpsJson(req) {
  // Exiger du JSON protège contre les envois de formulaires depuis un autre site (CSRF)
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new ErreurHttp(415, 'JSON attendu');
  const brut = await lireCorps(req);
  try { return brut ? JSON.parse(brut) : {}; } catch { throw new ErreurHttp(400, 'JSON invalide'); }
}


const ENTETES_SECURITE = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

function servirFichier(res, chemin) {
  const complet = path.join(PUBLIC_DIR, chemin);
  if (!complet.startsWith(PUBLIC_DIR + path.sep)) return false;
  let st;
  try { st = fs.statSync(complet); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(complet)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': chemin.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(complet).pipe(res);
  return true;
}

/* ---------- Requêtes SQL ---------- */

const q = {
  // Articles des flux auxquels l'utilisateur est abonné (nom et catégorie = ceux de SON abonnement)
  articles: db.prepare(`
    SELECT a.id, a.link, a.title, a.summary, a.published, s.feed_id AS feedId, s.name AS feed, s.category,
           (r.article_id IS NOT NULL) AS read
    FROM articles a
    JOIN subscriptions s ON s.feed_id = a.feed_id AND s.user_id = ? AND s.enabled = 1
    LEFT JOIN reads r ON r.article_id = a.id AND r.user_id = s.user_id
    WHERE a.published >= ?
    ORDER BY a.published ASC, a.id ASC`),
  mesErreurs: db.prepare(`SELECT s.name, f.last_error FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
    WHERE s.user_id = ? AND s.enabled = 1 AND f.error_count > 0 ORDER BY s.name COLLATE NOCASE`),
  mesFlux: db.prepare(`
    SELECT f.id, f.url, f.site_url, f.last_fetch, f.last_ok, f.last_error, f.error_count,
           s.name, s.category, s.enabled, s.created,
           (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS nb_articles,
           (SELECT MAX(published) FROM articles a WHERE a.feed_id = f.id) AS dernier_article,
           (SELECT COUNT(*) FROM reads r JOIN articles a ON a.id = r.article_id WHERE a.feed_id = f.id AND r.user_id = s.user_id) AS nb_lus
    FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
    WHERE s.user_id = ? ORDER BY s.category COLLATE NOCASE, s.name COLLATE NOCASE`),
  unDeMesFlux: db.prepare(`
    SELECT f.id, f.url, f.site_url, f.last_fetch, f.last_ok, f.last_error, f.error_count,
           s.name, s.category, s.enabled, s.created,
           (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS nb_articles,
           (SELECT MAX(published) FROM articles a WHERE a.feed_id = f.id) AS dernier_article,
           (SELECT COUNT(*) FROM reads r JOIN articles a ON a.id = r.article_id WHERE a.feed_id = f.id AND r.user_id = s.user_id) AS nb_lus
    FROM subscriptions s JOIN feeds f ON f.id = s.feed_id WHERE s.user_id = ? AND s.feed_id = ?`),
  monFlux: db.prepare(`SELECT f.*, s.name AS s_name, s.category AS s_category, s.enabled AS s_enabled
    FROM subscriptions s JOIN feeds f ON f.id = s.feed_id WHERE s.user_id = ? AND s.feed_id = ?`),
  mesIdsActifs: db.prepare('SELECT feed_id FROM subscriptions WHERE user_id = ? AND enabled = 1'),
  nbAbonnements: db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?'),
  abonne: db.prepare('SELECT 1 FROM subscriptions WHERE user_id = ? AND feed_id = ?'),
  sAbonner: db.prepare('INSERT OR IGNORE INTO subscriptions (user_id, feed_id, name, category, enabled, created) VALUES (?, ?, ?, ?, 1, ?)'),
  desabonner: db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND feed_id = ?'),
  feed: db.prepare('SELECT * FROM feeds WHERE id = ?'),
  feedParUrl: db.prepare('SELECT * FROM feeds WHERE url = ?'),
  insFeed: db.prepare('INSERT INTO feeds (url, name, category, site_url, created) VALUES (?, ?, \'\', ?, ?)'),
  orphelin: db.prepare('DELETE FROM feeds WHERE id = ? AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE feed_id = ?)'),
  lu: db.prepare('INSERT OR IGNORE INTO reads (user_id, article_id, ts) SELECT ?, id, ? FROM articles WHERE id = ?'),
  nonLu: db.prepare('DELETE FROM reads WHERE user_id = ? AND article_id = ?'),
  // Même lien publié par plusieurs flux : l'état « lu » suit le lien
  memesLiens: db.prepare('SELECT b.id FROM articles a JOIN articles b ON b.link = a.link WHERE a.id = ?'),
  users: db.prepare(`SELECT u.id, u.username, u.role, u.created, u.totp_enabled AS twofa, u.require_2fa AS require2fa,
    MAX(COALESCE(u.last_login, 0), COALESCE((SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id), 0)) AS last_seen,
    (SELECT COUNT(*) FROM reads r WHERE r.user_id = u.id) AS nb_lus,
    (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id) AS nb_flux
    FROM users u ORDER BY u.username COLLATE NOCASE`),
  user: db.prepare('SELECT * FROM users WHERE id = ?'),
  nbAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
};

/* ---------- Validation ---------- */

const NOM_RE = /^[\w.@-]{2,40}$/;
function texteCourt(v, max, champ, obligatoire = false) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (obligatoire && !t) throw new ErreurHttp(400, `${champ} obligatoire`);
  if (t.length > max) throw new ErreurHttp(400, `${champ} trop long (${max} caractères max.)`);
  return t;
}
function motDePasse(v) {
  const m = String(v ?? '');
  if (m.length < 8) throw new ErreurHttp(400, 'Mot de passe : 8 caractères minimum');
  if (m.length > 200) throw new ErreurHttp(400, 'Mot de passe trop long');
  return m;
}

/* ---------- Routes ---------- */

const routes = [];
const route = (methode, motif, options, gestion) => {
  const cles = [];
  const re = new RegExp('^' + motif.replace(/:(\w+)/g, (_, k) => { cles.push(k); return '([^/]+)'; }) + '$');
  routes.push({ methode, re, cles, ...options, gestion });
};
const PUBLIC = { acces: 'public' };
const CONNECTE = { acces: 'connecte' };
const ADMIN = { acces: 'admin' };

route('GET', '/api/health', PUBLIC, () => ({ ok: true, version: VERSION }));

/* Logo personnalisé optionnel : branding/logo.(svg|png|webp|jpg) et branding/logo-dark.* (même principe que les autres apps) */
const LOGO_EXT = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
function trouverLogo(base) {
  for (const ext of Object.keys(LOGO_EXT)) {
    const f = path.join(BRANDING_DIR, `${base}.${ext}`);
    try {
      const st = fs.statSync(f);
      if (st.isFile() && st.size) return { name: `${base}.${ext}`, ext, v: Math.floor(st.mtimeMs / 1000), f, size: st.size };
    } catch {}
  }
  return null;
}
route('GET', '/api/info', PUBLIC, () => {
  const url = (l) => (l ? `/branding/${l.name}?v=${l.v}` : null);
  return { appName: 'Veille', version: VERSION, logo: url(trouverLogo('logo')), logoDark: url(trouverLogo('logo-dark')) };
});

function profil(id) {
  const u = q.user.get(id);
  return { id: u.id, username: u.username, role: u.role, twofa: !!u.totp_enabled, require2fa: !!u.require_2fa };
}

route('GET', '/api/me', PUBLIC, ({ user }) => ({
  user: user ? profil(user.id) : null,
  trustDays: TRUST_DAYS,
  version: VERSION,
}));

/* ---------- Connexion (mot de passe, puis code à 6 chiffres si la 2FA est active ou imposée) ---------- */

// Secret en cours de configuration : le même QR code est réaffiché après une erreur de saisie
async function configurationEnCours(u) {
  let secret = twofa.open(u.totp_pending);
  if (!secret) {
    secret = twofa.nouveauSecret();
    db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(twofa.seal(secret), u.id);
  }
  return { secret, qr: await twofa.qr(u.username, secret) };
}

route('POST', '/api/login', PUBLIC, async ({ req, res }) => {
  const b = await corpsJson(req);
  const r = auth.verifierIdentifiants(req, b.username, b.password);
  if (r.erreur) {
    console.warn(`LOGIN FAIL - user=${JSON.stringify(String(b.username || ''))} ip=${auth.ip(req)}`);
    throw new ErreurHttp(r.status, r.erreur);
  }
  const u = r.user;
  if (u.totp_enabled && auth.appareilDeConfiance(req, u)) {
    auth.ouvrirSession(req, res, u);
    console.log(`LOGIN OK (appareil de confiance) - user=${u.username} ip=${auth.ip(req)}`);
    return { ok: true };
  }
  if (u.totp_enabled || u.require_2fa) {
    auth.poserPre(res, u);
    const rep = { etape: '2fa', configuration: !u.totp_enabled, trustDays: TRUST_DAYS };
    if (!u.totp_enabled) Object.assign(rep, await configurationEnCours(u));
    return rep;
  }
  auth.ouvrirSession(req, res, u);
  console.log(`LOGIN OK - user=${u.username} ip=${auth.ip(req)}`);
  return { ok: true };
});

route('POST', '/api/login/2fa', PUBLIC, async ({ req, res }) => {
  const u = auth.comptePre(req);
  if (!u) throw new ErreurHttp(401, 'Étape expirée, reconnectez-vous.');
  const cle = '2fa:' + u.id;
  if (auth.bloque(cle) || auth.bloque('2fa-ip:' + auth.ip(req))) throw new ErreurHttp(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  const b = await corpsJson(req);
  const configuration = !u.totp_enabled;
  if (configuration && !u.require_2fa) throw new ErreurHttp(401, 'Étape expirée, reconnectez-vous.');
  const pas = twofa.verify(twofa.open(configuration ? u.totp_pending : u.totp), b.code, configuration ? -1 : u.totp_last_step);
  if (pas === null) {
    auth.noterEchec(cle);
    auth.noterEchec('2fa-ip:' + auth.ip(req));
    console.warn(`2FA FAIL - user=${u.username} ip=${auth.ip(req)}`);
    throw new ErreurHttp(400, 'Code incorrect ou déjà utilisé.');
  }
  auth.effacerEchecs(cle);
  const memoriser = b.remember === true && TRUST_DAYS > 0 && !configuration;
  if (configuration) {
    db.prepare('UPDATE users SET totp = totp_pending, totp_pending = NULL, totp_enabled = 1, trust_ver = ? WHERE id = ?').run(nouvelleVersion(), u.id);
  } else if (memoriser && !u.trust_ver) {
    db.prepare('UPDATE users SET trust_ver = ? WHERE id = ?').run(nouvelleVersion(), u.id);
  }
  db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(pas, u.id);
  const x = q.user.get(u.id);
  auth.ouvrirSession(req, res, x);
  if (memoriser) auth.memoriserAppareil(res, x);
  console.log(`LOGIN OK (2FA${configuration ? ' configurée' : ''}${memoriser ? ', appareil mémorisé' : ''}) - user=${x.username} ip=${auth.ip(req)}`);
  return { ok: true };
});

route('POST', '/api/logout', PUBLIC, async ({ req, res }) => {
  auth.fermerSession(req, res);
  return { ok: true };
});

/* ---------- Double authentification depuis « Mon compte » ---------- */

route('POST', '/api/2fa/setup', CONNECTE, async ({ user }) => {
  const secret = twofa.nouveauSecret();
  db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(twofa.seal(secret), user.id);
  return { secret, qr: await twofa.qr(user.username, secret) };
});

route('POST', '/api/2fa/enable', CONNECTE, async ({ req, user }) => {
  const b = await corpsJson(req);
  const cle = '2fa:' + user.id;
  if (auth.bloque(cle)) throw new ErreurHttp(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  const u = q.user.get(user.id);
  if (!u.totp_pending) throw new ErreurHttp(400, 'Aucune configuration en cours, recommencez');
  const pas = twofa.verify(twofa.open(u.totp_pending), b.code);
  if (pas === null) { auth.noterEchec(cle); throw new ErreurHttp(400, 'Code incorrect'); }
  auth.effacerEchecs(cle);
  db.prepare('UPDATE users SET totp = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ?, trust_ver = ? WHERE id = ?')
    .run(pas, nouvelleVersion(), u.id);
  console.log(`2FA ENABLED - user=${u.username}`);
  return profil(u.id);
});

route('POST', '/api/2fa/disable', CONNECTE, async ({ req, user }) => {
  const b = await corpsJson(req);
  const u = q.user.get(user.id);
  if (u.require_2fa) throw new ErreurHttp(400, "La double authentification est imposée par l'administrateur");
  const cle = 'pwchk:' + u.id;
  if (auth.bloque(cle)) throw new ErreurHttp(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  if (!auth.verifierMotDePasse(String(b.password || ''), u.pass_hash)) { auth.noterEchec(cle); throw new ErreurHttp(400, 'Mot de passe incorrect'); }
  auth.effacerEchecs(cle);
  effacer2fa(u.id);
  console.log(`2FA DISABLED - user=${u.username}`);
  return profil(u.id);
});

route('POST', '/api/me/forget-devices', CONNECTE, ({ res, user }) => {
  db.prepare('UPDATE users SET trust_ver = ? WHERE id = ?').run(nouvelleVersion(), user.id);
  auth.oublierAppareil(res);
  return { ok: true };
});

function effacer2fa(id) {
  // trust_ver changé : révoque les appareils mémorisés
  db.prepare('UPDATE users SET totp = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = -1, trust_ver = ? WHERE id = ?')
    .run(nouvelleVersion(), id);
}

route('GET', '/api/articles', CONNECTE, ({ user, url }) => {
  const maintenant = Date.now();
  let depuis = parseInt(url.searchParams.get('since'), 10);
  if (!Number.isFinite(depuis)) depuis = maintenant - 2 * 86400000;
  depuis = Math.max(depuis, maintenant - RETENTION * 86400000);
  const vus = new Map();
  for (const a of q.articles.all(user.id, depuis)) {
    const deja = vus.get(a.link);
    if (deja) { if (a.read) deja.read = true; continue; }
    a.read = !!a.read;
    vus.set(a.link, a);
  }
  return {
    articles: [...vus.values()],
    erreurs: q.mesErreurs.all(user.id),
    nbFlux: q.nbAbonnements.get(user.id).n,
    collecte: collecteur.etat(),
    retentionJours: RETENTION,
  };
});

route('POST', '/api/read', CONNECTE, async ({ req, user }) => {
  const b = await corpsJson(req);
  const ids = [].concat(b.ids || []).map(Number).filter(Number.isInteger).slice(0, 5000);
  const lu = b.read !== false;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      for (const { id: autre } of q.memesLiens.all(id)) {
        if (lu) q.lu.run(user.id, now, autre); else q.nonLu.run(user.id, autre);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, n: ids.length };
});

// « Actualiser » : collecte immédiate des flux du compte (au plus une fois par minute)
const derniereActualisation = new Map();
route('POST', '/api/refresh', CONNECTE, async ({ user }) => {
  const dernier = derniereActualisation.get(user.id) || 0;
  if (Date.now() - dernier < 60000) return { ok: 0, erreurs: 0, nouveaux: 0, ignore: true };
  derniereActualisation.set(user.id, Date.now());
  return { ...(await collecteur.collecterIds(q.mesIdsActifs.all(user.id).map((x) => x.feed_id))) };
});

/* Mes flux : chaque compte gère les siens. Une même URL suivie par plusieurs comptes n'est téléchargée qu'une fois. */

function nettoyerNom(v) { return texteCourt(v, 80, 'Nom', true); }
function nettoyerCategorie(v) { return texteCourt(v, 60, 'Catégorie'); }

// Flux existant pour cette URL, ou nouveau ; renvoie { id, nouveau }
function fluxPourUrl(url, nom, site) {
  const f = q.feedParUrl.get(url);
  if (f) return { id: f.id, nouveau: false };
  const r = q.insFeed.run(url, nom, site || null, Date.now());
  return { id: Number(r.lastInsertRowid), nouveau: true };
}

function verifierQuota(user, ajout = 1) {
  if (q.nbAbonnements.get(user.id).n + ajout > MAX_FEEDS) throw new ErreurHttp(400, `Limite de ${MAX_FEEDS} flux par compte atteinte`);
}

route('GET', '/api/feeds', CONNECTE, ({ user }) => ({ feeds: q.mesFlux.all(user.id), collecte: collecteur.etat(), max: MAX_FEEDS }));

route('POST', '/api/feeds/probe', CONNECTE, async ({ req, user }) => {
  const b = await corpsJson(req);
  try {
    const r = await sonder(b.url);
    const existe = q.feedParUrl.get(r.url);
    const mien = existe && q.monFlux.get(user.id, existe.id);
    return { ...r, existe: mien ? { id: mien.id, name: mien.s_name } : null };
  } catch (e) {
    throw new ErreurHttp(422, e.message);
  }
});

route('POST', '/api/feeds', CONNECTE, async ({ req, user }) => {
  const b = await corpsJson(req);
  const url = urlHttp(b.url);
  if (!url) throw new ErreurHttp(400, 'Adresse du flux invalide');
  const name = nettoyerNom(b.name);
  const category = nettoyerCategorie(b.category);
  const existant = q.feedParUrl.get(url);
  if (existant && q.abonne.get(user.id, existant.id)) throw new ErreurHttp(409, 'Vous suivez déjà ce flux');
  verifierQuota(user);
  const { id, nouveau } = fluxPourUrl(url, name, urlHttp(b.site_url || ''));
  q.sAbonner.run(user.id, id, name, category, Date.now());
  // Flux déjà suivi par un autre compte : ses articles sont déjà là, pas besoin de le retélécharger
  const collecte = nouveau || !q.feed.get(id).last_ok ? await collecteur.collecterUn(id) : { ok: true, nouveaux: 0, existant: true };
  return { feed: q.unDeMesFlux.get(user.id, id), collecte };
});

route('PATCH', '/api/feeds/:id', CONNECTE, async ({ req, params, user }) => {
  let id = Number(params.id);
  const f = q.monFlux.get(user.id, id);
  if (!f) throw new ErreurHttp(404, 'Flux introuvable');
  const b = await corpsJson(req);
  const champs = {};
  if ('name' in b) champs.name = nettoyerNom(b.name);
  if ('category' in b) champs.category = nettoyerCategorie(b.category);
  if ('enabled' in b) champs.enabled = b.enabled ? 1 : 0;
  let collecte = null;
  db.exec('BEGIN');
  try {
    if ('url' in b) {
      const url = urlHttp(b.url);
      if (!url) throw new ErreurHttp(400, 'Adresse du flux invalide');
      if (url !== f.url) {
        // Nouvelle adresse = autre flux : l'abonnement y est déplacé avec son nom et sa catégorie
        const autre = q.feedParUrl.get(url);
        if (autre && q.abonne.get(user.id, autre.id)) throw new ErreurHttp(409, 'Vous suivez déjà ce flux');
        const nv = fluxPourUrl(url, champs.name || f.s_name, null);
        q.sAbonner.run(user.id, nv.id, champs.name || f.s_name, champs.category ?? f.s_category, Date.now());
        db.prepare('UPDATE subscriptions SET enabled = ? WHERE user_id = ? AND feed_id = ?').run(champs.enabled ?? f.s_enabled, user.id, nv.id);
        q.desabonner.run(user.id, id);
        q.orphelin.run(id, id);
        id = nv.id;
        collecte = 'nouvelle-url';
      }
    }
    const cles = Object.keys(champs);
    if (cles.length) {
      db.prepare(`UPDATE subscriptions SET ${cles.map((k) => k + ' = ?').join(', ')} WHERE user_id = ? AND feed_id = ?`)
        .run(...cles.map((k) => champs[k]), user.id, id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const feed = q.feed.get(id);
  if (collecte || (champs.enabled === 1 && !f.s_enabled && !feed.last_ok)) collecte = await collecteur.collecterUn(id);
  return { feed: q.unDeMesFlux.get(user.id, id), collecte };
});

route('DELETE', '/api/feeds/:id', CONNECTE, ({ params, user }) => {
  const id = Number(params.id);
  if (!q.desabonner.run(user.id, id).changes) throw new ErreurHttp(404, 'Flux introuvable');
  // Plus personne ne le suit : le flux et ses articles disparaissent ; sinon seul l'état « lu » de ce compte est effacé
  if (!q.orphelin.run(id, id).changes) db.prepare('DELETE FROM reads WHERE user_id = ? AND article_id IN (SELECT id FROM articles WHERE feed_id = ?)').run(user.id, id);
  return { ok: true };
});

// Réafficher un flux : ses articles lus repassent en non lu (les autres flux ne bougent pas).
// Renvoie les articles concernés pour pouvoir annuler.
route('POST', '/api/feeds/:id/unread', CONNECTE, async ({ req, params, user }) => {
  const id = Number(params.id);
  if (!q.monFlux.get(user.id, id)) throw new ErreurHttp(404, 'Flux introuvable');
  const b = await corpsJson(req);
  const depuis = Number.isFinite(Number(b.since)) ? Number(b.since) : 0;
  const ids = db.prepare(`SELECT r.article_id AS id FROM reads r JOIN articles a ON a.id = r.article_id
    WHERE r.user_id = ? AND a.feed_id = ? AND a.published >= ?`).all(user.id, id, depuis).map((x) => x.id);
  // Le même lien repris par un autre flux suivi repasse aussi en non lu (sinon il resterait masqué)
  db.prepare(`DELETE FROM reads WHERE user_id = ? AND article_id IN (
      SELECT b.id FROM articles a JOIN articles b ON b.link = a.link WHERE a.feed_id = ? AND a.published >= ?)`)
    .run(user.id, id, depuis);
  return { ok: true, ids };
});

route('POST', '/api/feeds/:id/refresh', CONNECTE, async ({ params, user }) => {
  const id = Number(params.id);
  if (!q.monFlux.get(user.id, id)) throw new ErreurHttp(404, 'Flux introuvable');
  const r = await collecteur.collecterUn(id);
  return { ...r, feed: q.unDeMesFlux.get(user.id, id) };
});

route('GET', '/api/feeds/export.opml', CONNECTE, ({ res, user }) => {
  const xml = ecrireOpml(q.mesFlux.all(user.id));
  res.writeHead(200, {
    'Content-Type': 'text/x-opml; charset=utf-8',
    'Content-Disposition': `attachment; filename="veille-${user.username.replace(/[^\w.-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.opml"`,
    'Cache-Control': 'no-store',
  });
  res.end(xml);
});

route('POST', '/api/feeds/import', CONNECTE, async ({ req, user }) => {
  const b = await corpsJson(req);
  let liste;
  try { liste = lireOpml(String(b.opml || '')); } catch (e) { throw new ErreurHttp(400, e.message); }
  if (!liste.length) throw new ErreurHttp(400, 'Aucun flux trouvé dans ce fichier');
  let ajoutes = 0, existants = 0, ignores = 0;
  const aCollecter = [];
  const now = Date.now();
  db.exec('BEGIN');
  try {
    let place = MAX_FEEDS - q.nbAbonnements.get(user.id).n;
    for (const f of liste) {
      const existant = q.feedParUrl.get(f.url);
      if (existant && q.abonne.get(user.id, existant.id)) { existants++; continue; }
      if (place <= 0) { ignores++; continue; }
      const nom = (f.name || f.url).replace(/\s+/g, ' ').trim().slice(0, 80);
      const { id, nouveau } = fluxPourUrl(f.url, nom, f.site);
      q.sAbonner.run(user.id, id, nom, (f.category || '').replace(/\s+/g, ' ').trim().slice(0, 60), now);
      if (nouveau || !q.feed.get(id).last_ok) aCollecter.push(id);   // jamais collecté avec succès : on (re)tente
      ajoutes++;
      place--;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  // Collecte des nouveaux flux en arrière-plan
  if (aCollecter.length) collecteur.collecterIds(aCollecter).catch(() => {});
  return { ajoutes, existants, ignores };
});

/* Comptes */

route('GET', '/api/users', ADMIN, () => ({
  users: q.users.all().map((u) => ({ ...u, twofa: !!u.twofa, require2fa: !!u.require2fa, last_seen: u.last_seen || null })),
}));

route('POST', '/api/users', ADMIN, async ({ req }) => {
  const b = await corpsJson(req);
  const username = String(b.username || '').trim();
  if (!NOM_RE.test(username)) throw new ErreurHttp(400, 'Identifiant : 2 à 40 caractères (lettres, chiffres, . _ - @)');
  const role = b.role === 'admin' ? 'admin' : 'user';
  try {
    db.prepare('INSERT INTO users (username, pass_hash, role, created, pv, require_2fa) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hacherMotDePasse(motDePasse(b.password)), role, Date.now(), nouvelleVersion(), b.require2fa ? 1 : 0);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new ErreurHttp(409, 'Cet identifiant existe déjà');
    throw e;
  }
  return { ok: true };
});

route('PATCH', '/api/users/:id', ADMIN, async ({ req, params, user }) => {
  const cible = q.user.get(Number(params.id));
  if (!cible) throw new ErreurHttp(404, 'Compte introuvable');
  const b = await corpsJson(req);
  if (b.role && b.role !== cible.role) {
    if (cible.role === 'admin' && q.nbAdmins.get().n <= 1) throw new ErreurHttp(400, 'Il doit rester au moins un administrateur');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role === 'admin' ? 'admin' : 'user', cible.id);
  }
  if (typeof b.require2fa === 'boolean') {
    db.prepare('UPDATE users SET require_2fa = ? WHERE id = ?').run(b.require2fa ? 1 : 0, cible.id);
  }
  let fermer = false;
  if (b.reset2fa === true && cible.totp_enabled) {   // téléphone perdu : 2FA supprimée, sessions fermées
    effacer2fa(cible.id);
    fermer = true;
    console.log(`2FA RESET - user=${cible.username} par ${user.username}`);
  }
  if (b.password) {
    db.prepare('UPDATE users SET pass_hash = ?, pv = ? WHERE id = ?').run(hacherMotDePasse(motDePasse(b.password)), nouvelleVersion(), cible.id);
    fermer = true;
  }
  // Déconnecte ses appareils (sauf la session courante si c'est soi-même)
  if (fermer) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(cible.id, user.tokenHash);
  return { ok: true };
});

route('DELETE', '/api/users/:id', ADMIN, ({ params, user }) => {
  const cible = q.user.get(Number(params.id));
  if (!cible) throw new ErreurHttp(404, 'Compte introuvable');
  if (cible.id === user.id) throw new ErreurHttp(400, 'Impossible de supprimer votre propre compte');
  if (cible.role === 'admin' && q.nbAdmins.get().n <= 1) throw new ErreurHttp(400, 'Il doit rester au moins un administrateur');
  // Ses flux et ses articles lus sont gardés dans data/backups/comptes-supprimes/ (restaurables dans un autre compte)
  const archive = sauvegardes.archiverCompteSupprime(cible.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(cible.id);
  collecteur.purgerOrphelins();   // ses flux que personne d'autre ne suit
  console.log(`USER DELETED - user=${cible.username} par ${user.username}, sauvegarde ${archive}`);
  return { ok: true, archive };
});

route('POST', '/api/me/password', CONNECTE, async ({ req, user }) => {
  const b = await corpsJson(req);
  const u = q.user.get(user.id);
  if (!auth.verifierMotDePasse(String(b.current || ''), u.pass_hash)) throw new ErreurHttp(400, 'Mot de passe actuel incorrect');
  db.prepare('UPDATE users SET pass_hash = ?, pv = ? WHERE id = ?').run(hacherMotDePasse(motDePasse(b.password)), nouvelleVersion(), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, user.tokenHash);
  return { ok: true };
});

/* ---------- Sauvegardes ---------- */

function envoyerFichier(res, nom, type, contenu) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${nom}"`,
    'Content-Length': Buffer.byteLength(contenu),
    'Cache-Control': 'no-store',
  });
  res.end(contenu);
}

const nomFichierCompte = (u) => `veille-${u.replace(/[^\w.@-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;

// Restaure une sauvegarde de compte : « ajouter » (fusion sans doublons) ou « remplacer » (flux et lus du fichier uniquement)
function restaurerCompte(userId, fichier, mode) {
  let o;
  try { o = sauvegardes.verifierFichierCompte(typeof fichier === 'string' ? JSON.parse(fichier) : fichier); }
  catch (e) { throw new ErreurHttp(400, e instanceof SyntaxError ? 'Fichier JSON illisible' : e.message); }
  const remplacer = mode === 'remplacer';
  const majAbo = db.prepare('UPDATE subscriptions SET name = ?, category = ?, enabled = ? WHERE user_id = ? AND feed_id = ?');
  let ajoutes = 0, misAJour = 0, retires = 0, ignores = 0;
  const nouveaux = [];
  const urls = new Set();
  db.exec('BEGIN');
  try {
    for (const f of o.flux.slice(0, 5000)) {
      const url = urlHttp(f.url || '');
      if (!url || urls.has(url)) continue;
      urls.add(url);
      const nom = String(f.name || url).replace(/\s+/g, ' ').trim().slice(0, 80) || url.slice(0, 80);
      const cat = String(f.category || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const actif = f.enabled === false ? 0 : 1;
      const existant = q.feedParUrl.get(url);
      if (existant && q.abonne.get(userId, existant.id)) {
        if (remplacer) { majAbo.run(nom, cat, actif, userId, existant.id); misAJour++; }
        continue;
      }
      if (q.nbAbonnements.get(userId).n >= MAX_FEEDS) { ignores++; continue; }
      const { id, nouveau } = fluxPourUrl(url, nom, urlHttp(f.site || ''));
      q.sAbonner.run(userId, id, nom, cat, Date.now());
      if (!actif) majAbo.run(nom, cat, 0, userId, id);
      if (nouveau || !q.feed.get(id).last_ok) nouveaux.push(id);
      ajoutes++;
    }
    if (remplacer) {
      for (const x of q.mesFlux.all(userId)) {
        if (!urls.has(x.url)) { q.desabonner.run(userId, x.id); retires++; }
      }
      db.prepare('DELETE FROM reads WHERE user_id = ?').run(userId);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (retires) collecteur.purgerOrphelins();
  const lus = Array.isArray(o.lus) ? o.lus : [];
  const lusAppliques = sauvegardes.appliquerLus(userId, lus);
  // Flux encore jamais collectés : collecte en arrière-plan, puis réapplication des « lu »
  if (nouveaux.length) {
    collecteur.collecterIds(nouveaux).then(() => sauvegardes.appliquerLus(userId, lus)).catch(() => {});
  }
  return { ok: true, ajoutes, misAJour, retires, ignores, lus: lus.length, lusAppliques, collecte: nouveaux.length };
}

route('GET', '/api/me/backup', CONNECTE, ({ res, user }) => {
  envoyerFichier(res, nomFichierCompte(user.username), 'application/json; charset=utf-8', JSON.stringify(sauvegardes.exporterCompte(user.id), null, 2));
});

route('POST', '/api/me/restore', CONNECTE, async ({ req, user }) => {
  const b = await corpsJson(req);
  const r = restaurerCompte(user.id, b.fichier, b.mode);
  console.log(`ACCOUNT RESTORE - user=${user.username} mode=${b.mode === 'remplacer' ? 'remplacer' : 'ajouter'} +${r.ajoutes} -${r.retires}`);
  return r;
});

route('GET', '/api/users/:id/backup', ADMIN, ({ res, params, user }) => {
  const o = sauvegardes.exporterCompte(Number(params.id));
  if (!o) throw new ErreurHttp(404, 'Compte introuvable');
  console.log(`ACCOUNT BACKUP - compte=${o.compte} par ${user.username}`);
  envoyerFichier(res, nomFichierCompte(o.compte), 'application/json; charset=utf-8', JSON.stringify(o, null, 2));
});

route('POST', '/api/users/:id/restore', ADMIN, async ({ req, params, user }) => {
  const cible = q.user.get(Number(params.id));
  if (!cible) throw new ErreurHttp(404, 'Compte introuvable');
  const b = await corpsJson(req);
  const r = restaurerCompte(cible.id, b.fichier, b.mode);
  console.log(`ACCOUNT RESTORE - compte=${cible.username} par ${user.username} mode=${b.mode === 'remplacer' ? 'remplacer' : 'ajouter'} +${r.ajoutes} -${r.retires}`);
  return r;
});

route('GET', '/api/backups', ADMIN, () => ({
  quotidiennes: sauvegardes.lister(),
  jours: BACKUP_DAYS,
  config: sauvegardes.configMontee(),
}));

route('POST', '/api/backups/now', ADMIN, () => {
  const jour = sauvegardes.quotidienne({ forcer: true });
  return { ok: true, jour, quotidiennes: sauvegardes.lister() };
});

route('POST', '/api/backups/full', ADMIN, async ({ req, res, user }) => {
  const b = await corpsJson(req);
  const phrase = String(b.phrase || '');
  if (phrase.length < 10) throw new ErreurHttp(400, 'Phrase de passe : 10 caractères minimum (12 ou plus recommandés)');
  if (phrase.length > 200) throw new ErreurHttp(400, 'Phrase de passe trop longue');
  const zipBuf = await sauvegardes.complete(phrase, user.username);
  console.log(`FULL BACKUP - par ${user.username} (${Math.round(zipBuf.length / 1024)} Ko)`);
  envoyerFichier(res, `sauvegarde-veille-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.zip`, 'application/zip', zipBuf);
});

/* ---------- Serveur ---------- */

const serveur = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(ENTETES_SECURITE)) res.setHeader(k, v);
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { res.writeHead(400).end(); return; }
  const chemin = decodeURIComponent(url.pathname);

  try {
    if (chemin.startsWith('/api/')) {
      const r = routes.find((x) => x.methode === req.method && x.re.test(chemin));
      if (!r) throw new ErreurHttp(404, 'Introuvable');
      const user = auth.utilisateur(req);
      if ((r.acces === 'connecte' || r.acces === 'admin') && !user) throw new ErreurHttp(401, 'Connexion requise');
      if (r.acces === 'admin' && user.role !== 'admin') throw new ErreurHttp(403, 'Réservé aux administrateurs');
      const params = {};
      const m = r.re.exec(chemin);
      r.cles.forEach((k, i) => { params[k] = m[i + 1]; });
      const resultat = await r.gestion({ req, res, url, user, params });
      if (!res.headersSent) json(res, 200, resultat ?? { ok: true });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new ErreurHttp(405, 'Méthode non autorisée');

    if (chemin === '/' || chemin === '/index.html') {
      if (!auth.utilisateur(req)) {
        res.writeHead(302, { Location: '/login.html' }).end();
        return;
      }
      servirFichier(res, 'index.html');
      return;
    }
    const mLogo = /^\/branding\/(logo|logo-dark)\.[a-z]+$/.exec(chemin);
    if (mLogo) {
      const l = trouverLogo(mLogo[1]);
      if (!l || '/branding/' + l.name !== chemin) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': LOGO_EXT[l.ext], 'Content-Length': l.size, 'Cache-Control': 'public, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      });
      fs.createReadStream(l.f).pipe(res);
      return;
    }
    if (chemin === '/login.html' && auth.utilisateur(req)) {
      res.writeHead(302, { Location: '/' }).end();
      return;
    }
    if (!servirFichier(res, chemin.replace(/^\/+/, ''))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable');
    }
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(req.method, chemin, e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Erreur interne' : e.message });
    else res.end();
  }
});

serveur.listen(PORT, () => {
  console.log(`Veille ${VERSION} — port ${PORT}, collecte toutes les ${INTERVALLE} min (${SIMULTANES} en parallèle), ` +
    `rétention ${RETENTION} j, flux par compte (${MAX_FEEDS} max., réseau local ${ALLOW_PRIVATE_FEEDS ? 'autorisé' : 'refusé'}), ` +
    `cookies ${COOKIE_SECURE ? 'Secure (HTTPS)' : 'non Secure — COOKIE_SECURE=1 si servi en HTTPS'}, proxy ${TRUST_PROXY ? 'de confiance' : 'ignoré'}, fuseau ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  collecteur.demarrer();
  sauvegardes.demarrer();
});

const arreter = () => { serveur.close(); try { db.close(); } catch {} process.exit(0); };
process.on('SIGTERM', arreter);
process.on('SIGINT', arreter);
