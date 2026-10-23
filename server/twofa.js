'use strict';
/**
 * Double authentification TOTP (RFC 6238 : SHA-1, 6 chiffres, 30 s) — compatible Aegis, 2FAS, Google Authenticator,
 * Microsoft Authenticator, Proton Authenticator…
 * - secret chiffré au repos (AES-256-GCM, clé dérivée de SECRET_KEY) ;
 * - un code n'est accepté qu'une fois (on mémorise le dernier pas utilisé) ;
 * - tolérance d'un pas (± 30 s) pour les horloges de téléphone un peu décalées.
 */
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function b32decode(s) {
  const propre = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const c of propre) {
    val = (val << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secretB32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function creerTwoFactor(secretKey, issuer) {
  // Ne pas modifier 'xgr-2fa' : cette valeur entre dans la dérivation de la clé, la changer rendrait illisibles les secrets 2FA existants
  const cle = Buffer.from(crypto.hkdfSync('sha256', String(secretKey), 'xgr-2fa', 'totp-secret-at-rest', 32));

  return {
    issuer,

    seal(clair) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', cle, iv);
      const ct = Buffer.concat([c.update(clair, 'utf8'), c.final()]);
      return JSON.stringify({ iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') });
    },

    open(blob) {
      try {
        const o = typeof blob === 'string' ? JSON.parse(blob) : blob;
        if (!o || !o.ct) return null;
        const d = crypto.createDecipheriv('aes-256-gcm', cle, Buffer.from(o.iv, 'base64'));
        d.setAuthTag(Buffer.from(o.tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8');
      } catch {
        return null; // SECRET_KEY changée : la 2FA doit être réinitialisée
      }
    },

    /** Renvoie le pas accepté (à mémoriser) ou null. */
    verify(secretB32, code, dernierPas = -1) {
      code = String(code ?? '').replace(/\s/g, '');
      if (!secretB32 || !/^\d{6}$/.test(code)) return null;
      const maintenant = Math.floor(Date.now() / 30000);
      for (const w of [0, -1, 1]) {
        const pas = maintenant + w;
        if (pas <= dernierPas) continue;
        if (crypto.timingSafeEqual(Buffer.from(hotp(secretB32, pas)), Buffer.from(code))) return pas;
      }
      return null;
    },

    uri(compte, secret) {
      const label = encodeURIComponent(`${issuer}:${compte}`);
      return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    },

    /** QR code (data URL SVG) d'un secret existant. */
    async qr(compte, secret) {
      const svg = await QRCode.toString(this.uri(compte, secret), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
      return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    },

    nouveauSecret() {
      return b32encode(crypto.randomBytes(20));
    },
  };
}

module.exports = { creerTwoFactor, hotp, b32encode, b32decode };
