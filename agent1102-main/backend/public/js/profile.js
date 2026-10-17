// Profile
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

  // The one place the avatar changes everywhere: header icon, profile-modal preview, and the local cache.
  // Supabase is the source of truth; localStorage only holds the picture's URL so it shows instantly on load.
  function setAvatar(url) {
    if (url) localStorage.setItem("agent1102_avatar", url); else localStorage.removeItem("agent1102_avatar");
    updateProfileIcon(url);
    avatarPreview.src = url || DEFAULT_AVATAR;
  }
  function clearAvatar() { setAvatar(null); }

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
    } catch { /* network error: keep whatever is cached */ }
  }

  profileBtn.addEventListener("click", () => {
    document.getElementById("profile-name").value = localStorage.getItem("agent1102_name") || "";
    document.getElementById("profile-email").value = "";
    document.getElementById("profile-password").value = "";
    hidePasswords();
    profileMsg.textContent = "";
    profileModal.classList.add("open");
  });
  profileClose.addEventListener("click", () => { profileModal.classList.remove("open"); });
  profileModal.addEventListener("click", (e) => { if (e.target === profileModal) profileModal.classList.remove("open"); });

  profileSave.addEventListener("click", async () => {
    const name = document.getElementById("profile-name").value.trim();
    const email = document.getElementById("profile-email").value.trim();
    const password = document.getElementById("profile-password").value.trim();
    profileSave.disabled = true; profileSave.innerHTML = '<i class="fa-solid fa-spinner fa-spin-pulse"></i> Saving...';
    try {
      const res = await fetch(`${BACKEND_URL}/auth/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${userToken}` },
        body: JSON.stringify({ name: name || undefined, email: email || undefined, password: password || undefined }),
      });
      const data = await res.json();
      if (data.error) { profileMsg.style.color = "#e74c3c"; profileMsg.textContent = data.error; }
      else {
        if (name) localStorage.setItem("agent1102_name", name);
        profileMsg.style.color = "#2ecc71"; profileMsg.textContent = "Saved!";
        setTimeout(() => { profileModal.classList.remove("open"); profileMsg.textContent = ""; }, 1500);
      }
    } catch { profileMsg.style.color = "#e74c3c"; profileMsg.textContent = "Something went wrong."; }
    profileSave.disabled = false; profileSave.textContent = "Save";
  });

  profileDelete.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to delete your account? This can't be undone!")) return;
    if (!confirm("Last chance — all your chats will be permanently deleted too. Continue?")) return;
    try {
      const res = await fetch(`${BACKEND_URL}/auth/delete`, { method: "DELETE", headers: { "Authorization": `Bearer ${userToken}` } });
      const data = await res.json();
      if (data.error) { alert("Error: " + data.error); return; }
      localStorage.clear(); showAuth();
    } catch { alert("Something went wrong. Try again."); }
  });

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
    if (!res.ok || data.error) throw new Error(data.error || "Upload failed");
    return data.avatar_url;
  }

  avatarInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type)) { showToast("Only JPG, PNG, and WEBP images are allowed!"); e.target.value = ""; return; }
    if (file.size > AVATAR_MAX_BYTES) { showToast(`File too big! Max ${AVATAR_MAX_BYTES / 1024 / 1024}MB.`); e.target.value = ""; return; }

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
      showToast('<span class="toast-success">Profile picture updated! <i class="fa-solid fa-circle-check"></i></span>');
    } catch (err) {
      console.error("Avatar upload failed:", err);
      setAvatar(previousUrl); // put the old picture back
      URL.revokeObjectURL(localUrl);
      showToast(String(err.message || "Upload failed. Try again.").replace(/&/g, "&amp;").replace(/</g, "&lt;"));
    }
    e.target.value = "";
  });
