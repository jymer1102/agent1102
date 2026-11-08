// The sidebar footer, the Settings window (Profile / AI / Danger Zone), and the removed chat commands, driven through the
// REAL page in jsdom.   run:  node test/settings.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { bootApp } = require("./app-harness");

let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message)); } }
async function withApp(opts, fn) {
  const app = await bootApp(opts);
  try { app.w.confirm = () => true; await fn(app); assert.deepStrictEqual(app.errors.map(e => String(e && e.message || e)), [], "the page reported script errors"); }
  finally { app.close(); }
}
const ok = json => ({ status: 200, json });
const bad = (status, error) => ({ status, json: { error } });
const txt = el => el.textContent.replace(/\s+/g, " ").trim();
const callsTo = (app, p, method) => app.calls.filter(c => c.path === p && (!method || c.method === method));

// the server's answers for a person with some saved settings; tests override single routes
const baseRoutes = (over = {}) => ({
  "/settings": () => ok({ available: true, canStoreKey: true, talkStyle: "Keep it short.", aboutMe: "Nursing student.", maxChars: 1500, groq: { hasKey: false, last4: "" } }),
  "/memory": () => ok({ enabled: true, memories: [{ id: "m1", content: "Studies nursing", source: "auto" }, { id: "m2", content: "<img src=x onerror=alert(1)>", source: "user" }] }),
  "/prefs": () => ok({ rows: [] }),
  ...over,
});
const openSettings = async (app, page) => {
  app.$("#settings-btn").click();
  if (page) { app.$("#tab-" + page).click(); }
  await app.sleep(40);
};

(async () => {
  console.log("layout");
  await t("the header keeps only the history button, the title, theme and delete-chat: no new chat, profile or log out", () => withApp({}, async app => {
    const header = app.$("header");
    for (const id of ["new-chat-btn", "profile-btn", "logout-btn", "settings-btn"]) assert(!header.querySelector("#" + id), id + " must not be in the header");
    assert(header.querySelector("#history-btn") && header.querySelector("#theme-btn") && header.querySelector("#clear-btn"));
  }));
  await t("the sidebar has no title bar: New chat top-left, then Clear All and the close button; the Settings button is last", () => withApp({}, async app => {
    const sb = app.$("#sidebar");
    assert(!sb.querySelector("#sidebar-header") && !/Chat History/.test(sb.textContent), "no sidebar title");
    const top = app.$("#sidebar-top");
    const ids = [...top.querySelectorAll("button")].map(b => b.id);
    assert.deepStrictEqual(ids, ["new-chat-btn", "clear-all-btn", "close-sidebar"], "the only top buttons, in order");
    assert.strictEqual(top.querySelector("button"), app.$("#new-chat-btn"), "New chat comes first (top left)");
    const kids = [...sb.children].map(c => c.id);
    assert.deepStrictEqual(kids, ["sidebar-top", "sidebar-list", "sidebar-footer"]);
    assert(app.$("#sidebar-footer #settings-btn"));
  }));
  await t("New chat in the sidebar starts a fresh chat and closes the sidebar", () => withApp({}, async app => {
    app.$("#history-btn").click(); await app.sleep(40);
    assert(app.$("#sidebar").classList.contains("open"));
    app.$("#new-chat-btn").click(); await app.sleep(40);
    assert(!app.$("#sidebar").classList.contains("open"), "sidebar closed");
  }));

  console.log("\nthe Settings button");
  await t("it shows the saved name, and the default icon when there is no picture", () => withApp({}, async app => {
    assert.strictEqual(txt(app.$("#settings-name")), "Sam");
    assert.notStrictEqual(app.$("#profile-icon-fallback").style.display, "none", "icon fallback visible");
    assert.strictEqual(app.$("#profile-icon").style.display, "none");
  }));
  await t("it shows the profile picture when there is one", () => withApp({ routes: { "/profile": () => ok({ profile: { name: "Ada", email: "ada@x.co", avatar_url: "https://img.test/a.png" } }) } }, async app => {
    assert.strictEqual(txt(app.$("#settings-name")), "Ada");
    assert.strictEqual(app.$("#profile-icon").getAttribute("src"), "https://img.test/a.png");
    assert.strictEqual(app.$("#profile-icon").style.display, "block");
  }));

  console.log("\nthe window and its pages");
  await t("opens on Profile; the three pages are Profile, AI and Danger Zone, and Danger Zone is the red one", () => withApp({}, async app => {
    assert(!app.$("#settings-modal").classList.contains("open"));
    await openSettings(app);
    assert(app.$("#settings-modal").classList.contains("open"));
    assert.deepStrictEqual([...app.w.document.querySelectorAll(".settings-tab")].map(b => txt(b)), ["Profile", "AI", "Danger Zone"]);
    assert.strictEqual(app.$("#tab-profile").getAttribute("aria-selected"), "true");
    assert(!app.$("#page-profile").hidden && app.$("#page-ai").hidden && app.$("#page-danger").hidden);
    assert(app.$("#tab-danger").classList.contains("danger") && app.$("#page-danger .settings-h").classList.contains("danger"));
    for (const p of ["profile", "ai", "danger"]) assert(app.$("#page-" + p + " .settings-h svg, #page-" + p + " .settings-h i"), p + " page has its icon next to its title");
  }));
  await t("tabs switch pages, and the arrow keys move between them", () => withApp({ routes: baseRoutes() }, async app => {
    await openSettings(app, "ai");
    assert(!app.$("#page-ai").hidden && app.$("#page-profile").hidden);
    app.$("#tab-ai").dispatchEvent(new app.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    assert(!app.$("#page-danger").hidden && app.$("#tab-danger").getAttribute("aria-selected") === "true");
    app.$("#tab-danger").dispatchEvent(new app.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    assert(!app.$("#page-profile").hidden, "wraps around to Profile");
  }));
  await t("Escape, the close button and a tap outside all close it", () => withApp({}, async app => {
    await openSettings(app);
    app.$("#settings-modal").dispatchEvent(new app.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert(!app.$("#settings-modal").classList.contains("open"));
    await openSettings(app); app.$("#settings-close").click();
    assert(!app.$("#settings-modal").classList.contains("open"));
    await openSettings(app); app.$("#settings-modal").click();
    assert(!app.$("#settings-modal").classList.contains("open"));
  }));

  console.log("\nProfile page");
  await t("the small x on the picture only shows when there is a picture, and removes it", () => withApp({ routes: {
    "/profile": () => ok({ profile: { name: "Ada", email: "ada@x.co", avatar_url: "https://img.test/a.png" } }),
    "/auth/avatar": () => ok({ success: true }),
  } }, async app => {
    await openSettings(app);
    assert.strictEqual(app.$("#avatar-remove").hidden, false, "x visible with a picture");
    app.$("#avatar-remove").click(); await app.sleep(40);
    assert.strictEqual(callsTo(app, "/auth/avatar", "DELETE").length, 1);
    assert.strictEqual(app.$("#avatar-remove").hidden, true, "x gone once removed");
    assert.strictEqual(app.$("#profile-icon").style.display, "none");
    assert.strictEqual(app.w.localStorage.getItem("agent1102_avatar"), null);
  }));
  await t("with no picture there is no x", () => withApp({}, async app => { await openSettings(app); assert.strictEqual(app.$("#avatar-remove").hidden, true); }));
  await t("if removing fails, the picture stays", () => withApp({ routes: {
    "/profile": () => ok({ profile: { name: "Ada", avatar_url: "https://img.test/a.png" } }),
    "/auth/avatar": () => bad(500, "I couldn't remove that picture."),
  } }, async app => {
    await openSettings(app); app.$("#avatar-remove").click(); await app.sleep(40);
    assert.strictEqual(app.$("#avatar-remove").hidden, false);
    assert.strictEqual(app.$("#profile-icon").getAttribute("src"), "https://img.test/a.png");
  }));
  await t("the account email is shown", () => withApp({ routes: { "/profile": () => ok({ profile: { name: "Sam", email: "sam@example.com" } }) } }, async app => {
    await openSettings(app);
    assert.strictEqual(txt(app.$("#profile-email-current")), "sam@example.com");
  }));
  await t("changing the username saves it and updates the name on the Settings button", () => withApp({ routes: { "/auth/update": () => ok({ success: true }) } }, async app => {
    await openSettings(app);
    assert.strictEqual(app.$("#profile-name").value, "Sam", "pre-filled with the current name");
    app.$("#profile-name").value = "  Samantha "; app.$("#save-name").click(); await app.sleep(40);
    assert.deepStrictEqual(callsTo(app, "/auth/update")[0].body, { name: "Samantha" });
    assert.strictEqual(txt(app.$("#settings-name")), "Samantha");
    assert.strictEqual(app.w.localStorage.getItem("agent1102_name"), "Samantha");
    assert(/saved/i.test(txt(app.$("#profile-msg"))) && app.$("#profile-msg").classList.contains("ok"));
  }));
  await t("changing the email and password each send only that one field, and clear the box", () => withApp({ routes: { "/auth/update": () => ok({ success: true }) } }, async app => {
    await openSettings(app);
    app.$("#profile-email").value = "new@x.co"; app.$("#save-email").click(); await app.sleep(40);
    app.$("#profile-password").value = "hunter22!"; app.$("#save-password").click(); await app.sleep(40);
    const sent = callsTo(app, "/auth/update").map(c => c.body);
    assert.deepStrictEqual(sent, [{ email: "new@x.co" }, { password: "hunter22!" }]);
    assert.strictEqual(txt(app.$("#profile-email-current")), "new@x.co");
    assert.strictEqual(app.$("#profile-password").value, "");
    assert.strictEqual(app.$("#profile-email").value, "");
  }));
  await t("empty boxes and server errors show a message in red; nothing is sent for empty ones", () => withApp({ routes: { "/auth/update": () => bad(400, "That email address doesn't look right.") } }, async app => {
    await openSettings(app);
    app.$("#profile-name").value = ""; app.$("#save-name").click();
    app.$("#save-email").click(); app.$("#save-password").click(); await app.sleep(20);
    assert.strictEqual(callsTo(app, "/auth/update").length, 0);
    assert(app.$("#profile-msg").classList.contains("err"));
    app.$("#profile-email").value = "nope"; app.$("#save-email").click(); await app.sleep(40);
    assert.strictEqual(txt(app.$("#profile-msg")), "That email address doesn't look right.");
    assert(app.$("#profile-msg").classList.contains("err"));
  }));

  console.log("\nAI page");
  await t("shows both preference boxes filled in, the Suggested key option, and instructions with working links", () => withApp({ routes: baseRoutes() }, async app => {
    await openSettings(app, "ai");
    assert.strictEqual(app.$("#ai-talk").value, "Keep it short.");
    assert.strictEqual(app.$("#ai-about").value, "Nursing student.");
    const badge = app.$(".badge-suggested");
    assert.strictEqual(txt(badge), "Suggested");
    assert(badge.closest(".key-section"), "the badge belongs to the key option");
    const details = app.$(".key-section details");
    assert(details && /How do I get a key/i.test(txt(details.querySelector("summary"))), "an instructions dropdown");
    const links = [...details.querySelectorAll("a")].map(a => [a.getAttribute("href"), a.getAttribute("rel"), a.getAttribute("target")]);
    assert(links.some(l => l[0] === "https://console.groq.com/keys"), "links to the keys page");
    for (const l of links) { assert(/^https:\/\//.test(l[0])); assert(/noopener/.test(l[1])); assert.strictEqual(l[2], "_blank"); }
    assert(/Using the shared key/.test(txt(app.$("#groq-status"))) && app.$("#groq-remove").hidden);
  }));
  await t("Save preferences sends both boxes", () => withApp({ routes: baseRoutes({ "/settings/ai": body => ok({ available: true, canStoreKey: true, talkStyle: body.talkStyle, aboutMe: body.aboutMe, groq: { hasKey: false } }) }) }, async app => {
    await openSettings(app, "ai");
    app.$("#ai-talk").value = "Be formal."; app.$("#ai-about").value = "I teach math.";
    app.$("#ai-save").click(); await app.sleep(40);
    assert.deepStrictEqual(callsTo(app, "/settings/ai", "POST")[0].body, { talkStyle: "Be formal.", aboutMe: "I teach math." });
    assert(app.$("#ai-msg").classList.contains("ok"));
    assert.strictEqual(app.$("#ai-talk").value, "Be formal.", "what they typed is not overwritten");
  }));
  await t("saving a Groq key: sent once, box cleared, status shows the last 4, Remove appears; the key is never shown back", () => withApp({ routes: baseRoutes({
    "/settings/groq-key": (body, opts) => opts.method === "DELETE"
      ? ok({ available: true, canStoreKey: true, talkStyle: "", aboutMe: "", groq: { hasKey: false, last4: "" } })
      : ok({ available: true, canStoreKey: true, talkStyle: "", aboutMe: "", groq: { hasKey: true, last4: "wxyz" } }),
  }) }, async app => {
    await openSettings(app, "ai");
    app.$("#groq-key").value = "  gsk_" + "a".repeat(30) + "wxyz "; app.$("#groq-save").click(); await app.sleep(40);
    assert.deepStrictEqual(callsTo(app, "/settings/groq-key", "POST")[0].body, { key: "gsk_" + "a".repeat(30) + "wxyz" });
    assert.strictEqual(app.$("#groq-key").value, "", "the pasted key is cleared from the box");
    assert(/own key \(ending in wxyz\)/.test(txt(app.$("#groq-status"))), txt(app.$("#groq-status")));
    assert.strictEqual(app.$("#groq-remove").hidden, false);
    assert(!app.w.document.body.textContent.includes("a".repeat(30)), "the key is not anywhere on the page");
    assert(![...Array(app.w.localStorage.length).keys()].some(i => String(app.w.localStorage.getItem(app.w.localStorage.key(i))).includes("gsk_")), "and not in localStorage");
    app.$("#groq-remove").click(); await app.sleep(40);
    assert.strictEqual(callsTo(app, "/settings/groq-key", "DELETE").length, 1);
    assert(/shared key/.test(txt(app.$("#groq-status"))) && app.$("#groq-remove").hidden);
  }));
  await t("a rejected key shows Groq's reason in red and keeps the box so it can be fixed", () => withApp({ routes: baseRoutes({ "/settings/groq-key": () => bad(400, "Groq didn't accept that key. Check that you copied all of it and that it hasn't been deleted.") }) }, async app => {
    await openSettings(app, "ai");
    app.$("#groq-key").value = "gsk_" + "b".repeat(30); app.$("#groq-save").click(); await app.sleep(40);
    assert(/didn't accept/.test(txt(app.$("#groq-msg"))) && app.$("#groq-msg").classList.contains("err"));
    assert.strictEqual(app.$("#groq-key").value, "gsk_" + "b".repeat(30));
  }));
  await t("an unreadable saved key says so (not 'using your own key') and can still be removed", () => withApp({ routes: baseRoutes({ "/settings": () => ok({ available: true, canStoreKey: true, talkStyle: "", aboutMe: "", groq: { hasKey: false, unreadable: true, last4: "" } }) }) }, async app => {
    await openSettings(app, "ai");
    assert(/can't be read any more/.test(txt(app.$("#groq-status"))) && /paste your key again/.test(txt(app.$("#groq-status"))));
    assert.strictEqual(app.$("#groq-remove").hidden, false);
    assert(!app.$("#groq-status").classList.contains("own"));
  }));
  await t("an empty key box asks for a key and sends nothing", () => withApp({ routes: baseRoutes() }, async app => {
    await openSettings(app, "ai"); app.$("#groq-save").click(); await app.sleep(20);
    assert.strictEqual(callsTo(app, "/settings/groq-key").length, 0);
    assert(app.$("#groq-msg").classList.contains("err"));
  }));
  await t("when the server hasn't been set up for settings, the page says so and the save buttons are off", () => withApp({ routes: baseRoutes({ "/settings": () => ok({ available: false, canStoreKey: true, talkStyle: "", aboutMe: "", groq: { hasKey: false } }) }) }, async app => {
    await openSettings(app, "ai");
    assert(/isn't set up/.test(txt(app.$("#ai-msg"))));
    assert(app.$("#ai-save").disabled && app.$("#groq-save").disabled);
  }));
  await t("saved memories replace /memory: listed as plain text (never HTML), deletable one by one, switch and Forget everything work", () => withApp({ routes: baseRoutes({
    "/memory/m1": () => ok({ success: true }),
    "/memory": (body, opts) => opts.method === "DELETE" ? ok({ success: true }) : ok({ enabled: true, memories: [{ id: "m2", content: "<img src=x onerror=alert(1)>", source: "user" }].concat(opts.__cleared ? [] : []) }),
  }) }, async app => {
    await openSettings(app, "ai");
    const items = [...app.w.document.querySelectorAll("#memory-list li")];
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].querySelector(".mem-text").textContent, "<img src=x onerror=alert(1)>");
    assert.strictEqual(app.$("#memory-list img"), null, "a memory is text, not markup");
    app.$("#memory-toggle").checked = false; app.$("#memory-toggle").dispatchEvent(new app.w.Event("change", { bubbles: true })); await app.sleep(30);
    assert.deepStrictEqual(callsTo(app, "/prefs", "POST")[0].body, { updates: { memory: false } });
    app.$("#style-reset").click(); await app.sleep(30);
    assert.deepStrictEqual(callsTo(app, "/prefs", "POST")[1].body, { command: "reset" });
    app.$("#memory-clear").click(); await app.sleep(40);
    assert.strictEqual(callsTo(app, "/memory", "DELETE").length, 1);
  }));
  await t("one memory can be forgotten with its own x", () => withApp({ routes: baseRoutes({ "/memory/m1": () => ok({ success: true }) }) }, async app => {
    await openSettings(app, "ai");
    assert.strictEqual(app.w.document.querySelectorAll("#memory-list li").length, 2);
    app.$("#memory-list li .mem-x").click(); await app.sleep(30);
    assert.strictEqual(callsTo(app, "/memory/m1", "DELETE").length, 1);
    assert.strictEqual(app.w.document.querySelectorAll("#memory-list li").length, 1);
  }));

  console.log("\nDanger Zone page");
  await t("has Log out and Delete account; Log out signs out and closes Settings", () => withApp({}, async app => {
    await openSettings(app, "danger");
    assert(app.$("#page-danger #logout-btn") && app.$("#page-danger #profile-delete"));
    app.$("#logout-btn").click(); await app.sleep(40);
    assert(!app.$("#settings-modal").classList.contains("open"), "Settings must not stay open over the sign-in screen");
    assert.notStrictEqual(app.$("#auth-screen") && app.$("#auth-screen").style.display, "none", "sign-in screen showing");
    assert.strictEqual(app.$("#app").style.display, "none");
    assert.strictEqual(txt(app.$("#settings-name")), "Account", "the next person doesn't see the last person's name");
  }));
  await t("Delete account asks twice, then deletes and signs out", () => withApp({ routes: { "/auth/delete": () => ok({ success: true }) } }, async app => {
    let asked = 0; app.w.confirm = () => { asked++; return true; };
    await openSettings(app, "danger"); app.$("#profile-delete").click(); await app.sleep(40);
    assert.strictEqual(asked, 2);
    assert.strictEqual(callsTo(app, "/auth/delete", "DELETE").length, 1);
    assert.strictEqual(app.$("#app").style.display, "none");
  }));
  await t("answering No to the confirmations deletes nothing", () => withApp({ routes: { "/auth/delete": () => ok({ success: true }) } }, async app => {
    app.w.confirm = () => false;
    await openSettings(app, "danger"); app.$("#profile-delete").click(); await app.sleep(30);
    assert.strictEqual(callsTo(app, "/auth/delete").length, 0);
  }));
  await t("signing out and in as someone else never shows the last person's AI settings", () => withApp({ routes: baseRoutes() }, async app => {
    await openSettings(app, "ai");
    assert.strictEqual(app.$("#ai-talk").value, "Keep it short.");
    app.$("#tab-danger").click(); app.$("#logout-btn").click(); await app.sleep(30);
    assert.strictEqual(app.$("#ai-talk").value, "");
    assert.strictEqual(app.$("#ai-about").value, "");
  }));

  console.log("\nthe old chat commands");
  await t("/memory, /remember, /forget and /style are gone from the slash menu and explained, not sent to the AI", () => withApp({}, async app => {
    const menu = app.peek("agent1102Commands.COMMANDS ? agent1102Commands.COMMANDS.map(c => c.name) : []");
    for (const gone of ["memory", "remember", "forget", "style"]) assert(!menu.includes(gone), gone + " still in the menu");
    const historyBefore = app.peek("history").length; // (the chat starts with the greeting)
    for (const cmd of ["/memory", "/remember I like jazz", "/forget 2", "/style concise"]) {
      const before = app.calls.filter(c => c.path === "/chat").length;
      await app.send(cmd);
      assert.strictEqual(app.calls.filter(c => c.path === "/chat").length, before, cmd + " must not reach the AI");
    }
    assert(/Settings/.test(app.$("#chat").textContent), "tells the person where it moved");
    assert.strictEqual(app.peek("history").length, historyBefore, "and none of it is added to the conversation");
  }));
  await t("/help points to Settings for memory and style", () => withApp({}, async app => {
    await app.send("/help");
    const chat = app.$("#chat").textContent;
    assert(/Settings/.test(chat) && !/\/memory|\/forget|\/style/.test(chat), "help mentions Settings, not the old commands");
  }));

  console.log("\nfiles");
  await t("personal.js is gone and no page script still loads it", () => {
    assert(!fs.existsSync(path.join(__dirname, "..", "public", "js", "personal.js")));
    assert(!/personal\.js/.test(fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8")));
  });

  console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
  process.exit(failed ? 1 : 0);
})();
