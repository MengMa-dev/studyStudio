import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createIngestionServer } from "./ingestion-server.js";

const port = Number(process.env.STUDY_STUDIO_PORT ?? 43118);
const dataDir = process.env.STUDY_STUDIO_DATA_DIR ?? join(process.cwd(), "StudyStudioData");
const tokenFile = join(dataDir, ".pairing-token");
await mkdir(dataDir, { recursive: true });
const pairingToken = process.env.STUDY_STUDIO_TOKEN ?? (existsSync(tokenFile) ? (await readFile(tokenFile, "utf8")).trim() : randomUUID());
if (!existsSync(tokenFile)) await writeFile(tokenFile, pairingToken, { mode: 0o600 });

const dev = process.env.STUDY_STUDIO_DEV === "1";
const ingestion = await createIngestionServer({ dataDir, pairingToken, ...(dev ? { minRevisitSeconds: 3 } : {}) });
await ingestion.listen(port);
console.log(`Study Studio ingestion listening at http://127.0.0.1:${port}${dev ? " (DEV: revisit reading time counts from 3s)" : ""}`);
console.log(`Pairing token: ${pairingToken}`);
console.log(`Data directory: ${dataDir}`);
