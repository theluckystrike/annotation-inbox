import { defineConfig } from 'vitest/config';

// obsidian ships typings only, so tests run against obsidian-test-mocks in happy-dom.
export default defineConfig({
	define: { __PRO_BUILD__: 'false' },
	resolve: { alias: { obsidian: 'obsidian-test-mocks/obsidian' } },
	test: {
		environment: 'happy-dom',
		setupFiles: ['obsidian-test-mocks/vitest-setup'],
		include: ['tests/**/*.test.ts'],
	},
});
