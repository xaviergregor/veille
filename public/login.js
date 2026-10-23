(function () {
  var $ = function (id) { return document.getElementById(id); };
  $('btnTheme').addEventListener('click', function () { window.toggleTheme(); });

  var f = $('f'), f2 = $('f2'), err = $('err');
  function erreur(t) {
    $('errTexte').textContent = t || '';
    err.hidden = !t;
  }
  function envoyer(url, corps) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corps)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Erreur ' + r.status); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function etapeMotDePasse() {
    $('etape2').hidden = true;
    f.hidden = false;
    f.password.value = '';
    f.username.focus();
  }

  // Étape 2 : code à 6 chiffres (ou configuration imposée par l'administrateur)
  function etape2fa(rep) {
    f.hidden = true;
    $('etape2').hidden = false;
    var config = !!rep.configuration;
    $('config2fa').hidden = !config;
    $('intro2fa').hidden = config;
    $('rangSouvenir').hidden = config || !rep.trustDays;
    $('texteSouvenir').textContent = 'Se souvenir de cet appareil pendant ' + rep.trustDays + ' jours';
    $('btn2').textContent = config ? 'Activer la double authentification' : 'Valider';
    if (config) {
      $('qr').src = rep.qr;
      $('cle').textContent = rep.secret.replace(/(.{4})/g, '$1 ').trim();
    }
    f2.code.value = '';
    delete f2.dataset.sent;
    f2.code.focus();
  }

  f.addEventListener('submit', function (e) {
    e.preventDefault();
    erreur('');
    var bouton = f.querySelector('button');
    bouton.disabled = true;
    envoyer('/api/login', { username: f.username.value.trim(), password: f.password.value })
      .then(function (rep) {
        if (rep.etape === '2fa') etape2fa(rep);
        else location.href = '/';
      })
      .catch(function (e) { erreur(e.status ? e.message : 'Serveur injoignable'); })
      .finally(function () { bouton.disabled = false; });
  });

  function validerCode() {
    erreur('');
    var bouton = $('btn2');
    bouton.disabled = true;
    envoyer('/api/login/2fa', { code: f2.code.value, remember: f2.remember.checked })
      .then(function () { location.href = '/'; })
      .catch(function (e) {
        erreur(e.status ? e.message : 'Serveur injoignable');
        if (e.status === 401) { etapeMotDePasse(); return; }   // étape expirée (5 min)
        f2.code.value = '';
        delete f2.dataset.sent;
        f2.code.focus();
      })
      .finally(function () { bouton.disabled = false; });
  }

  f2.addEventListener('submit', function (e) { e.preventDefault(); validerCode(); });
  // Saisie limitée aux chiffres, envoi automatique au 6e chiffre
  f2.code.addEventListener('input', function () {
    f2.code.value = f2.code.value.replace(/\D/g, '').slice(0, 6);
    if (f2.code.value.length === 6 && !f2.dataset.sent) { f2.dataset.sent = '1'; validerCode(); }
  });
  $('annuler2').addEventListener('click', function () { erreur(''); etapeMotDePasse(); });

  // Logo personnalisé optionnel (dossier branding/)
  fetch('/api/info').then(function (r) { return r.json(); }).then(function (info) {
    if (!info || !info.logo) return;
    var el = $('loginBrandIcon');
    if (!el) return;
    el.outerHTML = info.logoDark
      ? '<img src="' + info.logo + '" alt="" class="brand-logo-lg only-light"><img src="' + info.logoDark + '" alt="" class="brand-logo-lg only-dark">'
      : '<img src="' + info.logo + '" alt="" class="brand-logo-lg auto-dark">';
  }).catch(function () {});
})();
