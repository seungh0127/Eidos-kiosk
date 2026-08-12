import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, photoSharingConfigured } from "./config.js";
import { renderPhotoSharePage } from "./photo-share-page.js";

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

function compactShareSignature(payload: string): string {
  return createHmac("sha256", config.r2SecretAccessKey)
    .update(payload)
    .digest("base64url")
    .slice(0, 10);
}

export type VisitorPhotoUpload = {
  shareUrl: string;
  sharePath: string;
  downloadUrl: string;
  expiresAt: string;
  objectKey: string;
};

export async function uploadVisitorPhoto(body: Buffer): Promise<VisitorPhotoUpload> {
  if (!client || !photoSharingConfigured) throw new Error("Photo sharing is not configured.");
  const createdAt = new Date();
  // A short, URL-safe id keeps the public QR path compact while retaining
  // enough entropy for temporary exhibition photos.
  const shareId = randomBytes(9).toString("base64url");
  const photoDatePath = datePath(createdAt);
  const objectKey = `eidos-photos/${photoDatePath}/${shareId}.jpg`;
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

  // The QR code doesn't point at the raw image — it points at a small,
  // self-contained HTML page (also uploaded to R2, alongside the photo)
  // that presents it in the kiosk's own visual style instead of just
  // opening a bare JPEG in the visitor's phone browser.
  const pageKey = objectKey.replace(/\.jpg$/, ".html");
  const page = renderPhotoSharePage({ imageUrl: signedDownloadUrl });
  await client.send(new PutObjectCommand({
    Bucket: config.r2BucketName,
    Key: pageKey,
    Body: page,
    ContentType: "text/html; charset=utf-8",
    ContentDisposition: 'inline; filename="eidos-photo.html"',
    CacheControl: `private, max-age=${config.photoUrlTtlSeconds}`,
    Metadata: { source: "eidos-kiosk" },
  }));
  const signedShareUrl = await getSignedUrl(client, new GetObjectCommand({
    Bucket: config.r2BucketName,
    Key: pageKey,
    ResponseContentDisposition: 'inline; filename="eidos-photo.html"',
  }), { expiresIn: config.photoUrlTtlSeconds });

  const expiresAtMs = Date.now() + config.photoUrlTtlSeconds * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const compactDate = photoDatePath.replaceAll("-", "");
  const compactExpiry = Math.floor(expiresAtMs / 1000).toString(36);
  const compactPayload = `${compactDate}.${compactExpiry}.${shareId}`;
  const sharePath = `/p/${compactDate}/${compactExpiry}/${shareId}/${compactShareSignature(compactPayload)}`;
  return { shareUrl: signedShareUrl, sharePath, downloadUrl: signedDownloadUrl, expiresAt, objectKey };
}

/**
 * Resolve the deliberately short URL encoded in the QR into a fresh signed
 * R2 URL. The path contains only the date, expiry and random photo id, so it
 * remains sparse enough for a visually simple QR without making the bucket
 * public.
 */
export async function resolveVisitorPhotoShare(
  compactDate: string,
  compactExpiry: string,
  shareId: string,
  signature: string,
): Promise<string | null> {
  if (!client || !photoSharingConfigured) return null;
  if (!/^\d{8}$/.test(compactDate)) return null;
  if (!/^[0-9a-z]+$/.test(compactExpiry)) return null;
  if (!/^[A-Za-z0-9_-]{12}$/.test(shareId)) return null;
  if (!/^[A-Za-z0-9_-]{10}$/.test(signature)) return null;

  const expectedSignature = compactShareSignature(`${compactDate}.${compactExpiry}.${shareId}`);
  const receivedSignature = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
  if (
    receivedSignature.length !== expectedSignatureBuffer.length
    || !timingSafeEqual(receivedSignature, expectedSignatureBuffer)
  ) return null;

  const expiresAtSeconds = Number.parseInt(compactExpiry, 36);
  const remainingSeconds = expiresAtSeconds - Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiresAtSeconds) || remainingSeconds <= 0) return null;

  const year = compactDate.slice(0, 4);
  const month = compactDate.slice(4, 6);
  const day = compactDate.slice(6, 8);
  const parsedDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || datePath(parsedDate) !== `${year}-${month}-${day}`) return null;

  const pageKey = `eidos-photos/${year}-${month}-${day}/${shareId}.html`;
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: config.r2BucketName,
    Key: pageKey,
    ResponseContentDisposition: 'inline; filename="eidos-photo.html"',
  }), {
    expiresIn: Math.max(1, Math.min(config.photoUrlTtlSeconds, remainingSeconds)),
  });
}

export async function removeVisitorPhoto(objectKey: string): Promise<void> {
  if (!client) return;
  await Promise.all([
    client.send(new DeleteObjectCommand({ Bucket: config.r2BucketName, Key: objectKey })),
    client.send(new DeleteObjectCommand({ Bucket: config.r2BucketName, Key: objectKey.replace(/\.jpg$/, ".html") })),
  ]);
}
