// ============================================================
//  Tables in answers (including tables read out of photos and scans) get "Copy CSV" and "Download CSV".
// ============================================================
(function () {
  "use strict";

  // Spreadsheets run text that starts with = or @ (and + or - followed by a letter) as a formula; defuse it.
  const safe = v => (/^[=@]/.test(v) || /^[+\-][^\d.\s]/.test(v)) ? "'" + v : v;
  const cell = v => { v = safe(String(v).replace(/\s+/g, " ").trim()); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

  function tableToCsv(table) {
    return [...table.querySelectorAll("tr")].map(tr => [...tr.children].map(td => cell(td.textContent)).join(",")).join("\r\n");
  }

  function button(icon, label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "msg-action-btn";
    b.style.cssText = "width:auto;padding:0.2rem 0.55rem;gap:0.35rem;font-size:0.75rem;";
    b.innerHTML = `<i class="fa-solid ${icon}"></i> <span></span>`;
    b.querySelector("span").textContent = label;
    b.addEventListener("click", () => onClick(b));
    return b;
  }

  function enhance(root) {
    root.querySelectorAll(".msg-content-body .table-wrap:not([data-csv])").forEach(wrap => {
      wrap.setAttribute("data-csv", "1");
      const table = wrap.querySelector("table");
      if (!table || table.rows.length < 2) return;
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;gap:0.25rem;margin:-0.4rem 0 0.6rem;";
      bar.appendChild(button("fa-copy", "Copy CSV", async b => {
        try { await navigator.clipboard.writeText(tableToCsv(table)); b.classList.add("copied"); setTimeout(() => b.classList.remove("copied"), 1200); }
        catch (_) { if (typeof showToast === "function") showToast("I couldn't copy that. Your browser blocked it."); }
      }));
      bar.appendChild(button("fa-download", "Download CSV", () => {
        const blob = new Blob(["\uFEFF" + tableToCsv(table)], { type: "text/csv;charset=utf-8" }); // BOM so Excel reads accents correctly
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `agent1102-table-${Date.now()}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }));
      wrap.after(bar);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const chat = document.getElementById("chat");
    if (!chat) return;
    enhance(chat);
    new MutationObserver(() => enhance(chat)).observe(chat, { childList: true, subtree: true });
  });

  window.agent1102Tables = { tableToCsv };
})();
