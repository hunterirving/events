// Print-only flyer for the selected event. Most browsers get a print-CSS DOM flyer +
// window.print; Safari stamps a non-removable header/footer on printed web content, so
// there the flyer is drawn into a vector PDF (pdf.js) and opened in a new tab.

(function () {
	var SVG_NS = "http://www.w3.org/2000/svg";
	var TAB_COUNT = 10;
	var QUIET = 0; // no baked-in quiet zone

	// Safari (desktop/iOS) but not the other browsers whose UA also carries "Safari".
	// Safari takes the PDF path; the print CSS swap stays gated off (.flyer-print).
	var isSafari = /Safari/.test(navigator.userAgent) &&
		!/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);
	if (!isSafari) { document.documentElement.classList.add("flyer-print"); }

	var flyerEl = null;
	var building = false; // guards against the link + beforeprint paths double-building

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) { n.className = cls; }
		if (text != null) { n.textContent = text; }
		return n;
	}

	// QR for `text` as an <svg> `mm` square. Dark modules merge into per-row run rects.
	function qrSvg(text, mm) {
		var matrix = window.qr.createMatrix(text);
		var n = matrix.length;
		var total = n + QUIET * 2;

		var svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("viewBox", "0 0 " + total + " " + total);
		svg.setAttribute("width", mm + "mm");
		svg.setAttribute("height", mm + "mm");
		svg.setAttribute("shape-rendering", "crispEdges");
		svg.classList.add("flyer-qr");

		var bg = document.createElementNS(SVG_NS, "rect");
		bg.setAttribute("width", total);
		bg.setAttribute("height", total);
		bg.setAttribute("fill", "#fff");
		svg.appendChild(bg);

		for (var r = 0; r < n; r++) {
			var c = 0;
			while (c < n) {
				if (!matrix[r][c]) { c++; continue; }
				var start = c;
				while (c < n && matrix[r][c]) { c++; }
				var rect = document.createElementNS(SVG_NS, "rect");
				rect.setAttribute("x", start + QUIET);
				rect.setAttribute("y", r + QUIET);
				rect.setAttribute("width", c - start);
				rect.setAttribute("height", 1);
				rect.setAttribute("fill", "#000");
				svg.appendChild(rect);
			}
		}
		return svg;
	}

	// .flyer-flow (the fitFlow-sized element) holds a floated QR the description wraps around.
	function buildBody(m) {
		var body = el("div", "flyer-body");
		body.appendChild(el("h1", "flyer-title", m.title));

		var flow = el("div", "flyer-flow");
		flow.appendChild(qrSvg(window.fmt.eventUrl(m), QR_BODY)); // max-size; fitQr shrinks to the line grid
		flow.appendChild(el("p", "flyer-desc", m.description));
		var ul = el("ul", "flyer-details");
		window.fmt.detailItems(m).forEach(function (line) {
			ul.appendChild(el("li", null, line));
		});
		flow.appendChild(ul);
		body.appendChild(flow);

		return body;
	}

	function buildTab(m) {
		var inner = el("div", "flyer-tab-inner");
		var text = el("div", "flyer-tab-text");
		text.appendChild(el("div", "flyer-tab-title", m.title));
		text.appendChild(el("div", "flyer-tab-when", window.fmt.startLine(m)));
		text.appendChild(el("div", "flyer-tab-where", m.venue));
		inner.appendChild(text);
		inner.appendChild(qrSvg(window.fmt.eventUrl(m), 16));
		return inner;
	}

	function buildTabs(m) {
		var tabs = el("div", "flyer-tabs");
		var template = buildTab(m);
		for (var i = 0; i < TAB_COUNT; i++) {
			var tab = el("div", "flyer-tab");
			tab.appendChild(template.cloneNode(true));
			tabs.appendChild(tab);
		}
		return tabs;
	}

	// Tabs are identical: fit the first's text and copy the font-size to the rest.
	function fitTabs(tabsEl) {
		var inners = tabsEl.querySelectorAll(".flyer-tab-inner");
		if (!inners.length) { return; }
		var inner = inners[0];
		var text = inner.querySelector(".flyer-tab-text");
		// transforms don't affect layout: the rotated tab lays out in its unrotated frame
		var maxH = inner.clientHeight;
		var lo = 6, hi = 16;
		while (lo < hi) {
			var mid = Math.ceil((lo + hi) / 2);
			inner.style.fontSize = mid + "pt";
			if (text.offsetHeight <= maxH) { lo = mid; } else { hi = mid - 1; }
		}
		var size = lo + "pt";
		for (var i = 0; i < inners.length; i++) { inners[i].style.fontSize = size; }
	}

	// White leading inside a line box, in em: Times metrics (ascent .683, descent .217,
	// caps .662) with CSS half-leading. Page gaps are equalized as ink, so each margin
	// is widened by the leading of the line boxes facing it.
	function leadBelow(lineHeight) { return (lineHeight - 0.9) / 2 + 0.217; }
	function leadAbove(lineHeight) { return (lineHeight - 0.9) / 2 + 0.683 - 0.662; }

	// Largest QR (<= 42mm) whose float band ends on the flow's line grid (0.2mm short so
	// rounding can't re-narrow the boundary line), so the first full-width line clears
	// the float at the same 7mm gutter the text gets. Text size beats QR size.
	function alignedQrMm(lineHmm) {
		var n = Math.floor((2 + QR_BODY + 7) / lineHmm);
		return n * lineHmm - (2 + 7) - 0.2;
	}

	// Run after fitFlow: shrinking the float only frees space, so the fitted size still fits.
	function fitQr(flow) {
		var qr = flow.querySelector(".flyer-qr");
		var size = alignedQrMm(parseFloat(flow.style.fontSize) * 1.3 * 25.4 / 96); // CSS px -> mm
		qr.setAttribute("width", size + "mm");
		qr.setAttribute("height", size + "mm");
	}

	// Largest quarter-px font-size at which the flow fits maxH. The flow is a stretched
	// flex child, so collapse the stretch (flex:none, height:auto) to measure content.
	function fitFlow(flow, maxH) {
		flow.style.flex = "none";
		flow.style.height = "auto";
		flow.style.lineHeight = "1.3";
		var lo = 32, hi = 256; // quarter-px units
		while (lo < hi) {
			var mid = Math.ceil((lo + hi) / 2);
			flow.style.fontSize = mid / 4 + "px";
			if (flow.getBoundingClientRect().height <= maxH) { lo = mid; } else { hi = mid - 1; }
		}
		flow.style.fontSize = lo / 4 + "px";
		flow.style.flex = "";
		flow.style.height = "";
	}

	// Build the flyer for `m`, size its body text to fit, open the print dialog. Lays out
	// offscreen at the print width first so measurements reflect true print layout.
	function build(m) {
		flyerEl = document.getElementById("flyer");
		if (!flyerEl) { return; }
		flyerEl.textContent = "";

		var body = buildBody(m);
		var tabs = buildTabs(m);
		flyerEl.appendChild(body);
		flyerEl.appendChild(tabs);

		flyerEl.classList.add("flyer-measuring");
		var flow = body.querySelector(".flyer-flow");
		var title = body.querySelector(".flyer-title");
		var titleStyle = getComputedStyle(title);
		// avail height from the rendered title block, not the flex-stretched flow box
		var titleBlock = title.getBoundingClientRect().height +
			parseFloat(titleStyle.marginTop) + parseFloat(titleStyle.marginBottom);
		var flyerH = flyerEl.getBoundingClientRect().height;
		var tabsH = tabs.getBoundingClientRect().height;
		var maxH = flyerH - tabsH - titleBlock;
		fitFlow(flow, Math.max(maxH, 0));

		// Equalize the three page gaps as ink (see leadBelow/leadAbove): comp is the net
		// height the widened margins cost beyond 7mm; if positive, refit with it reserved.
		var titlePx = parseFloat(titleStyle.fontSize);
		function gapComp(f) { return (leadBelow(1.3) + leadAbove(1.3)) * f - leadBelow(1.05) * titlePx; }
		var fs = parseFloat(flow.style.fontSize);
		var comp = gapComp(fs);
		if (comp > 0) {
			fitFlow(flow, Math.max(maxH - comp, 0));
			fs = parseFloat(flow.style.fontSize);
			comp = gapComp(fs);
		}
		fitQr(flow);

		// leftover slack split a third per gap; measured after fitQr frees wrapped lines
		flow.style.flex = "none";
		flow.style.height = "auto";
		var s3 = Math.max(maxH - comp - flow.getBoundingClientRect().height, 0) / 3;
		flow.style.flex = "";
		flow.style.height = "";
		var b7 = 7 * 96 / 25.4; // 7mm base in px
		title.style.marginBottom = (b7 + s3 + leadBelow(1.3) * fs - leadBelow(1.05) * titlePx) + "px";
		var ul = flow.querySelector(".flyer-details");
		ul.style.marginTop = (b7 + s3) + "px";
		ul.style.marginBottom = (b7 + s3 + leadAbove(1.3) * fs) + "px";

		fitTabs(tabs);

		flyerEl.classList.remove("flyer-measuring");
	}

	// ---- PDF path (Safari) ----
	// Mirrors the DOM flyer's CSS in flyer-local mm with a top-left origin; px()/py()
	// are the only crossing into PDF points (origin bottom-left, y-up).

	var MM = 72 / 25.4; // mm -> pt
	var PAGE_W = 215.9, PAGE_H = 279.4; // US Letter
	var BOX_W = 197.3, BOX_H = 266.7; // flyer box (shared Letter/A4 safe area)
	var BOX_X = (PAGE_W - BOX_W) / 2, BOX_Y = 6.35; // centered, 6.35mm top margin
	var TABS_H = 78, TAB_W = BOX_W / TAB_COUNT;
	var DASH = { width: 0.75, dash: [2.25, 2.25] }; // 1px dashed at print scale
	var TITLE_PT = 48, TITLE_LINE_H = TITLE_PT * 1.05 / MM;
	var QR_BODY = 42; // mm, body QR max; alignedQrMm shrinks it to the line grid
	var QR_TAB = 16; // mm, tab QR
	var TAB_PAD_V = 2.5, TAB_PAD_TEXT = 1.5, TAB_PAD_QR = 2.5, TAB_GAP = 2.5;
	var TAB_TEXT_W = TABS_H - TAB_PAD_TEXT - TAB_PAD_QR - TAB_GAP - QR_TAB;
	var TAB_CONTENT_H = TAB_W - 2 * TAB_PAD_V; // cross-axis space (clientHeight in fitTabs)

	function px(x) { return (BOX_X + x) * MM; }
	function py(y) { return (PAGE_H - (BOX_Y + y)) * MM; }

	// mm width of str at sizePt, via the vendored AFM tables
	function tw(str, font, sizePt) { return window.pdf.widthOf(str, font, sizePt) / MM; }

	// baseline's mm offset from the top of a line box (CSS half-leading, Times metrics)
	function baselineOff(sizePt, lineHmm) {
		return ((lineHmm * MM - sizePt * 0.9) / 2 + sizePt * 0.683) / MM;
	}

	// Word-wrap str into [{ text, yTop }], yTop in mm from y0. availFn(yTop) gives the
	// usable width at a line's top (how the floated QR narrows lines beside it). Words
	// wider than a line break mid-word (overflow-wrap: break-word).
	function wrap(str, font, sizePt, availFn, y0, lineHmm) {
		var lines = [];
		var cur = "";
		var y = y0;
		function push(s) { lines.push({ text: s, yTop: y }); y += lineHmm; }
		String(str).split(/\s+/).filter(Boolean).forEach(function (word) {
			var cand = cur ? cur + " " + word : word;
			if (tw(cand, font, sizePt) <= availFn(y)) { cur = cand; return; }
			if (cur) { push(cur); cur = ""; }
			while (tw(word, font, sizePt) > availFn(y)) {
				var k = 1; // longest fitting prefix; min 1 char so we always advance
				while (k < word.length && tw(word.slice(0, k + 1), font, sizePt) <= availFn(y)) { k++; }
				push(word.slice(0, k));
				word = word.slice(k);
			}
			cur = word;
		});
		if (cur) { push(cur); }
		return lines;
	}

	// title block: lines at 48pt/1.05 plus the h1's 1.5mm top / 7mm bottom margins
	function layoutTitle(m) {
		var lines = wrap(m.title, "times", TITLE_PT, function () { return BOX_W; }, 1.5, TITLE_LINE_H);
		return { lines: lines, block: 1.5 + lines.length * TITLE_LINE_H + 7 };
	}

	// Mirrors buildBody/fitFlow in flow-local mm: lines beside the floated QR wrap at the
	// narrowed width; the flow is at least the float band tall.
	function layoutFlow(m, pxSize, qrMm, gapTopMm, gapBotMm) {
		var size = pxSize * 0.75; // CSS px -> pt
		var lineH = size * 1.3 / MM;
		var em = size / MM;
		var band = 2 + qrMm + 7; // float margin box: 2mm top + QR + 7mm bottom
		var narrow = BOX_W - (qrMm + 7); // line width beside the float (7mm margin-left)
		var runs = [];
		var y = 0;
		function availAt(yy) { return yy < band ? narrow : BOX_W; }
		var descLines = wrap(m.description, "times", size, availAt, 0, lineH);
		descLines.forEach(function (line, i) {
			// justify: pad word gaps to fill the line; last line stays ragged
			var gaps = line.text.split(" ").length - 1;
			var ws = (i < descLines.length - 1 && gaps > 0)
				? (availAt(line.yTop) - tw(line.text, "times", size)) * MM / gaps : 0;
			runs.push({ text: line.text, x: 0, yTop: line.yTop, ws: ws });
			y = line.yTop + lineH;
		});
		y += gapTopMm; // ul margin-top
		var indent = 1.2 * em; // ul padding-left
		var bulletW = tw("•", "times", size);
		window.fmt.detailItems(m).forEach(function (item) {
			y += 0.15 * em; // li margin-top
			var lines = wrap(item, "times", size, function (yy) { return availAt(yy) - indent; }, y, lineH);
			runs.push({ text: "•", x: indent - 0.45 * em - bulletW, yTop: lines[0].yTop });
			lines.forEach(function (line) {
				runs.push({ text: line.text, x: indent, yTop: line.yTop });
				y = line.yTop + lineH;
			});
		});
		y += gapBotMm; // ul margin-bottom (counts toward the flow's BFC height)
		return { height: Math.max(y, band), size: size, lineH: lineH, qr: qrMm, runs: runs };
	}

	// fitFlow + fitQr's mirror: fit at the max QR, then final layout at the grid-aligned QR
	function fitPdfFlow(m, maxH) {
		var lo = 32, hi = 256; // quarter-px units
		while (lo < hi) {
			var mid = Math.ceil((lo + hi) / 2);
			if (layoutFlow(m, mid / 4, QR_BODY, 7, 7).height <= maxH) { lo = mid; } else { hi = mid - 1; }
		}
		return layoutFlow(m, lo / 4, alignedQrMm(lo / 4 * 0.75 * 1.3 / MM), 7, 7);
	}

	// QR as rects (white backing + black per-row runs), top-left at (x, y). emit places one rect.
	function qrPaint(emit, text, x, y, sizeMm) {
		var matrix = window.qr.createMatrix(text);
		var n = matrix.length;
		var mod = sizeMm / n;
		emit(x, y, sizeMm, sizeMm, 1);
		for (var r = 0; r < n; r++) {
			var c = 0;
			while (c < n) {
				if (!matrix[r][c]) { c++; continue; }
				var start = c;
				while (c < n && matrix[r][c]) { c++; }
				emit(x + start * mod, y + r * mod, (c - start) * mod, mod, 0);
			}
		}
	}

	// record a QR's rects once so the 10 tabs replay them
	function qrRuns(text, sizeMm) {
		var runs = [];
		qrPaint(function (x, y, w, h, gray) { runs.push([x, y, w, h, gray]); }, text, 0, 0, sizeMm);
		return runs;
	}

	// Tab text column (bold title, when, where) at base size s pt, in inner-local coords:
	// u along the 78mm axis, v across the 19.73mm one.
	function layoutTabText(m, s) {
		var runs = [];
		var v = 0;
		function add(str, font, sizePt, lineH, marginTop) {
			v += marginTop;
			wrap(str, font, sizePt, function () { return TAB_TEXT_W; }, v, lineH).forEach(function (line) {
				runs.push({ text: line.text, font: font, size: sizePt, vTop: line.yTop, lineH: lineH });
				v = line.yTop + lineH;
			});
		}
		add(m.title, "timesBold", 1.3 * s, 1.3 * s * 1.1 / MM, 0);
		add(window.fmt.startLine(m), "times", s, s * 1.15 / MM, 0.1 * s / MM);
		add(m.venue, "times", s, s * 1.15 / MM, 0.1 * s / MM);
		return { runs: runs, height: v };
	}

	// fitTabs's mirror: largest base pt size whose text stack fits the strip
	function fitPdfTab(m) {
		var lo = 6, hi = 16;
		while (lo < hi) {
			var mid = Math.ceil((lo + hi) / 2);
			if (layoutTabText(m, mid).height <= TAB_CONTENT_H) { lo = mid; } else { hi = mid - 1; }
		}
		return layoutTabText(m, lo);
	}

	// One tab's rotated content. The inner box is centered on its cell and rotated 90deg CW,
	// so local (u, v) maps to flyer-local (cx + TAB_W/2 - v, cy - TABS_H/2 + u): u runs down
	// the page, QR at the foot. Rects swap w/h; text uses the writer's rotate90.
	function paintTab(doc, i, tabText, runs) {
		var cx = i * TAB_W + TAB_W / 2;
		var cy = BOX_H - TABS_H / 2;
		function mapX(v) { return cx + TAB_W / 2 - v; }
		function mapY(u) { return cy - TABS_H / 2 + u; }
		var vText = TAB_PAD_V + (TAB_CONTENT_H - tabText.height) / 2; // align-items: center
		tabText.runs.forEach(function (run) {
			var v = vText + run.vTop + baselineOff(run.size, run.lineH);
			doc.text(run.text, px(mapX(v)), py(mapY(TAB_PAD_TEXT)),
				{ font: run.font, size: run.size, rotate90: true });
		});
		var u0 = TAB_PAD_TEXT + TAB_TEXT_W + TAB_GAP;
		var v0 = TAB_PAD_V + (TAB_CONTENT_H - QR_TAB) / 2;
		runs.forEach(function (r) {
			var u = u0 + r[0], v = v0 + r[1], w = r[2], h = r[3];
			doc.rect(px(mapX(v + h)), py(mapY(u) + w), h * MM, w * MM, r[4]);
		});
	}

	// the tear-from-body line plus the 11 cut lines bounding the 10 tabs
	function paintCutLines(doc) {
		var top = BOX_H - TABS_H;
		doc.dashedLine(px(0), py(top), px(BOX_W), py(top), DASH);
		for (var i = 0; i <= TAB_COUNT; i++) {
			doc.dashedLine(px(i * TAB_W), py(top), px(i * TAB_W), py(BOX_H), DASH);
		}
	}

	// Draw the whole flyer for `m`; returns the PDF file bytes.
	function buildPdf(m) {
		var doc = window.pdf.create(PAGE_W * MM, PAGE_H * MM);
		var title = layoutTitle(m);
		title.lines.forEach(function (line) {
			doc.text(line.text, px(0), py(line.yTop + baselineOff(TITLE_PT, TITLE_LINE_H)),
				{ font: "times", size: TITLE_PT });
		});
		var flowTop = title.block;
		var avail = BOX_H - TABS_H - flowTop;
		// build()'s mirror: ink-equalized gaps with the fit slack split a third per gap
		var titleEm = TITLE_PT / MM; // title font size in mm
		function gapComp(e) { return (leadBelow(1.3) + leadAbove(1.3)) * e - leadBelow(1.05) * titleEm; }
		var flow = fitPdfFlow(m, avail);
		var comp = gapComp(flow.size / MM);
		if (comp > 0) {
			flow = fitPdfFlow(m, avail - comp);
			comp = gapComp(flow.size / MM);
		}
		var s3 = Math.max(avail - comp - flow.height, 0) / 3;
		flow = layoutFlow(m, flow.size / 0.75, flow.qr,
			7 + s3, 7 + s3 + leadAbove(1.3) * flow.size / MM);
		flowTop += s3 + leadBelow(1.3) * flow.size / MM - leadBelow(1.05) * titleEm;
		flow.runs.forEach(function (run) {
			doc.text(run.text, px(run.x), py(flowTop + run.yTop + baselineOff(flow.size, flow.lineH)),
				{ font: "times", size: flow.size, wordSpacing: run.ws });
		});
		var url = window.fmt.eventUrl(m);
		qrPaint(function (x, y, w, h, gray) {
			doc.rect(px(x), py(y + h), w * MM, h * MM, gray);
		}, url, BOX_W - flow.qr, flowTop + 2, flow.qr);
		paintCutLines(doc);
		var tabText = fitPdfTab(m);
		var tabQr = qrRuns(url, QR_TAB);
		for (var i = 0; i < TAB_COUNT; i++) { paintTab(doc, i, tabText, tabQr); }
		return doc.end();
	}

	var pdfUrl = null;

	// Safari can't script-print a blob PDF (WebKit), so open it in a new tab and let the
	// user print from Safari's viewer. Synchronous so window.open keeps the gesture
	// allowance. Old blob URL revoked on next build, not after open (tab loads it async).
	function openPdf(m) {
		var bytes = buildPdf(m);
		if (pdfUrl) { URL.revokeObjectURL(pdfUrl); }
		pdfUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
		window.open(pdfUrl, "_blank");
	}

	window.addEventListener("pagehide", function () {
		if (pdfUrl) { URL.revokeObjectURL(pdfUrl); pdfUrl = null; }
	});

	// afterprint, not synchronously after print(): some engines render async
	window.addEventListener("afterprint", function () {
		if (flyerEl) { flyerEl.textContent = ""; }
		building = false;
	});

	function printFlyer(m) {
		if (!m) { return; }
		if (isSafari) { openPdf(m); return; }
		if (building) { return; }
		building = true;
		build(m);
		window.print();
	}

	// Cmd/Ctrl+P with an event selected: beforeprint can't cancel Safari's dialog, but
	// keydown can preempt it and route to the PDF.
	if (isSafari) {
		window.addEventListener("keydown", function (e) {
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey &&
				(e.key === "p" || e.key === "P")) {
				var m = window.panel && window.panel.getSelectedEvent && window.panel.getSelectedEvent();
				if (!m) { return; } // intro showing -> let Safari print the page
				e.preventDefault();
				openPdf(m);
			}
		});
	}

	// beforeprint fires before the dialog, so build here so any browser-initiated print
	// gets the flyer instead of the live app. (Link path sets `building` and we skip.)
	window.addEventListener("beforeprint", function () {
		if (isSafari || building) { return; }
		var m = window.panel && window.panel.getSelectedEvent && window.panel.getSelectedEvent();
		if (!m) { return; } // intro showing -> let the browser proceed
		building = true;
		build(m);
	});

	window.flyer = { print: printFlyer, buildPdf: buildPdf, enabled: true };
})();
