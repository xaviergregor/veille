'use strict';
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      created INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      agent TEXT
    );

    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      site_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created INTEGER NOT NULL,
      last_fetch INTEGER,
      last_ok INTEGER,
      last_error TEXT,
      error_count INTEGER NOT NULL DEFAULT 0,
      etag TEXT,
      last_modified TEXT
    );

    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY,
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      link TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL,
      fetched INTEGER NOT NULL,
      UNIQUE (feed_id, link)
    );
    CREATE INDEX IF NOT EXISTS articles_published ON articles(published);
    CREATE INDEX IF NOT EXISTS articles_link ON articles(link);

    CREATE TABLE IF NOT EXISTS reads (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      PRIMARY KEY (user_id, article_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);

  // v1.2 : double authentification (comme les autres outils)
  const colonnes = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  const ajouter = (nom, def) => { if (!colonnes.has(nom)) db.exec(`ALTER TABLE users ADD COLUMN ${nom} ${def}`); };
  ajouter('pv', "TEXT NOT NULL DEFAULT ''");              // version du mot de passe (invalide les appareils mémorisés)
  ajouter('totp', 'TEXT');                                  // secret chiffré
  ajouter('totp_pending', 'TEXT');                          // secret en cours de configuration
  ajouter('totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ajouter('totp_last_step', 'INTEGER NOT NULL DEFAULT -1');
  ajouter('require_2fa', 'INTEGER NOT NULL DEFAULT 0');
  ajouter('trust_ver', "TEXT NOT NULL DEFAULT ''");         // numéro de révocation des appareils mémorisés
  ajouter('last_login', 'INTEGER');
  db.exec("UPDATE users SET pv = lower(hex(randomblob(8))) WHERE pv = ''");

  // v1.3 : flux par utilisateur. Un flux (une URL) n'est téléchargé qu'une fois, même suivi par plusieurs comptes ;
  // chaque abonnement a son propre nom, sa catégorie et son interrupteur.
  const avaitAbonnements = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created INTEGER NOT NULL,
      PRIMARY KEY (user_id, feed_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS subscriptions_feed ON subscriptions(feed_id);
  `);
  // Mise à jour depuis la 1.2 (flux communs) : les flux existants sont confiés aux administrateurs
  if (!avaitAbonnements && db.prepare('SELECT 1 FROM feeds LIMIT 1').get()) {
    const n = db.prepare(`INSERT OR IGNORE INTO subscriptions (user_id, feed_id, name, category, enabled, created)
      SELECT u.id, f.id, f.name, f.category, f.enabled, f.created FROM users u CROSS JOIN feeds f WHERE u.role = 'admin'`).run().changes;
    console.log(`Migration 1.3 : ${n} abonnement(s) créés pour les administrateurs à partir des flux existants.`);
  }

  return db;
}

module.exports = { openDb };
