import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({resolve:{alias:{obsidian:fileURLToPath(new URL('./test/obsidian.mock.ts',import.meta.url))}},test:{include:['test/**/*.test.ts'],coverage:{provider:'v8',include:['src/**/*.ts'],reporter:['text','json-summary','html'],exclude:['test/**','scripts/**'],thresholds:{lines:98,statements:95,functions:95,branches:90}}}});
