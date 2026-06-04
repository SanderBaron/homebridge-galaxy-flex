// Parses Galaxy Flex NEW_EVENT / OLD_EVENT payload strings.
//
// Observed format (ASCII, fields separated by /):
//   ti<HH>:<MM>                    – timestamp
//   id<NNN>                        – zone/device ID
//   pi<NNN>                        – partition/area number
//   <CODE>                         – 2-char SIA-style event code (last field)
//
// Examples:
//   "ti16:46/RR"
//   "ti16:46/id001/pi010/OR"

import { Logger } from 'homebridge';
import { SiaMessage } from './events';

export function parseGalaxyEvent(payload: Buffer, log: Logger): SiaMessage | null {
  const raw = payload.toString('ascii').trim();
  log.debug(`Galaxy event string: ${JSON.stringify(raw)}`);

  const parts = raw.split('/');
  let time = '';
  let zone: number | null = null;
  let eventCode = '';

  for (const part of parts) {
    if (part.startsWith('ti')) {
      time = part.slice(2);
    } else if (part.startsWith('id')) {
      // id<NNN> can be user ID or zone — only use as zone if no explicit zone found later
      const n = parseInt(part.slice(2), 10);
      if (!isNaN(n) && zone === null) zone = n;
    } else {
      // Event code: 2 alpha chars, optionally followed by digits (zone), e.g. "CL", "BA1023"
      const m = /^([A-Za-z]{2})(\d*)$/.exec(part);
      if (m) {
        eventCode = m[1].toUpperCase();
        if (m[2]) zone = parseInt(m[2], 10);
      }
    }
    // pi<NNN> (partition) ignored — single-partition panel
  }

  if (!eventCode) {
    log.warn(`Galaxy event: no event code found in "${raw}"`);
    return null;
  }

  return {
    raw,
    type: 'GALAXY',
    sequence: 0,
    receiver: 0,
    line: 0,
    account: '',
    eventCode,
    zone,
    timestamp: time || null,
  };
}
