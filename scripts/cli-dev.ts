/** `npm run cli -- <args>`: the study-studio CLI from source, defaulting to the dev data dir like `npm run dev`. */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../packages/cli/src/cli.js";

process.env.STUDY_STUDIO_DATA_DIR ??= join(process.cwd(), "StudyStudioData");
await main(process.argv.slice(2), { version: "dev", binPath: fileURLToPath(import.meta.url) });
