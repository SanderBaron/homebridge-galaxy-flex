import * as mqtt from 'mqtt';
import { EventEmitter } from 'events';
import { Logger } from 'homebridge';

// group/<GRP>/state values (wat het paneel publiceert)
export const GROUP_STATE = {
  NOT_READY:   '0',  // niet klaar / uitgeschakeld (open zones aanwezig)
  SET:         '1',  // volledig ingeschakeld
  PART_SET:    '2',  // deels ingeschakeld
  READY:       '3',  // klaar om in te schakelen (alle zones dicht, nog niet ingeschakeld)
  TIME_LOCKED: '4',  // tijd vergrendeld
} as const;

// group/<GRP>/alarm values
export const GROUP_ALARM = {
  NORMAL:         '0',
  ALARM:          '1',
  RESET_REQUIRED: '2',  // alarm geweest, paneel moet gereset worden
} as const;

// group/<GRP>/cmd/set values (commando's die wij sturen)
export const GROUP_CMD = {
  UNSET: '0',  // uitschakelen
  FULL:  '1',  // volledig inschakelen (alleen als alle zones OK)
  PART:  '2',  // deelbewapening
  RESET: '3',  // reset (na alarm, bij alarm=1 of alarm=2)
  ABORT: '4',  // afbreken inschakeling
  FORCE: '5',  // volledig inschakelen met bypass van overbrugbare zones (aanbevolen)
  NIGHT: '6',  // nachtbewapening (Flex only, Dimension ondersteunt dit niet)
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
  private lastGroupState: Map<string, string> = new Map(); // laatst bekende group/state per groep
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
      `${base}/zone/+/attr`,
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

    // Zone attr: alarm:1 = zone in alarm, alarm:0 = opgeheven. Beide doorgeven zodat
    // de platform-laag kan bijhouden welke zones in alarm staan (storing vs inbraak).
    const zoneAttrMatch = topic.match(new RegExp(`^${this.baseEsc}/zone/(\\d+)/attr$`));
    if (zoneAttrMatch) {
      try {
        const attr = JSON.parse(payload) as { alarm?: number };
        this.emit('zone-alarm', { zone: parseInt(zoneAttrMatch[1], 10), active: attr.alarm === 1 });
      } catch { /* malformed */ }
      return;
    }

    const groupStateMatch = topic.match(new RegExp(`^${this.baseEsc}/group/([^/]+)/state$`));
    if (groupStateMatch) {
      const group = groupStateMatch[1];
      this.lastGroupState.set(group, payload);
      this.emit('group', { group, state: payload, alarm: this.groupAlarmState.get(group) ?? false } as GroupStateEvent);
      return;
    }

    const groupAlarmMatch = topic.match(new RegExp(`^${this.baseEsc}/group/([^/]+)/alarm$`));
    if (groupAlarmMatch) {
      const group    = groupAlarmMatch[1];
      const wasAlarm = this.groupAlarmState.get(group) ?? false;
      // alarm=1 (alarm actief) en alarm=2 (reset required) zijn beide alarm-actief
      const isAlarm  = payload === GROUP_ALARM.ALARM || payload === GROUP_ALARM.RESET_REQUIRED;
      this.groupAlarmState.set(group, isAlarm);

      // Emit direct zodra alarm activeert — niet wachten op group state update
      if (isAlarm && !wasAlarm) {
        this.emit('group', { group, state: GROUP_STATE.SET, alarm: true } as GroupStateEvent);
      } else if (!isAlarm && wasAlarm) {
        // Alarm heft op → HomeKit terugzetten naar de werkelijke groepsstatus.
        // Zonder dit blijft de security system in ALARM_TRIGGERED hangen, want
        // elk group/state-bericht erfde tot nu toe de oude alarm=true vlag mee.
        const lastState = this.lastGroupState.get(group) ?? GROUP_STATE.NOT_READY;
        this.emit('group', { group, state: lastState, alarm: false } as GroupStateEvent);
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
