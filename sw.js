// Caches the app shell (so it works offline) and map tiles (so panning/zooming
// reuses previously-viewed tiles instead of refetching). Leaflet is vendored in
// the shell, so map tiles are the only remaining network dependency.

const SHELL_CACHE = "app-shell-v8";
const TILE_CACHE = "map-tiles-v1"; // CORS fetches so the cached responses aren't opaque
const KEEP = new Set([SHELL_CACHE, TILE_CACHE]);

// Every file the app needs to boot with no network.
const SHELL = [
	"./",
	"index.html",
	"manifest.json",
	"resources/icon.png",
	"resources/format.js",
	"resources/qr.js",
	"resources/pdf.js",
	"resources/flyer.js",
	"resources/panel.js",
	"resources/map.js",
	"resources/app.js",
	"resources/nav.js",
	"resources/styles.css",
	"resources/leaflet/leaflet-nogap.js",
	"resources/demo.json",
	"resources/leaflet/leaflet.js",
	"resources/leaflet/leaflet.css",
];

// Real (gitignored) data; overrides demo.json when present, but often absent. Cached
// best-effort so a 404 can't fail the install — the app boots fine on demo.json alone.
const OPTIONAL = ["resources/events.json"];

self.addEventListener("install", (e) => {
	self.skipWaiting();
	// Atomic precache of the shell: any failure rejects, so the prior shell cache
	// survives a bad install. waitUntil resolves only once the full shell is cached,
	// so activate won't drop the old version until this one is complete.
	e.waitUntil(caches.open(SHELL_CACHE).then((cache) =>
		cache.addAll(SHELL).then(() =>
			Promise.all(OPTIONAL.map((u) => cache.add(u).catch(() => {})))
		)
	));
});

self.addEventListener("activate", (e) => e.waitUntil(
	Promise.all([
		self.clients.claim(),
		// drop old cache versions (e.g. superseded shells/tiles)
		caches.keys().then((keys) => Promise.all(
			keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))
		)),
	])
));

function isCacheableTile(url) {
	return url.hostname.endsWith("basemaps.cartocdn.com"); // map tiles
}

// network-first for same-origin app files: fresh when online, cached when not,
// so edits show up on reload but the app still boots offline.
async function shellResponse(request) {
	const cache = await caches.open(SHELL_CACHE);
	try {
		const resp = await fetch(request);
		if (resp.ok) cache.put(request, resp.clone());
		return resp;
	} catch {
		const hit = await cache.match(request) || await cache.match("index.html");
		if (hit) return hit;
		throw new Error("offline and not cached");
	}
}

// cache-first for map tiles: serve a cached copy instantly, else fetch and store.
async function tileResponse(url) {
	const cache = await caches.open(TILE_CACHE);
	const hit = await cache.match(url.href);
	if (hit) return hit;
	const resp = await fetch(url.href, { mode: "cors", credentials: "omit" });
	if (resp.ok) cache.put(url.href, resp.clone());
	return resp;
}

self.addEventListener("fetch", (event) => {
	if (event.request.method !== "GET") return;
	const url = new URL(event.request.url);

	if (isCacheableTile(url)) {
		event.respondWith(tileResponse(url));
		return;
	}
	// same-origin navigations + assets -> app shell
	if (url.origin === self.location.origin) {
		event.respondWith(shellResponse(event.request));
	}
});
