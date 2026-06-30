(function () {
	if (!window.location.search) { window.panel.paintIntro(); }
	window.eventsData
		.then(function (data) {
			window.eventsMap.setEvents(data);
			// preset the panel color for a deep-linked event that will actually be shown,
			// so it never flashes antiquewhite first. A passed event is only shown (and so
			// only worth presetting) in past mode, i.e. when nothing is upcoming.
			var deepLinked = window.fmt.eventFromUrl(data);
			var shown = deepLinked && (!window.fmt.hasPassed(deepLinked) ||
				!window.fmt.upcomingEvents(data).length);
			if (shown) { window.panel.presetEventColor(deepLinked); }
			window.eventsMap.load();
		})
		.catch(function () {
			document.getElementById("text-title").textContent = "Couldn't load events";
			document.getElementById("text-content").textContent = "If you opened this file directly, serve it over http (./serve.py) so the browser can fetch events.json.";
		});
})();
