import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import type { StoragePaths } from "./paths.js";

export interface ColdObjectMetadata {
  category: string;
  compressedTokens?: number;
  compressionMode?: string;
  compressor?: string;
  createdAt?: string;
  expiresAt?: string;
  projectId?: string;
  rawTokens?: number;
  referenceId?: string;
  sessionId?: string;
  sourcePath?: string;
  sourceTool?: string;
}

export interface StoredColdObject {
  contentHash: string;
  filePath: string;
  id: string;
  referenceId: string;
}

const hashContent = (content: Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

const isAlreadyExistsError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

// Publish a fully written payload with a hard link so concurrent writers never expose partial data.
const writeColdPayload = (filePath: string, content: Uint8Array, contentHash: string): void => {
  mkdirSync(dirname(filePath), { mode: 0o700, recursive: true });

  if (!existsSync(filePath)) {
    const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600 });

    try {
      linkSync(temporaryPath, filePath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    } finally {
      unlinkSync(temporaryPath);
    }
  }

  const storedContent = readFileSync(filePath);
  if (hashContent(storedContent) !== contentHash) {
    throw new Error(`Cold object ${contentHash} failed its integrity check.`);
  }
  chmodSync(filePath, 0o600);
};

// Store canonical bytes before committing metadata so a database reference never points to a partial file.
export const storeColdObject = (
  database: BetterSqlite3.Database,
  paths: StoragePaths,
  content: string | Uint8Array,
  metadata: ColdObjectMetadata,
): StoredColdObject => {
  if (metadata.category.trim().length === 0) {
    throw new Error("Cold object category must not be empty.");
  }

  const contentBytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const contentHash = hashContent(contentBytes);
  const id = `szal://cold/sha256/${contentHash}`;
  const referenceId = metadata.referenceId ?? randomUUID();
  const relativePath = join("sha256", contentHash.slice(0, 2), contentHash);
  const filePath = join(paths.coldDirectory, relativePath);
  const createdAt = metadata.createdAt ?? new Date().toISOString();

  writeColdPayload(filePath, contentBytes, contentHash);

  const recordMetadata = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO cold_objects (id, content_hash, relative_path, raw_bytes, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(id, contentHash, relativePath, contentBytes.byteLength, createdAt);
    database
      .prepare(
        `INSERT INTO cold_object_references (
           id, cold_object_id, session_id, project_id, category, raw_tokens,
           compressed_tokens, compressor, compression_mode, source_tool,
           source_path, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        referenceId,
        id,
        metadata.sessionId ?? null,
        metadata.projectId ?? null,
        metadata.category,
        metadata.rawTokens ?? null,
        metadata.compressedTokens ?? null,
        metadata.compressor ?? null,
        metadata.compressionMode ?? null,
        metadata.sourceTool ?? null,
        metadata.sourcePath ?? null,
        createdAt,
        metadata.expiresAt ?? null,
      );
  });

  recordMetadata.immediate();

  return { contentHash, filePath, id, referenceId };
};
