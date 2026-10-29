const BACKEND_URL = "https://agent1102.onrender.com";

  // Elements
  const authScreen = document.getElementById("auth-screen");
  const appEl = document.getElementById("app");
  const authForm = document.getElementById("auth-form");
  const authName = document.getElementById("auth-name");
  const authPhone = document.getElementById("auth-phone");
  const authEmail = document.getElementById("auth-email");
  const authPassword = document.getElementById("auth-password");
  const authSubmit = document.getElementById("auth-submit");
  const authToggle = document.getElementById("auth-toggle");
  const authStay = document.getElementById("auth-stay"); // "Stay signed in" checkbox
  const authError = document.getElementById("auth-error");
  const authSubtitle = document.getElementById("auth-subtitle");
  const chatEl = document.getElementById("chat");
  const input = document.getElementById("input");
  const btn = document.getElementById("send");
  const fileInput = document.getElementById("file-input");
  const uploadBtn = document.getElementById("upload-btn");
  const previewArea = document.getElementById("preview-area");
  const previewImg = document.getElementById("preview-img");
  const removeImgBtn = document.getElementById("remove-img");
  const themeBtn = document.getElementById("theme-btn");
  const clearBtn = document.getElementById("clear-btn");
  const micBtn = document.getElementById("mic-btn");
  const historyBtn = document.getElementById("history-btn");
  const newChatBtn = document.getElementById("new-chat-btn");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  const closeSidebarBtn = document.getElementById("close-sidebar");
  const sidebarList = document.getElementById("sidebar-list");
  const clearAllBtn = document.getElementById("clear-all-btn");
  const headerBtns = document.getElementById("header-btns");
  const headerTitle = document.getElementById("header-title");
  const logoutBtn = document.getElementById("logout-btn");
  const profileModal = document.getElementById("profile-modal");
  const profileBtn = document.getElementById("profile-btn");
  const profileClose = document.getElementById("profile-close");
  const profileSave = document.getElementById("profile-save");
  const profileDelete = document.getElementById("profile-delete");
  const profileMsg = document.getElementById("profile-msg");
  const avatarInput = document.getElementById("avatar-upload");
  const avatarPreview = document.getElementById("profile-preview");

  let history = [];
  let pendingImageBase64 = null;
  let pendingImageType = null;
  let isLight = false;
  let recognition = null;
  let isRecording = false;
  let currentChatId = Date.now().toString();
  let currentChatTitle = null; // AI-generated summary title for the sidebar; null = not generated yet
  let currentChatTitleLocked = false; // true once the person renamed this chat: the automatic titler must leave the name alone
  let userToken = localStorage.getItem("agent1102_token") || null;
  let isSignUp = false;

  // Keeps the Render backend awake by hitting the dedicated /ping route
  function pingRenderServer() {
    console.log("Pinging Render backend to prevent spin-down...");
    fetch(`${BACKEND_URL}/ping`)
      .then(res => {
        if (res.ok) console.log("Render backend is awake! status:", res.status);
      })
      .catch(err => console.warn("Ping failed, server might be sleeping:", err));
  }

  // Ping immediately on load, then repeat every 5 minutes (300,000 ms)
  pingRenderServer();
  setInterval(pingRenderServer, 5 * 60 * 1000);
