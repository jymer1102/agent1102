// Easter-egg progress saved per account (GET/POST /easter-eggs).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)

module.exports = function registerEggs(ctx) {
const { app, auth, userMeta, MSG, fail } = ctx;

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

const eggUser = req => auth.verify(auth.bearer(req)); // the same cached sign-in check every other route uses

app.get("/easter-eggs", async (req, res) => {
  const user = await eggUser(req);
  if (!user) return res.status(401).json({ error: MSG.signIn });
  res.json({ eggs: readEggs(user.user_metadata) });
});

app.post("/easter-eggs", async (req, res) => {
  const user = await eggUser(req);
  if (!user) return res.status(401).json({ error: MSG.signIn });
  const incoming = req.body?.eggs && typeof req.body.eggs === "object" ? req.body.eggs : {};
  const mergeEggs = current => ({
    // once found, always found: unlocks can be added but never taken away
    background_unlocked: current.background_unlocked || incoming.background_unlocked === true,
    dino: current.dino || incoming.dino === true,
    pacman: current.pacman || incoming.pacman === true,
    // the on/off switch is a preference, so the latest value wins
    background_on: typeof incoming.background_on === "boolean" ? incoming.background_on : current.background_on,
  });
  const current = readEggs(user.user_metadata);
  const merged = mergeEggs(current);
  if (JSON.stringify(merged) === JSON.stringify(current)) return res.json({ eggs: merged });
  try {
    // merged again from fresh data inside the per-user queue, so a style change made at the same moment isn't lost
    const meta = await userMeta.patch(user.id, fresh => ({ easter_eggs: mergeEggs(readEggs(fresh)) }));
    res.json({ eggs: readEggs(meta) });
  } catch (error) { fail(res, 500, MSG.generic, error); }
});

};
