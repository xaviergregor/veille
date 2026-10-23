'use strict';
// Récupération et lecture des flux RSS / Atom / RDF, découverte de flux, OPML.
const { XMLParser } = require('fast-xml-parser');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const UA = 'Veille/1.5 (+https://github.com/xaviergregor/veille)';
const TIMEOUT_MS = 15000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 100;
const SUMMARY_LEN = 280;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,          // dc:date → date, content:encoded → encoded
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ['item', 'entry', 'link', 'outline'].includes(name),
});

/* ---------- Texte ---------- */

const ENTITES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', euro: '€', copy: '©', reg: '®',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä', ccedil: 'ç',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü', oelig: 'œ',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Acirc: 'Â', Ccedil: 'Ç', Ocirc: 'Ô', OElig: 'Œ',
  middot: '·', bull: '•', deg: '°', times: '×', shy: '',
};

function decoderEntites(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return ''; }
    }
    return ENTITES[e] ?? m;
  });
}

// HTML → texte brut (le résultat n'est jamais interprété comme du HTML côté navigateur)
function texteBrut(html) {
  return decoderEntites(
    String(html || '')
      .replace(/<(script|style|iframe|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/?(p|li|h\d|div|td|tr|ul|ol|blockquote|section|article)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  ).replace(/\s+/g, ' ').trim();
}

function tronquer(t, max) {
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

function texte(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return texte(v[0]);
  if (typeof v === 'object') return String(v['#text'] ?? '');
  return String(v);
}

function urlHttp(u, base) {
  try {
    const x = new URL(String(u).trim(), base);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : '';
  } catch { return ''; }
}

/* ---------- Téléchargement ---------- */

function decoderCorps(buf, contentType) {
  // Encodage : en-tête HTTP, sinon déclaration XML, sinon UTF-8
  let enc = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!enc) {
    const debut = buf.subarray(0, 200).toString('latin1');
    enc = /encoding=["']([\w-]+)["']/i.exec(debut)?.[1];
  }
  try {
    return new TextDecoder((enc || 'utf-8').toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// --- Protection SSRF : n'importe quel compte peut ajouter un flux, le serveur ne doit pas servir à sonder le réseau interne ---
const BLOQUEES = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
  BLOQUEES.addSubnet(a, p, 'ipv4');
}
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]]) {
  BLOQUEES.addSubnet(a, p, 'ipv6');
}
let reseauPriveAutorise = false;
function autoriserReseauPrive(oui) { reseauPriveAutorise = !!oui; }

function adresseInterdite(ip) {
  if (reseauPriveAutorise) return false;
  const v4mappee = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4mappee) ip = v4mappee[1];
  const type = net.isIP(ip);
  if (!type) return true;
  return BLOQUEES.check(ip, type === 6 ? 'ipv6' : 'ipv4');
}

// Résolution DNS qui refuse les adresses internes (vérifiée à la connexion : pas de contournement par rebinding)
function lookupSur(hostname, options, cb) {
  dns.lookup(hostname, { all: true, family: options.family || 0 }, (err, adresses) => {
    if (err) return cb(err);
    const ok = adresses.filter((x) => !adresseInterdite(x.address));
    if (!ok.length) {
      const e = new Error('Adresse interne refusée');
      e.code = 'EINTERNE';
      return cb(e);
    }
    if (options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function requete(url, headers, signal) {
  return new Promise((ok, ko) => {
    const u = new URL(url);
    const hote = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hote) && adresseInterdite(hote)) return ko(Object.assign(new Error('Adresse interne refusée'), { code: 'EINTERNE' }));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', headers, lookup: lookupSur, signal }, ok);
    req.on('error', ko);
    req.end();
  });
}

async function telecharger(url, { etag, lastModified } = {}) {
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = {
      'User-Agent': UA,
      Accept: 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml;q=0.9, text/html;q=0.5, */*;q=0.1',
      'Accept-Encoding': 'gzip, deflate, br',
    };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;

    let courante = url;
    let rep;
    for (let sauts = 0; ; sauts++) {
      rep = await requete(courante, headers, ctrl.signal);
      if ([301, 302, 303, 307, 308].includes(rep.statusCode) && rep.headers.location) {
        rep.resume();
        if (sauts >= 5) throw new Error('Trop de redirections');
        const suivante = urlHttp(rep.headers.location, courante);
        if (!suivante) throw new Error('Redirection invalide');
        courante = suivante;
        continue;
      }
      break;
    }
    if (rep.statusCode === 304) { rep.resume(); return { notModified: true }; }
    if (rep.statusCode < 200 || rep.statusCode >= 300) { rep.resume(); throw new Error('HTTP ' + rep.statusCode); }

    // Décompression + lecture limitée en taille
    const enc = String(rep.headers['content-encoding'] || '').toLowerCase();
    let flux = rep;
    if (enc === 'gzip' || enc === 'x-gzip') flux = rep.pipe(zlib.createGunzip());
    else if (enc === 'deflate') flux = rep.pipe(zlib.createInflate());
    else if (enc === 'br') flux = rep.pipe(zlib.createBrotliDecompress());
    const morceaux = [];
    let total = 0;
    for await (const m of flux) {
      total += m.length;
      if (total > MAX_BYTES) { rep.destroy(); throw new Error('Flux trop volumineux (> 4 Mo)'); }
      morceaux.push(m);
    }
    const buf = Buffer.concat(morceaux);
    const contentType = String(rep.headers['content-type'] || '');
    return {
      body: decoderCorps(buf, contentType),
      contentType,
      finalUrl: courante,
      etag: rep.headers.etag || null,
      lastModified: rep.headers['last-modified'] || null,
    };
  } catch (e) {
    if (e.name === 'AbortError' || ctrl.signal.aborted) throw new Error('Délai dépassé (15 s)');
    if (e.code === 'EINTERNE') throw new Error('Adresse du réseau interne refusée');
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') throw new Error('Nom de domaine introuvable');
    if (e.code === 'ECONNREFUSED') throw new Error('Connexion refusée');
    if (e.code === 'ECONNRESET') throw new Error('Connexion interrompue');
    if (e.code && /CERT|SSL|TLS/.test(e.code)) throw new Error('Certificat HTTPS invalide (' + e.code + ')');
    throw new Error(e.code ? `${e.message} (${e.code})` : e.message);
  } finally {
    clearTimeout(minuteur);
  }
}

/* ---------- Lecture d'un flux ---------- */

function lienAtom(liens, base) {
  const l = [].concat(liens || []);
  const choix =
    l.find((x) => typeof x === 'object' && x['@_rel'] === 'alternate' && (!x['@_type'] || /html/.test(x['@_type']))) ||
    l.find((x) => typeof x === 'object' && x['@_href'] && !x['@_rel']) ||
    l.find((x) => typeof x === 'string' && x.trim()) ||
    l.find((x) => typeof x === 'object' && x['#text']);
  if (!choix) return '';
  return urlHttp(typeof choix === 'string' ? choix : choix['@_href'] || choix['#text'], base);
}

function lireDate(item) {
  const brut = texte(item.pubDate) || texte(item.published) || texte(item.updated) || texte(item.date) || texte(item.issued);
  if (!brut) return null;
  const d = Date.parse(brut);
  return Number.isFinite(d) ? d : null;
}

/**
 * Analyse un document RSS 2.0, Atom ou RSS 1.0 (RDF).
 * Renvoie { titre, site, articles: [{ link, title, summary, published|null }] }
 */
function analyserFlux(xml, urlFlux) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new Error('XML invalide : ' + e.message.split('\n')[0]);
  }
  let canal, items, atom = false;
  if (doc.rss) {
    canal = doc.rss.channel || {};
    if (Array.isArray(canal)) canal = canal[0];
    items = canal.item || [];
  } else if (doc.feed) {
    canal = doc.feed;
    items = canal.entry || [];
    atom = true;
  } else if (doc.RDF) {
    canal = doc.RDF.channel || {};
    items = doc.RDF.item || [];
  } else {
    throw new Error("Ce n'est pas un flux RSS ou Atom");
  }

  const site = atom ? lienAtom(canal.link, urlFlux) : lienAtom(canal.link, urlFlux);
  const articles = [];
  for (const it of items.slice(0, MAX_ITEMS)) {
    const titre = tronquer(texteBrut(texte(it.title)), 300);
    let link = lienAtom(it.link, site || urlFlux);
    if (!link) {
      const guid = it.guid;
      const perma = typeof guid === 'object' ? guid['@_isPermaLink'] !== 'false' : true;
      if (perma) link = urlHttp(texte(guid));
    }
    if (!link) link = urlHttp(texte(it.id));
    if (!titre || !link) continue;
    const corps = texte(it.description) || texte(it.summary) || texte(it.content) || texte(it.encoded);
    articles.push({
      link,
      title: titre,
      summary: tronquer(texteBrut(corps), SUMMARY_LEN),
      published: lireDate(it),
    });
  }
  return { titre: texteBrut(texte(canal.title)), site, articles };
}

/* ---------- Découverte ---------- */

// Si l'adresse est une page HTML, cherche le flux déclaré dans <link rel="alternate">
function trouverFluxDansHtml(html, base) {
  const trouves = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n) => new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] || '';
    if (!/alternate/i.test(attr('rel'))) continue;
    if (!/(rss|atom|rdf)\+xml/i.test(attr('type'))) continue;
    const href = urlHttp(decoderEntites(attr('href')), base);
    if (href) trouves.push({ url: href, title: decoderEntites(attr('title')) });
  }
  return trouves;
}

/**
 * Teste une adresse saisie par l'utilisateur : flux direct, ou page HTML qui en déclare un.
 * Renvoie { url, titre, site, nb, dernier }
 */
async function sonder(urlSaisie) {
  const url = urlHttp(urlSaisie);
  if (!url) throw new Error('Adresse invalide (http ou https uniquement)');
  let rep = await telecharger(url);
  let urlFlux = rep.finalUrl;
  const debut = rep.body.slice(0, 1000).toLowerCase();
  if (/<html|<!doctype html/.test(debut) || /text\/html/i.test(rep.contentType)) {
    const flux = trouverFluxDansHtml(rep.body, rep.finalUrl);
    if (!flux.length) throw new Error("Page web sans flux RSS/Atom déclaré");
    urlFlux = flux[0].url;
    rep = await telecharger(urlFlux);
  }
  const f = analyserFlux(rep.body, urlFlux);
  const dates = f.articles.map((a) => a.published).filter(Boolean);
  return {
    url: urlFlux === url ? url : urlFlux,
    titre: f.titre,
    site: f.site,
    nb: f.articles.length,
    dernier: dates.length ? Math.max(...dates) : null,
  };
}

/* ---------- OPML ---------- */

function lireOpml(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new Error('Fichier OPML invalide');
  }
  const corps = doc.opml?.body;
  if (!corps) throw new Error('Fichier OPML invalide');
  const res = [];
  const parcourir = (outlines, categorie) => {
    for (const o of outlines || []) {
      const nom = decoderEntites(o['@_title'] || o['@_text'] || '');
      const url = urlHttp(decoderEntites(o['@_xmlUrl'] || ''));
      if (url) res.push({ url, name: nom || url, category: categorie, site: urlHttp(o['@_htmlUrl'] || '') });
      if (o.outline) parcourir(o.outline, url ? categorie : nom || categorie);
    }
  };
  parcourir(corps.outline, '');
  return res;
}

function echXml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function ecrireOpml(feeds) {
  const parCat = new Map();
  for (const f of feeds) {
    const c = f.category || '';
    if (!parCat.has(c)) parCat.set(c, []);
    parCat.get(c).push(f);
  }
  const ligne = (f, ind) =>
    `${ind}<outline type="rss" text="${echXml(f.name)}" title="${echXml(f.name)}" xmlUrl="${echXml(f.url)}"${f.site_url ? ` htmlUrl="${echXml(f.site_url)}"` : ''}/>`;
  let corps = '';
  for (const [cat, liste] of [...parCat].sort((a, b) => a[0].localeCompare(b[0], 'fr'))) {
    if (!cat) { corps += liste.map((f) => ligne(f, '    ')).join('\n') + '\n'; continue; }
    corps += `    <outline text="${echXml(cat)}" title="${echXml(cat)}">\n${liste.map((f) => ligne(f, '      ')).join('\n')}\n    </outline>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Veille — flux</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${corps}  </body>
</opml>
`;
}

module.exports = { autoriserReseauPrive, adresseInterdite, telecharger, analyserFlux, sonder, lireOpml, ecrireOpml, texteBrut, urlHttp, trouverFluxDansHtml };
