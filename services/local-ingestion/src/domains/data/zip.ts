import { closeSync, openSync, writeSync } from "node:fs";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_32 = 0xffffffff;

type CentralRecord = { name: Buffer; crc: number; method: number; compressed: number; size: number; offset: number; time: number; date: number };

function dosTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/** Minimal non-zip64 ZIP writer (deflate per entry, entries written as they are added). */
export class ZipWriter {
  private readonly fd: number;
  private offset = 0;
  private readonly records: CentralRecord[] = [];

  constructor(path: string) {
    this.fd = openSync(path, "w");
  }

  private write(buffer: Buffer): void {
    writeSync(this.fd, buffer);
    this.offset += buffer.length;
  }

  add(name: string, data: Buffer, modified = new Date()): void {
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    if (this.offset + body.length > MAX_32 || data.length > MAX_32) throw new Error("backup exceeds 4 GB zip limit");
    const nameBuf = Buffer.from(name, "utf8");
    const { time, date } = dosTime(modified);
    const record: CentralRecord = {
      name: nameBuf,
      crc: crc32(data),
      method: stored ? 0 : 8,
      compressed: body.length,
      size: data.length,
      offset: this.offset,
      time,
      date
    };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(record.method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(record.crc, 14);
    header.writeUInt32LE(record.compressed, 18);
    header.writeUInt32LE(record.size, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    this.write(header);
    this.write(nameBuf);
    this.write(body);
    this.records.push(record);
  }

  close(): number {
    const start = this.offset;
    for (const record of this.records) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_SIG, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(record.method, 10);
      header.writeUInt16LE(record.time, 12);
      header.writeUInt16LE(record.date, 14);
      header.writeUInt32LE(record.crc, 16);
      header.writeUInt32LE(record.compressed, 20);
      header.writeUInt32LE(record.size, 24);
      header.writeUInt16LE(record.name.length, 28);
      header.writeUInt32LE(record.offset, 42);
      this.write(header);
      this.write(record.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIG, 0);
    end.writeUInt16LE(this.records.length, 8);
    end.writeUInt16LE(this.records.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    this.write(end);
    closeSync(this.fd);
    return this.offset;
  }
}

export type ZipEntry = { name: string; size: number; read(): Buffer };

export class InvalidZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidZipError";
  }
}

/** Lists entries of an in-memory ZIP; `read()` inflates and verifies CRC on demand. */
export function readZip(buffer: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new InvalidZipError("not a zip archive");
  const count = buffer.readUInt16LE(end + 10);
  let pos = buffer.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CENTRAL_SIG) throw new InvalidZipError("corrupt central directory");
    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const compressed = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const offset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;
    entries.push({
      name,
      size,
      read() {
        if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIG) throw new InvalidZipError(`corrupt entry ${name}`);
        const dataStart = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
        const raw = buffer.subarray(dataStart, dataStart + compressed);
        let data: Buffer;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = inflateRawSync(raw);
        else throw new InvalidZipError(`unsupported compression for ${name}`);
        if (crc32(data) !== crc) throw new InvalidZipError(`checksum mismatch for ${name}`);
        return data;
      }
    });
  }
  return entries;
}
