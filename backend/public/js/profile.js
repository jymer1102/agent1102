// Profile picture, name and email: shown on the sidebar's Settings button and on Settings -> Profile.
// (The Settings window itself, its pages and its forms live in settings.js.)
  // Inline placeholder shown when a user has no picture (no external image host needed)
  const DEFAULT_AVATAR = "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='#888' fill-opacity='.35'/>" +
    "<circle cx='50' cy='38' r='18' fill='#fff' fill-opacity='.75'/><path d='M14 94c4-22 20-32 36-32s32 10 36 32z' fill='#fff' fill-opacity='.75'/></svg>"
  );

  function updateProfileIcon(src) {
    const icon = document.getElementById("profile-icon");
    const fallback = document.getElementById("profile-icon-fallback");
    if (src) { icon.src = src; icon.style.display = "block"; fallback.style.display = "none"; }
    else { icon.style.display = "none"; fallback.style.display = "block"; }
  }

  const avatarRemoveBtn = document.getElementById("avatar-remove");

  // The one place the avatar changes everywhere: the sidebar's Settings button, the Settings -> Profile preview, and the local cache.
  // Supabase is the source of truth; localStorage only holds the picture's URL so it shows instantly on load.
  function setAvatar(url) {
    if (url) localStorage.setItem("agent1102_avatar", url); else localStorage.removeItem("agent1102_avatar");
    updateProfileIcon(url);
    avatarPreview.src = url || DEFAULT_AVATAR;
    if (avatarRemoveBtn) avatarRemoveBtn.hidden = !url; // the little x only exists when there is a picture to remove
  }
  function clearAvatar() { setAvatar(null); }

  // The name on the Settings button, and the email shown under Settings -> Profile
  function setDisplayName(name) {
    name = String(name || "").trim();
    if (name) localStorage.setItem("agent1102_name", name); else localStorage.removeItem("agent1102_name");
    document.getElementById("settings-name").textContent = name || "Account";
  }
  function setAccountEmail(email) {
    document.getElementById("profile-email-current").textContent = email || "\u2014";
  }
  function clearAccountDisplay() { setDisplayName(""); setAccountEmail(""); }
  setDisplayName(localStorage.getItem("agent1102_name"));

  // Show the cached picture immediately. (Older versions cached the image itself as base64, so only trust real URLs.)
  const savedAvatar = localStorage.getItem("agent1102_avatar");
  setAvatar(savedAvatar && /^https?:/.test(savedAvatar) ? savedAvatar : null);

  // Called on every sign-in / page load: pulls the user's saved picture from Supabase so it follows them to any device.
  async function loadProfile() {
    try {
      const res = await fetch(`${BACKEND_URL}/profile`, { headers: { "Authorization": `Bearer ${userToken}` } });
      if (!res.ok) return; // e.g. offline or no profile row yet: keep whatever is cached
      const { profile } = await res.json();
      setAvatar(profile?.avatar_url || null);
      if (profile?.name) setDisplayName(profile.name);
      setAccountEmail(profile?.email || "");
    } catch { /* network error: keep whatever is cached */ }
  }

  // --- PROFILE PICTURE UPLOAD LOGIC ---
  // The original file is sent to the server untouched (no resizing or re-compression) and stored in Supabase Storage.
  const AVATAR_MAX_BYTES = 10 * 1024 * 1024; // keep in sync with AVATAR_MAX_BYTES in server.js
  const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];

  async function uploadAvatar(file) {
    const res = await fetch(`${BACKEND_URL}/auth/avatar`, {
      method: "POST",
      headers: { "Content-Type": file.type, "Authorization": `Bearer ${userToken}` },
      body: file,
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "I couldn't upload that picture. Please try again.");
    return data.avatar_url;
  }

  avatarInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type)) { showToast("Profile pictures must be JPG, PNG or WEBP images."); e.target.value = ""; return; }
    if (file.size > AVATAR_MAX_BYTES) { showToast(`That picture is too big. Profile pictures can be up to ${AVATAR_MAX_BYTES / 1024 / 1024} MB.`); e.target.value = ""; return; }

    // Show the picture right away from the local file while it uploads
    const previousUrl = localStorage.getItem("agent1102_avatar");
    const localUrl = URL.createObjectURL(file);
    updateProfileIcon(localUrl);
    avatarPreview.src = localUrl;
    showToast('<i class="fa-solid fa-spinner fa-spin-pulse"></i> Uploading profile picture...');

    try {
      const url = await uploadAvatar(file);
      // Remember the saved URL for next time. The UI keeps showing the already-loaded local image,
      // so there's no flicker or second download; every other device / future load uses `url`.
      localStorage.setItem("agent1102_avatar", url);
      if (avatarRemoveBtn) avatarRemoveBtn.hidden = false;
      showToast('<span class="toast-success">Profile picture updated! <i class="fa-solid fa-circle-check"></i></span>');
    } catch (err) {
      console.error("Avatar upload failed:", err);
      setAvatar(previousUrl); // put the old picture back
      URL.revokeObjectURL(localUrl);
      // a failed request (no connection) has the browser's own wording, so only server messages are shown as-is
      const reason = err instanceof TypeError ? "I can't reach the server right now. Check your connection and try again." : err.message;
      showToast(agent1102Render.escapeHtml(reason || "I couldn't upload that picture. Please try again."));
    }
    e.target.value = "";
  });

  // --- REMOVE THE PICTURE (the small x on the preview) ---
  if (avatarRemoveBtn) avatarRemoveBtn.addEventListener("click", async () => {
    if (!confirm("Remove your profile picture?")) return;
    const previousUrl = localStorage.getItem("agent1102_avatar");
    avatarRemoveBtn.disabled = true;
    try {
      const res = await fetch(`${BACKEND_URL}/auth/avatar`, { method: "DELETE", headers: { "Authorization": `Bearer ${userToken}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || "I couldn't remove that picture. Please try again.");
      setAvatar(null);
      showToast('<span class="toast-success">Profile picture removed <i class="fa-solid fa-circle-check"></i></span>');
    } catch (err) {
      setAvatar(previousUrl); // nothing changed on the server, so keep showing the picture
      const reason = err instanceof TypeError ? "I can't reach the server right now. Check your connection and try again." : err.message;
      showToast(agent1102Render.escapeHtml(reason || "I couldn't remove that picture. Please try again."));
    }
    avatarRemoveBtn.disabled = false;
  });
