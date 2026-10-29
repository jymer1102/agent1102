// Game high scores and the profile that shows them (POST /trex-score, /pacman-score, GET /profile).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)

module.exports = function registerScores(ctx) {
const { app, supabaseAdmin, auth, MSG, fail, needUser, L } = ctx;

// The username stored next to each score comes from the user's profile
async function getUsername(userId) {
  const { data: p } = await supabaseAdmin.from("profiles").select("name, email").eq("id", userId).maybeSingle();
  if (p?.name) return p.name;
  // no profile row (or no name on it): fall back to what they signed up with
  const { data: a } = await supabaseAdmin.auth.admin.getUserById(userId);
  const u = a?.user;
  return u?.user_metadata?.name || p?.email?.split("@")[0] || u?.email?.split("@")[0] || "Player";
}

// Each game has its own table (trex_highscores / pacman_highscores) with one row per user:
// user_id, username, high_score, updated_at.
const MAX_SCORE = 10000000; // far above any real game; stops absurd numbers from being stored
function highScoreRoute(table, label) {
  return async (req, res) => {
    const { score, token } = req.body || {};
    if (!token || score == null) return res.status(400).json({ error: "Your score couldn't be saved. Please sign in and try again." });
    if (!Number.isInteger(score) || score < 0) return res.status(400).json({ error: "Scores must be a whole number, 0 or higher." });
    if (score > MAX_SCORE) return res.status(400).json({ error: "That score doesn't look valid." });

    const user = await auth.verify(token);
    if (!user) return res.status(401).json({ error: MSG.session });
    const userId = user.id;

    // only update if it's actually a new high score
    const { data: existing } = await supabaseAdmin
      .from(table)
      .select("high_score")
      .eq("user_id", userId)
      .maybeSingle();

    if (existing && score <= existing.high_score) {
      return res.json({ message: "Not a new high score, no update needed" });
    }

    const { error } = await supabaseAdmin.from(table).upsert({
      user_id: userId,
      username: await getUsername(userId),
      high_score: score,
      updated_at: new Date().toISOString()
    });

    if (error) return fail(res, 500, MSG.generic, error);
    res.json({ message: `${label} high score saved!` });
  };
}

app.post("/trex-score", L.scores, highScoreRoute("trex_highscores", "T-Rex"));
app.post("/pacman-score", L.scores, highScoreRoute("pacman_highscores", "Pac-Man"));

// Get profile (for displaying scores)
app.get("/profile", needUser, async (req, res) => {
  const userId = req.user.id;

  const [profileRes, trexRes, pacmanRes] = await Promise.all([
    supabaseAdmin.from("profiles").select("name, email, phone, avatar_url").eq("id", userId).maybeSingle(),
    supabaseAdmin.from("trex_highscores").select("high_score").eq("user_id", userId).maybeSingle(),
    supabaseAdmin.from("pacman_highscores").select("high_score").eq("user_id", userId).maybeSingle(),
  ]);

  if (profileRes.error) return fail(res, 500, MSG.generic, profileRes.error);
  res.json({
    profile: {
      ...(profileRes.data || {}),
      trex_high_score: trexRes.data?.high_score ?? 0,
      pacman_high_score: pacmanRes.data?.high_score ?? 0,
    }
  });
});

};
