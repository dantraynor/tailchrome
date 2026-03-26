import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createBuilder } from "../shared/build-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const builder = createBuilder({
  packageDir: __dirname,
  sharedDir: resolve(__dirname, "../shared"),
  target: "firefox109",
});

await builder.run();
