import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, cpSync, existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sharedDir = resolve(__dirname, "../shared");
const isWatch = process.argv.includes("--watch");

const sharedAlias = {
  "@tailchrome/shared": resolve(sharedDir, "src"),
};

const commonOptions = {
  bundle: true,
  format: "esm",
  target: "firefox109",
  sourcemap: isWatch ? "inline" : false,
  minify: !isWatch,
  alias: sharedAlias,
};

function copyStaticFiles() {
  mkdirSync("dist/icons", { recursive: true });
  mkdirSync("dist/popup", { recursive: true });

  const iconsDir = resolve(sharedDir, "src/assets/icons");
  if (existsSync(iconsDir)) {
    cpSync(iconsDir, "dist/icons", { recursive: true });
  }

  copyFileSync("manifest.json", "dist/manifest.json");
  copyFileSync(resolve(sharedDir, "src/popup/popup.html"), "dist/popup/popup.html");

  for (const css of ["popup.css", "variables.css", "components.css"]) {
    const src = resolve(sharedDir, `src/popup/styles/${css}`);
    if (existsSync(src)) {
      copyFileSync(src, `dist/popup/${css}`);
    }
  }
}

async function build() {
  // Build background script
  await esbuild.build({
    ...commonOptions,
    entryPoints: ["src/background/index.ts"],
    outfile: "dist/background/index.js",
  });

  // Build popup script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [resolve(sharedDir, "src/popup/popup.ts")],
    outfile: "dist/popup/popup.js",
  });
}

copyStaticFiles();

if (isWatch) {
  // Background watcher
  const bgCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ["src/background/index.ts"],
    outfile: "dist/background/index.js",
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

  // Popup watcher
  const popupCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: [resolve(sharedDir, "src/popup/popup.ts")],
    outfile: "dist/popup/popup.js",
  });

  await Promise.all([bgCtx.watch(), popupCtx.watch()]);
  console.log("Watching for changes...");
} else {
  await build();
  // Clean up any stale outbase artifacts
  if (existsSync("dist/_.._")) {
    rmSync("dist/_.._", { recursive: true });
  }
  console.log("Build complete.");
}
