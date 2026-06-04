import * as net from 'net';
import { EventEmitter } from 'events';
import { Logger } from 'homebridge';
import { SiaMessage } from './events';
import { GalaxyFramer, buildFrame, GALAXY_HEADER } from './galaxy-protocol';
import { parseGalaxyEvent } from './galaxy-parser';

export interface SiaServerOptions {
  port: number;
  account: string;
  userCode: string; // reserved for Phase 2 (Seasoft Gateway integration)
  log: Logger;
}

export declare interface SiaServer {
  on(event: 'message', listener: (msg: SiaMessage) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export class SiaServer extends EventEmitter {
  private server: net.Server;
  private readonly opts: SiaServerOptions;

  constructor(opts: SiaServerOptions) {
    super();
    this.opts = opts;
    this.server = net.createServer(sock => this.handleConnection(sock));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, () => {
        this.opts.log.info(`Galaxy receiver listening on port ${this.opts.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private handleConnection(sock: net.Socket): void {
    const remote    = `${sock.remoteAddress}:${sock.remotePort}`;
    const connStart = Date.now();
    this.opts.log.info(`SIA: verbinding van ${remote}`);

    const framer = new GalaxyFramer();
    let handshakeDone = false;

    sock.on('data', (chunk: Buffer) => {
      const t = Date.now() - connStart;

      // Handshake
      if (!handshakeDone && chunk.slice(0, 2).equals(GALAXY_HEADER)) {
        handshakeDone = true;
        try {
          sock.write(Buffer.from([0x50, 0x01, 0x00, 0x6d, 0xff]));
          this.opts.log.info(`SIA: handshake ACK verstuurd (${t}ms)`);
        } catch (e) {
          this.opts.log.error(`SIA: handshake schrijven mislukt (${t}ms): ${e}`);
        }
      }

      const frames = framer.feed(chunk);

      if (frames.length === 0 && chunk.length > 0) {
        this.opts.log.warn(`SIA: onbekend pakket (${chunk.toString('hex')}) na ${t}ms`);
        try { sock.write(buildFrame('ACKNOWLEDGE')); } catch (_) { /* ignore */ }
      }

      for (const frame of frames) {
        // ACK every frame
        try {
          sock.write(buildFrame('ACKNOWLEDGE'));
          this.opts.log.info(`SIA: ACK verstuurd voor ${frame.command} (${Date.now() - connStart}ms)`);
        } catch (e) {
          this.opts.log.error(`SIA: ACK schrijven mislukt voor ${frame.command}: ${e}`);
        }

        if (frame.command === 'END_OF_DATA') {
          this.opts.log.info(`SIA: sessie afgerond (${Date.now() - connStart}ms totaal)`);
          continue;
        }

        if (frame.command === 'ACCOUNT_ID') {
          const account = frame.payload.toString('ascii').replace(/\0/g, '').trim();
          if (this.opts.account && account !== this.opts.account) {
            this.opts.log.warn(`SIA: account mismatch: ontvangen=${account}, verwacht=${this.opts.account}`);
          }
          continue;
        }

        if (frame.command === 'NEW_EVENT' || frame.command === 'OLD_EVENT') {
          const msg = parseGalaxyEvent(frame.payload, this.opts.log);
          if (msg) {
            this.opts.log.info(
              `SIA event: code=${msg.eventCode}` +
              (msg.zone !== null ? ` zone=${msg.zone}` : '') +
              ` (${Date.now() - connStart}ms)`,
            );
            this.emit('message', msg);
          }
          continue;
        }

        if (frame.command === 'ASCII') {
          this.opts.log.info(`SIA ASCII: ${frame.payload.toString('ascii')}`);
        }
      }
    });

    sock.on('error', err => {
      this.opts.log.error(`SIA: socket fout van ${remote} na ${Date.now() - connStart}ms: ${err.message}`);
    });
    sock.on('close', () => {
      this.opts.log.info(`SIA: verbinding gesloten ${remote} (duur: ${Date.now() - connStart}ms)`);
    });
  }
}
