// Eigen logbestand van de plugin, los van de Homebridge-log.
//
// De Homebridge-log wordt door hb-service afgekapt bij 1 MB (er blijft 200 KB
// over) — met een paar praatgrage plugins is dat nog geen halve dag. Daarom
// schrijft de plugin alles (inclusief debug-regels zoals ruwe MQTT-berichten)
// óók naar een eigen bestand in de Homebridge-map, en ruimt dat zelf op:
//  - alles ouder dan RETENTION_HOURS wordt bij start en daarna elk uur verwijderd;
//  - als het bestand ondanks dat groter wordt dan MAX_BYTES blijft alleen de
//    staart over (harde bovengrens, zodat de schijf nooit volloopt).

import * as fs from 'fs';
import type { Logging } from 'homebridge';

const RETENTION_HOURS  = 72;
const MAX_BYTES        = 10 * 1024 * 1024; // harde bovengrens
const KEEP_TAIL_BYTES  = 2 * 1024 * 1024;  // wat overblijft na afkappen op grootte
const PRUNE_INTERVAL   = 60 * 60 * 1000;   // elk uur

export class FileLog {
  private pruneTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly filePath: string) {
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL);
    this.pruneTimer.unref?.(); // mag het proces niet in leven houden
  }

  get path(): string { return this.filePath; }

  write(level: string, message: string): void {
    const line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${message}\n`;
    try {
      fs.appendFileSync(this.filePath, line);
    } catch { /* schrijffout mag de plugin nooit stoppen */ }
  }

  // Verwijdert regels ouder dan RETENTION_HOURS. Het bestand is chronologisch,
  // dus alles vanaf de eerste regel die nog jong genoeg is blijft staan.
  prune(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      let content = fs.readFileSync(this.filePath, 'utf8');
      const cutoff = Date.now() - RETENTION_HOURS * 60 * 60 * 1000;
      const lines = content.split('\n');
      let firstKeep = lines.findIndex(l => {
        const ts = Date.parse(l.slice(0, 24));
        return !Number.isNaN(ts) && ts >= cutoff;
      });
      if (firstKeep === -1) firstKeep = lines.length; // alles is oud
      let changed = false;
      if (firstKeep > 0) {
        content = lines.slice(firstKeep).join('\n');
        changed = true;
      }
      if (Buffer.byteLength(content) > MAX_BYTES) {
        content = content.slice(-KEEP_TAIL_BYTES);
        content = content.slice(content.indexOf('\n') + 1); // geen halve regel bovenaan
        changed = true;
      }
      if (changed) {
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, this.filePath);
      }
    } catch { /* opruimen mislukt → volgende keer opnieuw */ }
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }
}

// Geeft een Logging-object terug dat alles naar Homebridge doorstuurt én naar
// het eigen bestand schrijft. Debug-regels gaan altijd naar het bestand, ook
// als Homebridge niet in debug-modus draait — dat is precies het bewijs dat
// je na een incident wilt hebben.
export function withFileLog(log: Logging, file: FileLog): Logging {
  const format = (message: string, parameters: unknown[]): string =>
    parameters.length ? `${message} ${parameters.map(p => String(p)).join(' ')}` : message;

  const wrapped = ((message: string, ...parameters: unknown[]) => {
    file.write('info', format(message, parameters));
    log(message, ...parameters);
  }) as Logging;

  wrapped.prefix = log.prefix;
  for (const level of ['info', 'success', 'warn', 'error', 'debug'] as const) {
    wrapped[level] = (message: string, ...parameters: unknown[]) => {
      file.write(level, format(message, parameters));
      log[level](message, ...parameters);
    };
  }
  wrapped.log = (level, message: string, ...parameters: unknown[]) => {
    file.write(String(level), format(message, parameters));
    log.log(level, message, ...parameters);
  };
  return wrapped;
}
