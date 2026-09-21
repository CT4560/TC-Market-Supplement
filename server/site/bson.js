// WebSocket 測試用的最小 BSON 編解碼，只支援這個服務會用到的型別。

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function int32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
}

function cstring(text) {
  return concat([encoder.encode(text), new Uint8Array([0])]);
}

function encodeElement(key, value) {
  const name = cstring(key);

  if (typeof value === "string") {
    const text = encoder.encode(value);
    return concat([new Uint8Array([0x02]), name, int32(text.length + 1), text, new Uint8Array([0])]);
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
      return concat([new Uint8Array([0x10]), name, int32(value)]);
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return concat([new Uint8Array([0x01]), name, bytes]);
  }
  if (typeof value === "boolean") return concat([new Uint8Array([0x08]), name, new Uint8Array([value ? 1 : 0])]);
  if (value === null) return concat([new Uint8Array([0x0a]), name]);
  if (Array.isArray(value)) {
    const asObject = Object.fromEntries(value.map((item, index) => [String(index), item]));
    return concat([new Uint8Array([0x04]), name, encode(asObject)]);
  }
  if (typeof value === "object") return concat([new Uint8Array([0x03]), name, encode(value)]);
  throw new Error(`不支援的型別：${typeof value}`);
}

export function encode(document) {
  const elements = Object.entries(document)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => encodeElement(key, value));
  const body = concat(elements);
  return concat([int32(body.length + 5), body, new Uint8Array([0])]);
}

function readCString(bytes, offset) {
  let end = offset;
  while (bytes[end] !== 0) end++;
  return [decoder.decode(bytes.subarray(offset, end)), end + 1];
}

function readValue(type, bytes, view, offset) {
  switch (type) {
    case 0x01:
      return [view.getFloat64(offset, true), offset + 8];
    case 0x02: {
      const length = view.getInt32(offset, true);
      return [decoder.decode(bytes.subarray(offset + 4, offset + 4 + length - 1)), offset + 4 + length];
    }
    case 0x03:
    case 0x04: {
      const size = view.getInt32(offset, true);
      const inner = decodeAt(bytes.subarray(offset, offset + size), type === 0x04);
      return [inner, offset + size];
    }
    case 0x05: {
      const length = view.getInt32(offset, true);
      return [bytes.slice(offset + 5, offset + 5 + length), offset + 5 + length];
    }
    case 0x07:
      return [Array.from(bytes.subarray(offset, offset + 12), (b) => b.toString(16).padStart(2, "0")).join(""), offset + 12];
    case 0x08:
      return [bytes[offset] === 1, offset + 1];
    case 0x09:
    case 0x11:
    case 0x12: {
      const big = view.getBigInt64(offset, true);
      const asNumber = Number(big);
      return [Number.isSafeInteger(asNumber) ? asNumber : big.toString(), offset + 8];
    }
    case 0x0a:
      return [null, offset];
    case 0x10:
      return [view.getInt32(offset, true), offset + 4];
    default:
      throw new Error(`不支援的 BSON 型別 0x${type.toString(16)}`);
  }
}

function decodeAt(bytes, asArray) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getInt32(0, true);
  if (size !== bytes.length) throw new Error("BSON 長度不符");

  const result = asArray ? [] : {};
  let offset = 4;
  while (offset < size - 1) {
    const type = bytes[offset++];
    let key;
    [key, offset] = readCString(bytes, offset);
    let value;
    [value, offset] = readValue(type, bytes, view, offset);
    if (asArray) result.push(value);
    else result[key] = value;
  }
  return result;
}

export function decode(bytes) {
  return decodeAt(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), false);
}
