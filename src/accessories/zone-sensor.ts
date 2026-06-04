import { PlatformAccessory, Service } from 'homebridge';
import { GalaxyFlexPlatform } from '../platform';

export type ZoneType = 'contact' | 'motion' | 'smoke';

export interface ZoneConfig {
  zone: number;
  name: string;
  type: ZoneType;
}

export class ZoneSensorAccessory {
  private readonly service: Service;
  private triggered = false;
  private open = false; // live state from Seasoft MQTT

  constructor(
    private readonly platform: GalaxyFlexPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: ZoneConfig,
  ) {
    const { Service: Svc, Characteristic: Char } = this.platform.api.hap;

    this.accessory.getService(Svc.AccessoryInformation)!
      .setCharacteristic(Char.Manufacturer, 'Honeywell')
      .setCharacteristic(Char.Model, `Galaxy Flex Zone ${config.zone}`)
      .setCharacteristic(Char.SerialNumber, `GFZ-${config.zone}`);

    this.service = this.getOrAddService();
    this.service.setCharacteristic(Char.Name, config.name);
    this.initCharacteristic();
  }

  private getOrAddService(): Service {
    const { Service: Svc } = this.platform.api.hap;
    switch (this.config.type) {
      case 'contact':
        return this.accessory.getService(Svc.ContactSensor) ?? this.accessory.addService(Svc.ContactSensor);
      case 'motion':
        return this.accessory.getService(Svc.MotionSensor) ?? this.accessory.addService(Svc.MotionSensor);
      case 'smoke':
        return this.accessory.getService(Svc.SmokeSensor) ?? this.accessory.addService(Svc.SmokeSensor);
    }
  }

  private initCharacteristic(): void {
    const { Characteristic: Char } = this.platform.api.hap;
    switch (this.config.type) {
      case 'contact':
        this.service.getCharacteristic(Char.ContactSensorState).onGet(() =>
          (this.open || this.triggered)
            ? Char.ContactSensorState.CONTACT_NOT_DETECTED
            : Char.ContactSensorState.CONTACT_DETECTED,
        );
        break;
      case 'motion':
        this.service.getCharacteristic(Char.MotionDetected).onGet(() => this.open || this.triggered);
        break;
      case 'smoke':
        this.service.getCharacteristic(Char.SmokeDetected).onGet(() =>
          (this.open || this.triggered)
            ? Char.SmokeDetected.SMOKE_DETECTED
            : Char.SmokeDetected.SMOKE_NOT_DETECTED,
        );
        break;
    }
  }

  getStateForUi(): { name: string; type: string; open: boolean; triggered: boolean } {
    return { name: this.config.name, type: this.config.type, open: this.open, triggered: this.triggered };
  }

  // Called by Seasoft MQTT for live zone state (open/closed)
  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.platform.log.info(`Zone ${this.config.zone} (${this.config.name}): ${open ? 'open' : 'closed'}`);
    this.open = open;
    this.pushUpdate();
  }

  setTriggered(triggered: boolean): void {
    if (triggered === this.triggered) return;
    this.platform.log.info(`Zone ${this.config.zone} (${this.config.name}): ${triggered ? 'TRIGGERED' : 'restored'}`);
    this.triggered = triggered;
    this.pushUpdate();
  }

  private pushUpdate(): void {
    const active = this.open || this.triggered;
    const { Characteristic: Char } = this.platform.api.hap;
    switch (this.config.type) {
      case 'contact':
        this.service.updateCharacteristic(
          Char.ContactSensorState,
          active ? Char.ContactSensorState.CONTACT_NOT_DETECTED : Char.ContactSensorState.CONTACT_DETECTED,
        );
        break;
      case 'motion':
        this.service.updateCharacteristic(Char.MotionDetected, active);
        break;
      case 'smoke':
        this.service.updateCharacteristic(
          Char.SmokeDetected,
          active ? Char.SmokeDetected.SMOKE_DETECTED : Char.SmokeDetected.SMOKE_NOT_DETECTED,
        );
        break;
    }
  }
}
