import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { GalaxyFlexPlatform } from '../platform';
import { AlarmState } from '../sia/events';
import { GROUP_CMD } from '../mqtt/seasoft';

export class SecuritySystemAccessory {
  private readonly service: Service;
  private currentState: AlarmState = AlarmState.DISARMED;
  private mqttStateReceived = false;

  constructor(
    private readonly platform: GalaxyFlexPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly seasoftGroup: string,
  ) {
    const { Service: Svc, Characteristic: Char } = this.platform.api.hap;

    this.accessory.getService(Svc.AccessoryInformation)!
      .setCharacteristic(Char.Manufacturer, 'Honeywell')
      .setCharacteristic(Char.Model, 'Galaxy Flex')
      .setCharacteristic(Char.SerialNumber, 'GalaxyFlex-001');

    this.service =
      this.accessory.getService(Svc.SecuritySystem) ??
      this.accessory.addService(Svc.SecuritySystem);

    this.service.setCharacteristic(Char.Name, accessory.displayName);

    this.service
      .getCharacteristic(Char.SecuritySystemCurrentState)
      .onGet(() => this.currentState);

    this.service
      .getCharacteristic(Char.SecuritySystemTargetState)
      .setProps({ validValues: [
        AlarmState.DISARMED,
        AlarmState.AWAY_ARM,
        AlarmState.STAY_ARM,
        AlarmState.NIGHT_ARM,
      ]})
      .onGet(() => this.currentState === AlarmState.ALARM_TRIGGERED
        ? AlarmState.AWAY_ARM
        : this.currentState,
      )
      .onSet((value: CharacteristicValue) => this.handleSet(value));
  }

  private handleSet(value: CharacteristicValue): void {
    const client = this.platform.getSeasoftClient();
    if (!client) {
      this.platform.log.warn('Seasoft MQTT client not available');
      return;
    }

    let cmd: string;
    switch (value) {
      case AlarmState.AWAY_ARM:
        cmd = GROUP_CMD.FULL;
        break;
      case AlarmState.STAY_ARM:
      case AlarmState.NIGHT_ARM:
        cmd = GROUP_CMD.PART;
        break;
      case AlarmState.DISARMED:
        cmd = GROUP_CMD.UNSET;
        break;
      default:
        this.platform.log.warn(`Unknown target state: ${value}`);
        return;
    }

    client.sendGroupCommand(this.seasoftGroup, cmd);
  }

  updateState(state: AlarmState): void {
    this.mqttStateReceived = true;
    this.applyState(state);
  }

  // SIA-based updates only apply if we haven't received MQTT state yet
  updateStateFromSia(state: AlarmState): void {
    if (this.mqttStateReceived) return;
    this.applyState(state);
  }

  private applyState(state: AlarmState): void {
    if (state === this.currentState) return;
    this.platform.log.info(`SecuritySystem state: ${AlarmState[state]}`);
    this.currentState = state;

    const { Characteristic: Char } = this.platform.api.hap;
    this.service.updateCharacteristic(Char.SecuritySystemCurrentState, state);

    const targetState = state === AlarmState.ALARM_TRIGGERED
      ? AlarmState.AWAY_ARM
      : state;
    this.service.updateCharacteristic(Char.SecuritySystemTargetState, targetState);
  }
}
