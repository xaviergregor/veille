'use strict';
/**
 * Sauvegardes :
 *  1. copie quotidienne automatique de la base dans data/backups/AAAA-MM-JJ/ (BACKUP_DAYS jours) ;
 *  2. sauvegarde par compte : fichier JSON (flux + articles lus), restaurable dans l'application ;
 *  3. sauvegarde complète (admin) : ZIP chiffré AES-256 par une phrase de passe (data, branding, .env, compose).
 */
const fs = require('node:fs');
const path = require('node:path');
const zip = require('@zip.js/zip.js');

const FORMAT_COMPTE = 'veille-compte';

function dateLocale(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const horodatage = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function creerSauvegardes(db, { dataDir, brandingDir, hostDir, jours, version, log = console.log }) {
  const dossier = path.join(dataDir, 'backups');
  const dossierSupprimes = path.join(dossier, 'comptes-supprimes');

  // Copie cohérente de la base, même pendant une écriture (VACUUM INTO)
  function copierBase(cible) {
    try { fs.unlinkSync(cible); } catch {}
    db.prepare('VACUUM INTO ?').run(cible);
  }

  /* ---------- 1. Copie quotidienne ---------- */

  function quotidienne({ forcer = false } = {}) {
    const jour = dateLocale();
    const rep = path.join(dossier, jour);
    const fichier = path.join(rep, 'veille.db');
    if (!forcer && fs.existsSync(fichier)) return null;
    fs.mkdirSync(rep, { recursive: true, mode: 0o700 });
    const tmp = fichier + '.tmp';
    copierBase(tmp);
    fs.renameSync(tmp, fichier);
    const cle = path.join(dataDir, 'secret.key');
    if (fs.existsSync(cle)) fs.copyFileSync(cle, path.join(rep, 'secret.key'));
    const purges = purger();
    log(`Sauvegarde quotidienne : backups/${jour}/veille.db (${Math.round(fs.statSync(fichier).size / 1024)} Ko)` +
      (purges ? `, ${purges} ancienne(s) supprimée(s)` : ''));
    return jour;
  }

  function purger() {
    const limite = dateLocale(new Date(Date.now() - jours * 86400000));
    let n = 0;
    for (const nom of lister().map((x) => x.jour)) {
      if (nom < limite) { fs.rmSync(path.join(dossier, nom), { recursive: true, force: true }); n++; }
    }
    return n;
  }

  function lister() {
    let noms = [];
    try { noms = fs.readdirSync(dossier); } catch {}
    return noms.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse().map((jour) => {
      let taille = 0;
      try { taille = fs.statSync(path.join(dossier, jour, 'veille.db')).size; } catch {}
      return { jour, taille };
    });
  }

  let minuteur = null;
  function demarrer() {
    const tenter = () => { try { quotidienne(); } catch (e) { log('Sauvegarde quotidienne : ÉCHEC — ' + e.message); } };
    setTimeout(tenter, 5000).unref();
    // Vérifie toutes les heures si la sauvegarde du jour existe (couvre le passage de minuit et les redémarrages)
    minuteur = setInterval(tenter, 3600000);
    minuteur.unref();
  }

  /* ---------- 2. Sauvegarde par compte ---------- */

  function exporterCompte(userId) {
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!u) return null;
    const flux = db.prepare(`SELECT f.url, f.site_url, s.name, s.category, s.enabled FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
      WHERE s.user_id = ? ORDER BY s.category COLLATE NOCASE, s.name COLLATE NOCASE`).all(userId)
      .map((x) => ({ url: x.url, name: x.name, category: x.category, enabled: !!x.enabled, ...(x.site_url ? { site: x.site_url } : {}) }));
    const lus = db.prepare(`SELECT DISTINCT a.link FROM reads r JOIN articles a ON a.id = r.article_id WHERE r.user_id = ?`).all(userId).map((x) => x.link);
    return { format: FORMAT_COMPTE, version: 1, application: 'Veille ' + version, exporte: new Date().toISOString(), compte: u.username, flux, lus };
  }

  /**
   * Restaure un fichier de compte dans le compte userId.
   * mode « ajouter » : fusion sans doublons ; « remplacer » : les flux absents du fichier sont retirés.
   * Les articles lus sont réappliqués par lien (maintenant pour ceux déjà collectés, et après la collecte des nouveaux flux).
   */
  function verifierFichierCompte(o) {
    if (!o || o.format !== FORMAT_COMPTE || !Array.isArray(o.flux)) throw new Error("Ce fichier n'est pas une sauvegarde de compte Veille");
    return o;
  }

  function appliquerLus(userId, liens) {
    if (!liens || !liens.length) return 0;
    const ins = db.prepare(`INSERT OR IGNORE INTO reads (user_id, article_id, ts)
      SELECT ?, a.id, ? FROM articles a JOIN subscriptions s ON s.feed_id = a.feed_id AND s.user_id = ? WHERE a.link = ?`);
    const now = Date.now();
    let n = 0;
    db.exec('BEGIN');
    try {
      for (const l of liens.slice(0, 100000)) n += ins.run(userId, now, userId, String(l)).changes;
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return n;
  }

  /* ---------- Comptes supprimés : leur sauvegarde est gardée ---------- */

  function archiverCompteSupprime(userId) {
    const o = exporterCompte(userId);
    if (!o) return null;
    fs.mkdirSync(dossierSupprimes, { recursive: true, mode: 0o700 });
    const f = path.join(dossierSupprimes, `${o.compte.replace(/[^\w.@-]/g, '_')}-${horodatage()}.json`);
    fs.writeFileSync(f, JSON.stringify(o, null, 2), { mode: 0o600 });
    return path.relative(dataDir, f);
  }

  /* ---------- 3. Sauvegarde complète chiffrée ---------- */

  function configMontee() {
    const env = path.join(hostDir, '.env');
    const compose = path.join(hostDir, 'docker-compose.yml');
    const estFichier = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
    return { env: estFichier(env), compose: estFichier(compose) };
  }

  async function complete(phrase, auteur) {
    const tmp = path.join(dataDir, `.export-${process.pid}-${Date.now()}.db`);
    copierBase(tmp);
    try {
      const w = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { password: phrase, encryptionStrength: 3, zipCrypto: false, level: 6 });
      const ajouterFichier = (nom, f) => w.add(nom, new zip.Uint8ArrayReader(fs.readFileSync(f)), { lastModDate: fs.statSync(f).mtime });
      await ajouterFichier('data/veille.db', tmp);
      if (fs.existsSync(path.join(dataDir, 'secret.key'))) await ajouterFichier('data/secret.key', path.join(dataDir, 'secret.key'));
      let logos = [];
      try { logos = fs.readdirSync(brandingDir).filter((n) => /^logo(-dark)?\.(svg|png|webp|jpe?g)$/i.test(n)); } catch {}
      for (const n of logos) await ajouterFichier('branding/' + n, path.join(brandingDir, n));
      const cfg = configMontee();
      if (cfg.env) await ajouterFichier('config/.env', path.join(hostDir, '.env'));
      if (cfg.compose) await ajouterFichier('config/docker-compose.yml', path.join(hostDir, 'docker-compose.yml'));
      await w.add('LISEZ-MOI.txt', new zip.TextReader(lisezMoi(cfg, auteur)));
      return Buffer.from(await w.close());
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function lisezMoi(cfg, auteur) {
    return [
      `Sauvegarde complète Veille ${version}`,
      `Créée le ${new Date().toLocaleString('fr-FR')} par ${auteur}`,
      '',
      'Contenu',
      '  data/veille.db        → comptes, flux, articles, état lu / non lu (copie cohérente)',
      '  data/secret.key       → clé de l\'application (si SECRET_KEY n\'est pas dans .env)',
      '  branding/             → logo éventuel',
      cfg.env ? '  config/.env           → réglages, dont SECRET_KEY' : '  (config/.env absent : non monté dans le conteneur)',
      cfg.compose ? '  config/docker-compose.yml' : '  (config/docker-compose.yml absent : non monté dans le conteneur)',
      '',
      'Les copies quotidiennes (data/backups/) ne sont pas incluses.',
      '',
      'Restauration, sur le serveur :',
      '  1. 7z x sauvegarde-veille-….zip          (demande la phrase de passe)',
      '  2. docker compose down',
      '  3. cp -r data branding ./ ; cp config/.env ./.env ; cp config/docker-compose.yml ./   (ou garder les vôtres)',
      '  4. docker compose up -d --build',
      '',
      'La SECRET_KEY du .env (ou data/secret.key) doit être celle de cette sauvegarde :',
      'sinon les doubles authentifications sont à réinitialiser et tout le monde est déconnecté.',
      '',
    ].join('\r\n');
  }

  return { demarrer, quotidienne, lister, exporterCompte, verifierFichierCompte, appliquerLus, archiverCompteSupprime, complete, configMontee };
}

module.exports = { creerSauvegardes, FORMAT_COMPTE };
