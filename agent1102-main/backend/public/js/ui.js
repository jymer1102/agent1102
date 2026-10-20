// Logout
  logoutBtn.addEventListener("click", () => { if (!confirm("Log out?")) return; showAuth(); });

 // Theme Toggle
  themeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    
    isLight = !isLight;
    document.body.classList.toggle("light", isLight);
    document.documentElement.classList.toggle("light", isLight);
    themeBtn.innerHTML = isLight ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
    
    localStorage.setItem("theme", isLight ? "light" : "dark");
    
    applyEaster();
  });

  // New chat (keeps the old behavior: saves the current chat, then starts fresh)
  newChatBtn.addEventListener("click", () => { saveCurrentChat(); history = []; chatEl.innerHTML = ""; currentChatId = Date.now().toString(); currentChatTitle = null; currentChatTitleLocked = false; titleAtCount = 0; addGreeting(); });

  // Trash-can button: permanently deletes the CURRENT chat (not just clears the view)
  clearBtn.addEventListener("click", async () => {
    if (!confirm("Delete this chat? This can't be undone.")) return;
    if (userToken && currentChatId) {
      try {
        await fetch(`${BACKEND_URL}/chats/${currentChatId}`, { method: "DELETE", headers: { "Authorization": `Bearer ${userToken}` } });
      } catch { console.error("Failed to delete chat"); }
    }
    history = []; chatEl.innerHTML = ""; currentChatId = Date.now().toString(); currentChatTitle = null; currentChatTitleLocked = false; titleAtCount = 0; addGreeting();
    if (sidebar.classList.contains("open")) await loadChats();
  });

  // Clear all chats
  clearAllBtn.addEventListener("click", async () => {
    if (!confirm("Delete all chat history? This can't be undone.")) return;
    await fetch(`${BACKEND_URL}/chats`, { method: "DELETE", headers: { "Authorization": `Bearer ${userToken}` } });
    history = []; chatEl.innerHTML = ""; currentChatId = Date.now().toString(); currentChatTitle = null; currentChatTitleLocked = false; titleAtCount = 0; addGreeting();
    renderSidebar([]);
  });

  // Sidebar
  historyBtn.addEventListener("click", async () => { await saveCurrentChat(); await loadChats(); sidebar.classList.add("open"); overlay.classList.add("show"); });
  closeSidebarBtn.addEventListener("click", closeSidebarFn);
  overlay.addEventListener("click", closeSidebarFn);
  function closeSidebarFn() { sidebar.classList.remove("open"); overlay.classList.remove("show"); }

  let titleAtCount = 0; // user-message count when the current title was generated
  let titleBusy = false; // saveCurrentChat fires often; never run two title requests at once
  async function maybeUpdateTitle() {
    if (titleBusy || currentChatTitleLocked) return; // a name the person chose is never replaced by an automatic one
    const userCount = history.filter(m => m.role === "user").length;
    const hasReply = history.some(m => m.role === "assistant");
    // Generate once there is a reply to summarize (the overview covers both sides of the
    // chat), then refresh every 3 user messages so it keeps tracking the conversation.
    const shouldGenerate = currentChatTitle === null
      ? userCount >= 1 && hasReply
      : userCount > 1 && (userCount - 1) % 3 === 0 && titleAtCount !== userCount;
    if (!shouldGenerate) return;
    titleBusy = true;
    const countAtStart = userCount, idAtStart = currentChatId;
    try {
      const res = await fetch(`${BACKEND_URL}/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data = await res.json();
      if (data && data.title && idAtStart === currentChatId && !currentChatTitleLocked) { currentChatTitle = data.title; titleAtCount = countAtStart; }
    } catch { console.error("Failed to generate chat title"); }
    finally { titleBusy = false; }
  }

  async function saveCurrentChat() {
    if (history.length < 1 || !userToken) return;
    const firstUserMsg = history.find(m => m.role === "user");
    if (!firstUserMsg) return;
    // Snapshot first: "New chat" resets these right after calling us, and the title
    // request below is async.
    const chatId = currentChatId, chatHistory = history;
    await maybeUpdateTitle();
    const title = (chatId === currentChatId && currentChatTitle) || agent1102Render.historyTitle(firstUserMsg);
    await fetch(`${BACKEND_URL}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${userToken}` },
      body: JSON.stringify({ id: chatId, title, history: chatHistory }),
    });
  }

  async function loadChats() {
    try {
      const res = await fetch(`${BACKEND_URL}/chats`, { headers: { "Authorization": `Bearer ${userToken}` } });
      const data = await res.json();
      renderSidebar(data.chats || []);
    } catch { console.error("Failed to load chats"); }
  }

  function renderSidebar(chats) {
    sidebarList.innerHTML = chats.length === 0
      ? `<p style="padding:1rem;color:var(--text-muted);font-size:0.9rem">No saved chats yet</p>`
      : chats.map(c => `<div class="history-item" data-id="${agent1102Render.escapeHtml(c.id)}"><span class="history-item-title"><span class="history-item-title-text">${agent1102Render.escapeHtml(c.title)}</span></span><button class="rename-chat-btn" data-id="${agent1102Render.escapeHtml(c.id)}" title="Rename chat" aria-label="Rename chat"><i class="fa-solid fa-pen"></i></button><button class="delete-chat-btn" data-id="${agent1102Render.escapeHtml(c.id)}" title="Delete chat"><i class="fa-solid fa-xmark"></i></button></div>`).join("");
    sidebarList.querySelectorAll(".history-item-title").forEach(el => {
      el.addEventListener("click", () => {
        const c = chats.find(x => x.id === el.closest(".history-item").dataset.id);
        if (!c) return;
        history = c.history; currentChatId = c.id; currentChatTitle = c.title || null; currentChatTitleLocked = !!c.title_locked; titleAtCount = 0; chatEl.innerHTML = "";
        history.forEach((m, i) => addHistoryMsg(m, i));
        closeSidebarFn();
      });
    });
    // ---- Rename: tap the pencil, type a name, Enter (or tap away) to save, Escape to cancel ----
    // Leave the name empty and the AI writes a title for the chat (and keeps it up to date from then on).
    async function saveName(chat, typed) {
      const auto = !typed; // empty name = "let the AI name it": the server writes a title from the saved conversation
      try {
        const res = await fetch(`${BACKEND_URL}/chats/${encodeURIComponent(chat.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${userToken}` },
          body: JSON.stringify(auto ? { auto: true } : { title: typed }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Couldn't rename the chat.");
        chat.title = data.title; chat.title_locked = data.locked;
        if (chat.id === currentChatId) {
          currentChatTitleLocked = data.locked;
          currentChatTitle = data.title;
          // a fresh AI title was just written, so don't write another one for this same message count
          titleAtCount = auto ? history.filter(m => m.role === "user").length : 0;
        }
      } catch (e) {
        // Nothing was changed on the server, so the old name simply comes back
        if (typeof showToast === "function") showToast(agent1102Render.escapeHtml(e.message || "Couldn't rename the chat."));
      }
      renderSidebar(chats);
    }
    function startRename(item, chat) {
      const titleEl = item.querySelector(".history-item-title");
      if (!titleEl || item.classList.contains("renaming")) return;
      const input = document.createElement("input");
      input.type = "text"; input.className = "history-item-input"; input.value = chat.title || "";
      input.maxLength = 60; input.placeholder = "Name (empty = AI title)"; input.setAttribute("aria-label", "Chat name");
      input.autocomplete = "off"; input.spellcheck = false;
      titleEl.replaceWith(input);
      item.classList.add("renaming");
      input.focus(); input.select();
      let finished = false;
      const finish = commit => {
        if (finished) return;
        finished = true;
        const typed = input.value.replace(/\s+/g, " ").trim();
        if (!commit || typed === (chat.title || "")) { renderSidebar(chats); return; }
        if (!typed) { // show that the AI is working on it (takes a second or two)
          const busy = document.createElement("span");
          busy.className = "history-item-naming"; busy.textContent = "Writing a title...";
          busy.setAttribute("role", "status");
          // Let go of focus BEFORE swapping: glow.js puts a caret-glow element next to a focused box and removes it
          // on blur, and removing it halfway through replaceWith() makes the browser throw.
          input.blur();
          input.replaceWith(busy);
        }
        saveName(chat, typed);
      };
      input.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true)); // tapping elsewhere (or closing the keyboard) saves it
      input.addEventListener("click", e => e.stopPropagation());
    }
    sidebarList.querySelectorAll(".rename-chat-btn").forEach(el => {
      el.addEventListener("click", e => {
        e.stopPropagation();
        const item = el.closest(".history-item");
        const chat = chats.find(x => x.id === el.dataset.id);
        if (item && chat) startRename(item, chat);
      });
    });
    sidebarList.querySelectorAll(".delete-chat-btn").forEach(el => {
      el.addEventListener("click", async e => {
        e.stopPropagation();
        const c = chats.find(x => x.id === el.dataset.id);
        if (!confirm(`Delete "${c ? c.title : "this chat"}"? This can't be undone.`)) return;
        await fetch(`${BACKEND_URL}/chats/${el.dataset.id}`, { method: "DELETE", headers: { "Authorization": `Bearer ${userToken}` } });
        if (el.dataset.id === currentChatId) {
          history = []; chatEl.innerHTML = ""; currentChatId = Date.now().toString(); currentChatTitle = null; currentChatTitleLocked = false; titleAtCount = 0; addGreeting();
        }
        await loadChats();
      });
    });
  }
