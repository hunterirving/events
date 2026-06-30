// Minimal single-page PDF writer for the flyer's Safari path: vector text (built-in
// Times-Roman/Times-Bold, no embedding), filled rects (QR modules), dashed lines (cut
// marks). No DOM. Pure data in, bytes out, so it also runs under node. Coordinates are
// raw PDF points, origin bottom-left (y-up); callers flip. Text is WinAnsi-encoded
// (ASCII/Latin-1 pass through, common Win-1252 punctuation mapped, else "?"); widthOf uses
// the same encoding via the vendored AFM widths so wrapping matches what renders.

(function (root) {
	// unicode -> WinAnsi byte for the 0x80-0x9F slots worth mapping
	var UNI2WIN = {
		0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
		0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
		0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
		0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
		0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
		0x017E: 0x9E, 0x0178: 0x9F
	};

	// Adobe core AFM advance widths (1/1000 em), codes 32-255 in WinAnsi order.
	// Zeros mark codes with no WinAnsi glyph; encode() never emits those.
	var W_TIMES = parseWidths("250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500 500 500 500 500 500 500 500 500 500 278 278 564 564 564 444 921 722 667 667 722 611 556 722 722 333 389 722 611 889 722 722 556 722 667 556 611 722 722 944 722 722 611 333 278 333 469 500 333 444 500 444 500 444 333 500 500 278 278 500 278 778 500 500 500 500 333 389 278 500 500 722 500 500 444 480 200 480 541 0 500 0 333 500 444 1000 500 500 333 1000 556 333 889 0 611 0 0 333 333 444 444 350 500 1000 333 980 389 333 722 0 444 722 250 333 500 500 500 500 200 500 333 760 276 500 564 333 760 333 400 564 300 300 333 500 453 250 333 300 310 500 750 750 750 444 722 722 722 722 722 722 889 667 611 611 611 611 333 333 333 333 722 722 722 722 722 722 722 564 722 722 722 722 722 722 556 500 444 444 444 444 444 444 667 444 444 444 444 444 278 278 278 278 500 500 500 500 500 500 500 564 500 500 500 500 500 500 500 500");
	var W_TIMES_BOLD = parseWidths("250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 500 500 500 333 333 570 570 570 500 930 722 667 722 722 667 611 778 778 389 500 778 667 944 722 778 611 778 722 556 667 722 722 1000 722 722 667 333 278 333 581 500 333 500 556 444 556 444 333 500 556 278 333 556 278 833 556 500 556 556 444 389 333 556 500 722 500 500 444 394 220 394 520 0 500 0 333 500 500 1000 500 500 333 1000 556 333 1000 0 667 0 0 333 333 500 500 350 500 1000 333 1000 389 333 722 0 444 722 250 333 500 500 500 500 220 500 333 747 300 500 570 333 747 333 400 570 300 300 333 556 540 250 333 300 330 500 750 750 750 500 722 722 722 722 722 722 1000 722 667 667 667 667 389 389 389 389 722 722 778 778 778 778 778 570 778 722 722 722 722 722 611 556 500 500 500 500 500 500 722 444 444 444 444 444 278 278 278 278 500 556 500 500 500 500 500 570 500 556 556 556 556 500 556 500");

	function parseWidths(s) {
		return s.split(" ").map(Number);
	}

	// string -> array of WinAnsi byte values (unmappable code points become "?")
	function encode(str) {
		var bytes = [];
		Array.from(String(str)).forEach(function (ch) {
			var cp = ch.codePointAt(0);
			if (cp >= 0x20 && cp <= 0x7E) { bytes.push(cp); return; }
			if (cp >= 0xA0 && cp <= 0xFF) { bytes.push(cp); return; }
			bytes.push(UNI2WIN[cp] || 0x3F);
		});
		return bytes;
	}

	function widthOf(str, font, size) {
		var tbl = font === "timesBold" ? W_TIMES_BOLD : W_TIMES;
		var w = 0;
		encode(str).forEach(function (b) {
			w += tbl[b - 32] || 500;
		});
		return w * size / 1000;
	}

	// PDF literal string body: escape delimiters, octal-escape non-ASCII bytes
	// (always 3 digits so a following literal digit can't extend the escape)
	function escapeBytes(bytes) {
		return bytes.map(function (b) {
			if (b === 0x28 || b === 0x29 || b === 0x5C) { return "\\" + String.fromCharCode(b); }
			if (b < 32 || b > 126) { return "\\" + ("00" + b.toString(8)).slice(-3); }
			return String.fromCharCode(b);
		}).join("");
	}

	// compact decimal, never exponential
	function num(n) {
		var s = n.toFixed(3).replace(/\.?0+$/, "");
		return s === "-0" ? "0" : s;
	}

	function create(widthPt, heightPt) {
		var ops = [];
		var lastGray = null;
		var lastWordSp = 0;

		// x,y position the baseline start. rotate90 renders the run reading down the page
		// (baseline 0,-1; glyph-up 1,0). wordSpacing (PDF Tw) persists across BT/ET, so
		// emit only on change.
		function text(str, x, y, opts) {
			var f = opts.font === "timesBold" ? "/F2" : "/F1";
			var ws = opts.wordSpacing || 0;
			var tw = ws !== lastWordSp ? num(ws) + " Tw " : "";
			lastWordSp = ws;
			var pos = opts.rotate90
				? "0 -1 1 0 " + num(x) + " " + num(y) + " Tm"
				: num(x) + " " + num(y) + " Td";
			ops.push("BT " + f + " " + num(opts.size) + " Tf " + tw + pos +
				" (" + escapeBytes(encode(str)) + ") Tj ET");
			lastGray = null; // BT/ET doesn't touch fill color, but stay conservative
		}

		// filled rect anchored at its bottom-left; gray 0 = black, 1 = white
		function rect(x, y, w, h, gray) {
			var g = gray || 0;
			if (g !== lastGray) {
				ops.push(num(g) + " g");
				lastGray = g;
			}
			ops.push(num(x) + " " + num(y) + " " + num(w) + " " + num(h) + " re f");
		}

		function dashedLine(x1, y1, x2, y2, opts) {
			ops.push("q [" + num(opts.dash[0]) + " " + num(opts.dash[1]) + "] 0 d " +
				num(opts.width) + " w 0 G " +
				num(x1) + " " + num(y1) + " m " + num(x2) + " " + num(y2) + " l S Q");
		}

		// assemble as a binary string (char codes <= 0xFF) so string offsets are byte
		// offsets, then convert to a Uint8Array
		function end() {
			var stream = ops.join("\n");
			var objects = [
				"<< /Type /Catalog /Pages 2 0 R >>",
				"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
				"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + num(widthPt) + " " + num(heightPt) + "]" +
					" /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
				"<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
				"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>",
				"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>"
			];
			var out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
			var offsets = [];
			objects.forEach(function (body, i) {
				offsets.push(out.length);
				out += (i + 1) + " 0 obj\n" + body + "\nendobj\n";
			});
			var xref = out.length;
			out += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
			offsets.forEach(function (off) {
				out += ("000000000" + off).slice(-10) + " 00000 n \n";
			});
			out += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\n" +
				"startxref\n" + xref + "\n%%EOF\n";
			var bytes = new Uint8Array(out.length);
			for (var i = 0; i < out.length; i++) { bytes[i] = out.charCodeAt(i); }
			return bytes;
		}

		return { text: text, rect: rect, dashedLine: dashedLine, end: end };
	}

	var api = { create: create, widthOf: widthOf };
	root.pdf = api;
	if (typeof module !== "undefined" && module.exports) { module.exports = api; }
})(typeof window !== "undefined" ? window : globalThis);
