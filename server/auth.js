'use strict';
const crypto = require('node:crypto');

const COOKIE = 'veille_session';
const COOKIE_PRE = 'veille_pre';     // étape « code à 6 chiffres » (5 min, jamais une session)
const COOKIE_TRUST = 'veille_trust'; // appareil mémorisé après une 2FA réussie
const PRE_TTL = 5 * 60 * 1000;

function hacherMotDePasse(mdp) {
  const sel = crypto.randomBytes(16);
  const h = crypto.scryptSync(mdp, sel, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sel.toString('base64')}$${h.toString('base64')}`;
}

function verifierMotDePasse(mdp, stocke) {
  const [algo, sel, h] = String(stocke).split('$');
  if (algo !== 'scrypt' || !sel || !h) return false;
  const attendu = Buffer.from(h, 'base64');
  const calcule = crypto.scryptSync(mdp, Buffer.from(sel, 'base64'), attendu.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(attendu, calcule);
}

// Hachage factice pour garder un temps de réponse constant quand l'identifiant n'existe pas
const HASH_FACTICE = hacherMotDePasse(crypto.randomBytes(12).toString('hex'));

const hacherJeton = (t) => crypto.createHash('sha256').update(t).digest('hex');
const nouvelleVersion = () => crypto.randomBytes(8).toString('hex');

function lireCookies(req) {
  const res = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { res[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
    }
  }
  return res;
}

function ajouterCookie(res, valeur) {
  const deja = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [].concat(deja || [], valeur));
}

/**
 * @param {object} o
 *   cookieSecure : COOKIE_SECURE=1 → cookies « Secure » (application servie en HTTPS)
 *   trustProxy   : TRUST_PROXY=1 → IP client lue dans X-Forwarded-For (derrière Nginx Proxy Manager)
 *   sessionHeures, trustJours, secretKey
 */
function creerAuth(db, { cookieSecure, trustProxy, sessionHeures, trustJours, secretKey }) {
  const cleSignature = Buffer.from(crypto.hkdfSync('sha256', String(secretKey), 'veille', 'cookies-signes', 32));
  const signer = (obj) => {
    const corps = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return corps + '.' + crypto.createHmac('sha256', cleSignature).update(corps).digest('base64url');
  };
  const lireSigne = (jeton) => {
    const [corps, sig] = String(jeton || '').split('.');
    if (!corps || !sig) return null;
    const attendu = crypto.createHmac('sha256', cleSignature).update(corps).digest('base64url');
    if (sig.length !== attendu.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return null;
    try {
      const o = JSON.parse(Buffer.from(corps, 'base64url').toString('utf8'));
      return o && o.exp > Date.now() ? o : null;
    } catch { return null; }
  };

  const q = {
    userParNom: db.prepare('SELECT * FROM users WHERE username = ?'),
    userParId: db.prepare('SELECT * FROM users WHERE id = ?'),
    session: db.prepare(`SELECT s.token_hash, s.last_seen, u.id, u.username, u.role FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?`),
    toucher: db.prepare('UPDATE sessions SET last_seen = ?, expires = ? WHERE token_hash = ?'),
    creer: db.prepare('INSERT INTO sessions (token_hash, user_id, created, expires, last_seen, agent) VALUES (?, ?, ?, ?, ?, ?)'),
    suppr: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires < ?'),
    derniereCnx: db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),
  };

  const cookie = (nom, valeur, maxAgeS, { path = '/', sameSite = 'Lax' } = {}) =>
    `${nom}=${valeur}; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeS}${cookieSecure ? '; Secure' : ''}`;

  // Anti-force brute : 5 échecs → blocage 15 min (par IP + identifiant, et par compte pour les codes 2FA)
  const echecs = new Map();
  const bloque = (k) => {
    const e = echecs.get(k);
    return !!e && e.n >= 5 && Date.now() - e.t < 15 * 60000;
  };
  const noterEchec = (k) => {
    const e = echecs.get(k);
    if (!e || Date.now() - e.t > 15 * 60000) echecs.set(k, { n: 1, t: Date.now() });
    else { e.n++; e.t = Date.now(); }
  };
  setInterval(() => {
    const limite = Date.now() - 15 * 60000;
    for (const [k, e] of echecs) if (e.t < limite) echecs.delete(k);
    q.purge.run(Date.now());
  }, 3600000).unref();

  function ip(req) {
    if (trustProxy) {
      const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (f) return f;
    }
    return req.socket.remoteAddress || '';
  }

  const api = {
    hacherMotDePasse,
    verifierMotDePasse,
    nouvelleVersion,
    ip,
    bloque,
    noterEchec,
    effacerEchecs: (k) => echecs.delete(k),

    // Utilisateur de la requête, ou null
    utilisateur(req) {
      const jeton = lireCookies(req)[COOKIE];
      if (!jeton || jeton.length < 32) return null;
      const h = hacherJeton(jeton);
      const now = Date.now();
      const s = q.session.get(h, now);
      if (!s) return null;
      // Session glissante, prolongée au plus une fois par heure
      if (now - s.last_seen > 3600000) q.toucher.run(now, now + sessionHeures * 3600000, h);
      return { id: s.id, username: s.username, role: s.role, tokenHash: h };
    },

    /** Étape 1 : identifiant + mot de passe. Renvoie { user } ou { erreur, status }. */
    verifierIdentifiants(req, username, password) {
      const k = 'pw:' + ip(req) + '|' + String(username).toLowerCase();
      if (bloque(k)) return { erreur: 'Trop de tentatives. Réessayez dans quelques minutes.', status: 429 };
      const u = q.userParNom.get(String(username || ''));
      const ok = verifierMotDePasse(String(password || ''), u ? u.pass_hash : HASH_FACTICE);
      if (!u || !ok) {
        noterEchec(k);
        return { erreur: 'Identifiant ou mot de passe incorrect.', status: 401 };
      }
      echecs.delete(k);
      return { user: u };
    },

    ouvrirSession(req, res, u) {
      const jeton = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      q.creer.run(hacherJeton(jeton), u.id, now, now + sessionHeures * 3600000, now, String(req.headers['user-agent'] || '').slice(0, 200));
      q.derniereCnx.run(now, u.id);
      ajouterCookie(res, cookie(COOKIE, jeton, Math.round(sessionHeures * 3600)));
      ajouterCookie(res, cookie(COOKIE_PRE, '', 0, { path: '/api/login' }));
    },

    fermerSession(req, res) {
      const jeton = lireCookies(req)[COOKIE];
      if (jeton) q.suppr.run(hacherJeton(jeton));
      ajouterCookie(res, cookie(COOKIE, '', 0));
    },

    /* --- Étape 2FA de la connexion --- */
    poserPre(res, u) {
      ajouterCookie(res, cookie(COOKIE_PRE, signer({ uid: u.id, pv: u.pv, exp: Date.now() + PRE_TTL }), PRE_TTL / 1000, { path: '/api/login' }));
    },
    // Compte de l'étape 2FA (mot de passe déjà vérifié), ou null si absente / expirée / mot de passe changé entre-temps
    comptePre(req) {
      const p = lireSigne(lireCookies(req)[COOKIE_PRE]);
      if (!p) return null;
      const u = q.userParId.get(p.uid);
      return u && u.pv === p.pv ? u : null;
    },
    effacerPre(res) {
      ajouterCookie(res, cookie(COOKIE_PRE, '', 0, { path: '/api/login' }));
    },

    /* --- Appareils de confiance : « se souvenir de cet appareil » ---
       Cookie signé (clé distincte : jamais valable comme session), envoyé uniquement à /api/login, lié au compte,
       à son mot de passe (pv) et à un numéro de révocation (trust_ver). Changer de mot de passe, désactiver /
       réinitialiser la 2FA ou « Oublier les appareils » les invalide tous. */
    appareilDeConfiance(req, u) {
      if (!trustJours || !u.totp_enabled || !u.trust_ver) return false;
      const p = lireSigne(lireCookies(req)[COOKIE_TRUST]);
      return !!p && p.uid === u.id && p.pv === u.pv && p.tv === u.trust_ver;
    },
    memoriserAppareil(res, u) {
      ajouterCookie(res, cookie(COOKIE_TRUST, signer({ uid: u.id, pv: u.pv, tv: u.trust_ver, exp: Date.now() + trustJours * 86400000 }),
        trustJours * 86400, { path: '/api/login', sameSite: 'Strict' }));
    },
    oublierAppareil(res) {
      ajouterCookie(res, cookie(COOKIE_TRUST, '', 0, { path: '/api/login', sameSite: 'Strict' }));
    },
  };
  return api;
}

module.exports = { creerAuth, hacherMotDePasse, verifierMotDePasse, nouvelleVersion };
