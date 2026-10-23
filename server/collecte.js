'use strict';
// Collecte périodique des flux, côté serveur : un seul téléchargement par flux pour tous les utilisateurs.
const { telecharger, analyserFlux } = require('./feeds');

function creerCollecteur(db, { intervalleMin, simultanes, retentionJours, log = console.log }) {
  const majFeedOk = db.prepare(`UPDATE feeds SET last_fetch = ?, last_ok = ?, last_error = NULL, error_count = 0,
    etag = ?, last_modified = ?, site_url = COALESCE(site_url, ?) WHERE id = ?`);
  const majFeedNonModifie = db.prepare('UPDATE feeds SET last_fetch = ?, last_ok = ?, last_error = NULL, error_count = 0 WHERE id = ?');
  const majFeedErreur = db.prepare('UPDATE feeds SET last_fetch = ?, last_error = ?, error_count = error_count + 1 WHERE id = ?');
  const insArticle = db.prepare(`INSERT OR IGNORE INTO articles (feed_id, link, title, summary, published, fetched)
    VALUES (?, ?, ?, ?, ?, ?)`);
  // Titre ou résumé corrigé par la source après coup
  const majArticle = db.prepare(`UPDATE articles SET title = ?, summary = ?
    WHERE feed_id = ? AND link = ? AND (title <> ? OR summary <> ?)`);
  const purge = db.prepare('DELETE FROM articles WHERE published < ? AND fetched < ?');

  let enCours = null;
  let derniere = { debut: 0, fin: 0, ok: 0, erreurs: 0, nouveaux: 0 };
  let minuteur = null;

  async function collecterUn(feed) {
    const maintenant = Date.now();
    try {
      const rep = await telecharger(feed.url, { etag: feed.etag, lastModified: feed.last_modified });
      if (rep.notModified) {
        majFeedNonModifie.run(maintenant, maintenant, feed.id);
        return { ok: true, nouveaux: 0 };
      }
      const f = analyserFlux(rep.body, feed.url);
      const premierPassage = !feed.last_ok;
      let nouveaux = 0;
      db.exec('BEGIN');
      try {
        for (const a of f.articles) {
          // Date absente : au tout premier passage on la classe comme ancienne (sinon tout
          // l'historique du flux apparaîtrait « aujourd'hui »), ensuite = date de découverte.
          let pub = a.published ?? (premierPassage ? maintenant - 7 * 86400000 : maintenant);
          if (pub > maintenant + 5 * 60000) pub = maintenant; // dates dans le futur
          if (insArticle.run(feed.id, a.link, a.title, a.summary, pub, maintenant).changes) nouveaux += 1;
          else majArticle.run(a.title, a.summary, feed.id, a.link, a.title, a.summary);
        }
        majFeedOk.run(maintenant, maintenant, rep.etag || null, rep.lastModified || null, f.site || null, feed.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return { ok: true, nouveaux, nb: f.articles.length };
    } catch (e) {
      majFeedErreur.run(maintenant, String(e.message).slice(0, 300), feed.id);
      return { ok: false, erreur: e.message };
    }
  }

  // Flux qui n'ont plus aucun abonné : supprimés avec leurs articles
  const purgeOrphelins = db.prepare('DELETE FROM feeds WHERE id NOT IN (SELECT feed_id FROM subscriptions)');

  async function collecterListe(feeds) {
    const file = [...feeds];
    let ok = 0, erreurs = 0, nouveaux = 0;
    await Promise.all(
      Array.from({ length: Math.min(simultanes, file.length) }, async () => {
        while (file.length) {
          const r = await collecterUn(file.shift());
          if (r.ok) { ok++; nouveaux += r.nouveaux; } else erreurs++;
        }
      }),
    );
    return { ok, erreurs, nouveaux };
  }

  // Collecte de quelques flux (ceux d'un utilisateur), indépendante de la collecte générale
  async function collecterIds(ids) {
    if (!ids.length) return { ok: 0, erreurs: 0, nouveaux: 0 };
    const feeds = db.prepare(`SELECT * FROM feeds WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    return collecterListe(feeds);
  }

  async function collecterTout() {
    if (enCours) return enCours;
    enCours = (async () => {
      const debut = Date.now();
      const orphelins = purgeOrphelins.run().changes;
      // Seuls les flux suivis (abonnement actif) par au moins un compte sont téléchargés
      const feeds = db.prepare('SELECT * FROM feeds WHERE id IN (SELECT feed_id FROM subscriptions WHERE enabled = 1)').all();
      const r = await collecterListe(feeds);
      const limite = Date.now() - retentionJours * 86400000;
      const purges = purge.run(limite, limite).changes;
      derniere = { debut, fin: Date.now(), ...r };
      log(`Collecte : ${feeds.length} flux, ${r.ok} ok, ${r.erreurs} en erreur, ${r.nouveaux} nouveaux articles` +
        (purges ? `, ${purges} anciens supprimés` : '') + (orphelins ? `, ${orphelins} flux sans abonné supprimés` : '') +
        ` (${((Date.now() - debut) / 1000).toFixed(1)} s)`);
      return r;
    })();
    try {
      return await enCours;
    } finally {
      enCours = null;
    }
  }

  function programmer() {
    clearTimeout(minuteur);
    minuteur = setTimeout(async () => {
      await collecterTout().catch((e) => log('Collecte : ' + e.message));
      programmer();
    }, intervalleMin * 60000);
    minuteur.unref?.();
  }

  return {
    demarrer() {
      setTimeout(() => collecterTout().catch((e) => log('Collecte : ' + e.message)).finally(programmer), 1000);
    },
    async maintenant() {
      const r = await collecterTout();
      programmer(); // repart pour un intervalle complet
      return r;
    },
    collecterIds,
    purgerOrphelins: () => purgeOrphelins.run().changes,
    collecterUn: (id) => {
      const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(id);
      return feed ? collecterUn(feed) : Promise.resolve({ ok: false, erreur: 'Flux introuvable' });
    },
    etat: () => ({
      ...derniere,
      enCours: !!enCours,
      prochaine: derniere.fin ? derniere.fin + intervalleMin * 60000 : null,
      intervalleMin,
    }),
  };
}

module.exports = { creerCollecteur };
