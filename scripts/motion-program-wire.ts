/**
 * Канонический бинарный эталон MotionProgram V1 для conformance и нативных портов.
 *
 * Файл намеренно живёт в scripts/: вне точек входа пакета и браузерной типизации.
 * Браузер исполняет разобранные кортежи и не получает бинарный кодек, TextEncoder
 * или TextDecoder из этого модуля.
 * «Канонический» здесь означает одно кодирование валидированного tuple graph;
 * удаление неиспользуемых таблиц и сортировка по первому использованию — задача
 * compiler, а не скрытая семантическая нормализация wire-кодека.
 */

import {
  MOTION_PROGRAM_LIMITS_V1,
  MOTION_PROGRAM_SUPPORTED_FEATURES_V1,
  MotionProgramParseError,
  parseMotionProgramV1,
  type MotionProgramBindingV1,
  type MotionProgramCurveV1,
  type MotionProgramEncodedValueV1,
  type MotionProgramSegmentV1,
  type MotionProgramTrackV1,
  type MotionProgramV1,
  type MotionProgramValueExprV1,
} from '../src/internal/motion-program.js';

const MAGIC = Uint8Array.of(0x4c, 0x4d, 0x50, 0x00); // "LMP\0"
const HEADER_BYTES = 18;
const LITTLE_ENDIAN = true;

/**
 * Один элемент смыслового бюджета занимает в V1 не более 48 фиксированных байт;
 * корректный UTF-16 — не более трёх UTF-8-байт на кодовую единицу. Если запись V1
 * вырастет, менять нужно эту выведенную формулу, а не отдельно поднимать DoS-лимит.
 */
export const MOTION_PROGRAM_MAX_WIRE_BYTES_V1 =
  HEADER_BYTES +
  MOTION_PROGRAM_LIMITS_V1.maxItems * 48 +
  MOTION_PROGRAM_LIMITS_V1.maxStringCodeUnits * 3;

const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function wireFailure(): never {
  throw new MotionProgramParseError('LMP_WIRE');
}

function limitFailure(): never {
  throw new MotionProgramParseError('LMP_LIMIT');
}

function checkedSize(current: number, addition: number): number {
  const next = current + addition;
  if (
    !Number.isSafeInteger(addition) ||
    addition < 0 ||
    !Number.isSafeInteger(next) ||
    next > MOTION_PROGRAM_MAX_WIRE_BYTES_V1
  ) {
    wireFailure();
  }
  return next;
}

function encodedValueSize(value: MotionProgramEncodedValueV1): number {
  if (value[0] === 0) return 9;
  if (value[0] === 1) return 3 + (value.length - 1) * 8;
  return 3;
}

function valueExprSize(value: MotionProgramValueExprV1): number {
  if (value[0] === 0) return 1;
  if (value[0] === 1) return 1 + encodedValueSize(value[1]);
  return 2 + encodedValueSize(value[2]);
}

function curveSize(curve: MotionProgramCurveV1): number {
  if (curve === 0) return 1;
  return 3 + ((curve.length - 1) / 2) * 16;
}

function bindingSize(binding: MotionProgramBindingV1): number {
  return typeof binding[1] === 'number' ? 5 : 7;
}

function segmentSize(segment: MotionProgramSegmentV1): number {
  return 19 + valueExprSize(segment[2]) + valueExprSize(segment[3]);
}

function trackSize(track: MotionProgramTrackV1): number {
  let size = 34;
  for (const segment of track[7]) size = checkedSize(size, segmentSize(segment));
  return size;
}

class WireWriter {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset = 0;

  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }

  raw(value: Uint8Array): void {
    this.bytes.set(value, this.offset);
    this.offset += value.length;
  }

  u8(value: number): void {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  i8(value: number): void {
    this.view.setInt8(this.offset, value);
    this.offset += 1;
  }

  u16(value: number): void {
    this.view.setUint16(this.offset, value, LITTLE_ENDIAN);
    this.offset += 2;
  }

  u32(value: number): void {
    this.view.setUint32(this.offset, value, LITTLE_ENDIAN);
    this.offset += 4;
  }

  i32(value: number): void {
    this.view.setInt32(this.offset, value, LITTLE_ENDIAN);
    this.offset += 4;
  }

  f64(value: number): void {
    this.view.setFloat64(this.offset, value, LITTLE_ENDIAN);
    this.offset += 8;
  }
}

function writeEncodedValue(writer: WireWriter, value: MotionProgramEncodedValueV1): void {
  writer.u8(value[0]);
  if (value[0] === 0) {
    writer.f64(value[1]);
  } else if (value[0] === 1) {
    writer.u16(value.length - 1);
    for (let i = 1; i < value.length; i++) writer.f64(value[i]!);
  } else {
    writer.u16(value[1]);
  }
}

function writeValueExpr(writer: WireWriter, value: MotionProgramValueExprV1): void {
  writer.u8(value[0]);
  if (value[0] === 1) {
    writeEncodedValue(writer, value[1]);
  } else if (value[0] === 2) {
    writer.i8(value[1]);
    writeEncodedValue(writer, value[2]);
  }
}

/** Повторно разбирает даже брендированный вход: unsafe cast не дойдёт до аллокации. */
export function encodeMotionProgramV1(input: MotionProgramV1): Uint8Array {
  const program = parseMotionProgramV1(input);
  const encodedStrings = new Array<Uint8Array>(program[2].length);
  let size = HEADER_BYTES;
  for (let i = 0; i < program[2].length; i++) {
    const encoded = UTF8.encode(program[2][i]!);
    encodedStrings[i] = encoded;
    size = checkedSize(size, 4 + encoded.length);
  }
  for (const curve of program[3]) size = checkedSize(size, curveSize(curve));
  for (const binding of program[4]) size = checkedSize(size, bindingSize(binding));
  for (const track of program[5]) size = checkedSize(size, trackSize(track));

  const writer = new WireWriter(size);
  writer.raw(MAGIC);
  writer.u8(program[0]);
  writer.u8(0); // reserved flags are canonical zero in V1
  writer.u32(program[1]);
  writer.u16(program[2].length);
  writer.u16(program[3].length);
  writer.u16(program[4].length);
  writer.u16(program[5].length);

  for (const encoded of encodedStrings) {
    writer.u32(encoded.length);
    writer.raw(encoded);
  }
  for (const curve of program[3]) {
    if (curve === 0) {
      writer.u8(0);
    } else {
      writer.u8(1);
      writer.u16((curve.length - 1) / 2);
      for (let i = 1; i < curve.length; i++) writer.f64(curve[i]!);
    }
  }
  for (const binding of program[4]) {
    writer.u16(binding[0]);
    if (typeof binding[1] === 'number') {
      writer.u8(binding[1]);
    } else {
      writer.u8(255);
      writer.u16(binding[1][1]);
    }
    writer.u16(binding[2]);
  }
  for (const track of program[5]) {
    writer.u16(track[0]);
    writer.f64(track[1]);
    writer.f64(track[2]);
    writer.i32(track[3]);
    writer.u8(track[4]);
    writer.f64(track[5]);
    writer.u8(track[6]);
    writer.u16(track[7].length);
    for (const segment of track[7]) {
      writer.f64(segment[0]);
      writer.f64(segment[1]);
      writeValueExpr(writer, segment[2]);
      writeValueExpr(writer, segment[3]);
      writer.u16(segment[4]);
      writer.u8(segment[5]);
    }
  }
  if (writer.offset !== size) wireFailure();
  return writer.bytes;
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
)?.get;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;
const SET_BYTES = Uint8Array.prototype.set;

function snapshotBytes(input: Uint8Array): Uint8Array {
  if (!ArrayBuffer.isView(input) || TYPED_ARRAY_LENGTH === undefined || TYPED_ARRAY_TAG === undefined) {
    wireFailure();
  }
  let length: number;
  let tag: unknown;
  try {
    length = TYPED_ARRAY_LENGTH.call(input) as number;
    tag = TYPED_ARRAY_TAG.call(input);
  } catch {
    wireFailure();
  }
  if (
    tag !== 'Uint8Array' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MOTION_PROGRAM_MAX_WIRE_BYTES_V1
  ) {
    wireFailure();
  }
  const copy = new Uint8Array(length);
  try {
    SET_BYTES.call(copy, input);
  } catch {
    wireFailure();
  }
  return copy;
}

class WireReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private require(count: number): void {
    if (count < 0 || count > this.bytes.length - this.offset) wireFailure();
  }

  raw(count: number): Uint8Array {
    this.require(count);
    const start = this.offset;
    this.offset += count;
    return this.bytes.subarray(start, this.offset);
  }

  u8(): number {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  i8(): number {
    this.require(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, LITTLE_ENDIAN);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, LITTLE_ENDIAN);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.require(4);
    const value = this.view.getInt32(this.offset, LITTLE_ENDIAN);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.require(8);
    const value = this.view.getFloat64(this.offset, LITTLE_ENDIAN);
    this.offset += 8;
    return value;
  }
}

interface DecodeBudget {
  remaining: number;
}

function debit(budget: DecodeBudget, count: number): void {
  if (count < 0 || count > budget.remaining) limitFailure();
  budget.remaining -= count;
}

function readEncodedValue(reader: WireReader, budget: DecodeBudget): unknown[] {
  const tag = reader.u8();
  if (tag === 0) return [0, reader.f64()];
  if (tag === 1) {
    const count = reader.u16();
    debit(budget, count);
    const value = new Array<unknown>(count + 1);
    value[0] = 1;
    for (let i = 0; i < count; i++) value[i + 1] = reader.f64();
    return value;
  }
  if (tag === 2) return [2, reader.u16()];
  return wireFailure();
}

function readValueExpr(reader: WireReader, budget: DecodeBudget): unknown[] {
  const tag = reader.u8();
  if (tag === 0) return [0];
  if (tag === 1) return [1, readEncodedValue(reader, budget)];
  if (tag === 2) return [2, reader.i8(), readEncodedValue(reader, budget)];
  return wireFailure();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

/** Декодирует только единственное каноническое little-endian представление V1. */
export function decodeMotionProgramV1(input: Uint8Array): MotionProgramV1 {
  const bytes = snapshotBytes(input);
  const reader = new WireReader(bytes);
  if (!sameBytes(reader.raw(4), MAGIC)) wireFailure();
  const version = reader.u8();
  if (version !== 1) throw new MotionProgramParseError('LMP_VERSION');
  if (reader.u8() !== 0) wireFailure();
  const requiredFeatures = reader.u32();
  if ((requiredFeatures & ~MOTION_PROGRAM_SUPPORTED_FEATURES_V1) !== 0) {
    throw new MotionProgramParseError('LMP_FEATURE');
  }
  const stringCount = reader.u16();
  const curveCount = reader.u16();
  const bindingCount = reader.u16();
  const trackCount = reader.u16();
  const budget: DecodeBudget = { remaining: MOTION_PROGRAM_LIMITS_V1.maxItems };
  debit(budget, stringCount);
  debit(budget, curveCount);
  debit(budget, bindingCount);
  debit(budget, trackCount);

  const strings = new Array<string>(stringCount);
  let utf8Bytes = 0;
  for (let i = 0; i < stringCount; i++) {
    const count = reader.u32();
    utf8Bytes = checkedSize(utf8Bytes, count);
    if (utf8Bytes > MOTION_PROGRAM_LIMITS_V1.maxStringCodeUnits * 3) limitFailure();
    const encoded = reader.raw(count);
    let decoded: string;
    try {
      decoded = UTF8_FATAL.decode(encoded);
    } catch {
      wireFailure();
    }
    // Даже fatal UTF-8 допускает хостовую обработку BOM; точный re-encode
    // оставляет для одной последовательности скаляров единственное представление.
    if (!sameBytes(UTF8.encode(decoded), encoded)) wireFailure();
    strings[i] = decoded;
  }

  const curves = new Array<unknown>(curveCount);
  for (let i = 0; i < curveCount; i++) {
    const tag = reader.u8();
    if (tag === 0) {
      curves[i] = 0;
    } else if (tag === 1) {
      const pointCount = reader.u16();
      debit(budget, pointCount);
      const curve = new Array<unknown>(pointCount * 2 + 1);
      curve[0] = 1;
      for (let point = 0; point < pointCount; point++) {
        curve[point * 2 + 1] = reader.f64();
        curve[point * 2 + 2] = reader.f64();
      }
      curves[i] = curve;
    } else {
      wireFailure();
    }
  }

  const bindings = new Array<unknown>(bindingCount);
  for (let i = 0; i < bindingCount; i++) {
    const subject = reader.u16();
    const channelTag = reader.u8();
    const channel = channelTag === 255 ? [255, reader.u16()] : channelTag;
    bindings[i] = [subject, channel, reader.u16()];
  }

  const tracks = new Array<unknown>(trackCount);
  for (let i = 0; i < trackCount; i++) {
    const binding = reader.u16();
    const startMs = reader.f64();
    const durationMs = reader.f64();
    const repeat = reader.i32();
    const direction = reader.u8();
    const repeatDelayMs = reader.f64();
    const composite = reader.u8();
    const segmentCount = reader.u16();
    debit(budget, segmentCount);
    const segments = new Array<unknown>(segmentCount);
    for (let segment = 0; segment < segmentCount; segment++) {
      segments[segment] = [
        reader.f64(),
        reader.f64(),
        readValueExpr(reader, budget),
        readValueExpr(reader, budget),
        reader.u16(),
        reader.u8(),
      ];
    }
    tracks[i] = [
      binding,
      startMs,
      durationMs,
      repeat,
      direction,
      repeatDelayMs,
      composite,
      segments,
    ];
  }
  if (reader.offset !== bytes.length) wireFailure();
  return parseMotionProgramV1([
    version,
    requiredFeatures,
    strings,
    curves,
    bindings,
    tracks,
  ]);
}
