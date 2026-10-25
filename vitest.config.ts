import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.{ts,tsx}'],
		// Several tests run the framework's own Python tests and dozens of git commands. On a Windows computer, with
		// the test files running side by side, one such test can take a minute or more; the limits only cap a
		// test that hangs, so they are generous.
		testTimeout: 180_000,
		hookTimeout: 60_000,
	},
});
