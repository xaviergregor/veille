'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { creerTwoFactor, hotp, b32encode, b32decode } = require('../server/twofa');

test('HOTP / TOTP : vecteurs de la RFC 6238 (SHA-1, 6 chiffres)', () => {
  const secret = b32encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(hotp(secret, Math.floor(59 / 30)), '287082');
  assert.equal(hotp(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(hotp(secret, Math.floor(2000000000 / 30)), '279037');
  assert.deepEqual(b32decode('gezd gnbv'), b32decode('GEZDGNBV'));
});

test('Chiffrement du secret et vérification à usage unique', async () => {
  const tf = creerTwoFactor('cle-de-test-'.repeat(4), 'Veille');
  const s = tf.nouveauSecret();
  const blob = tf.seal(s);
  assert.notEqual(blob.includes(s), true);
  assert.equal(tf.open(blob), s);
  assert.equal(creerTwoFactor('autre-cle-'.repeat(4), 'Veille').open(blob), null);
  const pas = Math.floor(Date.now() / 30000);
  const code = hotp(s, pas);
  assert.equal(tf.verify(s, code), pas);
  assert.equal(tf.verify(s, code, pas), null, 'code déjà utilisé');
  assert.equal(tf.verify(s, '12345'), null);
  assert.match(await tf.qr('alice', s), /^data:image\/svg\+xml;base64,/);
  assert.match(tf.uri('alice', s), /^otpauth:\/\/totp\/Veille%3Aalice\?secret=/);
});
