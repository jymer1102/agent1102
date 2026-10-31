// Finding pictures on the web (POST /web-images).  The /photos command in the chat uses this.
// The search itself is in lib/imagesearch.js. This route only checks the request and shapes the answer.
// (The code below receives the shared pieces through `ctx`, like every file in routes/.)

module.exports = function registerWebImages(ctx) {
const { app, needUser, L } = ctx;
const { searchImages, isBlockedQuery } = require("../lib/imagesearch");

app.post("/web-images", needUser, L.webImages, async (req, res) => {
  const query = typeof req.body.query === "string" ? req.body.query.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (query.length < 2) return res.status(400).json({ error: "What should I look for? For example: /photos golden gate bridge" });
  if (isBlockedQuery(query)) return res.status(400).json({ error: "I can't search for pictures of that." });
  try {
    const found = await searchImages(query, { max: 12 });
    if (found.failed) return res.status(502).json({ error: "The picture search isn't working right now. Please try again in a moment." });
    res.json({ query, provider: found.label, images: found.images });
  } catch (err) {
    console.error("Web image search failed:", err);
    res.status(500).json({ error: "I couldn't search for pictures. Please try again." });
  }
});

};
