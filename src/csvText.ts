// CSV text decoding shared by the attribute-table CSV importers.
// Our own exports are UTF-8 with BOM, but Excel on zh-TW Windows saves
// "CSV (逗號分隔)" as Big5 / cp950 — try strict UTF-8 first, then fall back.
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  try {
    // fatal: throw on invalid UTF-8 instead of producing U+FFFD; BOM is stripped by default.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('big5').decode(bytes);
  }
}

export async function readCsvText(file: Blob): Promise<string> {
  return decodeCsvBytes(await file.arrayBuffer());
}
