import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { SiaServer } from './sia/server';
import { SiaMessage, AlarmState, codeToAlarmState, isAlarmCode, isRestoreCode } from './sia/events';
import { SecuritySystemAccessory } from './accessories/security-system';
import { ZoneSensorAccessory, ZoneConfig } from './accessories/zone-sensor';
import { MqttBroker } from './mqtt/broker';
import { SeasoftMqttClient, ZoneStateEvent, GroupStateEvent, GROUP_STATE, GROUP_ALARM } from './mqtt/seasoft';
import { HueClient } from './hue/hue-client';
import { AlarmLighting, AlarmLightingConfig } from './hue/alarm-lighting';
import { UserSensorAccessory } from './accessories/user-sensor';
import { FaultSensorAccessory } from './accessories/fault-sensor';
import { IMessageSender } from './notify/imessage';
import { AlarmReporter } from './notify/alarm-reporter';

export interface GalaxyFlexConfig extends PlatformConfig {
  // SIA receiver
  port: number;
  account: string;
  userCode: string;
  zones: ZoneConfig[];

  // Seasoft Galaxy Gateway
  seasoftEnabled: boolean;
  seasoftIp?: string;
  seasoftPassword?: string;
  seasoftUniqueId?: string;
  seasoftGroup?: string;
  seasoftBaseTopic?: string;

  // MQTT
  mqttPort?: number;
  mqttExternalBroker?: boolean;
  mqttBrokerUrl?: string;
  mqttUsername?: string;
  mqttPassword?: string;

  // Gebruikersensoren
  users?: Array<{ id: string; name: string }>;

  // Hue alarm lighting
  hueBridgeIp?: string;
  hueApiKey?: string;
  hueRestoreAfterMinutes?: number;
  hueFireScene?: AlarmLightingConfig['fire'];
  hueIntrusionScene?: AlarmLightingConfig['intrusion'];

  // iMessage meldingen
  notifyEnabled?: boolean;
  notifyRecipients?: Array<{ name: string; phone: string }>;
  notifyOnAlarm?: boolean;
  notifyOnFault?: boolean;
  notifyOnArmDisarm?: boolean;
}

// State written to disk for the custom UI dashboard
export interface PluginState {
  alarmState: string;
  seasoftOnline: boolean;
  seasoftVersion: string;
  mqttBroker: string;
  zones: Record<number, { name: string; type: string; open: boolean; triggered: boolean }>;
  lastUpdated: string;
}

export class GalaxyFlexPlatform implements DynamicPlatformPlugin {
  public readonly log: Logger;
  public readonly api: API;

  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private securitySystem?: SecuritySystemAccessory;
  private readonly zoneSensors: Map<number, ZoneSensorAccessory> = new Map();
  private siaServer?: SiaServer;
  private mqttBroker?: MqttBroker;
  private seasoftClient?: SeasoftMqttClient;
  private alarmLighting?: AlarmLighting;
  private reporter?: AlarmReporter;
  private readonly userSensors: Map<string, UserSensorAccessory> = new Map(); // userId → sensor
  private faultSensor?: FaultSensorAccessory;
  private readonly zonesInAlarm: Set<number> = new Set(); // zones die nu attr.alarm:1 melden
  private faultTimer?: ReturnType<typeof setTimeout>;
  private readonly stateFilePath: string;

  constructor(log: Logger, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;
    this.stateFilePath = path.join(api.user.storagePath(), 'galaxy-flex-state.json');
    this.api.on('didFinishLaunching', () => this.init(config as GalaxyFlexConfig));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private async init(config: GalaxyFlexConfig): Promise<void> {
    const port = config.port ?? 52000;
    const account = config.account ?? '';
    const zones: ZoneConfig[] = config.zones ?? [];
    const seasoftEnabled = config.seasoftEnabled ?? false;
    const seasoftGroup = config.seasoftGroup || 'A1';
    const seasoftBaseTopic = config.seasoftBaseTopic || 'galaxy';
    const seasoftUniqueId = config.seasoftUniqueId || '';
    const mqttPort = config.mqttPort ?? 1883;
    const mqttExternalBroker = config.mqttExternalBroker ?? false;

    this.setupSecuritySystem(seasoftGroup);
    for (const zone of zones) {
      this.setupZoneSensor(zone);
    }
    this.setupUserSensors(config.users ?? []);
    this.setupFaultSensor();
    this.removeStaleAccessories(zones, config.users ?? []);

    // Start SIA receiver alleen als Seasoft NIET actief is.
    // Met Seasoft ontvangt de Seasoft module alle SIA events van het paneel
    // en stuurt ze via MQTT door — onze eigen SIA server krijgt dan niets.
    if (!seasoftEnabled) {
      this.siaServer = new SiaServer({ port, account, userCode: config.userCode ?? '', log: this.log });
      this.siaServer.on('message', (msg: SiaMessage) => this.handleSiaMessage(msg));
      this.siaServer.on('error', (err: Error) => this.log.error(`SIA server error: ${err.message}`));
      try {
        await this.siaServer.start();
      } catch (err) {
        this.log.error(`Failed to start SIA server: ${err}`);
      }
    } else {
      this.log.info('SIA server uitgeschakeld — events lopen via Seasoft MQTT');
    }

    // Hue alarm lighting (independent of Seasoft)
    if (config.hueBridgeIp && config.hueApiKey) {
      const hueClient = new HueClient(this.log, config.hueBridgeIp, config.hueApiKey);
      this.alarmLighting = new AlarmLighting(
        this.log,
        hueClient,
        {
          fire:      config.hueFireScene      ?? [],
          intrusion: config.hueIntrusionScene ?? [],
          restoreAfterMinutes: config.hueRestoreAfterMinutes ?? 15,
        },
        path.join(this.api.user.storagePath(), 'galaxy-flex-hue-snapshot.json'),
      );
      this.log.info('Hue alarm lighting ready');
    }

    // iMessage meldingen via de Berichten-app op deze Mac
    const notifyRecipients = (config.notifyRecipients ?? []).map(r => r.phone?.trim()).filter(Boolean) as string[];
    if (config.notifyEnabled && notifyRecipients.length > 0) {
      this.reporter = new AlarmReporter(this.log, new IMessageSender(this.log), notifyRecipients, {
        onAlarm:     config.notifyOnAlarm     ?? true,
        onFault:     config.notifyOnFault     ?? true,
        onArmDisarm: config.notifyOnArmDisarm ?? false,
      });
      this.log.info(`iMessage meldingen actief (${notifyRecipients.length} ontvanger${notifyRecipients.length !== 1 ? 's' : ''})`);
    } else if (config.notifyEnabled) {
      this.log.warn('iMessage meldingen ingeschakeld maar geen ontvangers geconfigureerd');
    }

    // Testbericht: maak 'galaxy-flex-notify-test.txt' aan in de Homebridge-map
    // en herstart — er gaat dan één testbericht naar alle ontvangers.
    const notifyTestFile = path.join(this.api.user.storagePath(), 'galaxy-flex-notify-test.txt');
    if (this.reporter && fs.existsSync(notifyTestFile)) {
      fs.unlinkSync(notifyTestFile);
      this.reporter.sendTest();
    }

    if (!seasoftEnabled) {
      this.log.info('Seasoft module disabled — running in SIA-only mode');
      return;
    }

    // Determine broker URL
    let brokerUrl: string;
    if (mqttExternalBroker && config.mqttBrokerUrl) {
      brokerUrl = config.mqttBrokerUrl;
      this.log.info(`Using external MQTT broker: ${brokerUrl}`);
    } else {
      // Start embedded broker
      this.mqttBroker = new MqttBroker(this.log, {
        port: mqttPort,
        username: config.mqttUsername,
        password: config.mqttPassword,
      });
      try {
        await this.mqttBroker.start();
      } catch (err) {
        this.log.error(`Failed to start MQTT broker: ${err}`);
        return;
      }
      brokerUrl = `mqtt://127.0.0.1:${mqttPort}`;
    }

    // Connect Seasoft client
    const resolvedUniqueId = seasoftUniqueId || await this.fetchSeasoftUniqueId(config.seasoftIp);
    if (!resolvedUniqueId) {
      this.log.error('Seasoft uniqueId unknown — set seasoftUniqueId in config or provide seasoftIp for auto-detect');
      return;
    }

    this.seasoftClient = new SeasoftMqttClient(this.log, brokerUrl, resolvedUniqueId, seasoftBaseTopic, {
      username: config.mqttUsername,
      password: config.mqttPassword,
    });
    this.seasoftClient.on('zone', (ev: ZoneStateEvent) => this.handleZoneState(ev));
    this.seasoftClient.on('group', (ev: GroupStateEvent) => this.handleGroupState(ev, seasoftGroup));
    this.seasoftClient.on('zone-alarm', (ev: { zone: number; active: boolean }) => {
      // Houd bij welke zones nu in alarm staan — dit onderscheidt een echt alarm
      // (inbraak/brand = zone-alarm) van een systeemstoring (group/alarm zónder zone).
      if (!ev.active) {
        this.zonesInAlarm.delete(ev.zone);
        return;
      }
      this.zonesInAlarm.add(ev.zone);

      // Zone attr meldt alarm:1 — alleen reageren als het alarm ingeschakeld is
      const currentState = this.securitySystem?.getCurrentState();
      const armed = currentState === AlarmState.AWAY_ARM
                 || currentState === AlarmState.STAY_ARM
                 || currentState === AlarmState.NIGHT_ARM
                 || currentState === AlarmState.ALARM_TRIGGERED;
      if (!armed) return;

      this.clearFault(); // echt alarm → eventuele Storing-melding intrekken
      this.log.info(`Zone ${ev.zone} in alarm (staat was ${currentState !== undefined ? AlarmState[currentState] : '?'}) — direct ALARM_TRIGGERED`);
      this.securitySystem?.updateState(AlarmState.ALARM_TRIGGERED);
      this.writeState({ alarmState: 'ALARM_TRIGGERED' });
      const alarmType = this.getAlarmTypeForZone(ev.zone);
      this.alarmLighting?.onAlarm(alarmType).catch(err => this.log.error(`Hue ${alarmType}: ${err}`));
      const zoneName = this.zoneSensors.get(ev.zone)?.getStateForUi().name ?? `Zone ${ev.zone}`;
      this.reporter?.onZoneAlarm(zoneName, alarmType);
    });
    this.seasoftClient.on('user-event', (ev: { userId: string; code: string; text: string }) => {
      const sensor = this.userSensors.get(ev.userId);
      if (sensor) {
        const state = codeToAlarmState(ev.code);
        const armed = state !== null && state !== AlarmState.DISARMED;
        this.log.info(`Alarm ${armed ? 'ingeschakeld' : 'uitgeschakeld'} door ${sensor.name} (${ev.code})`);
        sensor.setArmed(armed);
        this.reporter?.onUserEvent(sensor.name, armed);
      }
    });
    this.seasoftClient.on('online', (info: { version: string }) => {
      this.writeState({ seasoftOnline: true, seasoftVersion: info.version });
    });
    this.seasoftClient.on('offline', () => {
      this.writeState({ seasoftOnline: false });
    });

    setTimeout(async () => {
      try {
        await this.seasoftClient!.connect();
        this.log.info('Seasoft MQTT client connected');
        this.writeState({ mqttBroker: brokerUrl });
      } catch (err) {
        this.log.error(`Failed to connect Seasoft MQTT client: ${err}`);
      }
    }, 500);
  }

  getSeasoftClient(): SeasoftMqttClient | undefined {
    return this.seasoftClient;
  }

  // Fetch uniqueId from Seasoft HTTP API when not set in config
  private async fetchSeasoftUniqueId(ip?: string): Promise<string> {
    if (!ip) return '';
    try {
      const r = await fetch(`http://${ip}/data/status.json`);
      if (!r.ok) return '';
      const data = await r.json() as { moduniqueid?: string };
      const id = data.moduniqueid ?? '';
      if (id) this.log.info(`Seasoft uniqueId auto-detected: ${id}`);
      return id;
    } catch {
      return '';
    }
  }

  private setupSecuritySystem(group: string): void {
    const uuid = this.api.hap.uuid.generate('galaxy-flex-security-system');
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory('Galaxy Flex', uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }
    this.securitySystem = new SecuritySystemAccessory(this, accessory, group);
    this.log.info('SecuritySystem accessory ready');
  }

  private setupFaultSensor(): void {
    const uuid = this.api.hap.uuid.generate('galaxy-flex-fault');
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory('Galaxy Flex Storing', uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }
    this.faultSensor = new FaultSensorAccessory(this, accessory, 'Galaxy Flex Storing');
    this.log.info('Storing-melder ready');
  }

  private setupZoneSensor(zone: ZoneConfig): void {
    const uuid = this.api.hap.uuid.generate(`galaxy-flex-zone-${zone.zone}`);
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(zone.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }
    this.zoneSensors.set(zone.zone, new ZoneSensorAccessory(this, accessory, zone));
    this.log.info(`Zone ${zone.zone} (${zone.name} / ${zone.type}) ready`);
  }

  private setupUserSensors(users: Array<{ id: string; name: string }>): void {
    // Meerdere IDs kunnen dezelfde naam/sensor delen (bijv. Sanne met 2 keyfobs)
    const nameToUuid = new Map<string, string>();

    for (const user of users) {
      const userId = user.id.padStart(3, '0'); // "1" → "001"
      const name   = user.name;
      let uuid = nameToUuid.get(name);

      if (!uuid) {
        uuid = this.api.hap.uuid.generate(`galaxy-flex-user-${name}`);
        nameToUuid.set(name, uuid);
        let accessory = this.accessories.get(uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(name, uuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.set(uuid, accessory);
        }
        const sensor = new UserSensorAccessory(this, accessory, name);
        this.log.info(`Gebruikersensor: ${name}`);
        // Map alle IDs met dezelfde naam naar dezelfde sensor (later)
        nameToUuid.set(name, uuid);
        // Temporarily store by name
        this.userSensors.set(`_name_${name}`, sensor);
      }

      // Map userId → sensor
      const sensor = this.userSensors.get(`_name_${name}`)!;
      this.userSensors.set(userId, sensor);
    }

    // Ruim tijdelijke name-keys op
    for (const key of [...this.userSensors.keys()]) {
      if (key.startsWith('_name_')) this.userSensors.delete(key);
    }
  }

  private removeStaleAccessories(zones: ZoneConfig[], users: Array<{ id: string; name: string }> = []): void {
    const validUuids = new Set<string>();
    validUuids.add(this.api.hap.uuid.generate('galaxy-flex-security-system'));
    validUuids.add(this.api.hap.uuid.generate('galaxy-flex-fault'));
    for (const z of zones) {
      validUuids.add(this.api.hap.uuid.generate(`galaxy-flex-zone-${z.zone}`));
    }
    // Unieke namen voor gebruikersensoren
    const userNames = new Set(users.map(u => u.name));
    for (const name of userNames) {
      validUuids.add(this.api.hap.uuid.generate(`galaxy-flex-user-${name}`));
    }
    const stale = [...this.accessories.values()].filter(a => !validUuids.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} stale accessories`);
    }
  }

  private getAlarmTypeForZone(zoneId: number): 'fire' | 'intrusion' {
    const sensor = this.zoneSensors.get(zoneId);
    return sensor?.getStateForUi().type === 'smoke' ? 'fire' : 'intrusion';
  }

  private handleZoneState(ev: ZoneStateEvent): void {
    const sensor = this.zoneSensors.get(ev.zone);
    if (sensor) {
      sensor.setOpen(ev.active);
      this.writeState({});
    }
  }

  private handleGroupState(ev: GroupStateEvent, primaryGroup: string): void {
    if (ev.group !== primaryGroup) return;

    let newState: AlarmState;
    switch (ev.state) {
      case GROUP_STATE.SET:
        newState = AlarmState.AWAY_ARM;
        break;
      case GROUP_STATE.PART_SET:
        newState = AlarmState.NIGHT_ARM;
        break;
      case GROUP_STATE.NOT_READY:  // uitgeschakeld of open zones
      case GROUP_STATE.READY:      // klaar om in te schakelen (nog niet ingeschakeld)
        newState = AlarmState.DISARMED;
        break;
      case GROUP_STATE.TIME_LOCKED:
        return; // tijdslot — negeer, geen state change
      default:
        return;
    }

    // group/alarm-vlag actief? Onderscheid een ECHT alarm van een systeemstoring.
    // Echt alarm (inbraak/brand) zet altijd een zone in alarm → die loopt via de
    // zone-alarm-route die ALARM_TRIGGERED al heeft gezet. Een group/alarm ZONDER
    // zone-alarm is een comms-/sabotagestoring → géén vals inbraakalarm, wél Storing.
    if (ev.alarm) {
      if (this.zonesInAlarm.size > 0
          || this.securitySystem?.getCurrentState() === AlarmState.ALARM_TRIGGERED) {
        newState = AlarmState.ALARM_TRIGGERED;
        this.clearFault();
      } else {
        // Systeemstoring — debounce om een race (group/alarm net vóór zone/attr) op te vangen.
        this.scheduleFault();
        // newState blijft de echte groepsstatus → géén ALARM_TRIGGERED.
      }
    } else {
      this.clearFault();
    }

    const prevState = this.securitySystem?.getCurrentState();
    this.securitySystem?.updateState(newState);
    this.writeState({ alarmState: AlarmState[newState] });

    // Hue: herstel verlichting bij deactivering alarm
    if (newState === AlarmState.DISARMED) {
      this.alarmLighting?.onReset().catch(err => this.log.error(`Hue restore: ${err}`));
      if (prevState === AlarmState.ALARM_TRIGGERED) {
        this.zonesInAlarm.clear();
        this.reporter?.onAlarmCleared();
      }
    }
  }

  // Zet de Storing-melder pas aan als er na een korte debounce nog steeds geen
  // zone-alarm en geen ALARM_TRIGGERED is — zo voorkomen we een valse Storing
  // tijdens een echt alarm waarbij group/alarm net vóór de zone/attr binnenkomt.
  private scheduleFault(): void {
    if (this.faultSensor?.isFault() || this.faultTimer) return;
    this.faultTimer = setTimeout(() => {
      this.faultTimer = undefined;
      if (this.zonesInAlarm.size === 0
          && this.securitySystem?.getCurrentState() !== AlarmState.ALARM_TRIGGERED) {
        this.log.info('Systeemstoring actief (group/alarm zonder zone-alarm) — Storing-melder AAN');
        this.faultSensor?.setFault(true);
        this.reporter?.onFault(true);
        this.writeState({});
      }
    }, 3000);
  }

  private clearFault(): void {
    if (this.faultTimer) {
      clearTimeout(this.faultTimer);
      this.faultTimer = undefined;
    }
    if (this.faultSensor?.isFault()) {
      this.log.info('Systeemstoring opgeheven — Storing-melder UIT');
      this.faultSensor.setFault(false);
      this.reporter?.onFault(false);
      this.writeState({});
    }
  }

  private handleSiaMessage(msg: SiaMessage): void {
    const newState = codeToAlarmState(msg.eventCode);
    if (newState !== null) {
      this.log.debug(`SIA event ${msg.eventCode} → state update`);
      this.securitySystem?.updateStateFromSia(newState);
    }

    // Hue alarm lighting triggers
    if (msg.eventCode === 'FA') {
      this.alarmLighting?.onAlarm('fire').catch(err => this.log.error(`Hue fire: ${err}`));
    } else if (msg.eventCode === 'BA' || msg.eventCode === 'PA') {
      this.alarmLighting?.onAlarm('intrusion').catch(err => this.log.error(`Hue intrusion: ${err}`));
    } else if (['CA', 'OR', 'OP', 'OG'].includes(msg.eventCode)) {
      this.alarmLighting?.onReset().catch(err => this.log.error(`Hue restore: ${err}`));
    }
    if (msg.zone !== null) {
      const sensor = this.zoneSensors.get(msg.zone);
      if (sensor) {
        if (isAlarmCode(msg.eventCode)) sensor.setTriggered(true);
        else if (isRestoreCode(msg.eventCode)) sensor.setTriggered(false);
      } else if (isAlarmCode(msg.eventCode) || isRestoreCode(msg.eventCode)) {
        this.log.warn(`SIA event on unconfigured zone ${msg.zone} (${msg.eventCode})`);
      }
    }
  }

  // Write live state to disk so the custom UI can read it
  writeState(partial: Partial<PluginState>): void {
    try {
      let current: PluginState = {
        alarmState: 'DISARMED',
        seasoftOnline: false,
        seasoftVersion: '',
        mqttBroker: '',
        zones: {},
        lastUpdated: new Date().toISOString(),
      };
      try {
        current = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
      } catch { /* first run */ }

      // Merge zone states
      const zones: PluginState['zones'] = { ...current.zones };
      for (const [id, sensor] of this.zoneSensors) {
        zones[id] = sensor.getStateForUi();
      }

      const updated: PluginState = {
        ...current,
        ...partial,
        zones,
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(this.stateFilePath, JSON.stringify(updated, null, 2));
    } catch (err) {
      this.log.debug(`State file write failed: ${err}`);
    }
  }
}
