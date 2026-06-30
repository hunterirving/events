// Right panel: title/body/RSVP text, its color-shift + character-by-character typing, and
// which event is selected. map.js calls selectEvent / deselectEvent on taps; nav.js reads
// window.getActiveEvent and draws the location->event line via window.navLine.

(function () {
	var fmt = window.fmt;

	var intro = {
		color: "antiquewhite",
		title: "Upcoming Events"
	};
	// flipped on by setIntroData when there are no upcoming events: the intro lists the
	// most-recently-passed events under a "Past Events" heading instead.
	var pastMode = false;

	var rightBox = document.getElementById("right-box");
	var themeColorMeta = document.querySelector('meta[name="theme-color"]');
	var titleEl = document.getElementById("text-title");
	var contentEl = document.getElementById("text-content");
	var actionWrap = document.getElementById("action-wrap");
	var swapTimer = null;
	var linkTimer = null;
	var typeRaf = null;
	var currentEvent = null;
	var activePin = null; // .event-pin element of the selected marker (square -> circle)
	var introEvents = []; // upcoming events for the intro table, soonest first
	var introDataReady = false; // true once map.js hands over the events (post-fetch)
	var selectFromIntro = null; // map.js's selectMarker, so table rows can activate an event
	var introListEl = null; // the current intro grid, so fitIntroColumns can re-measure on resize

	function introTitle() { return pastMode ? "Past Events" : intro.title; }

	var CHAR_MS = readMs("--type-char-ms");

	function readMs(name) {
		var raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		var ms = parseFloat(raw);
		return /s$/.test(raw) && !/ms$/.test(raw) ? ms * 1000 : ms;
	}

	function clearTyping() {
		if (typeRaf !== null) { cancelAnimationFrame(typeRaf); typeRaf = null; }
	}

	// Lay the full text in up front, split into a "shown" span and a trailing "hidden"
	// (visibility:hidden) span. Layout/wrapping/height are final from frame one, so typing
	// only moves the boundary
	function prepTyped(el, text) {
		el.textContent = "";
		var shown = document.createElement("span");
		var hidden = document.createElement("span");
		hidden.className = "type-hidden";
		hidden.textContent = text;
		el.appendChild(shown);
		el.appendChild(hidden);
		return { shown: shown, hidden: hidden, text: text };
	}

	function typeStream(segments) {
		var prepped = segments.map(function (seg) {
			// flat segments (RSVP labels) already reserve width via a CSS sizer; flowing
			// body text gets the split-span treatment to pre-reserve wrapping + height
			var p = seg.flat
				? { shown: seg.el, hidden: null, text: seg.text }
				: prepTyped(seg.el, seg.text);
			// list marker stays hidden until this segment's first char reveals
			p.markerEl = seg.markerEl || null;
			return p;
		});
		// total time scales with text length; progress through it is smoothstep-eased.
		// rAF-driven (one reflow/frame) so CHAR_MS can sit below the ~1ms timer floor.
		var total = prepped.reduce(function (n, s) { return n + s.text.length; }, 0);
		var duration = total * CHAR_MS;
		var start = null;
		function frame(now) {
			if (start === null) { start = now; }
			var t = duration > 0 ? Math.min(1, (now - start) / duration) : 1;
			var eased = t * t * (3 - 2 * t); // smoothstep: zero velocity at both ends
			var revealed = Math.min(total, Math.round(eased * total));
			var n = revealed;
			prepped.forEach(function (s) {
				var len = s.text.length;
				var c = n <= 0 ? 0 : (n >= len ? len : n);
				s.shown.textContent = s.text.slice(0, c);
				if (s.hidden) { s.hidden.textContent = s.text.slice(c); }
				if (s.markerEl && c > 0) { s.markerEl.classList.add("li-typing"); }
				n -= len;
			});
			typeRaf = revealed < total ? requestAnimationFrame(frame) : null;
		}
		typeRaf = requestAnimationFrame(frame);
		return duration;
	}

	// Build the event's .ics in memory and trigger a download. On iOS, tapping the file
	// offers "Add to Calendar"; desktop drops it in Downloads.
	function downloadICS(m) {
		if (!m) { return; }
		var blob = new Blob([fmt.icsContent(m)], { type: "text/calendar;charset=utf-8" });
		var url = URL.createObjectURL(blob);
		var a = document.createElement("a");
		a.href = url;
		a.download = fmt.icsFilename(m);
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(function () { URL.revokeObjectURL(url); }, 0);
	}

	var canShare = typeof navigator.share === "function";

	// "Copy Link" -> "Copied Link!" feedback: swap instantly, hold, swap back
	function flashCopied(a) {
		a.textContent = "Copied Link!";
		a._copyTimer = setTimeout(function () {
			a.textContent = "Copy Link";
			a._copyTimer = null;
		}, 3000);
	}

	var LINKS = [
		{ text: "RSVP by E-mail", onClick: function (_a, m) { window.location.href = fmt.mailtoHref(m); } },
		{ text: "Add to Calendar", onClick: function (a, m) { downloadICS(m); } },
		// maps:// via location.href: the OS intercepts the scheme and the page stays put,
		// so no orphaned about:blank tab. https links still get a real tab.
		{ text: "Get Directions", onClick: function (a, m) {
			var href = fmt.directionsHref(m);
			if (href.indexOf("maps:") === 0) { window.location.href = href; }
			else { window.open(href, "_blank"); }
		} },
		{ text: canShare ? "Share Link" : "Copy Link", onClick: function (a, m) {
			var url = fmt.eventUrl(m);
			if (canShare) {
				navigator.share({ url: url }).catch(function () {});
			} else if (navigator.clipboard && !a._copyTimer) {
				navigator.clipboard.writeText(url);
				flashCopied(a);
			}
		} },
		// on Safari this opens a printable PDF in a new tab instead of the print dialog
		window.flyer.enabled ? { text: "Print Flyer", onClick: function (a, m) { window.flyer.print(m); } } : null,
	].filter(Boolean);

	function buildLinkRows() {
		actionWrap.innerHTML = "";
		return LINKS.map(function (def) {
			var row = document.createElement("div");
			row.className = "action-row";

			var box = document.createElement("span");
			box.className = "action-link action-typing";

			var sizer = document.createElement("span");
			sizer.className = "action-sizer";
			sizer.textContent = def.text;

			var shown = document.createElement("span");
			shown.className = "action-shown";

			box.appendChild(sizer);
			box.appendChild(shown);
			row.appendChild(box);
			actionWrap.appendChild(row);

			return { el: shown, row: row, def: def };
		});
	}

	// Build the detail <ul> inside #text-content and return its <li>s for typing. Each <li>
	// carries its text on ._text; the marker + hanging indent come from CSS.
	function buildDetailList(items) {
		var ul = document.createElement("ul");
		ul.className = "detail-list";
		contentEl.appendChild(ul);
		return items.map(function (text) {
			var li = document.createElement("li");
			li._text = text;
			ul.appendChild(li);
			return li;
		});
	}

	// Build the intro's upcoming-events table and return the segments to type (one per
	// cell). Rows are clickable. No events -> a single "No upcoming events." line. A flex
	// list of <div>s (not a <table>) so columns collapse cleanly.
	function buildIntroList() {
		introListEl = null;
		if (!introEvents.length) {
			var p = document.createElement("p");
			contentEl.appendChild(p);
			return [{ el: p, text: pastMode ? "No past events." : "No upcoming events." }];
		}

		var list = document.createElement("div");
		list.className = "intro-list";
		contentEl.appendChild(list);
		introListEl = list;

		var segments = [];
		introEvents.forEach(function (m) {
			var row = document.createElement("div");
			row.className = "intro-row";
			row.addEventListener("click", function () {
				if (selectFromIntro) { selectFromIntro(m, true); }
			});

			// each cell types into a child span so its final width is reserved (prepTyped)
			[
				{ text: m.title, cls: "intro-name" },
				{ text: fmt.shortDate(m, pastMode), cls: "intro-when" },
				{ text: m.venue, cls: "intro-where" }
			].forEach(function (col) {
				var cell = document.createElement("div");
				cell.className = col.cls;
				var span = document.createElement("span");
				cell.appendChild(span);
				row.appendChild(cell);
				segments.push({ el: span, text: col.text });
			});

			list.appendChild(row);
		});

		return segments;
	}

	// True if any title cell is clipped at the current column layout. With date + location
	// held rigid, a long title (or a title squeezed by them) ellipsizes here, which is the
	// signal to shed a column.
	function titleClipped() {
		var cells = introListEl.querySelectorAll(".intro-name");
		for (var i = 0; i < cells.length; i++) {
			if (cells[i].scrollWidth - cells[i].clientWidth > 1) { return true; }
		}
		return false;
	}

	// Shed columns by priority until the title fits: drop the date (.cols-2), then the
	// location (.cols-1). Re-measured on build and on container resize. Reading scrollWidth
	// forces the reflow between steps.
	function fitIntroColumns() {
		if (!introListEl || !introListEl.isConnected) { return; }
		introListEl.classList.remove("cols-2", "cols-1");
		if (titleClipped()) {
			introListEl.classList.add("cols-2");
			if (titleClipped()) { introListEl.classList.add("cols-1"); }
		}
	}

	function swapLinks(links) {
		links.forEach(function (link) {
			var def = link.def;
			var a = document.createElement("a");
			a.className = "action-link";
			a.textContent = def.text;
			if (def.href) {
				a.href = def.href(currentEvent);
			} else {
				a.href = "#";
				a.addEventListener("click", function (e) {
					e.preventDefault();
					def.onClick(a, currentEvent);
				});
			}
			link.row.replaceChild(a, link.row.firstChild);
		});
	}

	// Round the active pin into a circle (and square the previous one back) via a class.
	function setActivePin(m) {
		if (activePin) { activePin.classList.remove("active"); }
		activePin = null;
		var icon = m && m._marker && m._marker._icon;
		var pin = icon && icon.querySelector(".event-pin");
		if (pin) { pin.classList.add("active"); activePin = pin; }
	}

	function selectEvent(m) {
		if (m === currentEvent) { return; } // already viewing it; don't retype
		currentEvent = m;
		setActivePin(m);
		// draw the location->event line (no-op unless nav mode dropped a ladybug)
		if (window.navLine) { window.navLine.setTarget(L.latLng(m.latitude, m.longitude), m.color); }
		transitionTo(m.color, function () {
			var links = buildLinkRows();
			// description types into its own <p>, then each detail <li> as its own segment
			var para = document.createElement("p");
			contentEl.appendChild(para);
			var details = buildDetailList(fmt.detailItems(m, true));
			var segments = [
				{ el: titleEl, text: m.title },
				{ el: para, text: m.description }
			];
			details.forEach(function (li) {
				segments.push({ el: li, text: li._text, markerEl: li });
			});
			links.forEach(function (link) {
				segments.push({ el: link.el, text: link.def.text, flat: true });
			});
			var duration = typeStream(segments);
			// once the whole stream finishes, make the links clickable
			linkTimer = setTimeout(function () {
				swapLinks(links);
			}, duration);
		});
	}

	// nav.js asks for this on its first location fix: if an event is already selected, it
	// draws the line to it immediately.
	window.getActiveEvent = function () {
		if (!currentEvent) { return null; }
		return { latlng: L.latLng(currentEvent.latitude, currentEvent.longitude), color: currentEvent.color };
	};

	// Background tap deselects and types the intro back in.
	function deselectEvent() {
		if (currentEvent === null) { return; } // already showing the intro
		currentEvent = null;
		setActivePin(null);
		if (window.navLine) { window.navLine.clear(); }
		transitionTo(intro.color, function () {
			var segments = [{ el: titleEl, text: introTitle() }];
			typeStream(segments.concat(buildIntroList()));
			fitIntroColumns();
		});
	}

	// Drive the panel background and the iOS Safari top/bottom bars off one color so the
	// bars track the selected event.
	function setEventColor(color) {
		// :root so the body strips (overscroll/safe-area) and the panel both pick it up
		document.documentElement.style.setProperty("--event-color", color);
		if (themeColorMeta) themeColorMeta.setAttribute("content", color);
	}

	// Shared transition: shift color, fade the text out, then run `paint` once faded.
	function transitionTo(color, paint) {
		clearTimeout(swapTimer);
		clearTimeout(linkTimer);
		clearTyping();

		setEventColor(color);
		titleEl.classList.add("fading");
		contentEl.classList.add("fading");
		actionWrap.classList.add("fading");

		swapTimer = setTimeout(function () {
			contentEl.textContent = "";
			actionWrap.innerHTML = "";
			// reset scroll now (old text faded + cleared) so the prior event never flashes back
			rightBox.scrollTop = 0;

			titleEl.classList.remove("fading");
			contentEl.classList.remove("fading");
			actionWrap.classList.remove("fading");

			paint();
		}, 125);
	}

	// Intro fully shown (no typing). used on root page load, where typing is skipped.
	function paintIntro() {
		setEventColor(intro.color);
		titleEl.textContent = introTitle();
		contentEl.textContent = "";
		actionWrap.innerHTML = "";
		if (!introDataReady) { return; } // pre-fetch: title only, no table yet
		buildIntroList().forEach(function (seg) { seg.el.textContent = seg.text; });
		fitIntroColumns();
	}

	// map.js hands over the upcoming events (soonest first) + selectMarker, before the
	// first paintIntro / deselect, so the table can build from real data.
	function setIntroData(events, selectFn, past) {
		introEvents = events;
		selectFromIntro = selectFn;
		pastMode = !!past;
		introDataReady = true;
	}

	// Set the panel color up front (before any text paints) so a deep-linked event shows in
	// its own color instead of fading in from antiquewhite. Zero the color-shift duration
	// for this one set so it snaps, then restore.
	function presetEventColor(m) {
		var root = document.documentElement;
		root.style.setProperty("--color-shift-ms", "0ms");
		setEventColor(m.color);
		void root.offsetWidth; // force reflow so the instant set lands before restore
		root.style.removeProperty("--color-shift-ms");
	}

	// Re-fit the intro columns when the panel changes width (rotation, window resize).
	if (typeof ResizeObserver === "function") {
		new ResizeObserver(fitIntroColumns).observe(rightBox);
	}

	window.panel = {
		selectEvent: selectEvent,
		deselectEvent: deselectEvent,
		paintIntro: paintIntro,
		setIntroData: setIntroData,
		presetEventColor: presetEventColor,
		// the event currently shown, or null on the intro (lets flyer.js print on Cmd+P)
		getSelectedEvent: function () { return currentEvent; }
	};
})();
