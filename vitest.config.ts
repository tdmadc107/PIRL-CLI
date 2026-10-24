import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.{ts,tsx}'],
		// Several tests run the framework's own Python tests, which take several seconds on Windows runners.
		testTimeout: 60_000,
		hookTimeout: 30_000,
	},
});
