// Galaxy Flex proprietary IP receiver protocol.
//
// Frame format (plaintext, after optional 05 01 prefix):
//   [length_byte]  = payload_length + 0x40
//   [command_byte] = one of COMMANDS below
//   [payload...]   = variable length
//   [checksum]     = XOR of all preceding bytes, seeded with 0xFF
//
// The panel always opens with a 05 01 prefix; strip it before parsing frames.

export const GALAXY_HEADER = Buffer.from([0x05, 0x01]);

export const COMMANDS: Record<number, string> = {
  0x23: 'ACCOUNT_ID',
  0x4e: 'NEW_EVENT',
  0x41: 'ASCII',
  0x30: 'END_OF_DATA',
  0x38: 'ACKNOWLEDGE',
  0x39: 'REJECT',
  0x31: 'WAIT',
  0x32: 'ABORT',
  0x36: 'ACK_AND_STANDBY',
  0x37: 'ACK_AND_DISCONNECT',
  0x08: 'ALT_ACKNOWLEDGE',
  0x09: 'ALT_REJECT',
  0x43: 'CONTROL',
  0x3f: 'REMOTE_LOGIN',
  0x45: 'ENVIRONMENTAL',
  0x4f: 'OLD_EVENT',
  0x40: 'CONFIGURATION',
};

export const CMD: Record<string, number> = Object.fromEntries(
  Object.entries(COMMANDS).map(([k, v]) => [v, Number(k)]),
);

export interface GalaxyFrame {
  command: string;
  commandByte: number;
  payload: Buffer;
  checksumOk: boolean;
}

function checksum(data: Buffer): number {
  let cs = 0xff;
  for (const b of data) cs ^= b;
  return cs;
}

export function buildFrame(command: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const cmdByte = CMD[command];
  if (cmdByte === undefined) throw new Error(`Unknown Galaxy command: ${command}`);
  const lengthByte = payload.length + 0x40;
  const body = Buffer.concat([Buffer.from([lengthByte, cmdByte]), payload]);
  const cs = checksum(body);
  return Buffer.concat([body, Buffer.from([cs])]);
}

export function parseFrame(data: Buffer): GalaxyFrame | null {
  if (data.length < 3) return null;
  const lengthByte = data[0];
  const payloadLength = lengthByte - 0x40;
  if (payloadLength < 0 || data.length < 2 + payloadLength + 1) return null;

  const commandByte = data[1];
  const payload = data.slice(2, 2 + payloadLength);
  const receivedCs = data[2 + payloadLength];
  const body = data.slice(0, 2 + payloadLength);
  const expectedCs = checksum(body);

  return {
    command: COMMANDS[commandByte] ?? `UNKNOWN(0x${commandByte.toString(16)})`,
    commandByte,
    payload,
    checksumOk: receivedCs === expectedCs,
  };
}

// Accumulates TCP stream bytes and yields complete Galaxy frames.
export class GalaxyFramer {
  private buf = Buffer.alloc(0);
  private headerStripped = false;

  feed(chunk: Buffer): GalaxyFrame[] {
    this.buf = Buffer.concat([this.buf, chunk]);

    // Strip the 05 01 header once at the start of a session.
    if (!this.headerStripped) {
      if (this.buf.length < GALAXY_HEADER.length) return [];
      if (this.buf.slice(0, 2).equals(GALAXY_HEADER)) {
        this.buf = this.buf.slice(2);
      }
      this.headerStripped = true;
    }

    const frames: GalaxyFrame[] = [];

    while (this.buf.length >= 3) {
      const lengthByte = this.buf[0];
      const payloadLength = lengthByte - 0x40;

      if (payloadLength < 0) {
        // Bad length byte — skip and re-sync
        this.buf = this.buf.slice(1);
        this.headerStripped = false;
        continue;
      }

      const frameSize = 1 + 1 + payloadLength + 1; // length + command + payload + checksum
      if (this.buf.length < frameSize) break;

      const frame = parseFrame(this.buf.slice(0, frameSize));
      if (frame) frames.push(frame);
      this.buf = this.buf.slice(frameSize);
    }

    return frames;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
    this.headerStripped = false;
  }
}
