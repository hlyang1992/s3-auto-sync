import { build } from 'esbuild';
await build({entryPoints:['src/main.ts'],outfile:'main.js',bundle:true,platform:'browser',format:'cjs',target:'es2022',external:['obsidian'],minify:true,legalComments:'eof'});
