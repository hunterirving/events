// The MapLibre map: event markers, the compass wiring for the rotate gesture, and the
// loader for vendored MapLibre GL. Taps forward to window.panel; rotation is handed to
// window.initNav.

(function () {
	var fmt = window.fmt;

	var events = [];
	var map = null;
	var IS_TOUCH = window.matchMedia("(pointer: coarse)").matches;

	function panEase(t) { return 1 - Math.pow(1 - t, 5); }

	// Average lat/long of all events, so the page opens framing the events (no location
	// permission until the compass is tapped). Fallback: Seattle.
	function eventsCenter() {
		if (!events.length) { return [-122.3321, 47.6062]; }
		var lat = 0, lng = 0;
		events.forEach(function (m) { lat += m.latitude; lng += m.longitude; });
		return [lng / events.length, lat / events.length];
	}

	// If the URL carries ?<slug>, open that event. Returns true if it selected one.
	function selectFromUrl(select) {
		var m = fmt.eventFromUrl(events);
		if (!m) { return false; }
		select(m, false);
		return true;
	}

	// Rewrite the address bar to the event's deep link (no reload / history entry), so the
	// app keeps its single-page feel: Back leaves the app rather than showing the last
	// event you viewed.
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

		try {
			map = new maplibregl.Map({
				container: "map-container",
				style: "resources/basemap/style.json",
				center: eventsCenter(),
				zoom: 11.5,
				maxZoom: 19,
				attributionControl: false,
				doubleClickZoom: false,
				keyboard: false,
				scrollZoom: false,
				dragRotate: false,
				pitchWithRotate: false,
				touchPitch: false
			});
		} catch (e) {
			mapFailed();
			return;
		}

		map.getCanvas().setAttribute("tabindex", "-1");

		map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
		initAttribution();

		var endWheelGesture = initSmoothWheel();

		map.on("click", function () { window.panel.deselectEvent(); clearUrl(); });

		// container may have been sized after init; force a recalc
		setTimeout(function () {
			if (map) { map.resize(); }
		}, 200);

		function makeIcon(m) {
			var d = fmt.parseLocal(m.start);
			var el = document.createElement("div");
			el.setAttribute("role", "presentation");
			el.setAttribute("aria-label", "");
			el.innerHTML = "<a class=\"event-pin\" href=\"" + fmt.eventUrl(m) + "\" style=\"background:" + m.color + "\">" +
				"<span class=\"pin-month\">" + fmt.MONTH_ABBR[d.getMonth()] + "</span>" +
				"<span class=\"pin-day\">" + d.getDate() + "</span>" +
				"</a>";
			return el;
		}

		// seed z by date (events sorted soonest-first) so soonest sit on top at load;
		// topEventZ starts above every seed so the first tap still lifts over all
		var topEventZ = events.length;

		// Lift the event, type its panel, recenter - shared by marker taps and deep links.
		function selectMarker(m, animate) {
			endWheelGesture();
			m._el.style.zIndex = ++topEventZ;
			window.panel.selectEvent(m);
			syncUrl(m);
			// nav mode: stop following so the pan isn't fought + restart the ease-back
			if (window.navInteract) { window.navInteract(); }
			var center = [m.longitude, m.latitude];
			if (animate) { map.easeTo({ center: center, duration: 700, easing: panEase }); }
			else { map.jumpTo({ center: center }); }
		}

		events.forEach(function (m, i) {
			var el = makeIcon(m);
			el.style.zIndex = events.length - i;
			new maplibregl.Marker({ element: el, anchor: "center" })
				.setLngLat([m.longitude, m.latitude])
				.addTo(map);
			m._el = el; // so panel.js can reach this pin's DOM
			el.querySelector(".event-pin").addEventListener("click", function (e) {
				e.stopPropagation();
				// modified clicks (new tab/window) fall through to the anchor's native nav;
				// plain clicks + keyboard Enter select in-page instead of navigating
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) { return; }
				e.preventDefault();
				selectMarker(m, true);
			});
		});

		window.panel.setIntroData(events, selectMarker, pastMode);

		// deep-linked? open it. otherwise show intro.
		if (!selectFromUrl(selectMarker)) { window.panel.paintIntro(); }

		if (IS_TOUCH) {
			var rotation = initRotate();
			if (window.initNav) { window.initNav(map, rotation); }
		}
	}

	// Desktop wheel/trackpad. scrollZoom reads every wheel event as zoom, but a trackpad
	// two-finger scroll should pan, so discriminate on the delta shape and lock the mode
	// for the gesture's life.
	function initSmoothWheel() {
		var el = map.getCanvasContainer();
		var mode = null; // "pinch" | "wheel" | "pan" while a gesture is in flight
		var goalZoom = 0, anchor = null;
		var rafId = null, idleTimer = null;

		function step() {
			var zoom = map.getZoom() + (goalZoom - map.getZoom()) * 0.3;
			map.easeTo({ zoom: zoom, around: anchor, duration: 0 });
			rafId = requestAnimationFrame(step);
		}

		// end whichever gesture is in flight
		function settle() {
			clearTimeout(idleTimer);
			mode = null;
			if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
		}

		el.addEventListener("mousedown", settle);

		function armIdle() {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(settle, 200);
		}

		function containerPoint(clientX, clientY) {
			var r = el.getBoundingClientRect();
			return [clientX - r.left, clientY - r.top];
		}

		function beginZoom(clientX, clientY) {
			anchor = map.unproject(containerPoint(clientX, clientY));
			if (rafId === null) {
				map.stop();
				goalZoom = map.getZoom();
				rafId = requestAnimationFrame(step);
			}
			armIdle();
		}

		function looksLikeMouse(e) {
			if (e.deltaMode !== 0) { return true; }
			return typeof e.wheelDeltaY === "number" && e.wheelDeltaY !== 0 && e.wheelDeltaY % 120 === 0;
		}

		function clampZoom(z) {
			return Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), z));
		}

		el.addEventListener("wheel", function (e) {
			e.preventDefault();
			var next;
			if (e.ctrlKey) { next = "pinch"; }
			else if (mode === "pan" || mode === "wheel") { next = mode; } // locked while in flight
			else { next = looksLikeMouse(e) ? "wheel" : "pan"; }
			if (mode !== null && next !== mode) { settle(); }
			mode = next;
			if (mode === "pan") {
				map.panBy([e.deltaX, e.deltaY], { duration: 0 });
				armIdle();
			} else {
				beginZoom(e.clientX, e.clientY);
				var dy = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY; // line deltas (firefox mice) -> px
				goalZoom = clampZoom(goalZoom - dy * (mode === "pinch" ? 0.01 : 0.003));
			}
		}, { passive: false });

		// Safari desktop fires gesture* events with a cumulative scale instead of
		// ctrl+wheel. Touch devices also have GestureEvent - skip them for native pinch.
		if (!IS_TOUCH && "GestureEvent" in window) {
			var gestureBaseZoom = 0;
			el.addEventListener("gesturestart", function (e) {
				e.preventDefault();
				if (mode !== null && mode !== "pinch") { settle(); }
				mode = "pinch";
				beginZoom(e.clientX, e.clientY);
				gestureBaseZoom = goalZoom;
			});
			el.addEventListener("gesturechange", function (e) {
				e.preventDefault();
				if (rafId === null) { return; }
				goalZoom = clampZoom(gestureBaseZoom + Math.log2(e.scale));
				anchor = map.unproject(containerPoint(e.clientX, e.clientY));
				armIdle();
			});
			el.addEventListener("gestureend", function (e) { e.preventDefault(); });
		}

		return settle;
	}

	function initAttribution() {
		var el = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
		if (!el) { return; }
		var button = el.querySelector(".maplibregl-ctrl-attrib-button");

		function shown() { return el.classList.contains("maplibregl-compact-show"); }

		function setShown(show) {
			el.classList.toggle("maplibregl-compact-show", show);
			if (show) { el.setAttribute("open", ""); } else { el.removeAttribute("open"); }
		}

		if (button) {
			el.addEventListener("click", function (e) {
				if (!button.contains(e.target)) { return; }
				e.preventDefault();
				e.stopPropagation();
				setShown(!shown());
			}, true);
		}

		document.addEventListener("click", function (e) {
			if (button && button.contains(e.target)) { return; }
			if (shown()) { setShown(false); }
		}, true);

		function collapse() {
			if (!el.classList.contains("maplibregl-compact")) { return; } // no text yet
			setShown(false);
			map.off("sourcedata", collapse);
			map.off("styledata", collapse);
		}
		map.on("sourcedata", collapse);
		map.on("styledata", collapse);
		collapse();
	}

	// Mirrors the bearing onto the compass needle and exposes the interface nav.js
	// drives.
	function initRotate() {
		var container = map.getContainer();
		var panel = document.getElementById("left-box");
		var compass = document.getElementById("compass");

		// Tapping a pin partly outside the viewport makes iOS Safari "reveal" it by
		// auto-scrolling the container (despite overflow:hidden). Snap any such scroll back
		// to origin. The reveal may move #left-box or the document, so neutralize both;
		// the root scroller emits on window.
		function pinScroll(eventTarget, scroller) {
			eventTarget.addEventListener("scroll", function () {
				if (scroller.scrollLeft || scroller.scrollTop) { scroller.scrollTo(0, 0); }
			}, { passive: true });
		}
		pinScroll(panel, panel);
		var root = document.scrollingElement || document.documentElement;
		pinScroll(window, root);

		function normalizeDeg(d) {
			return ((d + 180) % 360 + 360) % 360 - 180;
		}

		function getAngle() { return normalizeDeg(-map.getBearing()); }
		function setAngle(deg) { map.setBearing(-deg); }

		// needle turns with the map so red keeps pointing to true north
		function syncCompass() {
			compass.style.setProperty("--compass-angle", getAngle() + "deg");
		}
		map.on("rotate", syncCompass);
		syncCompass();

		// screen point -> map container coords
		function clientToStage(clientX, clientY) {
			var r = container.getBoundingClientRect();
			return { x: clientX - r.left, y: clientY - r.top };
		}

		// interface consumed by nav.js
		return {
			panel: panel,
			compass: compass,
			getAngle: getAngle,
			setAngle: setAngle,
			clientToStage: clientToStage,
			normalizeDeg: normalizeDeg
		};
	}

	function mapFailed() {
		var el = document.getElementById("map-container");
		el.className = "map-error";
		el.textContent = "Unable to load map.";
	}

	// MapLibre is vendored under resources/maplibre/ so the map works offline from first load.
	function loadMapLibre() {
		if (window.maplibregl) { initMap(); return; }
		var s = document.createElement("script");
		s.src = "resources/maplibre/maplibre-gl.js";
		s.onload = function () { window.maplibregl ? initMap() : mapFailed(); };
		s.onerror = mapFailed;
		document.body.appendChild(s);
	}

	window.eventsMap = {
		setEvents: function (data) { events = data; },
		load: loadMapLibre
	};
})();
