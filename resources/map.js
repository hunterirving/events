// The Leaflet map: event markers, the rotate gesture engine (#map-stage spun as a unit,
// since Leaflet 1.x can't rotate its own panes), and the loader for vendored Leaflet +
// the NoGap tile layer. Taps forward to window.panel; rotation is handed to window.initNav.

(function () {
	var fmt = window.fmt;

	var events = [];
	var map = null;
	var IS_TOUCH = window.matchMedia("(pointer: coarse)").matches;
	var stageAngle = 0; // current map rotation in degrees, set by the rotate gesture

	// Average lat/long of all events, so the page opens framing the events (no location
	// permission until the compass is tapped). Fallback: Seattle.
	function eventsCenter() {
		if (!events.length) { return [47.6062, -122.3321]; }
		var lat = 0, lng = 0;
		events.forEach(function (m) { lat += m.latitude; lng += m.longitude; });
		return [lat / events.length, lng / events.length];
	}

	// If the URL carries ?<slug>, open that event. Returns true if it selected one.
	function selectFromUrl(select) {
		var m = fmt.eventFromUrl(events);
		if (!m) { return false; }
		select(m, false);
		return true;
	}

	// Rewrite the address bar to the event's deep link (no reload / history entry).
	function syncUrl(m) {
		if (window.history && history.replaceState) {
			history.replaceState(null, "", fmt.eventUrl(m));
		}
	}

	function clearUrl() {
		if (window.history && history.replaceState && window.location.search) {
			history.replaceState(null, "", window.location.pathname);
		}
	}

	function initMap() {
		// snapshot "now" once so marker filtering, z-ordering, and the intro all agree
		var now = new Date();
		// soonest first; passed events removed. With nothing upcoming, fall back to the
		// 10 most-recently-ended events (most recent first) so the map isn't empty.
		var upcoming = fmt.upcomingEvents(events, now);
		var pastMode = upcoming.length === 0;
		events = pastMode ? fmt.pastEvents(events, now, 10) : upcoming;

		map = L.map("map-container", { attributionControl: false, doubleClickZoom: false, zoomControl: false, scrollWheelZoom: false, keyboard: false, maxZoom: 19, bounceAtZoomLimits: false, zoomSnap: 0 }).setView(eventsCenter(), 12.5);

		// CartoDB tile scale matching display density for crisp tiles. Hardcoded (not
		// detectRetina, which shifts zoom and shrinks labels). carto serves up to @4x.
		var dpr = window.devicePixelRatio || 1;
		var scale = dpr >= 4 ? "@4x" : dpr >= 3 ? "@3x" : dpr >= 2 ? "@2x" : "";
		var carto = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}" + scale + ".png", {
			attribution: "",
			subdomains: "abcd",
			maxZoom: 19,
			// NoGap canvas spans keepBuffer; at full DPR each canvas is ratio² in memory,
			// so a small buffer keeps it under Safari's renderer limit (default 2)
			keepBuffer: 1
		});

		carto.addTo(map);

		var mapEl = map.getContainer();
		map.on("mousedown", function () { mapEl.classList.add("map-grabbing"); });
		document.addEventListener("mouseup", function () { mapEl.classList.remove("map-grabbing"); });

		initSmoothWheel();

		// background tap (not a marker, not a drag/hold) deselects; Leaflet's "click"
		// fires only for genuine background taps
		map.on("click", function () { window.panel.deselectEvent(); clearUrl(); });

		// container may have been sized after init; force a recalc
		setTimeout(function () {
			if (map) { map.invalidateSize(); }
		}, 200);

		function makeIcon(m) {
			var d = fmt.parseLocal(m.start);
			return L.divIcon({
				className: "",
				html: "<div class=\"event-pin\" style=\"background:" + m.color + "\">" +
					"<span class=\"pin-month\">" + fmt.MONTH_ABBR[d.getMonth()] + "</span>" +
					"<span class=\"pin-day\">" + d.getDate() + "</span>" +
					"</div>",
				iconSize: [48, 48],
				iconAnchor: [24, 24]
			});
		}

		// Leaflet bakes a latitude term into each marker's z-index, and that spread can
		// exceed a +1 step, so bump by a large amount to guarantee the newest tap wins.
		var Z_STEP = 10000;
		// seed z by date (events sorted soonest-first) so soonest sit on top at load;
		// topEventZ starts above every seed so the first tap still lifts over all
		var topEventZ = (events.length + 1) * Z_STEP;

		// Lift the event, type its panel, recenter - shared by marker taps and deep links.
		function selectMarker(m, animate) {
			topEventZ += Z_STEP;
			m._marker.setZIndexOffset(topEventZ);
			window.panel.selectEvent(m);
			syncUrl(m);
			// nav mode: stop following so the pan isn't fought + restart the ease-back
			if (window.navInteract) { window.navInteract(); }
			// low easeLinearity bends the default pan into a clear ease-in-out
			map.panTo([m.latitude, m.longitude], { animate: animate, duration: 0.7, easeLinearity: 0.1 });
		}

		events.forEach(function (m, i) {
			var marker = L.marker([m.latitude, m.longitude], { icon: makeIcon(m) }).addTo(map);
			marker.setZIndexOffset((events.length - i) * Z_STEP);
			m._marker = marker; // so selectEvent can reach this pin's DOM
			marker.on("click", function () { selectMarker(m, true); });
		});

		window.panel.setIntroData(events, selectMarker, pastMode);

		// deep-linked? open it. otherwise show intro.
		if (!selectFromUrl(selectMarker)) { window.panel.paintIntro(); }

		if (IS_TOUCH) {
			var rotation = initRotate();
			if (window.initNav) { window.initNav(map, rotation); }
		}
	}

	// Desktop wheel/trackpad. Leaflet's stock scrollWheelZoom debounces and steps, which
	// feels sluggish; instead ease map._move() toward a goal zoom every frame (the touch
	// pinch path) anchored under the cursor, and pan via _rawPanBy so markers ride along
	// (_move only re-renders layers on zoom change). zoomSnap 0 lets fractional zoom flow.
	function initSmoothWheel() {
		var el = map.getContainer();
		var mode = null; // "pinch" | "wheel" | "pan" while a gesture is in flight
		var goalZoom = 0, cursorPoint = null, centerPoint = null, anchorLatLng = null;
		var rafId = null, idleTimer = null, moved = false, panning = false;
		var prevCenter = null, prevZoom = 0;

		function step() {
			// something else moved the map (marker panTo, drag) - yield to it
			if (moved && (!map.getCenter().equals(prevCenter) || map.getZoom() !== prevZoom)) {
				clearTimeout(idleTimer);
				settle();
				return;
			}
			var zoom = map.getZoom() + (goalZoom - map.getZoom()) * 0.3;
			// keep the latlng under the cursor fixed while zooming
			var center = map.unproject(map.project(anchorLatLng, zoom).subtract(cursorPoint.subtract(centerPoint)), zoom);
			if (!moved) { map._moveStart(true, false); moved = true; }
			map._move(center, zoom);
			prevCenter = map.getCenter();
			prevZoom = map.getZoom();
			rafId = requestAnimationFrame(step);
		}

		// end whichever gesture is in flight so tiles settle and moveend fires
		function settle() {
			mode = null;
			if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
			if (moved) { moved = false; map._moveEnd(true); }
			if (panning) { panning = false; map.fire("moveend"); }
		}

		function armIdle() {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(settle, 200);
		}

		function beginZoom(clientX, clientY) {
			if (rafId === null) {
				map._stop();
				goalZoom = map.getZoom();
				centerPoint = map.getSize().divideBy(2);
				cursorPoint = map.mouseEventToContainerPoint({ clientX: clientX, clientY: clientY });
				anchorLatLng = map.containerPointToLatLng(cursorPoint);
				rafId = requestAnimationFrame(step);
			}
			armIdle();
		}

		function looksLikeMouse(e) {
			if (e.deltaMode !== 0) { return true; }
			return typeof e.wheelDeltaY === "number" && e.wheelDeltaY !== 0 && e.wheelDeltaY % 120 === 0;
		}

		el.addEventListener("wheel", function (e) {
			e.preventDefault();
			var next;
			if (e.ctrlKey) { next = "pinch"; }
			else if (mode === "pan" || mode === "wheel") { next = mode; } // locked while in flight
			else { next = looksLikeMouse(e) ? "wheel" : "pan"; }
			if (mode !== null && next !== mode) { clearTimeout(idleTimer); settle(); }
			mode = next;
			if (mode === "pan") {
				if (!panning) { panning = true; map.fire("movestart"); }
				map._rawPanBy(L.point(e.deltaX, e.deltaY));
				map.fire("move");
				armIdle();
			} else {
				beginZoom(e.clientX, e.clientY);
				var dy = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY; // line deltas (firefox mice) -> px
				goalZoom = map._limitZoom(goalZoom - dy * (mode === "pinch" ? 0.01 : 0.003));
				cursorPoint = map.mouseEventToContainerPoint(e);
			}
		}, { passive: false });

		// Safari desktop fires gesture* events with a cumulative scale instead of
		// ctrl+wheel. Touch devices also have GestureEvent - skip them for native pinch.
		if (!IS_TOUCH && "GestureEvent" in window) {
			var gestureBaseZoom = 0;
			el.addEventListener("gesturestart", function (e) {
				e.preventDefault();
				if (mode !== null && mode !== "pinch") { clearTimeout(idleTimer); settle(); }
				mode = "pinch";
				beginZoom(e.clientX, e.clientY);
				gestureBaseZoom = goalZoom;
			});
			el.addEventListener("gesturechange", function (e) {
				e.preventDefault();
				if (rafId === null) { return; }
				goalZoom = map._limitZoom(gestureBaseZoom + Math.log2(e.scale));
				cursorPoint = map.mouseEventToContainerPoint(e);
				armIdle();
			});
			el.addEventListener("gestureend", function (e) { e.preventDefault(); });
		}
	}

	// Rotate the whole #map-stage (oversized to the panel diagonal) via a CSS transform
	// and patch Leaflet's coordinate math so its native pinch-zoom/pan still land. Touch only.
	function initRotate() {
		var stage = document.getElementById("map-stage");
		var panel = document.getElementById("left-box");
		var compass = document.getElementById("compass");

		// Tapping a marker in the rotated stage's clipped corner makes iOS Safari "reveal"
		// it by auto-scrolling the container (despite overflow:hidden), shifting the stage
		// off-center. Snap any such scroll back to origin. The reveal may move #left-box or
		// the document, so neutralize both; the root scroller emits on window.
		function pinScroll(eventTarget, scroller) {
			eventTarget.addEventListener("scroll", function () {
				if (scroller.scrollLeft || scroller.scrollTop) { scroller.scrollTo(0, 0); }
			}, { passive: true });
		}
		pinScroll(panel, panel);
		var root = document.scrollingElement || document.documentElement;
		pinScroll(window, root);

		// square of the panel's diagonal so a rotated map never exposes the corners
		function sizeStage() {
			var w = panel.clientWidth, h = panel.clientHeight;
			var diag = Math.ceil(Math.hypot(w, h));
			stage.style.width = diag + "px";
			stage.style.height = diag + "px";
			applyStageTransform();
			map.invalidateSize();
		}

		// stage is anchored at the panel center (top/left 50%); translate by half its size
		// to center, then rotate (translate before rotate so the pivot is the panel center)
		function applyStageTransform() {
			var half = (parseFloat(stage.style.width) || 0) / 2;
			stage.style.transform = "translate(" + (-half) + "px, " + (-half) + "px) rotate(" + stageAngle + "deg)";
			// pins counter-rotate so their date text stays upright
			stage.style.setProperty("--pin-counter", (-stageAngle) + "deg");
			// needle turns with the map so red keeps pointing to true north
			compass.style.setProperty("--compass-angle", stageAngle + "deg");
		}

		function normalizeDeg(d) {
			return ((d + 180) % 360 + 360) % 360 - 180;
		}

		// invert the stage rotation about the panel center to map a screen point into
		// stage-local coords (getBoundingClientRect gives only the axis-aligned box)
		function clientToStage(clientX, clientY) {
			var r = panel.getBoundingClientRect();
			var cx = r.left + r.width / 2;
			var cy = r.top + r.height / 2;
			var rad = (-stageAngle * Math.PI) / 180;
			var dx = clientX - cx, dy = clientY - cy;
			var rx = dx * Math.cos(rad) - dy * Math.sin(rad);
			var ry = dx * Math.sin(rad) + dy * Math.cos(rad);
			var half = (parseFloat(stage.style.width) || 0) / 2;
			return { x: rx + half, y: ry + half };
		}

		// Leaflet derives container coords from the bounding rect, wrong once rotated.
		map.mouseEventToContainerPoint = function (e) {
			var p = clientToStage(e.clientX, e.clientY);
			return L.point(p.x, p.y);
		};

		// one-finger pan: Leaflet computes the delta in raw screen px, so rotate it by
		// -stageAngle so the map tracks the finger.
		var _dragUpdate = L.Draggable.prototype._updatePosition;
		L.Draggable.prototype._updatePosition = function () {
			if (stageAngle && this._startPos && this._newPos) {
				var rad = (-stageAngle * Math.PI) / 180;
				var cos = Math.cos(rad), sin = Math.sin(rad);
				var dx = this._newPos.x - this._startPos.x;
				var dy = this._newPos.y - this._startPos.y;
				this._newPos = this._startPos.add(L.point(dx * cos - dy * sin, dx * sin + dy * cos));
			}
			_dragUpdate.call(this);
		};

		// a panel touch sliding onto the map is handed off by iOS as a fresh map touchstart;
		// flag gestures starting outside the stage so the drag below can refuse it
		var panelGesture = false;
		var panelGestureEnded = 0;
		document.addEventListener("touchstart", function (e) {
			if (!stage.contains(e.target)) { panelGesture = true; }
		}, { passive: true, capture: true });
		function endPanelGesture(e) {
			if (e.touches.length === 0 && panelGesture) {
				panelGesture = false;
				panelGestureEnded = Date.now();
			}
		}
		document.addEventListener("touchend", endPanelGesture, { passive: true, capture: true });
		document.addEventListener("touchcancel", endPanelGesture, { passive: true, capture: true });

		// the rotated ancestor inflates the pane's bounding box, so Leaflet's cached
		// "parent scale" is bogus and distorts the drag. Force it to 1:1.
		var _dragDown = L.Draggable.prototype._onDown;
		L.Draggable.prototype._onDown = function (e) {
			if (panelGesture || Date.now() - panelGestureEnded < 250) { return; }
			_dragDown.call(this, e);
			if (this._parentScale) { this._parentScale = { x: 1, y: 1 }; }
		};

		// --- two-finger rotate, layered on Leaflet's native pinch ---
		var ROTATE_DEADZONE = 8; // deg of twist before rotation engages
		var rotGesture = null;

		function fingerAngle(t0, t1) {
			return Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX) * 180 / Math.PI;
		}

		// A one-finger touch landing while a zoom animates is dropped (Leaflet won't route
		// to the drag handler until the anim ends), so end the in-flight zoom at the
		// earliest capture point. _stop() doesn't cancel the zoom anim; _onZoomTransitionEnd
		// clears _animatingZoom. Capture phase so it runs first.
		stage.addEventListener("touchstart", function (e) {
			if (e.touches.length === 1 && map._animatingZoom) {
				map._onZoomTransitionEnd();
			}
		}, { passive: true, capture: true });

		stage.addEventListener("touchstart", function (e) {
			// rotation allowed in nav mode too; nav.js treats a manual twist as free-look
			if (e.touches.length === 2) {
				rotGesture = { startAngle: fingerAngle(e.touches[0], e.touches[1]), engaged: false, baseAngle: stageAngle };
			}
		}, { passive: true });

		stage.addEventListener("touchmove", function (e) {
			if (!rotGesture || e.touches.length !== 2) { return; }
			var cur = fingerAngle(e.touches[0], e.touches[1]);
			var twist = normalizeDeg(cur - rotGesture.startAngle);
			if (!rotGesture.engaged) {
				if (Math.abs(twist) < ROTATE_DEADZONE) { return; } // dead-zone keeps pure pinch from rotating
				rotGesture.engaged = true;
				rotGesture.startAngle = cur; // take accumulated twist as the new zero so it doesn't jump
				rotGesture.baseAngle = stageAngle;
				twist = 0;
			}
			stageAngle = normalizeDeg(rotGesture.baseAngle + twist);
			applyStageTransform();
		}, { passive: true });

		function endRotate(e) {
			if (rotGesture && e.touches.length < 2) { rotGesture = null; }
		}
		stage.addEventListener("touchend", endRotate);
		stage.addEventListener("touchcancel", endRotate);

		window.addEventListener("resize", sizeStage);
		sizeStage();

		// interface consumed by nav.js
		return {
			stage: stage,
			panel: panel,
			compass: compass,
			getAngle: function () { return stageAngle; },
			setAngle: function (deg) { stageAngle = deg; applyStageTransform(); },
			applyTransform: applyStageTransform,
			clientToStage: clientToStage,
			normalizeDeg: normalizeDeg
		};
	}

	function mapFailed() {
		var el = document.getElementById("map-container");
		el.className = "map-error";
		el.textContent = "Unable to load map.";
	}

	// NoGap composites each level's tiles onto one <canvas> so fractional zoom has no
	// per-tile seams. Loads after Leaflet (extends L.TileLayer); init regardless of failure.
	function loadNoGapThenInit() {
		var s = document.createElement("script");
		s.src = "resources/leaflet/leaflet-nogap.js";
		s.onload = initMap;
		s.onerror = initMap;
		document.body.appendChild(s);
	}

	// Leaflet is vendored under resources/leaflet/ so the map works offline from first load.
	function loadLeaflet() {
		if (window.L) { loadNoGapThenInit(); return; }
		var s = document.createElement("script");
		s.src = "resources/leaflet/leaflet.js";
		s.onload = function () { window.L ? loadNoGapThenInit() : mapFailed(); };
		s.onerror = mapFailed;
		document.body.appendChild(s);
	}

	window.eventsMap = {
		setEvents: function (data) { events = data; },
		load: loadLeaflet
	};
})();
