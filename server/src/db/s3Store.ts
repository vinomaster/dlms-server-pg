/**
 * s3Store.ts
 *
 * Manages binary attachment storage in Amazon S3.
 * Metadata is persisted to PostgreSQL via PgAdapter; this module handles
 * only the actual bytes.
 *
 * Environment variables
 * ─────────────────────
 *   ATTACHMENTS_BUCKET   S3 bucket name (required)
 *   AWS_REGION           Region (default: us-east-1)
 *   S3_ENDPOINT          Optional custom endpoint (for LocalStack dev)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { logger } from "../logger";

export class S3Store {
  private s3: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = process.env.ATTACHMENTS_BUCKET ?? "dlms-attachments";
    const region = process.env.AWS_REGION ?? "us-east-1";

    const config: any = { region };
    if (process.env.S3_ENDPOINT) {
      config.endpoint = process.env.S3_ENDPOINT;
      config.forcePathStyle = true; // needed for LocalStack
    }
    this.s3 = new S3Client(config);
  }

  /**
   * Upload a file buffer/stream to S3.
   * Returns the S3 key under which the file is stored.
   */
  async upload(
    collection: string,
    docId: string,
    attachmentId: string,
    filename: string,
    body: Buffer | Readable,
    contentType: string
  ): Promise<string> {
    const key = `${collection}/${docId}/${attachmentId}/${filename}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: "aws:kms", // enforce encryption at rest
        Tagging: `dlms_collection=${collection}&dlms_doc=${docId}`,
      })
    );
    logger.info(`Uploaded attachment to s3://${this.bucket}/${key}`);
    return key;
  }

  /**
   * Stream a file from S3.
   */
  async download(s3Key: string): Promise<Readable> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: s3Key })
    );
    return res.Body as Readable;
  }

  /**
   * Generate a pre-signed URL valid for `expiresIn` seconds (default 15 min).
   * Useful for direct browser download without proxying through the app server.
   */
  async presignedUrl(s3Key: string, expiresIn = 900): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
      { expiresIn }
    );
  }

  /**
   * Delete a file from S3.
   */
  async delete(s3Key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: s3Key }));
    logger.info(`Deleted attachment s3://${this.bucket}/${s3Key}`);
  }

  /**
   * Check whether an object exists in S3.
   */
  async exists(s3Key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key }));
      return true;
    } catch {
      return false;
    }
  }
}
