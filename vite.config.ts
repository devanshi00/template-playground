import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig as defineViteConfig, mergeConfig } from "vite";
import { defineConfig as defineVitestConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import nodePolyfills from "vite-plugin-node-stdlib-browser";
import { visualizer } from "rollup-plugin-visualizer";
import type { Plugin as EsbuildPlugin } from "esbuild";

function replaceFunctionBody(source: string, fnSignature: string, newBody: string): string {
  const startIdx = source.indexOf(fnSignature);
  if (startIdx === -1) return source;

  const braceStart = source.indexOf("{", startIdx);
  if (braceStart === -1) return source;

  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const fnEnd = i + 1;

  return source.slice(0, startIdx) + newBody + source.slice(fnEnd);
}

// @accordproject/template-engine's loadOptionalModule() does import(specifier)
// with a variable, so esbuild's dependency scanner can't discover
// @mistralai/mistralai, @anthropic-ai/sdk, etc. This onLoad hook rewrites
// Reasoners.js at pre-bundle time to use literal, analyzable imports.
// Only affects dev (optimizeDeps); the alias below handles both dev and build.
function fixDynamicOptionalImportsEsbuild(): EsbuildPlugin {
  return {
    name: "fix-template-engine-dynamic-imports",
    setup(build) {
      build.onLoad({ filter: /template-engine[\\/]lib[\\/]llm[\\/]Reasoners\.js$/ }, (args) => {
        let contents = readFileSync(args.path, "utf8");
        if (contents.includes("loadOptionalModule")) {
          contents = replaceFunctionBody(
            contents,
            "function loadOptionalModule(specifier)",
            `function loadOptionalModule(specifier) {
              switch (specifier) {
                case '@mistralai/mistralai': return import('@mistralai/mistralai');
                case '@anthropic-ai/sdk': return import('@anthropic-ai/sdk');
                case '@google/genai': return import('@google/genai');
                case 'openai': return import('openai');
                case 'groq-sdk': return import('groq-sdk');
                case '@openrouter/sdk': return import('@openrouter/sdk');
                default: return import(/* @vite-ignore */ specifier);
              }
            }`
          );
        }
        return { contents, loader: "js" };
      });
    },
  };
}

// https://vitejs.dev/config/
const viteConfig = defineViteConfig({
  plugins: [
    nodePolyfills(),
    react(),
    visualizer({
      emitFile: true,
      filename: "stats.html",
    }),
  ],
  resolve: {
    alias: {
      // Defensive safeguard: forces axios to use the browser-safe XHR adapter
      // instead of the Node http adapter (which pulls in zlib, crashing in browser builds).
      // Primary fix is offline:true + removing updateExternalModels() in store.ts —
      // this alias is an extra precaution for any indirect axios usage.
      // Note: relies on axios internals — revisit if axios is upgraded.
      './adapters/http.js': 'axios/lib/adapters/xhr.js',

      // @anthropic-ai/sdk's tools/agent-toolset (unused agent tool-use
      // scaffolding, never reached by Reasoners.js) imports these two
      // specifiers. vite-plugin-node-stdlib-browser doesn't polyfill the
      // /promises subpath variants correctly (it mis-resolves them against
      // its own mock file, producing ENOTDIR errors), in BOTH dev and Rollup
      // production builds — so alias them directly to a no-op stub instead
      // of relying on the polyfill plugin for just these two specifiers.
      'node:fs/promises': path.resolve(__dirname, 'src/shims/empty-promises.ts'),
      'node:stream/promises': path.resolve(__dirname, 'src/shims/empty-promises.ts'),
    },
    dedupe: [
      "@mistralai/mistralai",
      "@anthropic-ai/sdk",
      "@google/genai",
      "openai",
      "groq-sdk",
    ],
  },
  optimizeDeps: {
    include: ["immer"],
    needsInterop: ['@accordproject/template-engine'],
    esbuildOptions: {
      plugins: [fixDynamicOptionalImportsEsbuild()],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'template-engine': ['@accordproject/template-engine'],
          'markdown-transform': ['@accordproject/markdown-transform'],
          'markdown-template': ['@accordproject/markdown-template'],
          'concerto': ['@accordproject/concerto-core', '@accordproject/concerto-cto'],
          'anthropic': ['@anthropic-ai/sdk'],
          'google-genai': ['@google/genai'],
          'mistral': ['@mistralai/mistralai'],
          'openai': ['openai'],
          'groq': ['groq-sdk'],
        },
      },
    },
  },
});

// https://vitest.dev/config/
const vitestConfig = defineVitestConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/utils/testing/setup.ts",
    exclude: [...configDefaults.exclude, "**/e2e/**"],
    server: {
      deps: {
        inline: ["monaco-editor"],
      },
    },
  },
  resolve: {
    alias: process.env.VITEST ? {
      "monaco-editor": "monaco-editor/esm/vs/editor/editor.api",
    } : {},
  },
});

export default mergeConfig(viteConfig, vitestConfig);