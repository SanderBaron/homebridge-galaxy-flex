import * as mqtt from 'mqtt';
import { EventEmitter } from 'events';
import { Logger } from 'homebridge';

export const GROUP_STATE = {
  UNSET: '0',
  FULL: '1',
  PART: '2',
  RESET: '3',
  UNKNOWN: '4',
  FORCE: '5',
  NIGHT: '6',
} as const;

export const GROUP_CMD = {
  UNSET: '0',
  FULL: '1',
  PART: '2',
  RESET: '3',
  NIGHT: '6',
} as const;

export interface ZoneStateEvent  { zone: number; active: boolean }
export interface GroupStateEvent { group: string; state: string; alarm: boolean }
export interface UserEvent {
  userId: string;   // e.g. "001"
  code: string;     // SIA code: CL, OP, CG, etc.
  text: string;     // panel description, e.g. "VOLL. ING Sander"
}

export interface MqttAuth { username?: string; password?: string }

export class SeasoftMqttClient extends EventEmitter {
  private client?: mqtt.MqttClient;
  private groupAlarmState: Map<string, boolean> = new Map();
  private _version?: string;
  private readonly baseEsc: string;

  constructor(
    private readonly log: Logger,
    private readonly brokerUrl: string,
    private readonly uniqueId: string,
    private readonly baseTopic: string = 'galaxy',
    private readonly auth: MqttAuth = {},
  ) {
    super();
    this.baseEsc = `${baseTopic}/${uniqueId}`.replace(/\//g, '\\/');
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: 'homebridge-galaxy-flex',
        clean: true,
        reconnectPeriod: 5000,
        username: this.auth.username,
        password: this.auth.password,
      });

      this.client.once('connect', () => {
        this.log.info('Seasoft MQTT: connected');
        this.subscribeToTopics();
        resolve();
      });

      this.client.on('reconnect', () => this.log.debug('Seasoft MQTT: reconnecting...'));
      this.client.on('error', (err) => {
        this.log.error(`Seasoft MQTT error: ${err.message}`);
        reject(err);
      });

      this.client.on('message', (topic, payload) => {
        this.handleMessage(topic, payload.toString());
      });
    });
  }

  private subscribeToTopics(): void {
    const base = `${this.baseTopic}/${this.uniqueId}`;
    for (const topic of [
      `${base}/zone/+/state`,
      `${base}/group/+/state`,
      `${base}/group/+/alarm`,
      `${base}/device/state`,
      `${base}/device/version`,
      `${base}/event/attr`,
    ]) {
      this.client!.subscribe(topic, (err) => {
        if (err) this.log.error(`MQTT subscribe error (${topic}): ${err.message}`);
      });
    }
  }

  private handleMessage(topic: string, payload: string): void {
    const zoneMatch = topic.match(new RegExp(`^${this.baseEsc}/zone/(\\d+)/state$`));
    if (zoneMatch) {
      this.emit('zone', { zone: parseInt(zoneMatch[1], 10), active: payload === '1' } as ZoneStateEvent);
      return;
    }

    const groupStateMatch = topic.match(new RegExp(`^${this.baseEsc}/group/([^/]+)/state$`));
    if (groupStateMatch) {
      const group = groupStateMatch[1];
      this.emit('group', { group, state: payload, alarm: this.groupAlarmState.get(group) ?? false } as GroupStateEvent);
      return;
    }

    const groupAlarmMatch = topic.match(new RegExp(`^${this.baseEsc}/group/([^/]+)/alarm$`));
    if (groupAlarmMatch) {
      const group    = groupAlarmMatch[1];
      const wasAlarm = this.groupAlarmState.get(group) ?? false;
      const isAlarm  = payload === '1';
      this.groupAlarmState.set(group, isAlarm);

      // Emit direct zodra alarm activeert — niet wachten op group state update
      if (isAlarm && !wasAlarm) {
        this.emit('group', { group, state: GROUP_STATE.FULL, alarm: true } as GroupStateEvent);
      }
      return;
    }

    const base = `${this.baseTopic}/${this.uniqueId}`;
    // Event with user info: galaxy/<uniqueId>/event/attr
    if (topic === `${base}/event/attr`) {
      try {
        const ev = JSON.parse(payload) as { userid?: string; code?: string; text?: string };
        const ARM_CODES = ['CL','CR','CG','OP','OR','OG','CA'];
        if (ev.userid && ev.code && ARM_CODES.includes(ev.code)) {
          this.emit('user-event', {
            userId: ev.userid,
            code:   ev.code,
            text:   ev.text ?? '',
          } as UserEvent);
        }
      } catch { /* malformed JSON */ }
      return;
    }

    if (topic === `${base}/device/state`) {
      this.log.info(`Seasoft module: ${payload}`);
      if (payload === 'online') this.emit('online', { version: this._version ?? '' });
      else this.emit('offline');
    }
    if (topic === `${base}/device/version`) {
      this._version = payload;
      this.emit('online', { version: payload });
    }
  }

  sendGroupCommand(group: string, command: string): void {
    if (!this.client?.connected) {
      this.log.warn('Seasoft MQTT: not connected, cannot send command');
      return;
    }
    const topic = `${this.baseTopic}/${this.uniqueId}/group/${group}/cmd/set`;
    this.client.publish(topic, command, { qos: 0, retain: false });
    this.log.info(`Seasoft: sent group ${group} command ${command}`);
  }

  disconnect(): void {
    this.client?.end();
  }
}
