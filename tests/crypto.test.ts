import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptPii, encryptPii } from '../server/crypto.ts';

test('encryptPii/decryptPii round-trips a value and never stores it in the clear', () => {
  const plaintext = '0512345678';
  const ciphertext = encryptPii(plaintext);
  assert.notEqual(ciphertext, plaintext);
  assert.equal(ciphertext.split(':').length, 3, 'ciphertext is iv:authTag:data');
  assert.equal(decryptPii(ciphertext), plaintext);
});

test('encryptPii produces a different ciphertext each time (random IV) but both decrypt correctly', () => {
  const plaintext = '0598765432';
  const a = encryptPii(plaintext);
  const b = encryptPii(plaintext);
  assert.notEqual(a, b);
  assert.equal(decryptPii(a), plaintext);
  assert.equal(decryptPii(b), plaintext);
});

test('decryptPii passes through null/undefined and legacy plaintext values unchanged', () => {
  assert.equal(decryptPii(null), null);
  assert.equal(decryptPii(undefined), null);
  assert.equal(decryptPii('0511112222'), '0511112222', 'a value with no iv:authTag:data shape is treated as pre-existing plaintext');
});

test('tampered ciphertext fails to authenticate and falls back to returning the stored value', () => {
  const ciphertext = encryptPii('0500000000');
  const [iv, authTag, data] = ciphertext.split(':');
  const tampered = `${iv}:${authTag}:${data.slice(0, -2)}ff`;
  // GCM auth-tag mismatch throws inside decryptPii; it is caught and the raw stored value is
  // returned rather than throwing, so a corrupted row never crashes the request.
  assert.equal(decryptPii(tampered), tampered);
});
