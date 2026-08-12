import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { config, photoSharingConfigured } from "./config.js";

const client = photoSharingConfigured ? new S3Client({
  region: "auto",
  endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
  },
}) : null;

function datePath(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function uploadVisitorPhoto(body: Buffer): Promise<{ downloadUrl: string; expiresAt: string; objectKey: string }> {
  if (!client || !photoSharingConfigured) throw new Error("Photo sharing is not configured.");
  const objectKey = `eidos-photos/${datePath(new Date())}/${randomUUID()}.jpg`;
  await client.send(new PutObjectCommand({
    Bucket: config.r2BucketName,
    Key: objectKey,
    Body: body,
    ContentType: "image/jpeg",
    ContentDisposition: 'inline; filename="eidos-photo.jpg"',
    CacheControl: `private, max-age=${config.photoUrlTtlSeconds}`,
    Metadata: { source: "eidos-kiosk" },
  }));
  const signedDownloadUrl = await getSignedUrl(client, new GetObjectCommand({
    Bucket: config.r2BucketName,
    Key: objectKey,
    ResponseContentDisposition: 'inline; filename="eidos-photo.jpg"',
  }), { expiresIn: config.photoUrlTtlSeconds });
  const expiresAt = new Date(Date.now() + config.photoUrlTtlSeconds * 1000).toISOString();
  return { downloadUrl: signedDownloadUrl, expiresAt, objectKey };
}

export async function removeVisitorPhoto(objectKey: string): Promise<void> {
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: config.r2BucketName, Key: objectKey }));
}
