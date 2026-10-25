import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.{ts,tsx}'],
		// Several tests run the framework's own Python tests and dozens of git commands. On a Windows computer, with
		// the test files running side by side, one such test was measured at 65-100 s. The limits only cap a test
		// that hangs, so they leave at least three times that: npm publish runs these tests too.
		testTimeout: 300_000,
		hookTimeout: 120_000,
	},
});
