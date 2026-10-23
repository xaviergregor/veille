'use strict';

/* =====================================================================
   Veille — interface
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const stockage = {
  lire(k, defaut) { try { const v = localStorage.getItem(k); return v === null ? defaut : JSON.parse(v); } catch { return defaut; } },
  ecrire(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;
const ICON = {
  rss: svg('<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  undo: svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  trash: svg('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>'),
  key: svg('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  lock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  clock: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  download: svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
  upload: svg('<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>'),
  inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  alert: svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>'),
};

async function api(chemin, { methode = 'GET', corps } = {}) {
  const options = { method: methode, headers: {}, cache: 'no-store' };
  if (corps !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(corps);
  }
  const rep = await fetch(chemin, options);
  const json = await rep.json().catch(() => ({}));
  if (rep.status === 401 && etat.moi && etat.moi.user) { location.href = '/login.html'; }
  if (!rep.ok) {
    const e = new Error(json.error || 'Erreur ' + rep.status);
    e.status = rep.status;
    throw e;
  }
  return json;
}

/* ---------- Dates ---------- */

function debutJour(decalage = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - decalage);
  return d.getTime();
}

function libelleJour(ts) {
  if (ts >= debutJour(0)) return "Aujourd'hui";
  if (ts >= debutJour(1)) return 'Hier';
  const s = new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const heure = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dateCourte = (ts) => new Date(ts).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function ilYa(ts) {
  if (!ts) return 'jamais';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  const j = Math.round(s / 86400);
  return j < 60 ? `il y a ${j} j` : new Date(ts).toLocaleDateString('fr-FR');
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/* ---------- État ---------- */

const etat = {
  moi: null,
  vue: 'actus',
  articles: [],
  erreurs: [],
  collecte: null,
  chargeA: 0,
  categorie: stockage.lire('veille_categorie', ''),
  source: '',
  recherche: '',
  periode: stockage.lire('veille_periode', '2'),
  tri: stockage.lire('veille_tri', 'asc'),
  afficherLus: false,
  feeds: [],
  comptes: [],
  // (hérité de la lecture anonyme, plus utilisée : connexion obligatoire)
  lusLocaux: new Set(stockage.lire('veille_lus_local', [])),
  // Modifications pas encore confirmées par le serveur : id -> true (lu) | false (non lu)
  enAttente: new Map(stockage.lire('veille_en_attente', [])),
  syncErreur: '',
};

const connecte = () => !!(etat.moi && etat.moi.user);
const estAdmin = () => connecte() && etat.moi.user.role === 'admin';

/* ---------- Toast ---------- */

let minuteurToast = null;
let annulation = null;
function toast(texte, { annuler = null, erreur = false } = {}) {
  const t = $('#toast');
  $('#toastTexte').textContent = texte;
  $('#toastAnnuler').hidden = !annuler;
  annulation = annuler;
  t.classList.toggle('error', erreur);
  t.classList.add('show');
  clearTimeout(minuteurToast);
  minuteurToast = setTimeout(() => t.classList.remove('show'), annuler ? 6000 : 3500);
}
$('#toastAnnuler').addEventListener('click', () => {
  $('#toast').classList.remove('show');
  if (annulation) annulation();
  annulation = null;
});

/* =====================================================================
   Navigation, en-tête
   ===================================================================== */

const VUES = {
  actus: { kicker: 'Veille technologique', titre: 'Actualités', recherche: 'Rechercher un article, une source…' },
  flux: { kicker: 'Mes abonnements', titre: 'Mes flux', recherche: 'Filtrer mes flux (nom, adresse, catégorie)…' },
  comptes: { kicker: 'Administration', titre: "Comptes d'accès", recherche: 'Filtrer les comptes…' },
};

function afficherVue(vue) {
  if (!VUES[vue] || (vue === 'comptes' && !estAdmin())) vue = 'actus';
  const changement = etat.vue !== vue;
  etat.vue = vue;
  $$('.vue').forEach((s) => { s.hidden = s.id !== 'vue-' + vue; });
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.vue === vue));
  $('#kicker').textContent = VUES[vue].kicker;
  $('#titrePage').textContent = VUES[vue].titre;
  const champ = $('#recherche');
  champ.placeholder = VUES[vue].recherche;
  if (changement) { champ.value = ''; etat.recherche = ''; }
  if (vue === 'flux') chargerFlux();
  if (vue === 'comptes') chargerComptes();
  if (vue === 'actus') rendreArticles();
}
window.addEventListener('hashchange', () => afficherVue(location.hash.slice(1) || 'actus'));
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) location.hash = '#' + t.dataset.vue;
});

$('#btnTheme').addEventListener('click', () => window.toggleTheme());

$('#btnDeconnexion').addEventListener('click', async () => {
  await api('/api/logout', { methode: 'POST', corps: {} }).catch(() => {});
  location.href = '/login.html';
});

// Recherche commune aux trois vues ; « / » pour y aller directement
let minuteurRecherche = null;
$('#recherche').addEventListener('input', (e) => {
  clearTimeout(minuteurRecherche);
  minuteurRecherche = setTimeout(() => {
    etat.recherche = e.target.value;
    if (etat.vue === 'actus') rendreArticles();
    else if (etat.vue === 'flux') rendreFlux();
    else rendreComptes();
  }, 120);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input, textarea, select, dialog')) {
    e.preventDefault();
    $('#recherche').focus();
  } else if (e.key === 'Escape' && e.target.id === 'recherche' && e.target.value) {
    e.target.value = '';
    e.target.dispatchEvent(new Event('input'));
  }
});

/* ---------- Menu utilisateur ---------- */

function rendreMenu() {
  const el = $('#umenu');
  if (!connecte()) { el.innerHTML = ''; return; }
  const u = etat.moi.user;
  const role = u.role === 'admin' ? 'Administrateur' : 'Lecteur';
  el.innerHTML = `<button class="user-chip" type="button" aria-haspopup="menu" aria-expanded="false" id="umenuBtn" title="Compte">
      <span class="dot">${esc(u.username.slice(0, 2))}</span><span class="uname">${esc(u.username)}</span><span class="role">· ${u.role === 'admin' ? 'Admin' : 'Lecteur'}</span><span class="caret">▾</span></button>
    <div class="umenu-pop" role="menu">
      <div class="umenu-who"><strong>${esc(u.username)}</strong><span>${role}${u.twofa ? ' · 2FA active' : ''}</span></div>
      <button role="menuitem" type="button" data-menu="moncompte">${ICON.key}<span>Mon compte<small>Mot de passe, double authentification</small></span></button>
      <button role="menuitem" type="button" data-menu="flux">${ICON.rss}<span>Mes flux<small>Ajouter, importer / exporter en OPML</small></span></button>
      <button role="menuitem" type="button" data-menu="sauvegarde">${ICON.download}<span>Sauvegarder / restaurer<small>Mes flux et mes articles lus (.json)</small></span></button>
      ${u.role === 'admin' ? `<div class="umenu-sep"></div>
      <button role="menuitem" type="button" data-menu="comptes">${ICON.users}<span>Comptes d’accès<small>Qui peut se connecter à l’application</small></span></button>` : ''}
    </div>`;
}
function basculerMenu(force) {
  const m = $('#umenu');
  const ouvert = force ?? !m.classList.contains('open');
  m.classList.toggle('open', ouvert);
  $('#umenuBtn')?.setAttribute('aria-expanded', String(ouvert));
  if (ouvert) m.querySelector('.umenu-pop button')?.focus({ preventScroll: true });
}
$('#umenu').addEventListener('click', (e) => {
  if (e.target.closest('#umenuBtn')) { basculerMenu(); return; }
  const b = e.target.closest('[data-menu]');
  if (!b) return;
  basculerMenu(false);
  if (b.dataset.menu === 'moncompte') ouvrirMoi();
  else if (b.dataset.menu === 'sauvegarde') ouvrirSauvCompte(null);
  else location.hash = '#' + b.dataset.menu;
});
document.addEventListener('click', (e) => {
  const m = $('#umenu');
  if (m.classList.contains('open') && !m.contains(e.target)) basculerMenu(false);
});
document.addEventListener('keydown', (e) => {
  const m = $('#umenu');
  if (!m.classList.contains('open')) return;
  if (e.key === 'Escape') { basculerMenu(false); $('#umenuBtn')?.focus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = $$('.umenu-pop button', m);
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
});

/* ---------- Logo personnalisé (branding/) ---------- */

function appliquerBranding() {
  fetch('/api/info').then((r) => r.json()).then((info) => {
    if (!info || !info.logo) return;
    const mark = $('#brandMark');
    if (!mark) return;
    mark.outerHTML = info.logoDark
      ? `<img src="${esc(info.logo)}" alt="" class="brand-logo only-light"><img src="${esc(info.logoDark)}" alt="" class="brand-logo only-dark">`
      : `<img src="${esc(info.logo)}" alt="" class="brand-logo auto-dark">`;
  }).catch(() => {});
}

$$('dialog [data-fermer]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

/* =====================================================================
   Actualités
   ===================================================================== */

function depuis() {
  return debutJour(Number(etat.periode) - 1);
}

function estLu(a) {
  if (etat.enAttente.has(a.id)) return etat.enAttente.get(a.id);
  return connecte() ? a.read : etat.lusLocaux.has(a.link);
}

let chargementArticles = null;
async function chargerArticles({ silencieux = false } = {}) {
  if (chargementArticles) return chargementArticles;
  chargementArticles = (async () => {
    try {
      const d = await api('/api/articles?since=' + depuis());
      const signature = (l) => l.map((a) => a.id + (a.read ? 'l' : '')).join(',');
      const change = signature(d.articles) !== signature(etat.articles);
      etat.articles = d.articles;
      etat.erreurs = d.erreurs;
      etat.nbFlux = d.nbFlux;
      etat.collecte = d.collecte;
      $('#countFlux').textContent = d.nbFlux || '';
      etat.chargeA = Date.now();
      if (etat.vue === 'actus' && (change || !silencieux)) rendreArticles();
      else rendreEtat();
    } catch (e) {
      if (!silencieux) $('#liste').innerHTML = `<div class="empty">${ICON.alert}<div>Impossible de charger les actualités<small>${esc(e.message)}</small></div></div>`;
    } finally {
      chargementArticles = null;
    }
  })();
  return chargementArticles;
}

function articlesFiltres({ ignorerCategorie = false, ignorerSource = false } = {}) {
  const q = etat.recherche.trim().toLowerCase();
  return etat.articles.filter((a) =>
    (ignorerCategorie || !etat.categorie || (a.category || '') === etat.categorie) &&
    (ignorerSource || !etat.source || a.feedId === etat.source) &&
    (!q || a.title.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q) || a.feed.toLowerCase().includes(q)));
}

function rendreFiltres() {
  // Catégories, avec le nombre d'articles non lus
  const base = articlesFiltres({ ignorerCategorie: true, ignorerSource: true });
  const parCat = new Map();
  for (const a of base) {
    const c = a.category || '';
    parCat.set(c, (parCat.get(c) || 0) + (estLu(a) ? 0 : 1));
  }
  if (etat.categorie && !parCat.has(etat.categorie)) parCat.set(etat.categorie, 0);
  const total = base.filter((a) => !estLu(a)).length;
  const cats = [...parCat].sort((a, b) => (a[0] || '~').localeCompare(b[0] || '~', 'fr'));
  const chip = (val, lib, n, actif, attr) =>
    `<button type="button" class="chip${actif ? ' active' : ''}" ${attr}="${esc(val)}">${esc(lib)}<span class="n">${n}</span></button>`;
  $('#categories').innerHTML =
    chip('', 'Toutes', total, !etat.categorie, 'data-cat') +
    cats.map(([c, n]) => chip(c, c || 'Sans catégorie', n, etat.categorie === c, 'data-cat')).join('');

  // Sources de la catégorie choisie
  const zone = $('#sources');
  if (!etat.categorie) { zone.hidden = true; etat.source = ''; return; }
  const parSource = new Map();
  for (const a of articlesFiltres({ ignorerSource: true })) {
    const s = parSource.get(a.feedId) || { nom: a.feed, n: 0 };
    s.n += estLu(a) ? 0 : 1;
    parSource.set(a.feedId, s);
  }
  if (etat.source && !parSource.has(etat.source)) etat.source = '';
  const srcs = [...parSource].sort((a, b) => a[1].nom.localeCompare(b[1].nom, 'fr'));
  zone.hidden = srcs.length < 2 && !etat.source;
  zone.innerHTML =
    chip('', 'Toutes les sources', [...parSource.values()].reduce((t, s) => t + s.n, 0), !etat.source, 'data-src') +
    srcs.map(([id, s]) => chip(id, s.nom, s.n, etat.source === id, 'data-src')).join('');
}

function rendreSync() {
  const el = $('#sync');
  if (!connecte()) { el.dataset.state = 'idle'; return; }
  el.dataset.state = etat.syncErreur ? 'error' : etat.enAttente.size ? 'pending' : el.dataset.state === 'ok' ? 'ok' : 'idle';
  el.title = etat.syncErreur
    ? `Hors ligne : ${etat.syncErreur}${etat.enAttente.size ? ` — ${pluriel(etat.enAttente.size, 'modification', 'modifications')} en attente, nouvel essai automatique` : ''}`
    : 'Articles lus synchronisés entre vos appareils';
}

function rendreEtat() {
  const c = etat.collecte || {};
  const nonLus = etat.articles.filter((a) => !estLu(a)).length;
  const parts = [`<strong>${nonLus}</strong>&nbsp;non lu${nonLus > 1 ? 's' : ''}`];
  if (c.enCours) parts.push('collecte en cours…');
  else if (c.fin) parts.push(`collecte ${heure(c.fin)}` + (c.prochaine ? ` · prochaine ${heure(c.prochaine)}` : ''));
  if (etat.erreurs.length) {
    const titre = etat.erreurs.map((e) => `${e.name} : ${e.last_error || 'erreur'}`).join('\n');
    const texte = pluriel(etat.erreurs.length, 'flux en erreur', 'flux en erreur');
    parts.push(estAdmin()
      ? `<button type="button" class="alerte" title="${esc(titre)}" data-aller="flux">${texte}</button>`
      : `<span class="alerte" title="${esc(titre)}">${texte}</span>`);
  }
  $('#etat').innerHTML = ICON.clock + `<span>${parts.join(' <span class="sep">·</span> ')}</span>`;
  $('#countActus').textContent = nonLus || '';
  document.title = nonLus ? `(${nonLus}) Veille technologique` : 'Veille technologique';
  rendreSync();
}

function carteArticle(a) {
  const lu = estLu(a);
  return `<article class="card card-clickable article${lu ? ' lu' : ''}" data-id="${a.id}">
      <div class="article-top">
        <button type="button" class="badge badge-site badge-filtre" data-action="source" title="Afficher uniquement ${esc(a.feed)}">${esc(a.feed)}</button>
        ${lu
          ? `<button type="button" class="btn btn-icon btn-sm btn-lu fait" data-action="nonlu" title="Remettre en non lu" aria-label="Remettre en non lu">${ICON.undo}</button>`
          : `<button type="button" class="btn btn-icon btn-sm btn-lu" data-action="lu" title="Marquer comme lu" aria-label="Marquer comme lu">${ICON.check}</button>`}
      </div>
      <h3><a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></h3>
      ${a.summary ? `<p>${esc(a.summary)}</p>` : ''}
      <div class="article-meta"><span class="cat">${esc(a.category || '')}</span><time datetime="${new Date(a.published).toISOString()}">${dateCourte(a.published)}</time></div>
    </article>`;
}

function rendreArticles() {
  rendreFiltres();
  rendreEtat();
  const conteneur = $('#liste');
  if (!etat.chargeA) return;

  const selection = articlesFiltres();
  const nonLus = selection.filter((a) => !estLu(a));
  const nbLus = selection.length - nonLus.length;
  if (!nbLus) etat.afficherLus = false;
  const liste = (etat.afficherLus ? selection : nonLus).slice();
  if (etat.tri === 'desc') liste.reverse();

  const portee = etat.source ? `de ${esc(selection[0]?.feed || 'ce flux')}` : etat.categorie !== '' ? `de « ${esc(etat.categorie || 'Sans catégorie')} »` : '';
  const infoLus = nbLus
    ? `<p class="info-lus">${pluriel(nbLus, 'article lu', 'articles lus')} ${portee}${etat.afficherLus ? '' : ' masqué' + (nbLus > 1 ? 's' : '')} ·<button type="button" class="lien" data-action="basculer-lus">${etat.afficherLus ? 'Masquer les articles lus' : 'Les afficher'}</button>` +
      ` ·<button type="button" class="lien" data-action="remettre">Les remettre en non lu</button></p>`
    : '';

  $('#categories').hidden = !etat.nbFlux;
  if (!etat.nbFlux) {
    conteneur.innerHTML = `<div class="empty">${ICON.rss}<div>Vous ne suivez encore aucun flux<small>Ajoutez l'adresse d'un site ou importez un fichier OPML (NetNewsWire, Feedly, Inoreader…).</small></div>
      <div class="empty-actions"><a class="btn btn-primary" href="#flux">Ajouter mes flux</a></div></div>`;
    return;
  }
  if (!liste.length) {
    let msg;
    if (!etat.articles.length) msg = 'Aucun article publié sur cette période<small>Les flux ont été consultés mais rien de nouveau n\'a été publié.</small>';
    else if (etat.recherche) msg = 'Aucun article ne correspond à la recherche';
    else msg = 'Tout est lu<small>Les nouveaux articles apparaîtront ici automatiquement.</small>';
    conteneur.innerHTML = `<div class="empty">${ICON.inbox}<div>${msg}</div></div>` + infoLus;
    return;
  }

  // Regroupement par jour
  const jours = [];
  for (const a of liste) {
    const j = libelleJour(a.published);
    if (!jours.length || jours[jours.length - 1].nom !== j) jours.push({ nom: j, articles: [] });
    jours[jours.length - 1].articles.push(a);
  }
  conteneur.innerHTML = jours.map((j) => {
    const n = j.articles.filter((a) => !estLu(a)).length;
    return `<section class="site-group">
      <div class="site-group-header"><span class="site-group-name">${ICON.clock}${esc(j.nom)}</span><span class="site-group-count">${n ? pluriel(n, 'non lu', 'non lus') : 'tout lu'}</span></div>
      <div class="grid">${j.articles.map(carteArticle).join('')}</div>
    </section>`;
  }).join('') + infoLus;
}

/* ---------- Lu / non lu ---------- */

// Remet en non lu les articles lus de la sélection affichée (un flux, une catégorie…), pas les autres
function remettreSelection() {
  const ids = articlesFiltres().filter((a) => estLu(a)).map((a) => a.id);
  if (!ids.length) return;
  marquer(ids, false);
  toast(`${pluriel(ids.length, 'article remis', 'articles remis')} en non lu`, { annuler: () => marquer(ids, true) });
}

function sauverAttente() { stockage.ecrire('veille_en_attente', [...etat.enAttente]); }

let envoiEnCours = false;
async function envoyerAttente() {
  if (!connecte() || envoiEnCours || !etat.enAttente.size) return;
  envoiEnCours = true;
  rendreSync();
  const lot = [...etat.enAttente];
  try {
    for (const valeur of [true, false]) {
      const ids = lot.filter(([, v]) => v === valeur).map(([id]) => id);
      if (ids.length) await api('/api/read', { methode: 'POST', corps: { ids, read: valeur } });
    }
    for (const [id, v] of lot) {
      if (etat.enAttente.get(id) === v) {
        etat.enAttente.delete(id);
        const a = etat.articles.find((x) => x.id === id);
        if (a) a.read = v;
      }
    }
    etat.syncErreur = '';
    $('#sync').dataset.state = 'ok';
    setTimeout(() => { if ($('#sync').dataset.state === 'ok') $('#sync').dataset.state = 'idle'; }, 1500);
  } catch (e) {
    if (e.status !== 401) etat.syncErreur = e.message;
  } finally {
    envoiEnCours = false;
    sauverAttente();
    rendreEtat();
  }
}

function marquer(ids, lu) {
  for (const id of ids) {
    const a = etat.articles.find((x) => x.id === id);
    if (!a) continue;
    if (connecte()) etat.enAttente.set(id, lu);
    else if (lu) etat.lusLocaux.add(a.link);
    else etat.lusLocaux.delete(a.link);
  }
  if (connecte()) { sauverAttente(); envoyerAttente(); }
  else stockage.ecrire('veille_lus_local', [...etat.lusLocaux].slice(-3000));
  rendreArticles();
}

$('#liste').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'basculer-lus') {
    etat.afficherLus = !etat.afficherLus;
    rendreArticles();
    return;
  }
  if (btn.dataset.action === 'remettre') { remettreSelection(); return; }
  const id = Number(btn.closest('.article').dataset.id);
  if (btn.dataset.action === 'source') {
    const a = etat.articles.find((x) => x.id === id);
    if (!a) return;
    etat.categorie = a.category || '';
    etat.source = a.feedId;
    stockage.ecrire('veille_categorie', etat.categorie);
    rendreArticles();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (btn.dataset.action === 'nonlu') marquer([id], false);
  else if (btn.dataset.action === 'lu') {
    marquer([id], true);
    toast('Article marqué comme lu', { annuler: () => marquer([id], false) });
  }
});

$('#etat').addEventListener('click', (e) => {
  if (e.target.closest('[data-aller="flux"]')) location.hash = '#flux';
});

$('#categories').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  etat.categorie = b.dataset.cat;
  etat.source = '';
  stockage.ecrire('veille_categorie', etat.categorie);
  rendreArticles();
});

$('#sources').addEventListener('click', (e) => {
  const b = e.target.closest('[data-src]');
  if (!b) return;
  etat.source = b.dataset.src ? Number(b.dataset.src) : '';
  rendreArticles();
});

$('#periode').value = etat.periode;
$('#periode').addEventListener('change', (e) => {
  etat.periode = e.target.value;
  stockage.ecrire('veille_periode', etat.periode);
  chargerArticles();
});

$('#tri').value = etat.tri;
$('#tri').addEventListener('change', (e) => {
  etat.tri = e.target.value;
  stockage.ecrire('veille_tri', etat.tri);
  rendreArticles();
});

$('#btnToutLu').addEventListener('click', () => {
  const ids = articlesFiltres().filter((a) => !estLu(a)).map((a) => a.id);
  if (!ids.length) return;
  marquer(ids, true);
  toast(`${pluriel(ids.length, 'article marqué', 'articles marqués')} comme lu${ids.length > 1 ? 's' : ''}`, { annuler: () => marquer(ids, false) });
});

async function avecAttente(bouton, action) {
  bouton.disabled = true;
  const svgBouton = bouton.querySelector('svg');
  svgBouton?.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity });
  try { return await action(); } finally {
    bouton.disabled = false;
    svgBouton?.getAnimations().forEach((a) => a.cancel());
  }
}

$('#btnActualiser').addEventListener('click', (e) => avecAttente(e.currentTarget, async () => {
  try {
    if (connecte()) await api('/api/refresh', { methode: 'POST', corps: {} });
    await chargerArticles();
  } catch (err) {
    toast('Échec : ' + err.message, { erreur: true });
  }
}));

/* ---------- Synchronisation automatique ---------- */

function resynchroniser() {
  if (document.hidden) return;
  envoyerAttente();
  chargerArticles({ silencieux: true });   // la collecte se fait côté serveur : on relit la liste
}
document.addEventListener('visibilitychange', resynchroniser);
window.addEventListener('focus', resynchroniser);
window.addEventListener('online', resynchroniser);
setInterval(resynchroniser, 60000);

/* =====================================================================
   Gestion des flux (administrateurs)
   ===================================================================== */

async function chargerFlux() {
  try {
    const d = await api('/api/feeds');
    etat.feeds = d.feeds;
    if (d.collecte) etat.collecte = d.collecte;
    rendreFlux();
  } catch (e) {
    $('#listeFlux').innerHTML = `<div class="empty">${ICON.alert}<div>${esc(e.message)}</div></div>`;
  }
}

function etatFlux(f) {
  if (!f.enabled) return { tag: '<span class="acc-tag off">Désactivé</span>', icone: 'off' };
  if (!f.last_fetch) return { tag: '<span class="acc-tag warn">Jamais collecté</span>', icone: '' };
  if (f.error_count > 0) return { tag: `<span class="acc-tag off">Erreur${f.error_count > 1 ? ` ×${f.error_count}` : ''}</span>`, icone: 'err' };
  return { tag: `<span class="acc-tag ok">OK · ${ilYa(f.last_ok)}</span>`, icone: '' };
}

function ligneFlux(f) {
  const e = etatFlux(f);
  const erreur = f.enabled && f.error_count > 0
    ? `<div class="acc-meta erreur">${esc(f.last_error || '')}${f.last_ok ? ` — dernier succès ${ilYa(f.last_ok)}` : ''}</div>` : '';
  return `<div class="card acc-row${f.enabled ? '' : ' off'}" data-id="${f.id}">
      <span class="item-icon ${e.icone}">${ICON.rss}</span>
      <div class="acc-row-body">
        <div class="acc-name">${f.site_url ? `<a href="${esc(f.site_url)}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a>` : esc(f.name)} ${e.tag}</div>
        <div class="acc-meta" title="${esc(f.url)}">${esc(f.url)}</div>
        ${erreur}
      </div>
      <div class="acc-stats"><span><b>${f.nb_articles}</b> articles${f.nb_lus ? ` · ${f.nb_lus} lu${f.nb_lus > 1 ? 's' : ''}` : ''}</span><span>dernier : ${f.dernier_article ? ilYa(f.dernier_article) : '—'}</span></div>
      <div class="acc-acts">
        <label class="switch" title="${f.enabled ? 'Désactiver' : 'Activer'}"><input type="checkbox" data-action="activer" ${f.enabled ? 'checked' : ''} aria-label="Flux actif"><span></span></label>
 ${f.nb_lus ? `<button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="reafficher" title="Réafficher ses ${f.nb_lus} article${f.nb_lus > 1 ? 's' : ''} lu${f.nb_lus > 1 ? 's' : ''}" aria-label="Réafficher ses articles lus">${ICON.eye}</button>` : ''}
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="tester" title="Collecter maintenant" aria-label="Collecter maintenant">${ICON.refresh}</button>
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="modifier" title="Modifier" aria-label="Modifier">${ICON.edit}</button>
        <button class="btn btn-icon btn-sm btn-ghost btn-danger" type="button" data-action="supprimer" title="Supprimer" aria-label="Supprimer">${ICON.trash}</button>
      </div>
    </div>`;
}

function rendreFlux() {
  const q = etat.recherche.trim().toLowerCase();
  const feeds = etat.feeds.filter((f) => !q || [f.name, f.url, f.category].some((v) => (v || '').toLowerCase().includes(q)));
  const nbErr = etat.feeds.filter((f) => f.enabled && f.error_count > 0).length;
  const nbActifs = etat.feeds.filter((f) => f.enabled).length;
  const c = etat.collecte || {};
  $('#countFlux').textContent = etat.feeds.length || '';
  etat.nbFlux = etat.feeds.length;
  $('#etatFlux').innerHTML = ICON.rss + `<span><strong>${etat.feeds.length}</strong> flux · ${nbActifs} actif${nbActifs > 1 ? 's' : ''}` +
    (nbErr ? ` <span class="sep">·</span> <span class="alerte">${nbErr} en erreur</span>` : '') +
    (c.fin ? ` <span class="sep">·</span> collecte ${heure(c.fin)}` : '') +
    (c.intervalleMin ? `, toutes les ${c.intervalleMin} min` : '') + '</span>';

  $('#listeCategories').innerHTML = [...new Set(etat.feeds.map((f) => f.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'fr')).map((x) => `<option value="${esc(x)}">`).join('');

  if (!feeds.length) {
    $('#listeFlux').innerHTML = etat.feeds.length
      ? `<div class="empty">${ICON.rss}<div>Aucun flux ne correspond</div></div>`
      : `<div class="empty">${ICON.rss}<div>Aucun flux pour l'instant<small>Ajoutez l'adresse d'un site (le flux est détecté automatiquement) ou importez un fichier OPML.</small></div>
         <div class="empty-actions"><button class="btn btn-primary" type="button" data-vide="ajouter">Ajouter un flux</button><button class="btn" type="button" data-vide="importer">Importer OPML</button></div></div>`;
    return;
  }
  const groupes = new Map();
  for (const f of feeds) {
    const cat = f.category || '';
    if (!groupes.has(cat)) groupes.set(cat, []);
    groupes.get(cat).push(f);
  }
  $('#listeFlux').innerHTML = [...groupes].sort((a, b) => (a[0] || '~').localeCompare(b[0] || '~', 'fr')).map(([cat, liste]) => `
    <section class="site-group">
      <div class="site-group-header"><span class="site-group-name">${ICON.rss}${esc(cat || 'Sans catégorie')}</span><span class="site-group-count">${pluriel(liste.length, 'flux', 'flux')}</span></div>
      <div class="list">${liste.map(ligneFlux).join('')}</div>
    </section>`).join('');
}

$('#listeFlux').addEventListener('click', async (e) => {
  const v = e.target.closest('[data-vide]');
  if (v) { if (v.dataset.vide === 'ajouter') ouvrirFlux(); else $('#fichierOpml').click(); return; }
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  const id = Number(b.closest('[data-id]').dataset.id);
  const f = etat.feeds.find((x) => x.id === id);
  if (b.dataset.action === 'modifier') return ouvrirFlux(f);
  if (b.dataset.action === 'reafficher') {
    try {
      const r = await api(`/api/feeds/${id}/unread`, { methode: 'POST', corps: {} });
      const annuler = async () => {
        await api('/api/read', { methode: 'POST', corps: { ids: r.ids, read: true } }).catch(() => {});
        chargerFlux(); chargerArticles({ silencieux: true });
      };
      toast(`${f.name} : ${pluriel(r.ids.length, 'article réaffiché', 'articles réaffichés')}`, { annuler });
      chargerFlux();
      chargerArticles({ silencieux: true });
    } catch (err) { toast('Échec : ' + err.message, { erreur: true }); }
    return;
  }
  if (b.dataset.action === 'supprimer') {
    if (!confirm(`Supprimer le flux « ${f.name} » et ses articles ?`)) return;
    try {
      await api('/api/feeds/' + id, { methode: 'DELETE' });
      toast(`Flux « ${f.name} » supprimé`);
      chargerFlux();
      chargerArticles({ silencieux: true });
    } catch (err) { toast('Échec : ' + err.message, { erreur: true }); }
    return;
  }
  if (b.dataset.action === 'tester') {
    await avecAttente(b, async () => {
      try {
        const r = await api(`/api/feeds/${id}/refresh`, { methode: 'POST', corps: {} });
        if (r.ok) toast(`${f.name} : OK, ${pluriel(r.nouveaux || 0, 'nouvel article', 'nouveaux articles')}`);
        else toast(`${f.name} : ${r.erreur}`, { erreur: true });
        if (r.nouveaux) chargerArticles({ silencieux: true });
      } catch (err) {
        toast('Échec : ' + err.message, { erreur: true });
      }
    });
    chargerFlux();
  }
});

$('#listeFlux').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[data-action="activer"]');
  if (!cb) return;
  const id = Number(cb.closest('[data-id]').dataset.id);
  try {
    await api('/api/feeds/' + id, { methode: 'PATCH', corps: { enabled: cb.checked } });
    await chargerFlux();
    chargerArticles({ silencieux: true });
  } catch (err) {
    cb.checked = !cb.checked;
    toast('Échec : ' + err.message, { erreur: true });
  }
});

/* ---------- Fenêtre ajout / modification ---------- */

const dlgFlux = $('#dlgFlux');
let fluxEdite = null;

function erreurDans(el, texte) {
  el.textContent = texte || '';
  el.hidden = !texte;
}

function ouvrirFlux(f = null) {
  fluxEdite = f;
  const form = $('#formFlux');
  form.reset();
  $('#titreDlgFlux').textContent = f ? 'Modifier le flux' : 'Ajouter un flux';
  $('#btnEnregFlux').textContent = f ? 'Enregistrer' : 'Ajouter';
  erreurDans($('#errFlux'), '');
  const sonde = $('#sonde');
  sonde.className = 'form-hint';
  sonde.textContent = f ? '' : "Adresse d'un flux, ou simplement celle du site : le flux sera détecté.";
  if (f) {
    form.url.value = f.url;
    form.name.value = f.name;
    form.category.value = f.category || '';
  } else if (etat.categorie) {
    form.category.value = etat.categorie;
  }
  dlgFlux.showModal();
  (f ? form.name : form.url).focus();
}

$('#btnAjoutFlux').addEventListener('click', () => ouvrirFlux());

async function sonder() {
  const form = $('#formFlux');
  const url = form.url.value.trim();
  const sonde = $('#sonde');
  if (!url) return null;
  sonde.className = 'form-hint';
  sonde.textContent = 'Vérification…';
  $('#btnSonder').disabled = true;
  try {
    const r = await api('/api/feeds/probe', { methode: 'POST', corps: { url } });
    if (r.url !== url) form.url.value = r.url;
    if (!form.name.value.trim() && r.titre) form.name.value = r.titre.slice(0, 80);
    const doublon = r.existe && (!fluxEdite || r.existe.id !== fluxEdite.id);
    sonde.className = 'form-hint ' + (doublon ? 'ko' : 'ok');
    sonde.textContent = `✓ ${r.titre || 'Flux valide'} — ${pluriel(r.nb, 'article', 'articles')}` +
      (r.dernier ? `, dernier ${ilYa(r.dernier)}` : '') +
      (r.url !== url ? ' (adresse du flux détectée)' : '') +
      (doublon ? ` — vous le suivez déjà : « ${r.existe.name} »` : '');
    return r;
  } catch (e) {
    sonde.className = 'form-hint ko';
    sonde.textContent = '✗ ' + e.message;
    return null;
  } finally {
    $('#btnSonder').disabled = false;
  }
}
$('#btnSonder').addEventListener('click', sonder);
$('#fluxUrl').addEventListener('change', () => { if (!fluxEdite) sonder(); });

$('#formFlux').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  erreurDans($('#errFlux'), '');
  if (!form.name.value.trim() && !fluxEdite) await sonder();
  const corps = { url: form.url.value.trim(), name: form.name.value.trim(), category: form.category.value.trim() };
  if (!corps.name) { erreurDans($('#errFlux'), 'Indiquez un nom'); return; }
  const bouton = $('#btnEnregFlux');
  bouton.disabled = true;
  try {
    const r = fluxEdite
      ? await api('/api/feeds/' + fluxEdite.id, { methode: 'PATCH', corps })
      : await api('/api/feeds', { methode: 'POST', corps });
    dlgFlux.close();
    if (r.collecte && !r.collecte.ok) toast(`Enregistré, mais la collecte a échoué : ${r.collecte.erreur}`, { erreur: true });
    else toast(fluxEdite ? 'Flux modifié' : `Flux ajouté${r.collecte ? ` — ${pluriel(r.collecte.nouveaux || 0, 'article', 'articles')}` : ''}`);
    await chargerFlux();
    chargerArticles({ silencieux: true });
  } catch (ex) {
    erreurDans($('#errFlux'), ex.message);
  } finally {
    bouton.disabled = false;
  }
});

/* ---------- OPML, collecte ---------- */

$('#btnImport').addEventListener('click', () => $('#fichierOpml').click());
$('#fichierOpml').addEventListener('change', async (e) => {
  const fichier = e.target.files[0];
  e.target.value = '';
  if (!fichier) return;
  try {
    const opml = await fichier.text();
    // Sauvegarde de compte (.json) : restaurée en mode « Ajouter »
    if (/^\s*\{/.test(opml)) {
      const r = await api('/api/me/restore', { methode: 'POST', corps: { fichier: opml, mode: 'ajouter' } });
      toast(resumeRestauration(r));
      await chargerFlux();
      chargerArticles({ silencieux: true });
      return;
    }
    const r = await api('/api/feeds/import', { methode: 'POST', corps: { opml } });
    toast(`${pluriel(r.ajoutes, 'flux ajouté', 'flux ajoutés')}${r.existants ? `, ${r.existants} déjà suivi${r.existants > 1 ? 's' : ''}` : ''}` +
      `${r.ignores ? `, ${r.ignores} ignoré${r.ignores > 1 ? 's' : ''} (limite atteinte)` : ''}${r.ajoutes ? ' — collecte en cours' : ''}`);
    await chargerFlux();
    setTimeout(() => { if (etat.vue === 'flux') chargerFlux(); chargerArticles({ silencieux: true }); }, 20000);
  } catch (err) {
    toast('Import impossible : ' + err.message, { erreur: true });
  }
});

$('#btnCollecte').addEventListener('click', (e) => avecAttente(e.currentTarget, async () => {
  try {
    const r = await api('/api/refresh', { methode: 'POST', corps: {} });
    if (r.ignore) return toast('Collecte déjà lancée il y a moins d\'une minute');
    toast(`Collecte terminée : ${pluriel(r.nouveaux || 0, 'nouvel article', 'nouveaux articles')}${r.erreurs ? `, ${r.erreurs} flux en erreur` : ''}`);
    await chargerFlux();
    chargerArticles({ silencieux: true });
  } catch (err) {
    toast('Échec : ' + err.message, { erreur: true });
  }
}));

/* =====================================================================
   Comptes (administrateurs)
   ===================================================================== */

async function chargerComptes() {
  try {
    etat.comptes = (await api('/api/users')).users;
    rendreComptes();
  } catch (e) {
    $('#listeComptes').innerHTML = `<div class="empty">${ICON.alert}<div>${esc(e.message)}</div></div>`;
  }
}

function rendreComptes() {
  const q = etat.recherche.trim().toLowerCase();
  const moi = etat.moi.user.id;
  const comptes = etat.comptes.filter((u) => !q || u.username.toLowerCase().includes(q));
  if (!comptes.length) {
    $('#listeComptes').innerHTML = `<div class="empty">${ICON.users}<div>Aucun compte ne correspond</div></div>`;
    return;
  }
  $('#listeComptes').innerHTML = `<div class="list">${comptes.map((u) => `
    <div class="card acc-row" data-id="${u.id}">
      <span class="avatar">${esc(u.username.slice(0, 2))}</span>
      <div class="acc-row-body">
        <div class="acc-name">${esc(u.username)}${u.id === moi ? '<span class="you">(vous)</span>' : ''}
          <span class="acc-tag ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? 'Administrateur' : 'Lecteur'}</span>
          ${u.twofa ? '<span class="acc-tag ok" title="Double authentification active">2FA</span>'
            : u.require2fa ? '<span class="acc-tag warn" title="À configurer à la prochaine connexion">2FA requise</span>' : ''}</div>
        <div class="acc-meta">${u.last_seen ? 'actif ' + ilYa(u.last_seen) : 'jamais connecté'} · ${pluriel(u.nb_flux, 'flux', 'flux')} · ${pluriel(u.nb_lus, 'article lu', 'articles lus')}</div>
      </div>
      <div class="acc-acts">
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="sauvegarder" title="Sauvegarder / restaurer ce compte" aria-label="Sauvegarder / restaurer ce compte">${ICON.download}</button>
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="modifier" title="Modifier" aria-label="Modifier">${ICON.edit}</button>
        ${u.id === moi ? '' : `<button class="btn btn-icon btn-sm btn-ghost btn-danger" type="button" data-action="supprimer" title="Supprimer" aria-label="Supprimer">${ICON.trash}</button>`}
      </div>
    </div>`).join('')}</div>`;
}

$('#btnAjoutCompte').addEventListener('click', () => ouvrirCompte(null));

$('#listeComptes').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  const u = etat.comptes.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
  if (!u) return;
  if (b.dataset.action === 'sauvegarder') {
    ouvrirSauvCompte(u.id === etat.moi.user.id ? null : u);
  } else if (b.dataset.action === 'modifier') {
    if (u.id === etat.moi.user.id) ouvrirMoi();
    else ouvrirCompte(u);
  } else if (b.dataset.action === 'supprimer') {
    if (!confirm(`Supprimer le compte « ${u.username} » ?\n\nSes flux et ses articles lus sont gardés dans data/backups/comptes-supprimes/.`)) return;
    try {
      await api('/api/users/' + u.id, { methode: 'DELETE' });
      toast(`Compte « ${u.username} » supprimé (sauvegarde gardée sur le serveur)`);
      chargerComptes();
    } catch (err) { toast('Échec : ' + err.message, { erreur: true }); }
  }
});

/* ---------- Fenêtre compte d'accès : création, modification ---------- */

const dlgCompte = $('#dlgCompte');
let compteEdite = null; // null = création
let roleChoisi = 'user';

function choisirRole(r) {
  roleChoisi = r;
  $$('#choixRole button').forEach((b) => b.classList.toggle('on', b.dataset.role === r));
}

function ouvrirCompte(u) {
  compteEdite = u;
  const f = $('#formCompte');
  f.reset();
  erreurDans($('#errCompte'), '');
  $('#titreDlgCompte').textContent = u ? `Modifier « ${u.username} »` : 'Nouveau compte';
  $('#rangIdentifiant').hidden = !!u;
  f.username.required = !u;
  f.password.required = !u;
  $('#libMdp').textContent = u ? 'Nouveau mot de passe' : 'Mot de passe';
  f.password.placeholder = u ? 'Laisser vide pour ne pas le changer' : '';
  $('#aideMdp').textContent = u ? '8 caractères minimum. Ses appareils connectés seront déconnectés.' : '8 caractères minimum.';
  choisirRole(u ? u.role : 'user');
  $('#cptRequire2fa').checked = !!(u && u.require2fa);
  $('#rangReset2fa').hidden = !(u && u.twofa);
  $('#btnEnregCompte').textContent = u ? 'Enregistrer' : 'Créer';
  dlgCompte.showModal();
  (u ? f.password : f.username).focus();
}

$('#choixRole').addEventListener('click', (e) => {
  const b = e.target.closest('[data-role]');
  if (b) choisirRole(b.dataset.role);
});

$('#formCompte').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const bouton = $('#btnEnregCompte');
  bouton.disabled = true;
  try {
    const require2fa = $('#cptRequire2fa').checked;
    if (!compteEdite) {
      await api('/api/users', { methode: 'POST', corps: { username: f.username.value.trim(), password: f.password.value, role: roleChoisi, require2fa } });
      toast(`Compte « ${f.username.value.trim()} » créé`);
    } else {
      const corps = { role: roleChoisi, require2fa };
      if (f.password.value) corps.password = f.password.value;
      if ($('#cptReset2fa').checked) corps.reset2fa = true;
      await api('/api/users/' + compteEdite.id, { methode: 'PATCH', corps });
      toast(`Compte « ${compteEdite.username} » modifié`);
    }
    dlgCompte.close();
    chargerComptes();
  } catch (err) {
    erreurDans($('#errCompte'), err.message);
  } finally {
    bouton.disabled = false;
  }
});

/* =====================================================================
   Mon compte : mot de passe et double authentification
   ===================================================================== */

const dlgMoi = $('#dlgMoi');

function ouvrirMoi() {
  const u = etat.moi.user;
  const f = $('#formMoi');
  f.reset();
  f.username.value = u.username;
  erreurDans($('#errMoi'), '');
  $('#moiAvatar').textContent = u.username.slice(0, 2);
  $('#moiNom').textContent = u.username;
  $('#moiRole').textContent = u.role === 'admin' ? 'Administrateur' : 'Lecteur';
  rendre2fa();
  dlgMoi.showModal();
  f.current.focus();
}

$('#formMoi').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.password.value !== f.confirm.value) return erreurDans($('#errMoi'), 'Les deux mots de passe ne correspondent pas');
  try {
    await api('/api/me/password', { methode: 'POST', corps: { current: f.current.value, password: f.password.value } });
    f.reset();
    erreurDans($('#errMoi'), '');
    toast('Mot de passe modifié');
  } catch (err) {
    erreurDans($('#errMoi'), err.message);
  }
});

function rendre2fa(mode) {
  const el = $('#twofaSec');
  const u = etat.moi.user;
  const tete = `<h3>Double authentification ${u.twofa ? '<span class="acc-tag ok">Active</span>' : '<span class="acc-tag">Inactive</span>'}${u.require2fa ? '<span class="acc-tag warn">Imposée</span>' : ''}</h3>`;
  if (mode === 'desactiver') {
    el.innerHTML = tete + `<div class="acc-alert" id="tfErr" hidden></div><form class="row" id="tfDesactiver">
      <div class="form-row"><label class="form-label" for="tfMdp">Mot de passe</label><input type="password" id="tfMdp" autocomplete="current-password" required></div>
      <button class="btn btn-primary" type="submit">Désactiver</button><button type="button" class="btn" data-tf="annuler">Annuler</button></form>`;
    $('#tfMdp').focus();
    return;
  }
  el.innerHTML = tete + (u.twofa
    ? `<p>Un code à 6 chiffres de votre application d'authentification est demandé à chaque connexion.${u.require2fa ? " Elle est imposée par l'administrateur et ne peut pas être désactivée." : ''}</p>
       <div class="row">${u.require2fa ? '' : '<button type="button" class="btn" data-tf="desactiver">Désactiver</button>'}
         ${etat.moi.trustDays ? '<button type="button" class="btn" data-tf="oublier" title="Le code sera redemandé à la prochaine connexion sur chaque appareil">Oublier les appareils mémorisés</button>' : ''}</div>`
    : `<p>Protégez votre compte : en plus du mot de passe, un code à 6 chiffres généré par votre téléphone sera demandé.</p>
       <div><button type="button" class="btn btn-primary" data-tf="activer">Activer</button></div>`);
}

async function configurer2fa() {
  let st;
  try { st = await api('/api/2fa/setup', { methode: 'POST', corps: {} }); } catch (e) { return toast(e.message, { erreur: true }); }
  $('#twofaSec').innerHTML = `<h3>Double authentification</h3>
    <p class="twofa-intro">Scannez ce QR code avec l'application d'authentification <strong>de votre téléphone</strong> (Aegis, 2FAS, Google Authenticator,
      Microsoft Authenticator, Proton Authenticator…), puis saisissez le code affiché.</p>
    <img class="twofa-qr" src="${esc(st.qr)}" alt="QR code de configuration" width="200" height="200">
    <details class="twofa-manual"><summary>Impossible de scanner ? Saisie manuelle de la clé</summary>
      <code class="twofa-key">${esc(st.secret.replace(/(.{4})/g, '$1 ').trim())}</code><small>Type : basé sur le temps (TOTP) · 6 chiffres · 30 secondes</small></details>
    <div class="acc-alert" id="tfErr" hidden></div>
    <form class="acc-stack" id="tfActiver">
      <div class="form-row"><label class="form-label" for="tfCode">Code à 6 chiffres</label>
        <input type="text" id="tfCode" class="code-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456"></div>
      <div class="form-actions"><button type="button" class="btn" data-tf="annuler">Annuler</button><button class="btn btn-primary" type="submit">Activer la double authentification</button></div>
    </form>`;
  $('#tfCode').focus();
}

$('#twofaSec').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tf]');
  if (!b) return;
  const action = b.dataset.tf;
  if (action === 'activer') configurer2fa();
  else if (action === 'desactiver') rendre2fa('desactiver');
  else if (action === 'annuler') rendre2fa();
  else if (action === 'oublier') {
    try {
      await api('/api/me/forget-devices', { methode: 'POST', corps: {} });
      toast('Appareils oubliés : le code sera redemandé partout');
    } catch (err) { toast(err.message, { erreur: true }); }
  }
});

$('#twofaSec').addEventListener('input', (e) => {
  if (e.target.id === 'tfCode') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

$('#twofaSec').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (e.target.id === 'tfActiver') {
      const code = $('#tfCode').value;
      if (code.length !== 6) return erreurDans($('#tfErr'), 'Saisissez les 6 chiffres');
      etat.moi.user = await api('/api/2fa/enable', { methode: 'POST', corps: { code } });
      toast('Double authentification activée');
    } else if (e.target.id === 'tfDesactiver') {
      etat.moi.user = await api('/api/2fa/disable', { methode: 'POST', corps: { password: $('#tfMdp').value } });
      toast('Double authentification désactivée');
    }
    rendreMenu();
    rendre2fa();
    if (etat.vue === 'comptes') chargerComptes();
  } catch (err) {
    erreurDans($('#tfErr'), err.message);
    if ($('#tfCode')) $('#tfCode').value = '';
  }
});

/* =====================================================================
   Sauvegardes
   ===================================================================== */

function resumeRestauration(r) {
  const parts = [pluriel(r.ajoutes, 'flux ajouté', 'flux ajoutés')];
  if (r.misAJour) parts.push(`${r.misAJour} mis à jour`);
  if (r.retires) parts.push(`${r.retires} retiré${r.retires > 1 ? 's' : ''}`);
  if (r.ignores) parts.push(`${r.ignores} ignoré${r.ignores > 1 ? 's' : ''} (limite atteinte)`);
  if (r.lus) parts.push(`${r.lus} article${r.lus > 1 ? 's' : ''} lu${r.lus > 1 ? 's' : ''} repris`);
  return 'Restauration : ' + parts.join(', ') + (r.collecte ? ' — collecte en cours' : '');
}

// Téléchargement d'une réponse binaire (POST) sous forme de fichier
async function telechargerReponse(rep, nomParDefaut) {
  if (!rep.ok) {
    const j = await rep.json().catch(() => ({}));
    throw new Error(j.error || 'Erreur ' + rep.status);
  }
  const nom = /filename="([^"]+)"/.exec(rep.headers.get('content-disposition') || '')?.[1] || nomParDefaut;
  const url = URL.createObjectURL(await rep.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: nom });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* --- Sauvegarde / restauration d'un compte --- */

const dlgCompteSauv = $('#dlgCompteSauv');
let compteSauv = null; // null = moi
let modeRestauration = 'ajouter';

function choisirModeRestauration(m) {
  modeRestauration = m;
  $$('#modeRestaurer button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#aideModeRestaurer').textContent = m === 'remplacer'
    ? 'Les flux et les articles lus deviennent exactement ceux de la sauvegarde : les flux absents du fichier sont retirés.'
    : 'Ajoute les flux absents et marque lus les articles lus dans la sauvegarde. Rien n\'est supprimé.';
}

function ouvrirSauvCompte(u) {
  compteSauv = u;
  $('#formRestaurer').reset();
  erreurDans($('#errRestaurer'), '');
  choisirModeRestauration('ajouter');
  $('#titreCompteSauv').textContent = u ? `Sauvegarde de « ${u.username} »` : 'Sauvegarder / restaurer';
  $('#introCompteSauv').innerHTML = u
    ? `Flux (noms, catégories) et articles lus de <strong>${esc(u.username)}</strong>. L'opération est inscrite dans le journal du serveur.`
    : 'Vos flux (avec vos noms et catégories) et vos articles lus, dans un fichier <strong>.json</strong> à garder de côté. L’export OPML ne contient que les flux, pour un autre lecteur RSS.';
  $('#lienSauvJson').href = u ? `/api/users/${u.id}/backup` : '/api/me/backup';
  $('#lienSauvOpml').hidden = !!u;
  dlgCompteSauv.showModal();
}

$('#modeRestaurer').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) choisirModeRestauration(b.dataset.mode);
});

$('#formRestaurer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('#fichierRestaurer').files[0];
  if (!f) return;
  if (modeRestauration === 'remplacer' && !confirm('Remplacer tous les flux et l’état lu par ceux de la sauvegarde ?')) return;
  const bouton = $('#btnRestaurer');
  bouton.disabled = true;
  try {
    const url = compteSauv ? `/api/users/${compteSauv.id}/restore` : '/api/me/restore';
    const r = await api(url, { methode: 'POST', corps: { fichier: await f.text(), mode: modeRestauration } });
    dlgCompteSauv.close();
    toast(resumeRestauration(r));
    if (compteSauv) chargerComptes();
    else { if (etat.vue === 'flux') chargerFlux(); chargerArticles({ silencieux: true }); }
  } catch (err) {
    erreurDans($('#errRestaurer'), err.message);
  } finally {
    bouton.disabled = false;
  }
});

/* --- Sauvegardes de l'instance (admin) --- */

const dlgSauvegardes = $('#dlgSauvegardes');

function rendreQuotidiennes(d) {
  const derniere = d.quotidiennes[0];
  $('#infoQuotidienne').innerHTML = `Chaque jour, une copie de la base est faite dans <code>data/backups/AAAA-MM-JJ/</code> et gardée <strong>${d.jours} jours</strong>. ` +
    (derniere ? `Dernière : <strong>${esc(new Date(derniere.jour + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))}</strong>.` : 'Aucune copie pour l’instant.');
  $('#listeQuotidiennes').innerHTML = d.quotidiennes.map((x) =>
    `<span class="acc-tag" title="${Math.max(1, Math.round(x.taille / 1024))} Ko">${esc(x.jour)}</span>`).join('');
  const manque = [!d.config.env && '<code>.env</code>', !d.config.compose && '<code>docker-compose.yml</code>'].filter(Boolean);
  const av = $('#avertConfig');
  av.hidden = !manque.length;
  av.innerHTML = manque.length
    ? `${ICON.alert}<span>${manque.join(' et ')} non monté${manque.length > 1 ? 's' : ''} dans le conteneur : l’archive sera faite sans. Voir le README (section Sauvegardes).</span>` : '';
}

$('#btnSauvegardes').addEventListener('click', async () => {
  $('#formComplete').reset();
  erreurDans($('#errComplete'), '');
  try { rendreQuotidiennes(await api('/api/backups')); } catch (e) { return toast(e.message, { erreur: true }); }
  dlgSauvegardes.showModal();
});

$('#btnCopieMaintenant').addEventListener('click', async (e) => {
  await avecAttente(e.currentTarget, async () => {
    try {
      const d = await api('/api/backups/now', { methode: 'POST', corps: {} });
      rendreQuotidiennes({ ...(await api('/api/backups')), quotidiennes: d.quotidiennes });
      toast('Copie du jour faite');
    } catch (err) { toast(err.message, { erreur: true }); }
  });
});

$('#formComplete').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = $('#phrase1').value, p2 = $('#phrase2').value;
  if (p1.length < 10) return erreurDans($('#errComplete'), 'Phrase de passe : 10 caractères minimum (12 ou plus recommandés)');
  if (p1 !== p2) return erreurDans($('#errComplete'), 'Les deux phrases de passe ne correspondent pas');
  erreurDans($('#errComplete'), '');
  const bouton = $('#btnComplete');
  bouton.disabled = true;
  bouton.textContent = 'Préparation…';
  try {
    const rep = await fetch('/api/backups/full', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phrase: p1 }) });
    await telechargerReponse(rep, 'sauvegarde-veille.zip');
    $('#formComplete').reset();
    toast('Archive chiffrée téléchargée — gardez la phrase de passe à part');
  } catch (err) {
    erreurDans($('#errComplete'), err.message);
  } finally {
    bouton.disabled = false;
    bouton.textContent = 'Télécharger l’archive chiffrée';
  }
});

/* =====================================================================
   Démarrage
   ===================================================================== */

(async function demarrer() {
  appliquerBranding();
  try {
    etat.moi = await api('/api/me');
  } catch {
    $('#liste').innerHTML = `<div class="empty">${ICON.alert}<div>Serveur injoignable</div></div>`;
    return;
  }
  if (!connecte()) { location.href = '/login.html'; return; }

  if (connecte()) {
    $('#btnDeconnexion').hidden = false;
    // File d'attente laissée par un autre compte sur ce navigateur : on l'abandonne
    const proprietaire = stockage.lire('veille_attente_user', null);
    if (proprietaire !== etat.moi.user.id) { etat.enAttente.clear(); sauverAttente(); stockage.ecrire('veille_attente_user', etat.moi.user.id); }
  } else {
    $('#lienConnexion').hidden = false;
    $('#btnActualiser').hidden = true;
    $('#sync').hidden = true;
  }
  rendreMenu();
  $$('[data-admin]').forEach((el) => { el.hidden = !estAdmin(); });

  afficherVue(location.hash.slice(1) || 'actus');
  await envoyerAttente();
  await chargerArticles();

})();
