const path = require("path");
const { tests } = require("@iobroker/testing");

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."), {
	// Pin to the stable js-controller release; the default "dev" tag breaks the
	// test setup (missing iobroker.json) whenever an incompatible alpha is published.
	controllerVersion: "stable",
});