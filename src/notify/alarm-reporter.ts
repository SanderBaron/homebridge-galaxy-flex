// Stelt de iMessage-verslagen samen uit de gebeurtenissen van de plugin:
// alarm (met zone en wie in-/uitschakelde), storing, en optioneel elke
// in-/uitschakeling.

import { Logger } from 'homebridge';
import { IMessageSender } from './imessage';

export interface ReporterOptions {
  onAlarm:     boolean;  // verslag bij inbraak-/brandalarm + uitschakeling
  onFault:     boolean;  // melding bij storing (Storing-melder aan/uit)
  onArmDisarm: boolean;  // melding bij elke in-/uitschakeling
}

const tijd = (d: Date) => d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

function duurTekst(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} seconden`;
  return `${Math.round(s / 60)} minuten`;
}

export class AlarmReporter {
  private lastArm?:    { name: string; time: Date };
  private lastDisarm?: { name: string; time: Date };
  private session?:    { start: Date; type: 'fire' | 'intrusion'; zones: string[] };
  private lastClearedAt = 0;

  constructor(
    private readonly log: Logger,
    private readonly sender: IMessageSender,
    private readonly recipients: string[],
    private readonly opts: ReporterOptions,
  ) {}

  // Zone meldt alarm terwijl het systeem ingeschakeld is.
  onZoneAlarm(zoneName: string, type: 'fire' | 'intrusion'): void {
    if (!this.opts.onAlarm) return;
    const now = new Date();

    // Al een lopend alarm → alleen nieuwe zones kort namelden
    if (this.session) {
      if (!this.session.zones.includes(zoneName)) {
        this.session.zones.push(zoneName);
        this.stuur(`🚨 Ook alarm in zone: ${zoneName} (${tijd(now)})`);
      }
      return;
    }

    this.session = { start: now, type, zones: [zoneName] };
    const kop = type === 'fire' ? '🔥 BRANDALARM' : '🚨 INBRAAKALARM';
    const regels = [kop, `Zone: ${zoneName}`, `Tijd: ${tijd(now)}`];
    if (this.lastArm) {
      regels.push(`Ingeschakeld door: ${this.lastArm.name} (${tijd(this.lastArm.time)})`);
    }
    this.stuur(regels.join('\n'));
  }

  // Systeem uitgeschakeld terwijl een alarm actief was → samenvattend verslag.
  onAlarmCleared(): void {
    const session = this.session;
    this.session = undefined;
    this.lastClearedAt = Date.now();
    if (!session || !this.opts.onAlarm) return;
    const now = new Date();

    // De naam van wie uitschakelde (OP-event) komt vlak ná de statuswissel
    // binnen — even wachten zodat het verslag compleet is.
    setTimeout(() => {
      const recent = this.lastDisarm && (Date.now() - this.lastDisarm.time.getTime()) < 15_000;
      const door   = recent ? ` door ${this.lastDisarm!.name}` : '';
      this.stuur([
        `✅ Alarm uitgeschakeld${door}`,
        `Tijd: ${tijd(now)} (${duurTekst(now.getTime() - session.start.getTime())} na het alarm)`,
        `Oorzaak: ${session.zones.join(', ')}`,
      ].join('\n'));
    }, 3000);
  }

  // Gebruiker schakelt in of uit (CL/OP-event met gebruikersnummer).
  onUserEvent(name: string, armed: boolean): void {
    const now = new Date();
    if (armed) this.lastArm    = { name, time: now };
    else       this.lastDisarm = { name, time: now };

    if (!this.opts.onArmDisarm) return;
    // Na een alarm dekt het alarm-verslag de uitschakeling al
    if (!armed && (this.session || Date.now() - this.lastClearedAt < 15_000)) return;
    this.stuur(armed
      ? `🔒 Alarm ingeschakeld door ${name} (${tijd(now)})`
      : `🔓 Alarm uitgeschakeld door ${name} (${tijd(now)})`);
  }

  // Eenmalig testbericht (via markerbestand in de Homebridge-map).
  sendTest(): void {
    this.stuur(`✉️ Testbericht van homebridge-galaxy-flex (${tijd(new Date())})\nAls je dit leest werkt de iMessage-koppeling.`);
  }

  // Storing-melder aan/uit.
  onFault(active: boolean): void {
    if (!this.opts.onFault) return;
    const now = new Date();
    this.stuur(active
      ? `⚠️ STORING alarmsysteem\nHet paneel meldt een storing (sabotage of communicatie) zonder zone-alarm.\nTijd: ${tijd(now)}`
      : `✅ Storing alarmsysteem opgeheven (${tijd(now)})`);
  }

  private stuur(tekst: string): void {
    this.log.info(`iMessage: "${tekst.split('\n')[0]}" → ${this.recipients.length} ontvanger${this.recipients.length !== 1 ? 's' : ''}`);
    this.sender.send(this.recipients, tekst);
  }
}
