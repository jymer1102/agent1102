// Saved login
  // The session (access token + refresh token) lives in localStorage, so closing the tab or the
  // browser doesn't sign you out. The access token only lasts about an hour; the refresh token
  // quietly swaps it for a fresh one, so you only sign in again if you log out or the session is revoked.
  function tokenSecondsLeft(token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.exp - Math.floor(Date.now() / 1000);
    } catch { return 0; }
  }

  // One refresh at a time (the interval, tab-focus and page load can all ask at once)
  let refreshInFlight = null;
  function refreshToken() {
    if (!refreshInFlight) refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }
  async function doRefresh() {
    const storedRefresh = localStorage.getItem("agent1102_refresh_token");
    if (!storedRefresh) return;
    try {
      const res = await fetch(`${BACKEND_URL}/auth/refresh`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: storedRefresh }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.session) {
        userToken = data.session.access_token;
        localStorage.setItem("agent1102_token", userToken);
        localStorage.setItem("agent1102_refresh_token", data.session.refresh_token);
      } else if (res.status === 401) {
        showAuth(); // the server says the saved login is no longer valid: sign in again
      }
      // anything else (server waking up, Supabase hiccup): stay signed in and try again later
    } catch { console.error("Token refresh failed"); }
  }
  setInterval(refreshToken, 10 * 60 * 1000);

  // Background tabs throttle timers, so also top the token up when you come back to the tab
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && userToken && tokenSecondsLeft(userToken) < 300) refreshToken();
  });

  // Keep several open tabs in step: a refresh, sign-in or sign-out in one tab applies to the others
  window.addEventListener("storage", (e) => {
    if (e.key !== "agent1102_token") return;
    if (e.newValue) {
      const wasSignedOut = !userToken;
      userToken = e.newValue;
      if (wasSignedOut) showApp();
    } else if (userToken) {
      showAuth();
    }
  });

  // Auth
  authStay.checked = agent1102Session.stay(); // the box shows this device's last choice (ticked for a new device)
  document.getElementById("discord-btn").addEventListener("click", () => { agent1102Session.begin(authStay.checked); window.location.href = `${BACKEND_URL}/auth/oauth/discord`; });
  document.getElementById("github-btn").addEventListener("click", () => { agent1102Session.begin(authStay.checked); window.location.href = `${BACKEND_URL}/auth/oauth/github`; });

  authToggle.addEventListener("click", () => {
    isSignUp = !isSignUp;
    authName.style.display = isSignUp ? "block" : "none";
    authPhone.style.display = isSignUp ? "block" : "none";
    authSubtitle.textContent = isSignUp ? "Create an account" : "Sign in to your account";
    authSubmit.textContent = isSignUp ? "Sign Up" : "Sign In";
    authToggle.textContent = isSignUp ? "Already have an account? Sign in" : "Don't have an account? Sign up";
    authPassword.autocomplete = isSignUp ? "new-password" : "current-password"; // tells the password manager whether to fill or suggest
    setAuthMessage("");
  });

  // Submitting the <form> (button or Enter key) signs in / up. Using a real form submit is what lets the
  // browser offer to save the password and autofill it next time.
  authForm.addEventListener("submit", (e) => { e.preventDefault(); if (!authSubmit.disabled) submitAuth(); });

  // One place for the message under the sign-in form. info = good news (shown green), otherwise it is an error (red).
  function setAuthMessage(text, info) {
    authError.textContent = text || "";
    authError.classList.toggle("info", !!info && !!text);
  }
  function resetAuthButton() {
    authSubmit.disabled = false;
    authSubmit.textContent = isSignUp ? "Sign Up" : "Sign In";
  }

  async function submitAuth() {
    const email = authEmail.value.trim();
    const password = authPassword.value.trim();
    const name = authName.value.trim();
    const phone = authPhone.value.trim();
    if (!email || !password || (isSignUp && !name)) { setAuthMessage(isSignUp ? "Please fill in your name, email and password." : "Please enter your email and password."); return; }
    authSubmit.disabled = true; authSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin-pulse"></i> Loading...';
    try {
      const res = await fetch(`${BACKEND_URL}${isSignUp ? "/auth/signup" : "/auth/login"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name, phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.error) { setAuthMessage(data.error); resetAuthButton(); return; }
      if (!data.session) {
        // Supabase's "Confirm email" setting is on: the account was created but
        // needs email confirmation before it gets a session.
        if (data.needsConfirmation) setAuthMessage("Almost there! Check your email for a confirmation link, then come back and sign in.", true);
        else setAuthMessage("I couldn't sign you in. Please try again.");
        resetAuthButton();
        return;
      }
      setAuthMessage("");
      agent1102Session.begin(authStay.checked); // remember whether this login should survive closing the browser
      userToken = data.session.access_token;
      localStorage.setItem("agent1102_token", userToken);
      localStorage.setItem("agent1102_refresh_token", data.session.refresh_token);
      localStorage.setItem("agent1102_name", data.user?.user_metadata?.name || name || "");
      hidePasswords();
      showApp();
    } catch (err) {
      console.error("Sign-in request failed:", err);
      setAuthMessage("I can't reach the server right now. Check your connection and try again in a moment.");
      resetAuthButton();
    }
  }

  async function showApp() {
    // An old sign-in without a refresh token (e.g. from before OAuth saved one) can't renew itself once it expires
    if (!localStorage.getItem("agent1102_refresh_token") && tokenSecondsLeft(userToken) <= 0) { showAuth(); return; }
    authScreen.style.display = "none";
    appEl.style.display = "flex";
    if (tokenSecondsLeft(userToken) < 300) await refreshToken(); // only renew when it's about to expire
    if (!userToken) return; // the refresh was rejected and showAuth() already ran
    loadProfile(); // fetches the saved profile picture; not awaited so the chat isn't held up
    if (typeof loadEasterEggs === "function") loadEasterEggs(); // unlocked easter eggs follow the account; also not awaited
    if (history.length === 0) addGreeting();
    loadChats();
  }

  function showAuth() {
    appEl.style.display = "none";
    authScreen.style.display = "flex";
    userToken = null;
    agent1102Session.end(); // removes the saved login
    authStay.checked = agent1102Session.stay(); // the box shows this device's last choice
    authPassword.value = "";
    setAuthMessage("");
    authSubmit.disabled = false; authSubmit.textContent = isSignUp ? "Sign Up" : "Sign In"; // was left on "Loading..." after a successful sign-in
    hidePasswords();
    clearAvatar();
    // easter egg progress belongs to the account, so the next person on this browser starts clean
    if (typeof resetEasterEggs === "function") resetEasterEggs();
  }

  // The server sends people back to /?error=oauth_failed when Discord/GitHub sign-in doesn't complete
  window.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") !== "oauth_failed") return;
    setAuthMessage("That sign-in didn't work. Please try again, or sign in with your email and password.");
    params.delete("error");
    const rest = params.toString();
    history.replaceState(null, "", window.location.pathname + (rest ? "?" + rest : "") + window.location.hash);
  });

  // Wait for DOMContentLoaded so profile.js / chat.js (loaded after this file) are defined
  // before showApp() calls into them.
  if (userToken) window.addEventListener("DOMContentLoaded", showApp);
