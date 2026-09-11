import { defineConfig } from 'eslint/config';
import json from '@eslint/json';
import obsidianmd from 'eslint-plugin-obsidianmd';
export default defineConfig([
  {ignores:['node_modules/**','dist/**','coverage/**','.private/**','reports/**','test/**','scripts/**','main.js']},
  ...obsidianmd.configs.recommended.map(config => ({...config, ignores:[...(config.ignores || []),'manifest.json']})),
  {files:['src/**/*.ts'],languageOptions:{parserOptions:{projectService:{allowDefaultProject:['eslint.config.mjs']}}}},
  {files:['manifest.json'],plugins:{json,obsidianmd},language:'json/json',rules:{'obsidianmd/validate-manifest':'error'}}
]);
