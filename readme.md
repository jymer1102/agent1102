<div align="center">

# agent1102

![README Banner](agent1102-main/backend/public/images/favicon/favicon.png)

An intelligent web space designed to serve as an interactive AI companion experience with some different uses.

</div>

---

## What's new: the 8 improvements

| # | Improvement | What it does now | Where |
|---|---|---|---|
| 1 | **Long-term memory** | Remembers lasting facts (what you study or build, preferences) across chats. See, add and delete them with `/memory`, `/remember`, `/forget`; `/memory off` pauses it. | `lib/memory.js`, `supabase/memory.sql`, `js/personal.js` |
| 2 | **Emotional understanding** | Prompt guidance for sarcasm, humor, frustration, worry, good news and cultural context, plus a local detector that adds hints (and care instructions if someone mentions self-harm). | `lib/prompts.js`, `lib/cues.js` |
| 3 | **Ambiguity resolution** | Infers intent from the conversation and memory, states a short assumption instead of asking, and asks one question only when a wrong guess would be costly. | `lib/prompts.js` |
| 4 | **Speed and latency** | Answers stream in word by word; quick chat turns use low reasoning effort; long chats are trimmed to a budget; verified logins are cached; closing the tab cancels the request. | `lib/groq.js`, `lib/cues.js`, `js/stream.js`, `routes/chat.js` |
| 5 | **Multimodal** | Low-contrast photos are auto-levelled, images are sent sharper (1800px), scanned PDF pages render sharper, the vision model is told to transcribe first, mark uncertain words `[word?]` and rebuild tables exactly. Every table gets Copy / Download CSV. | `js/chat.js`, `lib/prompts.js`, `js/tables.js` |
| 6 | **Domain depth** | Medical, legal, finance, security, engineering and science questions get expert-mode guidance (no invented citations, name versions). With a search key set, current-facts questions are answered from live web results with sources. | `lib/cues.js`, `lib/prompts.js`, `lib/search.js` |
| 7 | **Error handling** | Before you see a reply, code blocks are syntax-checked (JS, Python, shell, JSON), charts are validated with the page's own rules, and LaTeX is checked for balance. Problems trigger one automatic fix; anything still broken gets an honest "Heads-up" note. | `lib/verify.js`, `routes/chat.js` |
| 8 | **Personalization** | Learns standing style instructions ("from now on keep answers short", "no emojis", "stop using bullet points") and saves them; `/style` shows and changes them. | `lib/prefs.js`, `js/personal.js` |

### Setup (3 steps)

1. **Memory:** open Supabase, go to SQL Editor, paste `supabase/memory.sql` and Run. Until you do, the app works normally and memory stays off (the server log says so).
2. **Web search (optional):** set `TAVILY_API_KEY` (or `BRAVE_API_KEY`) in your host's environment. Without one, the model is told to flag anything that may be out of date.
3. **Database tables (compare first):** `supabase/schema.sql` describes the `chats`, `profiles` and high-score tables and turns on Row Level Security for them. It was written from the code, not exported from your project, so compare it with your Table Editor before running it. It never changes a table that already exists.
4. Deploy. No new npm packages are needed to run the app.

### Optional environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | none | Turns on live web search for current or niche-fact questions |
| `REASONING_EFFORT` | automatic | Force `low`, `medium` or `high` thinking for every reply |
| `MAX_HISTORY_CHARS` | 48000 | How much chat history is sent per request (about 12k tokens) |
| `MEMORY_EXTRACT_GAP_MS` | 15000 | Minimum gap between automatic memory updates per user |
| `GROQ_API_URL` | Groq | Point at another OpenAI-compatible endpoint (also used by tests) |
| `TRUST_PROXY_HOPS` | 1 | How many proxies sit in front of the server (used to read visitors' addresses for rate limits). Raise it if every visitor ever looks like the same address |
| `ALLOWED_ORIGINS` | none | Extra websites (comma separated) that may call the API from a browser. This site is always allowed |
| `RATE_LIMIT_SCALE` | 1 | Multiplies every rate limit (the tests use 1000). Leave it alone in production |

### New commands

`/memory` (or `/memory on`, `/memory off`) · `/remember <fact>` · `/forget <number | all | words>` · `/style [concise | detailed | casual | formal | friendly | prose | bullets | beginner | expert | emoji off | reset]`

These show their output in the chat but are never added to the conversation sent to the AI.

### Accounts, security and upkeep

- **Forgot password?** There is no email service, so you reset it yourself. In Render's **Shell** tab: `node scripts/reset-password.js someone@email.com` (prints a random temporary password) or `node scripts/reset-password.js someone@email.com "chosen-password"`. Run from the `backend/` folder.
- **Stay signed in** is a checkbox on the sign-in form. Ticked keeps the login on that device; unticked ends it after the browser has been closed.
- **Sign-in is checked, never just read.** Every route that identifies a user asks Supabase to vouch for the token. Study, graph, titles, images, read-aloud and link previews require a sign-in. `/chat` still works signed out (strictly rate-limited).
- **Rate limits** (`lib/ratelimit.js`, in memory): 8 wrong passwords per account per 15 minutes, 10 sign-ups per address per hour, 30 chat messages per minute, 10 image requests per 10 minutes, and a generous per-address backstop on everything.
- **Browser protections** (`lib/security.js`): a Content-Security-Policy (scripts only from this site and jsDelivr, none inline), CORS limited to this site and localhost, and the usual headers. The code **Preview** button runs in its own sandboxed page, `preview-frame.html`.
- **Chats can't be taken over:** saving refuses a chat id that belongs to someone else.
- If something is blocked on the page, the browser console shows a "Content-Security-Policy" message naming it.

### Privacy

- Memories are only read with a **verified** login token (a forged token gets nothing), and the table has Row Level Security on with no policies, so browsers can't touch it.
- Passwords, API keys, card, ID and bank numbers are **never stored**, enforced in code, not just in the prompt.
- Memories are given to the model as background data, not instructions.
- Deleting an account deletes its memories. `/forget all` clears them any time.

### Honest limits

- **Verification parses code, it doesn't run it.** Running model-written code on the server would be unsafe. It catches code that doesn't even start; it can't prove the logic is right.
- **Emotion detection is a heuristic plus prompting**, not a trained model. Hints are labelled as guesses.
- **OCR quality is bounded by the vision model.** The upgrades are in preprocessing, prompting and export, not the model itself.
- **Memory relevance is keyword-based** (Groq has no embeddings endpoint). Saving a memory costs one small extra model call, only for messages that look personal, at most every 15 seconds per user.
- **Style is learned only from explicit standing instructions**, never guessed from behavior.
- **The streaming preview is plain text.** The finished, fully rendered message (code boxes, charts, math) replaces it once the server has checked the answer.
- The new system-prompt sections add about 550 tokens to every request (about 265 more when an image is attached).

### Tests

```
cd backend
npm install
npm test        # 29 unit + 35 end-to-end (real server vs fake Groq/Supabase) + 27 browser-script tests; runs all three even if one fails
npm run lint    # catches typos and missing variables in the server code
```

GitHub runs both on every push (`.github/workflows/test.yml`).

The client tests need Node 20+ (jsdom). They run against fakes, so do one pass against the real services after deploying: send a message and watch it stream, run `/memory`, say "I'm building a Discord bot in Python" then check `/memory` a few seconds later, and ask for a Python function.

### File map

```
README.md                         this section
supabase/memory.sql               NEW  run once in Supabase
supabase/schema.sql              NEW  chats, profiles and high-score tables + Row Level Security
.github/workflows/test.yml        NEW  lint + tests on every push (repo root, not inside agent1102-main/)
backend/server.js                 CHANGED  setup, security headers, rate limits, then loads routes/
backend/routes/*.js               NEW  one file per feature: chat, study, title, linkpreview, media, auth, eggs, scores, chats
backend/scripts/reset-password.js NEW  owner-run password reset
backend/lib/security.js           NEW  CORS + Content-Security-Policy + headers
backend/lib/ratelimit.js          NEW  in-memory rate limiter
backend/lib/models.js             NEW  which AI models are used
backend/lib/system-prompt.js      NEW  the AI's system prompt
backend/public/preview-frame.html NEW  sandboxed page behind the code Preview button
backend/public/js/session.js      NEW  "Stay signed in"
backend/package.json              CHANGED  test + lint scripts, jsdom and eslint (dev only)
backend/lib/auth.js               NEW  verified-user cache
backend/lib/groq.js               NEW  streaming + rate-limit parsing
backend/lib/prompts.js            NEW  intent, emotion, vision, domain, memory, search, repair prompts
backend/lib/cues.js               NEW  emotion cues, domains, effort routing, history trimming
backend/lib/prefs.js              NEW  style preferences
backend/lib/memory.js             NEW  long-term memory
backend/lib/verify.js             NEW  code / chart / LaTeX checks
backend/lib/search.js             NEW  optional web search
backend/public/index.html         CHANGED  loads the new scripts
backend/public/js/chat.js         CHANGED  streaming, token, commands, sharper images
backend/public/js/commands.js     CHANGED  new commands in the "/" menu and /help
backend/public/js/stream.js       NEW  live answer display
backend/public/js/personal.js     NEW  /memory /remember /forget /style
backend/public/js/tables.js       NEW  CSV buttons
backend/test/*.test.js            NEW  unit, integration, client tests
```
