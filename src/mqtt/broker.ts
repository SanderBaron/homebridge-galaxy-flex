import { Aedes, AedesOptions } from 'aedes';
import * as net from 'net';
import { Logger } from 'homebridge';

export interface BrokerOptions {
  port: number;
  username?: string;
  password?: string;
}

export class MqttBroker {
  private aedes?: Aedes;
  private server?: net.Server;

  constructor(private readonly log: Logger, private readonly opts: BrokerOptions) {}

  async start(): Promise<void> {
    const aedesOpts: AedesOptions = {};

    if (this.opts.username && this.opts.password) {
      const { username, password } = this.opts;
      aedesOpts.authenticate = (_client, user, pass, cb) => {
        const ok = user?.toString() === username && pass?.toString() === password;
        cb(null, ok);
      };
      this.log.debug('MQTT broker: authentication enabled');
    }

    this.aedes = await (Aedes as unknown as {
      createBroker(opts?: AedesOptions): Promise<Aedes>;
    }).createBroker(aedesOpts);

    this.server = net.createServer(this.aedes.handle.bind(this.aedes));

    return new Promise((resolve, reject) => {
      this.server!.listen(this.opts.port, '0.0.0.0', () => {
        this.log.info(`MQTT broker listening on port ${this.opts.port}`);
        resolve();
      });
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.log.warn(
            `MQTT broker: port ${this.opts.port} already in use. ` +
            'Set "mqttExternalBroker": true in config if you have an existing broker.',
          );
        }
        reject(err);
      });
    });
  }

  stop(): void {
    this.aedes?.close(() => {});
    this.server?.close();
  }
}
