// Encrypts the small secrets we keep for people (their own Groq API key) before they go into the database.
//   AES-256-GCM (encrypts AND detects tampering), a fresh random IV for every value, and the owner's user id bound in as
//   "additional data", so a stored value copied onto someone else's row simply fails to decrypt.
// The key is derived from a server-side secret: KEY_ENCRYPTION_SECRET if you set one, otherwise the Supabase service key
// (which only the server has). Change that secret and stored keys stop decrypting: people just paste theirs in again.
"use strict";
const crypto = require("crypto");

const b64 = buf => Buffer.from(buf).toString("base64url");
const unb64 = s => Buffer.from(String(s), "base64url");

function createSecretBox(secret) {
  if (typeof secret !== "string" || secret.trim().length < 16) return null; // no usable secret: callers must refuse to store anything
  const key = Buffer.from(crypto.hkdfSync("sha256", secret, "agent1102-secret-box", "v1", 32));

  function encrypt(plain, ownerId) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(String(ownerId)));
    const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    return ["v1", b64(iv), b64(cipher.getAuthTag()), b64(data)].join(".");
  }

  // returns the text, or null if the value is damaged, belongs to someone else, or was made with a different secret
  function decrypt(stored, ownerId) {
    try {
      const [v, iv, tag, data] = String(stored).split(".");
      if (v !== "v1" || !iv || !tag || !data) return null;
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, unb64(iv));
      decipher.setAAD(Buffer.from(String(ownerId)));
      decipher.setAuthTag(unb64(tag));
      return Buffer.concat([decipher.update(unb64(data)), decipher.final()]).toString("utf8");
    } catch (_) { return null; }
  }

  return { encrypt, decrypt };
}

module.exports = { createSecretBox };
