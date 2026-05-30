import assert from "node:assert/strict";
import test from "node:test";

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Reproduce the crash scenario: content wrapped at full safeWidth then
 * prepended with a "│   " pipe prefix overflows by 4 characters.
 *
 * This test validates the fix math: wrap at (safeWidth - pipeWidth) instead
 * of safeWidth, so continuation lines with the prefix stay within bounds.
 */
test("addWrappedPipe math: pipe prefix accounted for in wrap width", () => {
	const PIPE_PREFIX = "│   ";
	const PIPE_WIDTH = visibleWidth(PIPE_PREFIX);
	assert.equal(PIPE_WIDTH, 4, "Pipe prefix should be 4 visible characters");

	// Simulate the crash scenario: terminal width 110, content wraps
	for (const safeWidth of [50, 70, 109, 110, 120]) {
		// Content that would wrap at the given width
		const content = "a".repeat(safeWidth * 3);

		// BUG: wrap at full safeWidth, then prepend pipe prefix
		const bugLines = wrapTextWithAnsi(content, safeWidth).map(
			(line, i) => (i === 0 ? line : PIPE_PREFIX + line),
		);
		for (let i = 1; i < bugLines.length; i++) {
			assert.ok(
				visibleWidth(bugLines[i]) > safeWidth,
				`At safeWidth=${safeWidth}: buggy continuation line ${i} should overflow: ${visibleWidth(bugLines[i])} <= ${safeWidth}`,
			);
		}

		// FIX: wrap at safeWidth - pipeWidth, then prepend pipe prefix
		const wrapWidth = Math.max(1, safeWidth - PIPE_WIDTH);
		const fixLines = wrapTextWithAnsi(content, wrapWidth).map(
			(line, i) => (i === 0 ? line : PIPE_PREFIX + line),
		);
		for (let i = 0; i < fixLines.length; i++) {
			assert.ok(
				visibleWidth(fixLines[i]) <= safeWidth,
				`At safeWidth=${safeWidth}: fixed continuation line ${i} overflows: visibleWidth=${visibleWidth(fixLines[i])} > ${safeWidth}`,
			);
		}
	}
});

/**
 * Validate that wrapTextWithAnsi at a reduced width + pipe prefix
 * never exceeds safeWidth for realistic long content.
 */
test("addWrappedPipe with realistic long content never overflows", () => {
	const PIPE_PREFIX = "│   ";
	const PIPE_WIDTH = visibleWidth(PIPE_PREFIX);

	// Realistic content from the crash: long topic text that wraps inside pipe box
	const longTopic = [
		"Use and extend the pystata analyzer to ensure the full e2e suite passes on Linux, we have 100% parity in terms of features with the vendor, and all e2e pass (no skips). The constraints should be exactly those as per the design document and the previous goals.",
		"We need to dissassemble the vendor's implementation live, stepping through, to ensure we implement this in full, including all edge cases, error handling paths, and performance characteristics that the vendor has documented.",
		"Each component must be verified independently with unit tests that cover at minimum the public API surface, boundary conditions, error states, and the interaction contracts between modules.",
		"Integration testing must validate that the assembled system behaves identically to the vendor implementation across a comprehensive set of real-world workloads representative of production usage patterns.",
	].join(" ");

	for (const safeWidth of [80, 90, 100, 109, 110]) {
		const wrapWidth = Math.max(1, safeWidth - PIPE_WIDTH);
		const wrapped = wrapTextWithAnsi(longTopic, wrapWidth);
		for (let i = 0; i < wrapped.length; i++) {
			const line = i === 0 ? wrapped[i] : PIPE_PREFIX + wrapped[i];
			const w = visibleWidth(line);
			assert.ok(
				w <= safeWidth,
				`safeWidth=${safeWidth}, line ${i}: visibleWidth=${w} > ${safeWidth}, content=${JSON.stringify(line.slice(0, 60))}`,
			);
		}
	}
});

/**
 * Safety net test: verify truncateToWidth handles all the edge cases we'd expect.
 */
test("truncateToWidth safety net at various widths", () => {
	for (const width of [50, 60, 70, 80, 90, 100, 109, 110]) {
		const long = "x".repeat(width * 3);
		const truncated = truncateToWidth(long, width);
		assert.ok(visibleWidth(truncated) <= width, `truncateToWidth at ${width} produced ${visibleWidth(truncated)}`);
	}
});
