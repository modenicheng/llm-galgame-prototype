/**
 * PcmDecoder — converts pcm_s16le byte chunks into Int16Array samples.
 *
 * Network chunks are not guaranteed to end on a 16-bit sample boundary
 * (§10.2), so a trailing single byte is preserved across pushes and
 * concatenated with the next chunk. Little-endian, fixed internal format
 * (§10.1): pcm_s16le, 22050 Hz, 1ch, 16-bit.
 */
export class PcmDecoder {
  private pendingByte: number | null = null;

  /** Decode a byte chunk, returning all complete samples it contains. */
  push(chunk: Uint8Array): Int16Array {
    const hasPending = this.pendingByte !== null;
    const consumed = chunk.length + (hasPending ? 1 : 0);
    const sampleCount = consumed >> 1;
    const out = new Int16Array(sampleCount);

    let read = 0;
    let write = 0;
    if (hasPending) {
      // The pending byte is the low byte of the next sample; the first
      // byte of this chunk is its high byte.
      out[write] = littleEndianSample(this.pendingByte!, chunk[read]!);
      write++;
      read++;
    }
    while (write < sampleCount) {
      out[write] = littleEndianSample(chunk[read]!, chunk[read + 1]!);
      write++;
      read += 2;
    }

    if ((consumed & 1) === 1) {
      const last = chunk[chunk.length - 1];
      this.pendingByte = last ?? this.pendingByte;
    } else {
      this.pendingByte = null;
    }
    return out;
  }

  /** Return the remaining partial sample (if any) as a 1-element array. */
  flush(): Int16Array {
    const pending = this.pendingByte;
    this.pendingByte = null;
    if (pending === null) {
      return new Int16Array(0);
    }
    // The single byte is the low byte of a sample whose high byte never arrived.
    return new Int16Array([littleEndianSample(pending, 0)]);
  }

  /** Drop any pending partial byte. */
  reset(): void {
    this.pendingByte = null;
  }
}

/** Combine two bytes into a signed little-endian 16-bit sample. */
function littleEndianSample(lo: number, hi: number): number {
  const u = (lo & 0xff) | ((hi & 0xff) << 8);
  return u >= 0x8000 ? u - 0x10000 : u;
}
