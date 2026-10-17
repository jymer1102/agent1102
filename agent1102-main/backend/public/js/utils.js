// Toast
  function showToast(msg) {
  const toast = document.createElement("div");
  toast.style.cssText = "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#2f6feb;color:white;padding:0.6rem 1.2rem;border-radius:12px;font-size:0.9rem;z-index:9999;animation:fadeout 0.3s ease 2.7s forwards";
  
  toast.innerHTML = msg; 
  
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}


// Show / hide password: every <button class="pw-toggle"> sits next to its password <input>
// inside a .pw-wrap. Delegated, so any password field added later works automatically.
function setPasswordVisible(toggle, show) {
  const field = toggle.parentElement.querySelector("input");
  if (!field) return;
  field.type = show ? "text" : "password";
  const label = show ? "Hide password" : "Show password";
  toggle.setAttribute("aria-pressed", String(show));
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  toggle.innerHTML = '<i class="fa-solid ' + (show ? "fa-eye-slash" : "fa-eye") + '"></i>';
}
function hidePasswords() { document.querySelectorAll(".pw-toggle").forEach(t => setPasswordVisible(t, false)); }
// keep the caret in the text box when the eye is clicked
document.addEventListener("mousedown", (e) => { if (e.target.closest(".pw-toggle")) e.preventDefault(); });
document.addEventListener("click", (e) => {
  const toggle = e.target.closest(".pw-toggle");
  if (!toggle) return;
  const field = toggle.parentElement.querySelector("input");
  if (field) setPasswordVisible(toggle, field.type === "password");
});
