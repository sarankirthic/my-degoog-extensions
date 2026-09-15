(() => {
  function setActiveTab(root, mode) {
    root.querySelectorAll("[data-dgm-filter]").forEach((btn) => {
      const active = btn.getAttribute("data-dgm-filter") === mode;
      btn.classList.toggle("dgm-tab-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    root.querySelectorAll("[data-dgm-panel]").forEach((panel) => {
      panel.hidden = panel.getAttribute("data-dgm-panel") !== mode;
    });
    selectFirstVisibleRoute(root);
  }

  function selectFirstVisibleRoute(root) {
    const visiblePanel = root.querySelector("[data-dgm-panel]:not([hidden])");
    const firstCard = visiblePanel?.querySelector("[data-dgm-route]");
    if (firstCard) selectRoute(root, firstCard);
  }

  let leafletPromise = null;
  let mapInstance = null;
  let currentTileLayer = null;

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
      const script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = resolve;
      document.head.appendChild(script);
    });
    return leafletPromise;
  }

  async function selectRoute(root, card) {
    root.querySelectorAll(".dgm-route-selected").forEach((c) => c.classList.remove("dgm-route-selected"));
    card.classList.add("dgm-route-selected");

    const mapKey = card.getAttribute("data-map-key");
    const template = root.querySelector(`template[data-dgm-map-template="${mapKey}"]`);
    const frame = root.querySelector("[data-dgm-map-frame]");
    if (!frame || !template) return;

    const cloned = template.content.cloneNode(true);
    const mapDiv = cloned.querySelector(".dgm-leaflet-map") || cloned.querySelector(".dgm-map-empty");
    frame.innerHTML = "";
    frame.appendChild(cloned);
    if (!mapDiv || !mapDiv.classList.contains("dgm-leaflet-map")) return;

    const geom = JSON.parse(mapDiv.getAttribute("data-geom") || "[]");
    const tileUrl = mapDiv.getAttribute("data-tile-url") || "";
    if (!geom.length || !tileUrl) return;

    await loadLeaflet();
    const L = window.L;
    if (!L) return;

    if (mapInstance) {
      try { mapInstance.remove(); } catch (_) {}
      mapInstance = null;
    }

    const mapId = "dgm-leaflet-" + Date.now();
    mapDiv.id = mapId;
    mapDiv.style.height = "300px";
    mapDiv.style.width = "100%";
    mapDiv.style.borderRadius = "14px";

    mapInstance = L.map(mapId, { scrollWheelZoom: false, zoomControl: true });
    currentTileLayer = L.tileLayer(tileUrl, { maxZoom: 19, attribution: "OSM / Mappls" }).addTo(mapInstance);

    const latlngs = geom;
    if (latlngs.length > 1) {
      const polyline = L.polyline(latlngs, { color: "#2563eb", weight: 5, opacity: 0.8 }).addTo(mapInstance);
      L.circleMarker(latlngs[0], { radius: 8, color: "#fff", fillColor: "#2563eb", fillOpacity: 1, weight: 3 })
        .addTo(mapInstance)
        .bindTooltip("Start");
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 8, color: "#fff", fillColor: "#0f766e", fillOpacity: 1, weight: 3 })
        .addTo(mapInstance)
        .bindTooltip("End");
      mapInstance.fitBounds(polyline.getBounds(), { padding: [30, 30] });
    }

    setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 100);
    setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 400);
  }

  function init(root) {
    if (root.dataset.dgmReady === "true") return;
    root.dataset.dgmReady = "true";

    root.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-dgm-filter]");
      if (tab) { setActiveTab(root, tab.getAttribute("data-dgm-filter") || "all"); return; }
      const card = event.target.closest("[data-dgm-route]");
      if (card && !event.target.closest("a,button,details")) selectRoute(root, card);
    });

    root.addEventListener("keydown", (event) => {
      const card = event.target.closest("[data-dgm-route]");
      if (card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        selectRoute(root, card);
      }
    });

    selectFirstVisibleRoute(root);
  }

  function initAll() {
    document.querySelectorAll("[data-dgm-root]").forEach(init);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initAll);
  else initAll();
  new MutationObserver(initAll).observe(document.documentElement, { childList: true, subtree: true });
})();
