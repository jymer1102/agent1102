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
  newChatBtn.addEventListener("click", () => { saveCurrentChat(); history = []; chatEl.innerHTML = ""; currentChatId = Date.now().toString(); currentChatTitle = null; titleAtCount = 0; addGreeting(); });

  // Trash-can button: permanently deletes the CURRENT chat (not just clears the view)
  clearBtn.addEventListener("click", async () => {
    if (!confirm("Delete this chat? This can't be undone.")) return;
    if (userToken && currentChatId) {
      try {
        await fetch(`${BACKEND_URL}/chats/${currentChatId}`, { method: "DELETE", headers: { "Authorization": `Bearer ${userToken}` } });
      } catch { console.error("Failed to delete chat"); }
    }
    history = []; chatEl.innerHTML = ""; currentChatId = Date.now().toString(); currentChatTitle = null; titleAtCount = 0; addGreeting();
    if (sidebar.classList.contains("open")) await loadChats();
  });

  // Clear all chats
  clearAllBtn.addEventListener("click", async () => {
    if (!confirm("Delete all chat history? This can't be undone.")) return;
    await fetch(`${BACKEND_URL}/chats`, { method: "DELETE", headers: { "Authorization": `Bearer ${userToken}` } });
    history = []; chatEl.innerHTML = ""; currentChatId = Date.now().toString(); currentChatTitle = null; titleAtCount = 0; addGreeting();
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
    if (titleBusy) return;
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
      if (data && data.title && idAtStart === currentChatId) { currentChatTitle = data.title; titleAtCount = countAtStart; }
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
      : chats.map(c => `<div class="history-item" data-id="${agent1102Render.escapeHtml(c.id)}"><span class="history-item-title">${agent1102Render.escapeHtml(c.title)}</span><button class="delete-chat-btn" data-id="${agent1102Render.escapeHtml(c.id)}" title="Delete chat"><i class="fa-solid fa-xmark"></i></button></div>`).join("");
    sidebarList.querySelectorAll(".history-item-title").forEach(el => {
      el.addEventListener("click", () => {
        const c = chats.find(x => x.id === el.closest(".history-item").dataset.id);
        if (!c) return;
        history = c.history; currentChatId = c.id; currentChatTitle = c.title || null; titleAtCount = 0; chatEl.innerHTML = "";
        history.forEach((m, i) => addHistoryMsg(m, i));
        closeSidebarFn();
      });
    });
    sidebarList.querySelectorAll(".delete-chat-btn").forEach(el => {
      el.addEventListener("click", async e => {
        e.stopPropagation();
        const c = chats.find(x => x.id === el.dataset.id);
        if (!confirm(`Delete "${c ? c.title : "this chat"}"? This can't be undone.`)) return;
        await fetch(`${BACKEND_URL}/chats/${el.dataset.id}`, { method: "DELETE", headers: { "Authorization": `Bearer ${userToken}` } });
        if (el.dataset.id === currentChatId) {
          history = []; chatEl.innerHTML = ""; currentChatId = Date.now().toString(); currentChatTitle = null; titleAtCount = 0; addGreeting();
        }
        await loadChats();
      });
    });
  }
