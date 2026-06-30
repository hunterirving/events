// Pure date/text formatting helpers + email-obfuscation.

(function () {
	var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	var MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

	function ordinal(n) {
		var s = ["th", "st", "nd", "rd"], v = n % 100;
		return n + (s[(v - 20) % 10] || s[v] || s[0]);
	}

	// Parse "2026-06-07T14:00" as local time (no timezone applied).
	function parseLocal(iso) {
		var p = iso.split(/[-T:]/);
		return new Date(p[0], p[1] - 1, p[2], p[3], p[4]);
	}

	// "2:00" / "9:30pm" - am/pm only on the end so a range reads "1:00 - 4:00pm".
	function clockTime(d, withMeridian) {
		var h = d.getHours(), min = d.getMinutes();
		var mer = h >= 12 ? "pm" : "am";
		h = h % 12 || 12;
		return h + ":" + (min < 10 ? "0" + min : min) + (withMeridian ? mer : "");
	}

	// "1:00 - 4:00pm" when start/end share a meridian; "11:00am - 1:00pm" when they
	// differ, so a cross-noon/midnight range isn't ambiguous. forceStart keeps the start
	// meridian even when shared, so a multiday range doesn't read as a same-day span.
	function timeRange(start, end, forceStart) {
		var sameMer = (start.getHours() >= 12) === (end.getHours() >= 12);
		return clockTime(start, forceStart || !sameMer) + " - " + clockTime(end, true);
	}

	// "Sunday, June 7th"
	function dateLabel(d) {
		return WEEKDAYS[d.getDay()] + ", " + MONTH_NAMES[d.getMonth()] + " " + ordinal(d.getDate());
	}

	function sameDay(a, b) {
		return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	}

	// " (Today!)" / " (Tomorrow)" / "" against `now` at call time (no live refresh).
	// A passed event takes ", <year>" instead, so the year is clear to viewers in a
	// later year landing on the same day-of-month; the "(Ended)" marker is appended
	// separately by the caller so it can sit at the end of a multiday range.
	function relativeDayTag(m, d, now) {
		now = now || new Date();
		if (hasPassed(m, now)) { return ", " + d.getFullYear(); }
		if (sameDay(d, now)) { return " (Today!)"; }
		var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
		if (sameDay(d, tomorrow)) { return " (Tomorrow)"; }
		return "";
	}

	// An event has "passed" once its end time is in the past.
	function hasPassed(m, now) {
		return parseLocal(m.end) < (now || new Date());
	}

	// Upcoming events (end not yet past), soonest start first. Caller snapshots `now`.
	function upcomingEvents(events, now) {
		now = now || new Date();
		return events.filter(function (m) { return !hasPassed(m, now); })
			.sort(function (a, b) { return parseLocal(a.start) - parseLocal(b.start); });
	}

	// Up to `limit` passed events, most-recently-ended first. Caller snapshots `now`.
	function pastEvents(events, now, limit) {
		now = now || new Date();
		return events.filter(function (m) { return hasPassed(m, now); })
			.sort(function (a, b) { return parseLocal(b.end) - parseLocal(a.end); })
			.slice(0, limit == null ? 10 : limit);
	}

	// "June 7th" - short date for the intro table's date column. withYear appends ", 2025"
	// so past events read unambiguously in a later year.
	function shortDate(m, withYear) {
		var d = parseLocal(m.start);
		return MONTH_NAMES[d.getMonth()] + " " + ordinal(d.getDate()) + (withYear ? ", " + d.getFullYear() : "");
	}

	// "Sunday, June 7th from 1:00 - 4:00pm"
	function dateLine(m) {
		var start = parseLocal(m.start), end = parseLocal(m.end);
		return dateLabel(start) + " from " + timeRange(start, end);
	}

	// "Sunday, June 7th at 1:00pm" - start only (flyer tear-tabs).
	function startLine(m) {
		var start = parseLocal(m.start);
		return dateLabel(start) + " at " + clockTime(start, true);
	}

	// Detail bullets, one per <li>. Same-day events get separate date + time bullets.
	// Upcoming multiday events collapse into one "date time - date time" bullet so each
	// endpoint carries its day; once past, they split into a date-range line + time-range
	// line ("(Ended)" trailing), letting each time pair with its date. The year shows on
	// the end date only, or on both dates when the range spans two years.
	// Blank fields are dropped. address is intentionally not shown (kept in data for
	// later). withRelativeDay appends "(Today!)" / "(Ended)" - panel only.
	function detailItems(m, withRelativeDay) {
		var start = parseLocal(m.start), end = parseLocal(m.end);
		var single = sameDay(start, end);
		var ended = withRelativeDay && hasPassed(m) ? " (Ended)" : "";
		var startLabel = dateLabel(start) + (withRelativeDay ? relativeDayTag(m, start) : "");
		var when;
		if (single) {
			when = [startLabel + ended, timeRange(start, end)];
		} else if (ended) {
			var sameYear = start.getFullYear() === end.getFullYear();
			var startYear = sameYear ? "" : ", " + start.getFullYear();
			when = [dateLabel(start) + startYear + " - " + dateLabel(end) + ", " + end.getFullYear() + ended, timeRange(start, end, true)];
		} else {
			when = [startLabel + " " + clockTime(start, true) + " - " + dateLabel(end) + " " + clockTime(end, true)];
		}
		return when.concat([m.venue, m.price, m.ageRange]).filter(function (s) {
			return s && s.trim();
		});
	}

	function easeInOut(t) {
		return t < 0.5 ? 0.5 * Math.sqrt(2 * t) : 1 - 0.5 * Math.sqrt(2 * (1 - t));
	}

	// ROT13 to keep RSVP addresses out of page source; each event's `rsvp` is stored rotated.
	function rot(str) {
		var input = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
		var output = "NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm";
		return str.split("").map(function (x) {
			var i = input.indexOf(x);
			return i > -1 ? output[i] : x;
		}).join("");
	}

	// RSVP mailto: decode the rotated address, prepopulate subject + body. The event URL
	// goes on its own trailing line so mail clients auto-link it.
	function mailtoHref(m) {
		var url = eventUrl(m);
		var subject = "RSVP for " + m.title + " 🐞";
		var body = "I'm confirming my RSVP for the following event:\n\n" +
			m.title + "\n" + startLine(m) + "\n\n" +
			url + "\n\n· · · · ·\n\nAny notes or comments? Add them here:\n\n\n";
		return "mailto:" + rot(m.rsvp) +
			"?subject=" + encodeURIComponent(subject) +
			"&body=" + encodeURIComponent(body);
	}

	function pad2(n) { return n < 10 ? "0" + n : "" + n; }

	// "20260610T183000" - floating local time (no zone). JSON times are venue wall-clock,
	// so calendars show them in the viewer's local time.
	function icsLocal(d) {
		return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
			"T" + pad2(d.getHours()) + pad2(d.getMinutes()) + "00";
	}

	// "20260610T183000Z" - UTC stamp for DTSTAMP/UID.
	function icsStamp(d) {
		return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
			"T" + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + "Z";
	}

	// Escape a TEXT value per RFC 5545.
	function icsEscape(str) {
		return String(str)
			.replace(/\\/g, "\\\\")
			.replace(/;/g, "\\;")
			.replace(/,/g, "\\,")
			.replace(/\r?\n/g, "\\n");
	}

	// Fold a content line to <=75 octets per RFC 5545. Counts UTF-8 bytes (not chars)
	// and never splits a multibyte sequence across the fold.
	function icsFold(line) {
		var out = "", run = 0, limit = 75;
		for (var i = 0; i < line.length; i++) {
			var ch = line[i];
			var bytes = encodeURIComponent(ch).replace(/%[0-9A-F]{2}/gi, "x").length;
			if (run + bytes > limit) { out += "\r\n "; run = 1; } // leading space counts as 1
			out += ch;
			run += bytes;
		}
		return out;
	}

	// Single-event iCalendar (.ics). Floating local time; venue+address as LOCATION.
	function icsContent(m) {
		var start = parseLocal(m.start), end = parseLocal(m.end);
		var location = m.address ? m.venue + ", " + m.address : m.venue;
		var uid = icsLocal(start) + "-" + Math.abs(hashStr(m.title)) + "@events";
		var lines = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//events//EN",
			"CALSCALE:GREGORIAN",
			"BEGIN:VEVENT",
			"UID:" + uid,
			"DTSTAMP:" + icsStamp(new Date()),
			"DTSTART:" + icsLocal(start),
			"DTEND:" + icsLocal(end),
			"SUMMARY:" + icsEscape(m.title),
			"LOCATION:" + icsEscape(location),
			"URL:" + icsEscape(eventUrl(m)),
			"DESCRIPTION:" + icsEscape(m.description),
			"END:VEVENT",
			"END:VCALENDAR"
		];
		return lines.map(icsFold).join("\r\n") + "\r\n";
	}

	// Stable hash so the same event yields the same UID across downloads (calendars
	// dedupe/update on UID).
	function hashStr(str) {
		var h = 0;
		for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
		return h;
	}

	// Deep-link id: title slug + date, so two same-named events on different days don't
	// collide, e.g. "front-porch-jam-session-2026-06-12".
	function eventSlug(m) {
		var title = m.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "event";
		return title + "-" + m.start.slice(0, 10);
	}

	// Deep link to an event: current page sans query/hash + ?<slug>.
	function eventUrl(m) {
		var base = window.location.href.split(/[?#]/)[0];
		return base + "?" + encodeURIComponent(eventSlug(m));
	}

	function isApplePlatform() {
		return /Macintosh|iPhone|iPad|iPod/.test(navigator.userAgent);
	}

	// Driving-directions deep link (destination only, so the app fills in the origin).
	// Prefer the street address; fall back to lat,long when blank.
	// maps:// opens Apple Maps directly; Google Maps everywhere else.
	function directionsHref(m) {
		var dest = encodeURIComponent(m.address || (m.latitude + "," + m.longitude));
		return isApplePlatform()
			? "maps://?daddr=" + dest + "&dirflg=d"
			: "https://www.google.com/maps/dir/?api=1&destination=" + dest + "&travelmode=driving";
	}

	// Resolve the current URL's ?<slug> back to its event, or null. Inverse of eventUrl.
	function eventFromUrl(events) {
		var slug = decodeURIComponent(window.location.search.slice(1));
		if (!slug) { return null; }
		for (var i = 0; i < events.length; i++) {
			if (eventSlug(events[i]) === slug) { return events[i]; }
		}
		return null;
	}

	function icsFilename(m) {
		return eventSlug(m) + ".ics";
	}

	window.fmt = {
		MONTH_ABBR: MONTH_ABBR,
		parseLocal: parseLocal,
		hasPassed: hasPassed,
		upcomingEvents: upcomingEvents,
		pastEvents: pastEvents,
		shortDate: shortDate,
		dateLine: dateLine,
		startLine: startLine,
		detailItems: detailItems,
		easeInOut: easeInOut,
		mailtoHref: mailtoHref,
		icsContent: icsContent,
		icsFilename: icsFilename,
		eventSlug: eventSlug,
		eventUrl: eventUrl,
		directionsHref: directionsHref,
		eventFromUrl: eventFromUrl
	};
})();
