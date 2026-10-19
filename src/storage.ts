import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "./config.js";

// Le stockage objets : S3 compatible (Tigris ou R2) en production, un dossier local en dev et en test.
// Dans les deux cas, les octets circulent par URL signée à durée courte, jamais par le chat.
export interface ObjectStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  signedGetUrl(key: string, ttlSeconds: number, downloadName?: string): Promise<string>;
  signedPutUrl(key: string, ttlSeconds: number, contentType: string): Promise<string>;
}

export class S3Store implements ObjectStore {
  private client: S3Client;
  // Client de signature : sur le domaine média autorisé (canal A) quand il existe, sinon le même client.
  private signer: S3Client;
  private signBucket: string;
  constructor(
    private bucket: string,
    opts: { endpoint?: string; region: string; publicBase?: string },
  ) {
    this.client = new S3Client({ region: opts.region, endpoint: opts.endpoint });
    if (opts.publicBase) {
      // Le domaine média (ex. https://media.example.com) est un domaine personnalisé du bucket :
      // le SDK le prend comme point d'accès complet du bucket, les URL signées portent donc ce domaine.
      this.signer = new S3Client({ region: opts.region, endpoint: opts.publicBase, bucketEndpoint: true });
      this.signBucket = opts.publicBase;
    } else {
      this.signer = this.client;
      this.signBucket = bucket;
    }
  }
  async put(key: string, data: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }
  async get(key: string) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }
  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return false;
      throw e;
    }
  }
  async signedGetUrl(key: string, ttlSeconds: number, downloadName?: string) {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.signBucket,
        Key: key,
        ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName}"` : undefined,
      }),
      { expiresIn: ttlSeconds },
    );
  }
  async signedPutUrl(key: string, ttlSeconds: number, contentType: string) {
    return getSignedUrl(this.signer, new PutObjectCommand({ Bucket: this.signBucket, Key: key, ContentType: contentType }), {
      expiresIn: ttlSeconds,
    });
  }
}

// Stockage local : les URL signées pointent sur /files/<clé> du service lui-même, signées par HMAC.
export class LocalStore implements ObjectStore {
  constructor(
    private dir: string,
    private publicUrl: string,
    private secret: string,
  ) {}
  private file(key: string) {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(path.resolve(this.dir) + path.sep)) throw new Error("clé invalide");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.file(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    return readFile(this.file(key));
  }
  async exists(key: string) {
    try {
      await stat(this.file(key));
      return true;
    } catch {
      return false;
    }
  }
  sign(method: string, key: string, exp: number) {
    return createHmac("sha256", this.secret).update(`${method}\n${key}\n${exp}`).digest("base64url");
  }
  verify(method: string, key: string, exp: number, sig: string) {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const want = Buffer.from(this.sign(method, key, exp));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }
  private url(method: string, key: string, ttl: number) {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return `${this.publicUrl}/files/${key}?exp=${exp}&sig=${this.sign(method, key, exp)}`;
  }
  async signedGetUrl(key: string, ttlSeconds: number) {
    return this.url("GET", key, ttlSeconds);
  }
  async signedPutUrl(key: string, ttlSeconds: number) {
    return this.url("PUT", key, ttlSeconds);
  }
}

export function makeStore(config: Config): ObjectStore {
  const s = config.storage;
  if (s.kind === "s3") return new S3Store(s.bucket, s);
  return new LocalStore(s.dir, config.publicUrl, config.tokenSecret);
}
