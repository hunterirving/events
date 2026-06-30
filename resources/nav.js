// Nav mode: tap the compass to request location + orientation, drop a marker at
// the user's position, and follow them heading-up. Panning or pinch-rotating away
// suspends following; after 3s of no interaction the ladybug eases back and follow
// resumes. Touch only - script.js calls this from initMap once rotation is ready.

(function () {
	var LADYBUG = "🐞";
	var FOLLOW_IDLE_MS = 3000;
	var RING_REWIND_MS = 1200; // arc drain on touch; must stay under FOLLOW_IDLE_MS
	var RING_FADE_MS = 200;    // matches the 0.2s #compass box-shadow transition
	var RING_LEAD_MS = 100;    // arc completes a hair early so takeover feels instant
	// ease-in-out with a firm landing: a flat tail reads as lag at takeover
	var RING_FILL_EASE = "cubic-bezier(0.45, 0, 0.6, 0.9)";
	var FOLLOW_ANCHOR_Y = 0.80; // fraction down the panel: leaves room "ahead"
	var NAV_TRANSITION_MS = 900;
	var EASE_TAU_MS = 600;      // dead-reckon correction smoothing (bigger = smoother/laggier)
	var VEL_SMOOTH = 0.5;       // per-fix blend of new velocity into the running estimate
	var MAX_PREDICT_MS = 4000;  // stop extrapolating this long after the last fix
	var SNAP_DIST_M = 500;      // a fix this far from the rendered bug just teleports

	window.initNav = function (map, rotation) {
		var compass = rotation.compass;
		var panel = rotation.panel;
		var ringArc = compass.querySelector(".ring-arc");

		// require an orientation sensor: keeps the compass off desktop touchscreens that
		// can't give a heading.
		if (!("DeviceOrientationEvent" in window)) { return; }
		compass.classList.add("compass-enabled");

		// dedicated pane keeps the ladybug above every event square regardless of z math
		map.createPane("ladybugPane").style.zIndex = 700;

		// Pane for the location->event line, between tilePane (200) and markerPane (600).
		// We position the line ourselves every frame (see renderLine), so it must NOT carry
		// leaflet-zoom-animated, or Leaflet's zoom transform would fight our writes.
		var linePane = map.createPane("linePane");
		linePane.style.zIndex = 250;

		var heading = 0;          // device heading in deg (0 = north)
		var compassOn = false;    // heading-up follow mode
		var compassStarted = false;
		var headingReady = false; // a real reading has arrived
		var pendingEntry = false; // entered nav but waiting for first heading

		var following = false;
		var followIdleTimer = null;
		var navAnim = null;
		var rotAnimating = false;

		var marker = null;        // Leaflet marker for the ladybug
		var lastFix = null;       // { lat, lng, t } latest raw reading
		var vel = { lat: 0, lng: 0 }; // deg/s, smoothed across fixes
		var predictOn = false;
		var watching = false;

		// Line to the active event: a standalone SVG overlay. We reproject
		// the two endpoints every frame via latLngToContainerPoint, so the
		// line stays glued with constant 4px stroke.
		var DRAW_MS = 300;
		var lineSvg = null;
		var lineEl = null;
		var activeTarget = null;  // { latlng, color }
		var drawStart = 0;
		var lineRAF = null;


		// the panel-screen point the ladybug is pinned to while following
		function followAnchorPoint() {
			var r = panel.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height * FOLLOW_ANCHOR_Y };
		}

		function makeIcon() {
			return L.divIcon({
				className: "",
				html: "<div class=\"ladybug-pin\">" + LADYBUG + "</div>",
				iconSize: [40, 40],
				iconAnchor: [20, 20]
			});
		}

		// --- line to active event ---

		function ensureLineSvg() {
			if (lineSvg) { return; }
			var NS = "http://www.w3.org/2000/svg";
			lineSvg = document.createElementNS(NS, "svg");
			lineSvg.setAttribute("class", "ladybug-line-svg");
			lineEl = document.createElementNS(NS, "line");
			lineEl.setAttribute("class", "ladybug-line");
			lineSvg.appendChild(lineEl);
			linePane.appendChild(lineSvg);
		}

		function setLineTarget(latlng, color) {
			ensureLineSvg();
			activeTarget = { latlng: latlng, color: color };
			lineEl.setAttribute("stroke", color);
			drawStart = performance.now();
			lineSvg.classList.add("visible");
			renderLine();
			if (!lineRAF) { lineRAF = requestAnimationFrame(tickLine); }
		}

		function clearLine() {
			activeTarget = null;
			if (lineRAF) { cancelAnimationFrame(lineRAF); lineRAF = null; }
			if (lineSvg) { lineSvg.classList.remove("visible"); }
		}

		// linePane's local space is the map pane's space, offset from the container by the
		// pane's live translation; subtract it to place a container point inside the pane.
		// Grow the visible end from the ladybug toward the event over DRAW_MS.
		function renderLine() {
			if (!activeTarget || !marker || !lineEl) { return; }
			var off = L.DomUtil.getPosition(map.getPane("mapPane")) || L.point(0, 0);
			var ac = map.latLngToContainerPoint(marker.getLatLng());
			var bc = map.latLngToContainerPoint(activeTarget.latlng);
			var a = { x: ac.x - off.x, y: ac.y - off.y };
			var b = { x: bc.x - off.x, y: bc.y - off.y };
			var p = Math.min(1, (performance.now() - drawStart) / DRAW_MS);
			var e = p * p * (3 - 2 * p); // smoothstep
			lineEl.setAttribute("x1", a.x);
			lineEl.setAttribute("y1", a.y);
			lineEl.setAttribute("x2", a.x + (b.x - a.x) * e);
			lineEl.setAttribute("y2", a.y + (b.y - a.y) * e);
		}

		// keeps the line glued during one-finger pan and the ladybug glide (both move the
		// map outside Leaflet's zoom rAF)
		function tickLine() {
			if (!activeTarget || !marker) { clearLine(); return; }
			renderLine();
			lineRAF = requestAnimationFrame(tickLine);
		}

		// two-finger gestures move the map on Leaflet's own rAF; rendering on its move/zoom
		// events puts the line in the same phase as the markers
		map.on("move zoom", renderLine);

		window.navLine = { setTarget: setLineTarget, clear: clearLine };

		// --- following ---

		function startFollowing() {
			following = true;
			clearTimeout(followIdleTimer);
			followIdleTimer = null;
			pinToAnchor();
			if (compassOn) { animateRotation(); }
		}

		function stopFollowing() {
			following = false;
			pendingEntry = false;
			if (navAnim) { cancelAnimationFrame(navAnim); navAnim = null; }
			clearTimeout(followIdleTimer);
			followIdleTimer = null;
		}

		// pan (no animation) so the ladybug lands on the anchor point under the current
		// rotation. Inverting the anchor through the rotation makes the map spin about it.
		function pinToAnchor() {
			if (!following || !marker) { return; }
			var a = followAnchorPoint();
			var target = rotation.clientToStage(a.x, a.y);
			var cur = map.latLngToContainerPoint(marker.getLatLng());
			var dx = cur.x - target.x, dy = cur.y - target.y;
			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) { return; }
			map.panBy([dx, dy], { animate: false });
		}

		// Dead-reckon: extrapolate the last fix along its velocity and ease the rendered
		// position toward that moving target, so the ladybug glides between readings. Fresh
		// fixes steer the target; the ease supplies accel/decel. Extrapolation is capped
		// so a stalled GPS doesn't walk the bug off; once converged the loop idles.
		function startPredict() {
			if (predictOn) { return; }
			predictOn = true;
			var prev = performance.now();
			var step = function (now) {
				if (!marker || !lastFix) { predictOn = false; return; }
				var dt = Math.min(now - prev, 100); // clamp tab-switch gaps
				prev = now;
				var ahead = Math.min(now - lastFix.t, MAX_PREDICT_MS) / 1000;
				var tLat = lastFix.lat + vel.lat * ahead;
				var tLng = lastFix.lng + vel.lng * ahead;
				var cur = marker.getLatLng();
				var k = 1 - Math.exp(-dt / EASE_TAU_MS); // frame-rate independent
				marker.setLatLng([cur.lat + (tLat - cur.lat) * k, cur.lng + (tLng - cur.lng) * k]);
				if (following) { pinToAnchor(); }
				var z = map.getZoom();
				var px = map.project(marker.getLatLng(), z).distanceTo(map.project(L.latLng(tLat, tLng), z));
				var still = Math.hypot(vel.lat, vel.lng) < 1e-7;
				if (px <= 0.5 && (still || now - lastFix.t >= MAX_PREDICT_MS)) { predictOn = false; return; }
				requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		}

		// --- compass ring (suspend/countdown visuals) ---

		var ringFadeTimer = null;
		var ringFillTimer = null;   // delays the refill until fade/rewind lands
		var ringWaitUntil = 0;      // when the in-flight fade or rewind ends

		function ringSet(offset, transition) {
			ringArc.style.transition = transition;
			ringArc.style.strokeDashoffset = offset;
		}

		// snap the arc to empty, flushed so a transition set right after still runs
		function ringReset() {
			clearTimeout(ringFadeTimer);
			ringFadeTimer = null;
			clearTimeout(ringFillTimer);
			ringFillTimer = null;
			ringArc.style.transition = "none";
			ringArc.style.strokeDashoffset = 100;
			ringArc.style.opacity = "";
			void ringArc.getBoundingClientRect();
		}

		// touching the map suspends following (free-look). The countdown is NOT started
		// here (only on release) so holding a finger down keeps control indefinitely.
		function suspendFollow() {
			if (!compassOn) { return; }
			following = false;
			if (navAnim) { cancelAnimationFrame(navAnim); navAnim = null; }
			clearTimeout(followIdleTimer); // a new touch cancels a running countdown
			followIdleTimer = null;
			clearTimeout(ringFadeTimer);
			ringFadeTimer = null;
			clearTimeout(ringFillTimer);
			ringFillTimer = null;
			ringArc.style.opacity = "";
			if (!compass.classList.contains("paused")) {
				// engaged follow: blue ring fades to the grey track; arc regrows later
				compass.classList.add("paused");
				ringSet(100, "none");
				ringWaitUntil = performance.now() + RING_FADE_MS;
			} else if (ringArc.style.strokeDashoffset !== "100") {
				// arc has charge: drain it (a drain already in flight keeps its clock)
				ringSet(100, "stroke-dashoffset " + RING_REWIND_MS + "ms ease-out");
				ringWaitUntil = performance.now() + RING_REWIND_MS;
			}
		}

		// start the countdown once the LAST finger lifts; if fingers remain, keep waiting
		function armEaseBack(e) {
			if (!compassOn) { return; }
			if (e && e.touches && e.touches.length > 0) { return; }
			clearTimeout(followIdleTimer);
			followIdleTimer = setTimeout(easeBack, FOLLOW_IDLE_MS);
			// arc refills in sync with the countdown; let any in-flight fade/rewind land
			// first, landing RING_LEAD_MS early so takeover feels instant
			var wait = Math.max(0, ringWaitUntil - performance.now());
			var dur = FOLLOW_IDLE_MS - wait - RING_LEAD_MS;
			clearTimeout(ringFillTimer);
			if (wait > 0) {
				ringFillTimer = setTimeout(function () {
					ringFillTimer = null;
					ringSet(0, "stroke-dashoffset " + dur + "ms " + RING_FILL_EASE);
				}, wait);
			} else {
				ringReset();
				ringSet(0, "stroke-dashoffset " + dur + "ms " + RING_FILL_EASE);
			}
		}

		// timer fired: the app takes over. The completed arc fades over the same 0.2s the
		// inset ring fades grey->blue.
		function easeBack() {
			followIdleTimer = null;
			compass.classList.remove("paused");
			ringArc.style.transition = "opacity 0.2s ease";
			ringArc.style.opacity = "0";
			clearTimeout(ringFadeTimer);
			ringFadeTimer = setTimeout(ringReset, 200);
			animateToAnchor();
		}

		// glide the ladybug to the anchor AND rotate heading-up together off one ease, then
		// engage following. Re-aims at the LIVE heading every frame so the glide lands with
		// no leftover snap (the heading drifts during the 600ms).
		function animateToAnchor() {
			if (!compassOn) { return; }
			if (navAnim) { cancelAnimationFrame(navAnim); navAnim = null; }
			if (!marker) { startFollowing(); return; }

			var startAngle = rotation.getAngle();
			var dAngle = rotation.normalizeDeg(rotation.normalizeDeg(-heading) - startAngle);
			var t0 = performance.now();
			var ePrev = 0;

			var step = function (now) {
				if (!compassOn) { navAnim = null; return; }
				if (followIdleTimer) { navAnim = null; return; } // user interrupted
				var p = (now - t0) / NAV_TRANSITION_MS;
				if (p >= 1) {
					rotation.setAngle(rotation.normalizeDeg(-heading));
					navAnim = null;
					startFollowing();
					return;
				}
				// keep turning the same way if the target slips across the ±180 seam
				var d = rotation.normalizeDeg(rotation.normalizeDeg(-heading) - startAngle);
				if (d - dAngle > 180) { d -= 360; } else if (dAngle - d > 180) { d += 360; }
				dAngle = d;
				var e = p * p * p * (p * (p * 6 - 15) + 10); // smootherstep
				// move by the fraction of REMAINING distance this step covers, so cumulative
				// progress is exactly `e` (frame-invariant despite panBy shifting the frame)
				var frac = ePrev < 1 ? (e - ePrev) / (1 - ePrev) : 1;
				ePrev = e;
				rotation.setAngle(rotation.normalizeDeg(startAngle + dAngle * e));
				var a = followAnchorPoint();
				var target = rotation.clientToStage(a.x, a.y);
				var cur = map.latLngToContainerPoint(marker.getLatLng());
				map.panBy([(cur.x - target.x) * frac, (cur.y - target.y) * frac], { animate: false });
				navAnim = requestAnimationFrame(step);
			};
			navAnim = requestAnimationFrame(step);
		}

		// --- rotation (heading-up) ---

		// ease stageAngle toward the live heading; runs only while following.
		function animateRotation() {
			if (rotAnimating) { return; }
			rotAnimating = true;
			var step = function () {
				if (!compassOn || !following) { rotAnimating = false; return; }
				var delta = rotation.normalizeDeg(-heading - rotation.getAngle());
				if (Math.abs(delta) < 0.05) {
					rotation.setAngle(rotation.normalizeDeg(-heading));
					pinToAnchor();
					rotAnimating = false;
					return;
				}
				rotation.setAngle(rotation.getAngle() + delta * 0.2); // exp ease
				pinToAnchor(); // re-pin same tick so the ladybug never lags the spin
				requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		}

		// --- orientation ---

		function startCompass() {
			if (compassStarted) { return; }
			compassStarted = true;
			var onReading = function (e) {
				var h;
				if (typeof e.webkitCompassHeading === "number") {
					h = e.webkitCompassHeading; // iOS: deg clockwise from north
				} else if (typeof e.alpha === "number") {
					h = 360 - e.alpha;
				} else {
					return;
				}
				heading = h;
				var first = !headingReady;
				headingReady = true;
				if (first && pendingEntry) { pendingEntry = false; animateToAnchor(); return; }
				if (compassOn) { animateRotation(); }
			};
			window.addEventListener("deviceorientationabsolute", onReading, true);
			window.addEventListener("deviceorientation", onReading, true);
		}

		function requestOrientationPermission() {
			var DOE = window.DeviceOrientationEvent;
			if (DOE && typeof DOE.requestPermission === "function") {
				return DOE.requestPermission().then(function (s) { return s === "granted"; }).catch(function () { return false; });
			}
			return Promise.resolve(true);
		}

		// --- location ---

		map.on("locationfound", function (e) {
			var now = performance.now();
			var firstFix = !marker;
			if (firstFix) {
				marker = L.marker(e.latlng, { icon: makeIcon(), interactive: false, pane: "ladybugPane" }).addTo(map);
				// fade in: add .visible next frame so the opacity transition runs from 0
				var pin = marker._icon && marker._icon.querySelector(".ladybug-pin");
				if (pin) { requestAnimationFrame(function () { pin.classList.add("visible"); }); }
				// event already selected before location came on: draw the line now
				var active = window.getActiveEvent && window.getActiveEvent();
				if (active) { setLineTarget(active.latlng, active.color); }
			} else {
				var dt = (now - lastFix.t) / 1000;
				if (map.distance(e.latlng, marker.getLatLng()) >= SNAP_DIST_M) {
					// huge jump (first good fix after a bad one): no glide across town
					vel.lat = 0;
					vel.lng = 0;
					marker.setLatLng(e.latlng);
					if (following) { pinToAnchor(); }
				} else if (dt >= 10) {
					// stale gap: old velocity means nothing
					vel.lat = 0;
					vel.lng = 0;
				} else if (dt > 0.05) {
					// velocity from the last two fixes drives the dead-reckoner; blending
					// damps jitter (sub-50ms bursts keep the running value)
					vel.lat += ((e.latlng.lat - lastFix.lat) / dt - vel.lat) * VEL_SMOOTH;
					vel.lng += ((e.latlng.lng - lastFix.lng) / dt - vel.lng) * VEL_SMOOTH;
				}
			}
			lastFix = { lat: e.latlng.lat, lng: e.latlng.lng, t: now };
			if (!firstFix) { startPredict(); }
			// first fix: ease from the current view to the anchored ladybug rather than
			// hard-jumping. animateToAnchor pans relative to the marker, so just engaging
			// it (once a heading is ready) gives the fly-in for free.
			if (firstFix && compassOn) {
				if (headingReady) { animateToAnchor(); }
				else { pendingEntry = true; }
			}
		});

		function startWatching() {
			if (watching) { return; }
			watching = true;
			map.locate({ watch: true, enableHighAccuracy: true, maximumAge: 10000 });
		}

		// --- compass tap (enter/exit nav mode) ---
		function enterNav() {
			requestOrientationPermission().then(function (ok) {
				if (!ok) { return; } // orientation denied: stay off
				startCompass();
				startWatching();
				compassOn = true;
				compass.classList.remove("paused");
				ringReset();
				compass.classList.add("active");
				// ease to anchor + rotate heading-up together; defer to the first reading
				// if none yet, so it rotates too (not move-then-rotate)
				if (headingReady) { animateToAnchor(); }
				else { pendingEntry = true; }
			});
		}

		function exitNav() {
			compassOn = false;
			compass.classList.remove("active", "paused");
			ringReset();
			stopFollowing();
			// angle holds where it is - no snap back to north
		}

		compass.style.pointerEvents = "auto"; // CSS sets none; nav makes it tappable
		compass.style.cursor = "pointer";
		compass.addEventListener("click", function () {
			if (compassOn) { exitNav(); } else { enterNav(); }
		});

		// a map gesture in nav mode is a free-look: suspend on touchdown, start the
		// ease-back only once the finger(s) release
		var mapEl = map.getContainer();
		mapEl.addEventListener("touchstart", suspendFollow, { passive: true });
		mapEl.addEventListener("touchend", armEaseBack, { passive: true });
		mapEl.addEventListener("touchcancel", armEaseBack, { passive: true });

		// selecting an event counts as an interaction: suspend follow so the pan plays
		// out, then restart the countdown. No-op outside nav mode (compassOn guards).
		window.navInteract = function () {
			suspendFollow();
			armEaseBack();
		};
	};
})();
