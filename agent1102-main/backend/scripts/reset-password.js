#!/usr/bin/env node
// Owner-run password reset (no email service needed).
//
//   node scripts/reset-password.js someone@email.com              -> makes a random temporary password and prints it
//   node scripts/reset-password.js someone@email.com "new-pass"   -> sets exactly that password
//
// It needs the same two settings the server uses: SUPABASE_URL and SUPABASE_SERVICE_KEY. On Render, open the
// service's Shell tab (they are already set there). On your own computer, put them in front of the command:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=... node scripts/reset-password.js someone@email.com
// The service key can do anything to your database, so never paste it into chat, commit it, or share it.
"use strict";
const crypto = require("crypto");

// no look-alike characters (0/O, 1/l/I), so a password read out loud or typed from a message isn't mistyped
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomPassword(length = 14) {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

// Supabase has no "find user by email", so walk through the user list a page at a time
async function findUserByEmail(admin, email) {
  const wanted = String(email).trim().toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 500; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error("Couldn't read the user list: " + error.message);
    const users = (data && data.users) || [];
    const hit = users.find(u => String(u.email || "").toLowerCase() === wanted);
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  return null;
}

// Returns { email, password, generated }. Throws an Error with a plain message when it can't.
async function resetPassword(admin, email, password) {
  if (!email || !String(email).includes("@")) throw new Error("Give the person's email address, e.g. node scripts/reset-password.js someone@email.com");
  const user = await findUserByEmail(admin, email);
  if (!user) throw new Error(`No account found for ${email}. Check the spelling (it must be the email they signed up with).`);
  const generated = !password;
  const finalPassword = generated ? randomPassword() : String(password);
  const { error } = await admin.auth.admin.updateUserById(user.id, { password: finalPassword });
  if (error) throw new Error("Supabase refused the change: " + error.message);
  return { email: user.email, password: finalPassword, generated };
}

module.exports = { resetPassword, findUserByEmail, randomPassword };

if (require.main === module) {
  (async () => {
    const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const key = (process.env.SUPABASE_SERVICE_KEY || "").trim();
    if (!url || !key) {
      console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set. See the comment at the top of this file.");
      process.exit(1);
    }
    const { createClient } = require("@supabase/supabase-js");
    const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    try {
      const r = await resetPassword(admin, process.argv[2], process.argv[3]);
      console.log(`\nPassword changed for ${r.email}.`);
      if (r.generated) console.log(`Temporary password: ${r.password}`);
      console.log("Tell them to sign in with it, then change it under their profile settings.\n");
    } catch (e) {
      console.error("\n" + e.message + "\n");
      process.exit(1);
    }
  })();
}
