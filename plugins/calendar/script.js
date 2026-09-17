(function () {
  // __PLUGIN_ID__ is injected by Degoog at serve time — never hardcode the
  // folder name, since a Store install uses <author>-<repo>-<plugin-name>.
  const API_BASE = `/api/plugin/${__PLUGIN_ID__}`;

  function onDeleteClick(event) {
    const button = event.target.closest(".calendar-plugin__delete");
    if (!button) return;
    const id = button.dataset.eventId;
    if (!id) return;

    button.disabled = true;
    fetch(`${API_BASE}/events?id=${encodeURIComponent(id)}`, { method: "DELETE" })
      .then((res) => {
        if (!res.ok) throw new Error(`delete failed: ${res.status}`);
        const item = button.closest(".calendar-plugin__item");
        if (item) item.remove();
      })
      .catch((err) => {
        console.error("[calendar plugin] delete failed", err);
        button.disabled = false;
      });
  }

  document.addEventListener("click", onDeleteClick);
})();
