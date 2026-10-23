'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { analyserFlux, lireOpml, ecrireOpml, trouverFluxDansHtml, texteBrut } = require('../server/feeds');

test('RSS 2.0 avec CDATA, entités et guid', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel><title>Mon &amp; blog</title><link>https://ex.fr/</link>
  <atom:link href="https://ex.fr/feed/" rel="self" type="application/rss+xml"/>
  <item><title><![CDATA[Faille <b>critique</b> &amp; correctif]]></title><link>https://ex.fr/a1</link>
    <description><![CDATA[<p>Un r&eacute;sum&eacute; <a href="x">avec</a> lien&nbsp;!</p><script>alert(1)</script>]]></description>
    <pubDate>Wed, 14 Oct 2026 08:00:00 +0200</pubDate></item>
  <item><title>Sans lien</title><guid isPermaLink="true">https://ex.fr/a2</guid><dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">2026-10-14T10:00:00Z</dc:date></item>
  <item><title>Lien javascript</title><link>javascript:alert(1)</link></item>
  </channel></rss>`;
  const f = analyserFlux(xml, 'https://ex.fr/feed/');
  assert.equal(f.titre, 'Mon & blog');
  assert.equal(f.site, 'https://ex.fr/');
  assert.equal(f.articles.length, 2);
  assert.equal(f.articles[0].title, 'Faille critique & correctif');
  assert.equal(f.articles[0].summary, 'Un résumé avec lien !');
  assert.equal(f.articles[0].published, Date.parse('2026-10-14T06:00:00Z'));
  assert.equal(f.articles[1].link, 'https://ex.fr/a2');
  assert.equal(f.articles[1].published, Date.parse('2026-10-14T10:00:00Z'));
});

test('Atom : lien alternate, résumé HTML échappé', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">LinuxFR</title>
    <link rel="self" href="https://linuxfr.org/news.atom"/><link rel="alternate" type="text/html" href="https://linuxfr.org/"/>
    <entry><title>Sortie de Linux 7.0</title>
      <link rel="replies" href="https://linuxfr.org/c/1"/><link rel="alternate" type="text/html" href="https://linuxfr.org/news/linux-7"/>
      <published>2026-10-15T09:30:00+02:00</published><updated>2026-10-15T10:00:00+02:00</updated>
      <content type="html">&lt;p&gt;Le noyau &lt;em&gt;7.0&lt;/em&gt; est sorti.&lt;/p&gt;</content></entry>
  </feed>`;
  const f = analyserFlux(xml, 'https://linuxfr.org/news.atom');
  assert.equal(f.titre, 'LinuxFR');
  assert.equal(f.site, 'https://linuxfr.org/');
  assert.equal(f.articles[0].link, 'https://linuxfr.org/news/linux-7');
  assert.equal(f.articles[0].summary, 'Le noyau 7.0 est sorti.');
  assert.equal(f.articles[0].published, Date.parse('2026-10-15T07:30:00Z'));
});

test('RSS 1.0 (RDF)', () => {
  const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel><title>RDF</title><link>https://rdf.fr/</link></channel>
    <item><title>Un</title><link>https://rdf.fr/1</link><dc:date>2026-10-15T08:00:00Z</dc:date></item></rdf:RDF>`;
  const f = analyserFlux(xml, 'https://rdf.fr/rss');
  assert.equal(f.articles.length, 1);
  assert.equal(f.articles[0].link, 'https://rdf.fr/1');
});

test('Document qui n\'est pas un flux', () => {
  assert.throws(() => analyserFlux('<html><body>x</body></html>', 'https://x'), /RSS ou Atom/);
});

test('Découverte du flux dans une page HTML', () => {
  const html = `<head><link rel="stylesheet" href="/s.css"><link rel="alternate" type="application/rss+xml" title="Flux &amp; co" href="/feed/"></head>`;
  assert.deepEqual(trouverFluxDansHtml(html, 'https://site.fr/blog/'), [{ url: 'https://site.fr/feed/', title: 'Flux & co' }]);
});

test('OPML : lecture imbriquée et aller-retour', () => {
  const opml = `<?xml version="1.0"?><opml version="1.0"><body>
    <outline text="Cyber"><outline text="CERT" xmlUrl="https://cert.ssi.gouv.fr/feed/"/><outline title="ZATAZ" xmlUrl="https://www.zataz.com/feed/" htmlUrl="https://www.zataz.com/"/></outline>
    <outline text="Seul" xmlUrl="https://seul.fr/rss"/>
    <outline text="Mauvais" xmlUrl="file:///etc/passwd"/></body></opml>`;
  const l = lireOpml(opml);
  assert.equal(l.length, 3);
  assert.deepEqual(l[0], { url: 'https://cert.ssi.gouv.fr/feed/', name: 'CERT', category: 'Cyber', site: '' });
  assert.equal(l[2].category, '');
  const retour = lireOpml(ecrireOpml(l.map((x) => ({ ...x, site_url: x.site }))));
  const cle = (x) => [x.url, x.name, x.category].join('|');
  assert.deepEqual(retour.map(cle).sort(), l.map(cle).sort());
});

test('texteBrut', () => {
  assert.equal(texteBrut('<style>a{}</style>Hello&#8217;s <b>world</b>&hellip;'), 'Hello’s world…');
});

test('Adresses internes refusées (SSRF)', () => {
  const { adresseInterdite, autoriserReseauPrive } = require('../server/feeds');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:192.168.1.1']) {
    assert.equal(adresseInterdite(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '151.101.1.69', '2606:4700::6810:84e5']) assert.equal(adresseInterdite(ip), false, ip);
  autoriserReseauPrive(true);
  assert.equal(adresseInterdite('192.168.1.10'), false);
  autoriserReseauPrive(false);
});
