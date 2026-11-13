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

  // Banned or suspended. Supabase doesn't end a sign-in that already exists, so the server checks every request (and answers 403
  // "user_banned"), and this page does the rest: signs the person out at once and says why. fetchguard.js sees the answer and fires this.
  const BANNED = "This account has been banned or suspended, so it can't be used right now. If you think this is a mistake, please contact the site owner.";
  window.addEventListener("agent1102:banned", (e) => {
    if (!userToken) return; // on the sign-in screen the sign-in itself shows the reason
    const message = (e.detail && e.detail.message) || BANNED;
    showAuth();
    setMode("signin");
    setAuthMessage(message);
  });
  // While signed in, ask the server every minute (and when you come back to the tab) whether this account is still allowed. That is
  // what signs a banned person out even if they are just sitting on the page.
  function checkStillAllowed() {
    if (!userToken || document.visibilityState === "hidden") return;
    fetch(`${BACKEND_URL}/auth/session`, { headers: { "Authorization": `Bearer ${userToken}` } }).catch(() => { /* offline: try again next time */ });
  }
  setInterval(checkStillAllowed, 60 * 1000);

  // Background tabs throttle timers, so also top the token up when you come back to the tab
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && userToken && tokenSecondsLeft(userToken) < 300) refreshToken();
    if (document.visibilityState === "visible") checkStillAllowed();
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

  // The sign-in box has four modes, and this one function decides what each of them shows:
  //   signin  email + password                 signup  name, email, password + confirm
  //   forgot  email only: emails a reset link  reset   a new password + confirm, after opening that link
  let mode = "signin";
  const SUBMIT_TEXT = { signin: "Sign In", signup: "Sign Up", forgot: "Send reset link", reset: "Save new password" };
  const SUBTITLE = { signin: "Sign in to your account", signup: "Create an account", forgot: "Reset your password", reset: "Choose a new password" };
  const TOGGLE_TEXT = { signin: "Don't have an account? Sign up", signup: "Already have an account? Sign in", forgot: "Back to sign in", reset: "" };
  const NO_SERVER = "I can't reach the server right now. Check your connection and try again in a moment.";
  const LINK_EXPIRED = "That link has expired or was already used. Ask for a new one.";

  function setMode(next) {
    mode = next;
    const signup = next === "signup", forgot = next === "forgot", reset = next === "reset", plain = next === "signin" || signup;
    authName.style.display = signup ? "block" : "none";
    authPhone.style.display = signup ? "block" : "none";
    authEmail.style.display = reset ? "none" : "block";
    authPasswordWrap.style.display = forgot ? "none" : "flex";
    authConfirmWrap.style.display = signup || reset ? "flex" : "none";
    authStayLabel.style.display = plain ? "flex" : "none";
    authSocial.style.display = plain ? "flex" : "none";
    authForgot.hidden = next !== "signin";
    authResend.hidden = true; // only offered when a confirmation email is what's missing
    authToggle.style.display = reset ? "none" : "";
    authSubtitle.textContent = SUBTITLE[next];
    authSubmit.textContent = SUBMIT_TEXT[next];
    authToggle.textContent = TOGGLE_TEXT[next];
    authPassword.autocomplete = signup || reset ? "new-password" : "current-password"; // tells the password manager whether to fill or suggest
    authPassword.placeholder = reset ? "New password" : "Password";
    if (forgot || reset) authPassword.value = "";
    authConfirm.value = "";
    hidePasswords();
    setAuthMessage("");
  }

  authToggle.addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));
  authForgot.addEventListener("click", () => setMode("forgot"));
  authResend.addEventListener("click", () => resendConfirmation());

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
    authSubmit.textContent = SUBMIT_TEXT[mode];
  }
  const busyAuthButton = () => { authSubmit.disabled = true; authSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin-pulse"></i> Loading...'; };
  const postJson = (path, body, token) => fetch(`${BACKEND_URL}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "Authorization": `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });

  // Signed in (with a password, or with the code from the sign-up email): keep the login and open the app
  function completeSignIn(data, name) {
    setAuthMessage("");
    agent1102Session.begin(authStay.checked); // remember whether this login should survive closing the browser
    userToken = data.session.access_token;
    localStorage.setItem("agent1102_token", userToken);
    localStorage.setItem("agent1102_refresh_token", data.session.refresh_token);
    localStorage.setItem("agent1102_name", data.user?.user_metadata?.name || name || "");
    setDisplayName(localStorage.getItem("agent1102_name")); // the name on the sidebar's Settings button
    hidePasswords();
    showApp();
  }

  // The 6-digit code from a sign-up or "forgot password" email, in the full-screen code window (js/codedialog.js). The link in the
  // same email still works: whichever the person uses first. "signup" signs them in; "recovery" goes on to choosing a new password.
  async function openEmailCode(email, type) {
    const signup = type === "signup";
    const outcome = await agent1102CodeDialog.open({
      title: signup ? "Confirm your email" : "Check your email",
      email,
      note: "If the email has a link instead of a code, open the link. Can't find it? Check your spam folder.",
      resend: async () => {
        const res = await postJson(signup ? "/auth/resend" : "/auth/forgot", { email });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || "I couldn't send a new code. Please try again in a moment.");
      },
      verify: async (code) => {
        let res;
        try { res = await postJson("/auth/verify-code", { email, code, type }); } catch (_) { throw new Error(NO_SERVER); }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error || !data.session) {
          const err = new Error(data.error || "That code isn't right, or it has expired. Check your newest email, or ask for a new code.");
          if (data.code === "user_banned") err.closeDialog = true; // nothing more to try: close and show the reason
          throw err;
        }
        return data;
      },
    });
    if (!outcome.ok) { if (outcome.error) setAuthMessage(outcome.error.message); return; }
    const { session, user } = outcome.result;
    if (signup) return completeSignIn({ session, user }, "");
    // a reset code was accepted: the same thing the reset-password link does (this tab only, and only to set the new password)
    sessionStorage.setItem("agent1102_recovery", JSON.stringify({ a: session.access_token, r: session.refresh_token }));
    setMode("reset");
    setAuthMessage("Code accepted. Now choose a new password.", true);
  }

  async function submitAuth() {
    if (mode === "forgot") return submitForgot();
    if (mode === "reset") return submitReset();
    const signup = mode === "signup";
    const email = authEmail.value.trim();
    const password = authPassword.value.trim();
    const confirmPassword = authConfirm.value.trim();
    const name = authName.value.trim();
    const phone = authPhone.value.trim();
    if (!email || !password || (signup && !name)) { setAuthMessage(signup ? "Please fill in your name, email and password." : "Please enter your email and password."); return; }
    if (signup && password !== confirmPassword) { setAuthMessage(confirmPassword ? "The two passwords don't match. Please type them again." : "Please type your password a second time to confirm it."); return; }
    busyAuthButton();
    try {
      const res = await postJson(signup ? "/auth/signup" : "/auth/login", signup ? { email, password, confirmPassword, name, phone } : { email, password, name, phone });
      const data = await res.json().catch(() => ({}));
      if (data.error) { setAuthMessage(data.error); authResend.hidden = !data.needsConfirmation; resetAuthButton(); return; }
      if (!data.session) {
        // Supabase's "Confirm email" setting is on: the account was created but
        // needs email confirmation before it gets a session.
        if (data.needsConfirmation) {
          setAuthMessage(`Almost there! I sent a confirmation email to ${email}. Enter the 6-digit code from it (or open the link in it) and you'll be signed in. It can take a minute, and it may land in your spam folder.`, true);
          authResend.hidden = false;
          resetAuthButton();
          openEmailCode(email, "signup");
          return;
        }
        setAuthMessage("I couldn't sign you in. Please try again.");
        resetAuthButton();
        return;
      }
      completeSignIn(data, name);
    } catch (err) {
      console.error("Sign-in request failed:", err);
      setAuthMessage(NO_SERVER);
      resetAuthButton();
    }
  }

  // "Forgot password?": Supabase emails a link. The answer is the same whether or not the address has an account.
  async function submitForgot() {
    const email = authEmail.value.trim();
    if (!email) { setAuthMessage("Please type the email address you signed up with."); return; }
    busyAuthButton();
    try {
      const data = await (await postJson("/auth/forgot", { email })).json().catch(() => ({}));
      if (data.error) setAuthMessage(data.error);
      else { setAuthMessage(data.message || "If there's an account for that email, I've sent it a message.", true); resetAuthButton(); openEmailCode(email, "recovery"); return; }
    } catch { setAuthMessage(NO_SERVER); }
    resetAuthButton();
  }

  // "Sign-up email didn't arrive": send it again
  async function resendConfirmation() {
    const email = authEmail.value.trim();
    if (!email) { setAuthMessage("Type your email address above, then ask me to send it again."); return; }
    authResend.disabled = true;
    try {
      const data = await (await postJson("/auth/resend", { email })).json().catch(() => ({}));
      if (data.error) setAuthMessage(data.error);
      else { setAuthMessage(data.message || "I've sent it again.", true); openEmailCode(email, "signup"); }
    } catch { setAuthMessage(NO_SERVER); }
    setTimeout(() => { authResend.disabled = false; }, 30000); // no hammering the button
  }

  // After opening the reset link: oauth-callback.js kept that link's login for THIS tab only (sessionStorage) and sent the person
  // here. It is used for one thing, setting the new password, and only then becomes a normal sign-in.
  const recoveryTokens = () => { try { return JSON.parse(sessionStorage.getItem("agent1102_recovery") || "null"); } catch (_) { return null; } };

  async function submitReset() {
    const rec = recoveryTokens();
    if (!rec || !rec.a) { setMode("forgot"); setAuthMessage(LINK_EXPIRED); return; }
    const password = authPassword.value.trim(), confirmPassword = authConfirm.value.trim();
    if (!password) { setAuthMessage("Please type your new password."); return; }
    if (password !== confirmPassword) { setAuthMessage("The two passwords don't match. Please type them again."); return; }
    busyAuthButton();
    try {
      const res = await postJson("/auth/password", { password, confirmPassword }, rec.a);
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { sessionStorage.removeItem("agent1102_recovery"); setMode("forgot"); setAuthMessage(LINK_EXPIRED); resetAuthButton(); return; }
      if (!res.ok || data.error) { setAuthMessage(data.error || "I couldn't change your password. Please try again."); resetAuthButton(); return; }
      sessionStorage.removeItem("agent1102_recovery");
      agent1102Session.begin(true);
      userToken = rec.a;
      localStorage.setItem("agent1102_token", userToken);
      if (rec.r) localStorage.setItem("agent1102_refresh_token", rec.r);
      setMode("signin"); // so the reset form isn't what's waiting after the next sign-out
      await showApp();
      showToast('<span class="toast-success">Password changed. You\'re signed in. <i class="fa-solid fa-circle-check"></i></span>');
    } catch (err) {
      console.error("Password reset failed:", err);
      setAuthMessage(NO_SERVER);
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
    agent1102CodeDialog.close();         // no code window left open over the sign-in screen
    agent1102CodeDialog.clearVerified(); // and a code accepted in this session doesn't carry over to the next person
    appEl.style.display = "none";
    authScreen.style.display = "flex";
    userToken = null;
    agent1102Session.end(); // removes the saved login
    authStay.checked = agent1102Session.stay(); // the box shows this device's last choice
    authPassword.value = "";
    setAuthMessage("");
    authSubmit.disabled = false; authSubmit.textContent = SUBMIT_TEXT[mode]; // was left on "Loading..." after a successful sign-in
    authConfirm.value = "";
    hidePasswords();
    clearAvatar();
    clearAccountDisplay(); // name and email belong to the account that just left
    closeSettings(); // never leave Settings open on top of the sign-in screen
    agent1102Settings.forgetLoaded(); // and don't keep the last person's AI settings around for the next one
    // easter egg progress belongs to the account, so the next person on this browser starts clean
    if (typeof resetEasterEggs === "function") resetEasterEggs();
  }

  // Where the links in the emails (and a failed Discord/GitHub sign-in) send people back to the page. oauth-callback.js sets these.
  const NOTICES = {
    confirmed: ["Your email is confirmed. You're signed in.", "ok"],
    email_changed: ["Your email address was changed.", "ok"],
    email_pending: ["One more step: open the link I sent to your OTHER address too, and the change will go through.", "info"],
    link_invalid: [LINK_EXPIRED, "error"],
    banned: [BANNED, "error", true], // a Discord / GitHub sign-in for a banned account (true: no "resend the email" button)
  };
  const returningFromResetLink = new URLSearchParams(window.location.search).get("reset") === "1";

  window.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(window.location.search);
    const clean = (...names) => {
      names.forEach(n => params.delete(n));
      const rest = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? "?" + rest : "") + window.location.hash);
    };
    if (params.get("error") === "oauth_failed") {
      setAuthMessage("That sign-in didn't work. Please try again, or sign in with your email and password.");
      clean("error");
    }
    if (returningFromResetLink) {
      clean("reset");
      if (recoveryTokens()) { appEl.style.display = "none"; authScreen.style.display = "flex"; setMode("reset"); }
      else { setMode("forgot"); setAuthMessage(LINK_EXPIRED); }
    }
    const notice = NOTICES[params.get("notice")];
    if (notice) {
      clean("notice");
      const [text, kind, noResend] = notice;
      if (userToken) showToast(agent1102Render.escapeHtml(text));
      else { if (kind === "error") { setMode("signin"); authResend.hidden = !!noResend; } setAuthMessage(text, kind !== "error"); }
    }
  });

  // Wait for DOMContentLoaded so profile.js / chat.js (loaded after this file) are defined
  // before showApp() calls into them. (Not when someone just opened a reset link: they set a new password first.)
  if (userToken && !(returningFromResetLink && recoveryTokens())) window.addEventListener("DOMContentLoaded", showApp);
