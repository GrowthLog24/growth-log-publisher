import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");
const source = path.resolve(rootDirectory, "browser-automation.mjs");
const generatedDirectory = path.resolve(rootDirectory, "generated");
const destination = path.resolve(generatedDirectory, "browser-automation.mjs");
const legacyDestination = path.resolve(generatedDirectory, "knou-helper.mjs");

await mkdir(generatedDirectory, { recursive: true });
await copyFile(source, destination);
await rm(legacyDestination, { force: true });
