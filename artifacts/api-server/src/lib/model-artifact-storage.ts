import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function storagePath(): { bucketName: string; prefix: string } {
  const raw = process.env.PRIVATE_OBJECT_DIR;
  if (!raw) throw new Error("PRIVATE_OBJECT_DIR is not configured for model artifacts.");
  const parts = raw.replace(/^\/+/, "").split("/").filter(Boolean);
  if (!parts[0]) throw new Error("PRIVATE_OBJECT_DIR must include a bucket name.");
  return { bucketName: parts[0], prefix: parts.slice(1).join("/") };
}

function parseArtifactKey(artifactKey: string): { bucketName: string; objectName: string } {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(artifactKey);
  if (!match) throw new Error("Model artifact key is not a valid gs:// object path.");
  return { bucketName: match[1], objectName: match[2] };
}

/**
 * Writes a fresh immutable-generation artifact. A generation precondition
 * prevents accidental or concurrent replacement at the object name.
 */
export async function storeModelArtifact(
  versionId: string,
  content: string,
  contentHash: string,
): Promise<{ artifactKey: string; artifactGeneration: string }> {
  const { bucketName, prefix } = storagePath();
  const objectName = [prefix, "model-artifacts", `${versionId}.json`].filter(Boolean).join("/");
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  await file.save(Buffer.from(content, "utf8"), {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    contentType: "application/json",
    metadata: {
      cacheControl: "no-store",
      metadata: { sha256: contentHash, modelVersionId: versionId },
    },
  });
  const [metadata] = await file.getMetadata();
  if (!metadata.generation) throw new Error("App Storage did not return an immutable artifact generation.");
  return {
    artifactKey: `gs://${bucketName}/${objectName}`,
    artifactGeneration: String(metadata.generation),
  };
}

/**
 * Future model readers must call this before using a serialized artifact.
 * It reads the pinned Cloud Storage generation and rejects tampered bytes.
 */
export async function verifyModelArtifact(
  artifactKey: string,
  artifactGeneration: string,
  expectedContentHash: string,
): Promise<string> {
  const { bucketName, objectName } = parseArtifactKey(artifactKey);
  const [bytes] = await objectStorageClient
    .bucket(bucketName)
    .file(objectName, { generation: artifactGeneration })
    .download();
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedContentHash) {
    throw new Error(`Model artifact hash verification failed for ${artifactKey}.`);
  }
  return bytes.toString("utf8");
}