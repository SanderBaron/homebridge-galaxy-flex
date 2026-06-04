import { PlatformAccessory, Service } from 'homebridge';
import { GalaxyFlexPlatform } from '../platform';

// ContactSensor that momentarily opens when a user arms/disarms the alarm.
// HomeKit automations can trigger on the "opens" event to send personalised
// push notifications like "Sander heeft het alarm ingeschakeld".
export class UserSensorAccessory {
  private readonly service: Service;
  private resetTimer?: ReturnType<typeof setTimeout>;

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
      .onGet(() => Char.ContactSensorState.CONTACT_DETECTED);
  }

  // Briefly open the sensor (5s) so HomeKit automations can trigger
  trigger(durationMs = 5000): void {
    const { Characteristic: Char } = this.platform.api.hap;

    if (this.resetTimer) clearTimeout(this.resetTimer);

    this.service.updateCharacteristic(
      Char.ContactSensorState,
      Char.ContactSensorState.CONTACT_NOT_DETECTED,
    );

    this.resetTimer = setTimeout(() => {
      this.service.updateCharacteristic(
        Char.ContactSensorState,
        Char.ContactSensorState.CONTACT_DETECTED,
      );
    }, durationMs);
  }
}
