// Phone numbers, in the one form Supabase Auth accepts: E.164 ("+" then the country code and number, digits only, 8 to 15 digits).
//
// Supabase keeps a person's phone in TWO places: auth.users.phone (the real account column, one per account, always unique)
// and user_metadata.phone (free text the app put there at sign-up). Sign-up with an email only ever fills the second one,
// so the number has to be written to the first by the server (see routes/auth.js).
"use strict";

// A number typed without a country code ("(314) 555-0123") is read as belonging to this country. 1 = USA / Canada.
const DEFAULT_COUNTRY_CODE = () => String(process.env.DEFAULT_PHONE_COUNTRY_CODE || "1").replace(/\D/g, "") || "1";

// "(314) 555-0123" -> "+13145550123", "+44 20 7946 0958" -> "+442079460958", "00 44 20 7946 0958" -> "+442079460958".
// Returns null when it can't be a real phone number.
function toE164(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > 40) return null;
  if (/[^\d\s()+\-.]/.test(raw)) return null; // letters and other symbols: not a phone number
  let digits = raw.replace(/\D/g, "");
  let international = raw.startsWith("+");
  if (!international && digits.startsWith("00")) { international = true; digits = digits.slice(2); }
  if (!digits) return null;
  if (!international) {
    const cc = DEFAULT_COUNTRY_CODE();
    if (digits.length === 10) digits = cc + digits; // a local number: add the country code
    // anything else is taken as "country code included, '+' left off"
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? "+" + digits : null;
}

// GoTrue stores the number without the "+" ("13145550123"); this puts it back for showing and for comparing.
function withPlus(stored) {
  const d = String(stored || "").replace(/\D/g, "");
  return d ? "+" + d : null;
}

// are these two the same number, however each one is written? (compares the digits)
const samePhone = (a, b) => { const x = String(a || "").replace(/\D/g, ""), y = String(b || "").replace(/\D/g, ""); return !!x && x === y; };

module.exports = { toE164, withPlus, samePhone };
