export enum AlarmState {
  STAY_ARM = 0,
  AWAY_ARM = 1,
  NIGHT_ARM = 2,
  DISARMED = 3,
  ALARM_TRIGGERED = 4,
}

export interface SiaMessage {
  raw: string;
  type: string;        // SIA-DCS | NULL | ACK
  sequence: number;
  receiver: number;
  line: number;
  account: string;
  eventCode: string;   // e.g. BA, CL, OP
  zone: number | null; // zone number, or null for system events
  timestamp: string | null;
}

export interface SiaEvent {
  message: SiaMessage;
  alarmStateChange?: AlarmState;
  zoneEvent?: {
    zone: number;
    code: string;
    triggered: boolean;
  };
}

// SIA / Galaxy event codes
export const SIA_CODES: Record<string, string> = {
  // Burglary
  BA: 'Burglary Alarm',
  BR: 'Burglary Restore',
  // Fire
  FA: 'Fire Alarm',
  FR: 'Fire Restore',
  // Panic / hold-up
  PA: 'Panic Alarm',
  PR: 'Panic Restore',
  // Tamper
  TA: 'Tamper Alarm',
  TR: 'Tamper Restore',
  // Arm/Disarm (SIA standard)
  CL: 'Closing (Armed)',
  OP: 'Opening (Disarmed)',
  CA: 'Cancel (Alarm Acknowledged)',
  // Arm/Disarm (Galaxy-specific observed codes)
  OR: 'Opening Report (Disarmed)',
  CR: 'Closing Report (Armed)',
  OG: 'Opening Group (Part Disarm)',
  CG: 'Closing Group (Part Arm)',
  // Restore / status
  RR: 'Restoral Report (System OK)',
  // Comms
  NL: 'No Link (Comms Failure)',
  YK: 'Comms Restore',
  // Generic zone
  ZO: 'Zone Open',
  ZC: 'Zone Close',
};

export function isAlarmCode(code: string): boolean {
  return ['BA', 'FA', 'PA', 'TA'].includes(code);
}

export function isRestoreCode(code: string): boolean {
  return ['BR', 'FR', 'PR', 'TR'].includes(code);
}

export function codeToAlarmState(code: string): AlarmState | null {
  switch (code) {
    case 'CL':
    case 'CR': return AlarmState.AWAY_ARM;
    case 'CG': return AlarmState.STAY_ARM;
    case 'OP':
    case 'OR':
    case 'OG':
    case 'CA': return AlarmState.DISARMED;
    case 'BA':
    case 'FA':
    case 'PA': return AlarmState.ALARM_TRIGGERED;
    default:   return null;
  }
}
