export enum Compression {
  Unknown = 0,
  None = 1,
  Gzip = 2,
  Brotli = 3,
  Zstd = 4
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function decompress(bytes: Uint8Array, compression: Compression): Promise<Uint8Array> {
  if (compression === Compression.None || compression === Compression.Unknown) {
    return bytes;
  }

  if (compression !== Compression.Gzip) {
    throw new Error(`Unsupported compression: ${compression}`);
  }

  if (typeof DecompressionStream === "undefined") {
    throw new Error("Gzip decompression requires DecompressionStream");
  }

  const stream = new Response(toArrayBuffer(bytes)).body;
  if (!stream) {
    throw new Error("Unable to create decompression stream");
  }

  const decompressed = stream.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(decompressed).arrayBuffer());
}

export async function decompressIfGzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(bytes)) {
    return bytes;
  }
  return decompress(bytes, Compression.Gzip);
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("Gzip compression requires CompressionStream");
  }

  const stream = new Response(toArrayBuffer(bytes)).body;
  if (!stream) {
    throw new Error("Unable to create compression stream");
  }

  const compressed = stream.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
