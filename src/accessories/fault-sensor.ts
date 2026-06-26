import { PlatformAccessory, Service } from 'homebridge';
import { GalaxyFlexPlatform } from '../platform';

// ContactSensor die een SYSTEEMSTORING signaleert (communicatie/sabotage) — dus een
// group/alarm-conditie die GEEN echt zone-alarm (inbraak/brand) is.
//   Storing actief → CONTACT_NOT_DETECTED (HomeKit "Open")
//   OK            → CONTACT_DETECTED      (HomeKit "Dicht")
// Een echte inbraak/brand komt NIET hier binnen — die loopt via het beveiligings-
// accessoire (ALARM_TRIGGERED). Zo geeft een storing geen vals inbraakalarm meer.
export class FaultSensorAccessory {
  private readonly service: Service;
  private fault = false;

  constructor(
    private readonly platform: GalaxyFlexPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly name: string,
  ) {
    const { Service: Svc, Characteristic: Char } = this.platform.api.hap;

    this.accessory.getService(Svc.AccessoryInformation)!
      .setCharacteristic(Char.Manufacturer, 'Honeywell')
      .setCharacteristic(Char.Model, 'Galaxy Flex Storing')
      .setCharacteristic(Char.SerialNumber, 'GF-STORING');

    this.service =
      this.accessory.getService(Svc.ContactSensor) ??
      this.accessory.addService(Svc.ContactSensor);

    this.service.setCharacteristic(Char.Name, name);
    this.service.getCharacteristic(Char.ContactSensorState).onGet(() => this.state());
  }

  private state(): number {
    const { Characteristic: Char } = this.platform.api.hap;
    return this.fault
      ? Char.ContactSensorState.CONTACT_NOT_DETECTED  // Open = storing actief
      : Char.ContactSensorState.CONTACT_DETECTED;      // Dicht = OK
  }

  isFault(): boolean {
    return this.fault;
  }

  setFault(fault: boolean): void {
    if (fault === this.fault) return;
    this.fault = fault;
    this.service.updateCharacteristic(
      this.platform.api.hap.Characteristic.ContactSensorState,
      this.state(),
    );
  }
}
