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
| 4 | **Speed and latency** | Answers stream in word by word; quick chat turns use low reasoning effort; long chats are trimmed to a budget; verified logins are cached; closing the tab cancels the request. | `lib/groq.js`, `lib/cues.js`, `js/stream.js`, `server.js` |
| 5 | **Multimodal** | Low-contrast photos are auto-levelled, images are sent sharper (1800px), scanned PDF pages render sharper, the vision model is told to transcribe first, mark uncertain words `[word?]` and rebuild tables exactly. Every table gets Copy / Download CSV. | `js/chat.js`, `lib/prompts.js`, `js/tables.js` |
| 6 | **Domain depth** | Medical, legal, finance, security, engineering and science questions get expert-mode guidance (no invented citations, name versions). With a search key set, current-facts questions are answered from live web results with sources. | `lib/cues.js`, `lib/prompts.js`, `lib/search.js` |
| 7 | **Error handling** | Before you see a reply, code blocks are syntax-checked (JS, Python, shell, JSON), charts are validated with the page's own rules, and LaTeX is checked for balance. Problems trigger one automatic fix; anything still broken gets an honest "Heads-up" note. | `lib/verify.js`, `server.js` |
| 8 | **Personalization** | Learns standing style instructions ("from now on keep answers short", "no emojis", "stop using bullet points") and saves them; `/style` shows and changes them. | `lib/prefs.js`, `js/personal.js` |

### Setup (3 steps)

1. **Memory:** open Supabase, go to SQL Editor, paste `supabase/memory.sql` and Run. Until you do, the app works normally and memory stays off (the server log says so).
2. **Web search (optional):** set `TAVILY_API_KEY` (or `BRAVE_API_KEY`) in your host's environment. Without one, the model is told to flag anything that may be out of date.
3. Deploy. No new npm packages are needed to run the app.

### Optional environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | none | Turns on live web search for current or niche-fact questions |
| `REASONING_EFFORT` | automatic | Force `low`, `medium` or `high` thinking for every reply |
| `MAX_HISTORY_CHARS` | 48000 | How much chat history is sent per request (about 12k tokens) |
| `MEMORY_EXTRACT_GAP_MS` | 15000 | Minimum gap between automatic memory updates per user |
| `GROQ_API_URL` | Groq | Point at another OpenAI-compatible endpoint (also used by tests) |

### New commands

`/memory` (or `/memory on`, `/memory off`) · `/remember <fact>` · `/forget <number | all | words>` · `/style [concise | detailed | casual | formal | friendly | prose | bullets | beginner | expert | emoji off | reset]`

These show their output in the chat but are never added to the conversation sent to the AI.

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
npm test        # 16 unit + 21 end-to-end (real server vs fake Groq/Supabase) + 14 browser-script tests
```

The client tests need Node 20+ (jsdom). They run against fakes, so do one pass against the real services after deploying: send a message and watch it stream, run `/memory`, say "I'm building a Discord bot in Python" then check `/memory` a few seconds later, and ask for a Python function.

### File map

```
README.md                         this section
supabase/memory.sql               NEW  run once in Supabase
backend/server.js                 CHANGED  new /chat pipeline, /memory and /prefs routes
backend/package.json              CHANGED  test script, jsdom (dev only)
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
