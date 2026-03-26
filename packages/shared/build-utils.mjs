import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, cpSync, existsSync, rmSync } from "fs";
import { resolve } from "path";

/**
 * Create a builder for a browser extension package.
 * @param {object} options
 * @param {string} options.packageDir - Absolute path to the browser package (e.g. packages/chrome)
 * @param {string} options.sharedDir  - Absolute path to packages/shared
 * @param {string} options.target     - esbuild target (e.g. "chrome120", "firefox109")
 */
export function createBuilder({ packageDir, sharedDir, target }) {
  const isWatch = process.argv.includes("--watch");

  const sharedAlias = {
    "@tailchrome/shared": resolve(sharedDir, "src"),
  };

  const commonOptions = {
    bundle: true,
    format: "esm",
    target,
    sourcemap: isWatch ? "inline" : false,
    minify: !isWatch,
    alias: sharedAlias,
  };

  function copyStaticFiles() {
    mkdirSync(resolve(packageDir, "dist/icons"), { recursive: true });
    mkdirSync(resolve(packageDir, "dist/popup"), { recursive: true });

    const iconsDir = resolve(sharedDir, "src/assets/icons");
    if (existsSync(iconsDir)) {
      cpSync(iconsDir, resolve(packageDir, "dist/icons"), { recursive: true });
    }

    copyFileSync(
      resolve(packageDir, "manifest.json"),
      resolve(packageDir, "dist/manifest.json"),
    );
    copyFileSync(
      resolve(sharedDir, "src/popup/popup.html"),
      resolve(packageDir, "dist/popup/popup.html"),
    );

    for (const css of ["popup.css", "variables.css", "components.css"]) {
      const src = resolve(sharedDir, `src/popup/styles/${css}`);
      if (existsSync(src)) {
        copyFileSync(src, resolve(packageDir, `dist/popup/${css}`));
      }
    }
  }

  async function build() {
    await esbuild.build({
      ...commonOptions,
      entryPoints: [resolve(packageDir, "src/background/index.ts")],
      outfile: resolve(packageDir, "dist/background/index.js"),
    });

    await esbuild.build({
      ...commonOptions,
      entryPoints: [resolve(sharedDir, "src/popup/popup.ts")],
      outfile: resolve(packageDir, "dist/popup/popup.js"),
    });
  }

  async function run() {
    copyStaticFiles();

    if (isWatch) {
      const bgCtx = await esbuild.context({
        ...commonOptions,
        entryPoints: [resolve(packageDir, "src/background/index.ts")],
        outfile: resolve(packageDir, "dist/background/index.js"),
        plugins: [{
          name: "copy-static",
          setup(build) {
            build.onEnd(() => {
              copyStaticFiles();
              console.log("[watch] rebuilt");
            });
          },
        }],
      });

      const popupCtx = await esbuild.context({
        ...commonOptions,
        entryPoints: [resolve(sharedDir, "src/popup/popup.ts")],
        outfile: resolve(packageDir, "dist/popup/popup.js"),
      });

      await Promise.all([bgCtx.watch(), popupCtx.watch()]);
      console.log("Watching for changes...");
    } else {
      await build();
      const staleDir = resolve(packageDir, "dist/_.._");
      if (existsSync(staleDir)) {
        rmSync(staleDir, { recursive: true });
      }
      console.log("Build complete.");
    }
  }

  return { run };
}
