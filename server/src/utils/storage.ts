import { path_join } from "./path";
import { buildS3ObjectUrl, createS3Client, deleteObject as deleteS3Object, putObject as putS3Object } from "./s3";

type StorageTarget =
  | {
      type: "r2";
      bucket: R2Bucket;
      folder: string;
      publicBaseUrl: string;
    }
  | {
      type: "s3";
      env: Env;
      folder: string;
      publicBaseUrl: string;
    };

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function resolveStorageTarget(env: Env): StorageTarget {
  const folder = env.S3_FOLDER || "";
  const publicBaseUrl = trimTrailingSlash(env.S3_ACCESS_HOST || env.S3_ENDPOINT || "");

  if (env.R2_BUCKET) {
    return {
      type: "r2",
      bucket: env.R2_BUCKET,
      folder,
      publicBaseUrl,
    };
  }

  if (!env.S3_ENDPOINT) {
    throw new Error("S3_ENDPOINT is not defined");
  }
  if (!env.S3_ACCESS_KEY_ID) {
    throw new Error("S3_ACCESS_KEY_ID is not defined");
  }
  if (!env.S3_SECRET_ACCESS_KEY) {
    throw new Error("S3_SECRET_ACCESS_KEY is not defined");
  }
  if (!env.S3_BUCKET) {
    throw new Error("S3_BUCKET is not defined");
  }

  return {
    type: "s3",
    env,
    folder,
    publicBaseUrl,
  };
}

function encodeStorageKey(key: string) {
  return key
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildBlobUrl(storageKey: string, baseUrl?: string) {
  const encodedKey = encodeStorageKey(storageKey);
  const path = `/api/blob/${encodedKey}`;

  if (!baseUrl) {
    return path;
  }

  return `${trimTrailingSlash(baseUrl)}${path}`;
}

function createStorageResponse(
  object: R2ObjectBody | R2Object,
  body?: BodyInit | null,
  status = 200,
  extraHeaders?: HeadersInit,
) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);

  if (object.httpEtag) {
    headers.set("ETag", object.httpEtag);
  }

  if (!headers.has("Content-Length")) {
    headers.set("Content-Length", String(object.size));
  }

  if (!headers.has("Last-Modified")) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }

  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }

  if (!headers.has("Access-Control-Allow-Origin")) {
    headers.set("Access-Control-Allow-Origin", "*");
  }

  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }

  return new Response(body ?? null, {
    status,
    headers,
  });
}

function parseRange(rangeHeader: string | undefined, size: number) {
  if (!rangeHeader?.startsWith("bytes=") || size <= 0) {
    return undefined;
  }

  const [range] = rangeHeader.slice(6).split(",", 1);
  const [startText, endText] = (range || "").split("-", 2);
  const suffixRange = !startText;
  const start = suffixRange ? Math.max(0, size - Number.parseInt(endText || "0", 10)) : Number.parseInt(startText, 10);
  const end = suffixRange ? size - 1 : (endText ? Number.parseInt(endText, 10) : size - 1);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
    return undefined;
  }

  return {
    offset: start,
    length: Math.min(end, size - 1) - start + 1,
    end: Math.min(end, size - 1),
  };
}

export async function getStorageObject(env: Env, storageKey: string, rangeHeader?: string): Promise<Response | null> {
  if (env.R2_BUCKET) {
    const head = rangeHeader ? await env.R2_BUCKET.head(storageKey) : null;
    if (rangeHeader && !head) {
      return null;
    }
    const range = parseRange(rangeHeader, head?.size ?? 0);
    const object = await env.R2_BUCKET.get(
      storageKey,
      range ? { range: { offset: range.offset, length: range.length } } : undefined,
    );
    if (!object) {
      return null;
    }
    const extraHeaders: Record<string, string> = range
      ? {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${range.offset}-${range.end}/${head?.size ?? object.size}`,
          "Content-Length": String(range.length),
        }
      : { "Accept-Ranges": "bytes" };
    return createStorageResponse(object, object.body, range ? 206 : 200, extraHeaders);
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "GET",
    headers: rangeHeader ? { Range: rangeHeader } : undefined,
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function headStorageObject(env: Env, storageKey: string): Promise<Response | null> {
  if (env.R2_BUCKET) {
    const object = await env.R2_BUCKET.head(storageKey);
    if (!object) {
      return null;
    }
    return createStorageResponse(object);
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "HEAD",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to inspect storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export function getStoragePublicUrl(env: Env, storageKey: string, baseUrl?: string) {
  if (env.S3_ACCESS_HOST) {
    return `${trimTrailingSlash(env.S3_ACCESS_HOST)}/${storageKey}`;
  }

  return buildBlobUrl(storageKey, baseUrl);
}

export async function putStorageObject(
  env: Env,
  key: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
) {
  const target = resolveStorageTarget(env);
  const storageKey = path_join(target.folder, key);

  return putStorageObjectAtKey(env, storageKey, body, contentType, baseUrl);
}

export async function putStorageObjectAtKey(
  env: Env,
  storageKey: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
) {
  if (env.R2_BUCKET) {
    await env.R2_BUCKET.put(storageKey, body, {
      httpMetadata: contentType ? { contentType } : undefined,
    });
  } else {
    const client = createS3Client(env);
    await putS3Object(client, env, storageKey, body, contentType);
  }

  return {
    key: storageKey,
    url: getStoragePublicUrl(env, storageKey, baseUrl),
  };
}

export async function deleteStorageObject(env: Env, storageKey: string) {
  if (env.R2_BUCKET) {
    await env.R2_BUCKET.delete(storageKey);
    return;
  }

  const client = createS3Client(env);
  await deleteS3Object(client, env, storageKey);
}
