import { PlatformAccessory, Service } from 'homebridge';
import { GalaxyFlexPlatform } from '../platform';

// ContactSensor that reflects whether this user last armed or disarmed the alarm.
//   Armed   → CONTACT_DETECTED      (HomeKit "Dicht") → automatisering: "<naam> gesloten"
//   Disarmed→ CONTACT_NOT_DETECTED  (HomeKit "Open")  → automatisering: "<naam> geopend"
// HomeKit automations trigger on the state transition, so each arm/disarm by this
// user fires exactly one personalised notification (no spurious duplicates).
export class UserSensorAccessory {
  private readonly service: Service;
  private armed = false; // resting/unknown state = disarmed (Open)

  constructor(
    private readonly platform: GalaxyFlexPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly name: string,
  ) {
    const { Service: Svc, Characteristic: Char } = this.platform.api.hap;

    this.accessory.getService(Svc.AccessoryInformation)!
      .setCharacteristic(Char.Manufacturer, 'Honeywell')
      .setCharacteristic(Char.Model, 'Galaxy Flex User')
      .setCharacteristic(Char.SerialNumber, `GFU-${name}`);

    this.service =
      this.accessory.getService(Svc.ContactSensor) ??
      this.accessory.addService(Svc.ContactSensor);

    this.service.setCharacteristic(Char.Name, name);
    this.service.getCharacteristic(Char.ContactSensorState)
      .onGet(() => this.contactState());
  }

  private contactState(): number {
    const { Characteristic: Char } = this.platform.api.hap;
    return this.armed
      ? Char.ContactSensorState.CONTACT_DETECTED      // Dicht = ingeschakeld
      : Char.ContactSensorState.CONTACT_NOT_DETECTED; // Open  = uitgeschakeld
  }

  // Reflect whether this user armed (true) or disarmed (false) the alarm.
  setArmed(armed: boolean): void {
    this.armed = armed;
    this.service.updateCharacteristic(
      this.platform.api.hap.Characteristic.ContactSensorState,
      this.contactState(),
    );
  }
}
