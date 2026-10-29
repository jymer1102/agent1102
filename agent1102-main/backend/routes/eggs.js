// Easter-egg progress saved per account (GET/POST /easter-eggs).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)

module.exports = function registerEggs(ctx) {
const { app, supabase, supabaseAdmin, MSG, fail } = ctx;

// --- EASTER EGG PROGRESS ---
// Which easter eggs an account has unlocked (and whether the background is switched on) is saved in the
// user's Supabase auth metadata (user_metadata.easter_eggs), so it follows them to any device or browser.
// This needs no table or SQL migration.
function readEggs(meta) {
  const e = (meta && meta.easter_eggs) || {};
  return {
    background_unlocked: e.background_unlocked === true,
    background_on: typeof e.background_on === "boolean" ? e.background_on : null, // null = never set
    dino: e.dino === true,
    pacman: e.pacman === true,
  };
}

async function eggUser(req) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data?.user ? null : data.user;
}

app.get("/easter-eggs", async (req, res) => {
  const user = await eggUser(req);
  if (!user) return res.status(401).json({ error: MSG.signIn });
  res.json({ eggs: readEggs(user.user_metadata) });
});

app.post("/easter-eggs", async (req, res) => {
  const user = await eggUser(req);
  if (!user) return res.status(401).json({ error: MSG.signIn });
  const current = readEggs(user.user_metadata);
  const incoming = req.body?.eggs || {};
  const merged = {
    // once found, always found: unlocks can be added but never taken away
    background_unlocked: current.background_unlocked || incoming.background_unlocked === true,
    dino: current.dino || incoming.dino === true,
    pacman: current.pacman || incoming.pacman === true,
    // the on/off switch is a preference, so the latest value wins
    background_on: typeof incoming.background_on === "boolean" ? incoming.background_on : current.background_on,
  };
  if (JSON.stringify(merged) !== JSON.stringify(current)) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, easter_eggs: merged },
    });
    if (error) return fail(res, 500, MSG.generic, error);
  }
  res.json({ eggs: merged });
});

};
