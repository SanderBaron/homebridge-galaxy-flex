import * as fs from 'fs';
import { Logger } from 'homebridge';
import { HueClient, LightSnapshot, COLORS } from './hue-client';

export type BlinkSpeed = 'none' | 'slow' | 'fast';
export type ColorMode  = 'colorTemp' | 'color';

export interface LightSceneConfig {
  lightId:    string;
  lightName:  string;
  brightness: number;       // 1-100
  colorMode:  ColorMode;
  colorTemp?: number;       // kelvin (2000-6500), used when colorMode='colorTemp'
  color?:     string;       // key from COLORS, used when colorMode='color'
  blink:      BlinkSpeed;
}

export interface AlarmLightingConfig {
  fire:       LightSceneConfig[];
  intrusion:  LightSceneConfig[];
  restoreAfterMinutes: number;
}

// Blink interval in ms (on→off→on cycle)
const BLINK_MS: Record<BlinkSpeed, number> = {
  none: 0,
  slow: 2000,
  fast: 800,
};

// Kelvin → mirek
function kelvinToMirek(k: number): number { return Math.round(1_000_000 / k); }

export class AlarmLighting {
  private snapshot: LightSnapshot[] = [];
  private restoreTimer?: ReturnType<typeof setTimeout>;
  private blinkTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private blinkState: Map<string, boolean> = new Map();
  private active = false;
  private pending = false;   // true vanaf het moment onAlarm start, vóór snapshot klaar is
  private cancelled = false; // true als onReset werd aangeroepen tijdens snapshot

  constructor(
    private readonly log: Logger,
    private readonly client: HueClient,
    private readonly config: AlarmLightingConfig,
    private readonly snapshotFile: string,
  ) {}

  async onAlarm(type: 'fire' | 'intrusion'): Promise<void> {
    const scene = this.config[type];
    if (!scene?.length) {
      this.log.debug(`Hue: geen scène geconfigureerd voor ${type}`);
      return;
    }

    // Al actief of pending → niet opnieuw starten (debounce)
    if (this.active || this.pending) {
      this.log.debug(`Hue: scene al actief, sla nieuwe activering over`);
      return;
    }

    this.log.info(`Hue: activeer ${type} scène (${scene.length} lamp${scene.length !== 1 ? 'en' : ''})`);
    this.pending   = true;
    this.cancelled = false;

    // Save snapshot (only if not already active — don't overwrite original state)
    if (!this.active) {
      try {
        this.snapshot = await this.client.snapshot(scene.map(l => l.lightId));
        fs.writeFileSync(this.snapshotFile, JSON.stringify(this.snapshot, null, 2));
        this.log.debug(`Hue: snapshot opgeslagen (${this.snapshot.length} lampen)`);
      } catch (err) {
        this.log.warn(`Hue: snapshot mislukt — ${err}`);
      }
    }

    // Alarm al geannuleerd terwijl snapshot bezig was → herstel direct
    if (this.cancelled) {
      this.log.info('Hue: alarm geannuleerd tijdens snapshot — herstel verlichting');
      this.pending   = false;
      this.cancelled = false;
      await this.restore('reset');
      return;
    }

    this.pending = false;
    this.active  = true;
    this.stopAllBlinks();
    this.cancelRestoreTimer();

    // Activeer lampen in batches van 10 om bridge niet te overbelasten
    const BATCH = 10;
    for (let i = 0; i < scene.length; i += BATCH) {
      await Promise.allSettled(scene.slice(i, i + BATCH).map(cfg => this.activateLight(cfg)));
    }

    // Auto-restore timer
    const minutes = this.config.restoreAfterMinutes ?? 15;
    this.restoreTimer = setTimeout(() => this.restore('timer'), minutes * 60 * 1000);
    this.log.info(`Hue: automatisch herstel over ${minutes} minuten`);
  }

  async onReset(): Promise<void> {
    if (this.pending) {
      // Alarm is nog bezig met snapshot — markeer als geannuleerd
      this.log.info('Hue: reset ontvangen tijdens snapshot — annuleer en herstel zodra snapshot klaar');
      this.cancelled = true;
      return;
    }
    if (!this.active) return;
    await this.restore('reset');
  }

  private async restore(reason: 'reset' | 'timer'): Promise<void> {
    this.log.info(`Hue: herstel verlichting (reden: ${reason})`);
    this.cancelRestoreTimer();
    this.stopAllBlinks();
    this.active = false;

    // Load snapshot from disk in case of restart
    let toRestore = this.snapshot;
    if (!toRestore.length) {
      try {
        toRestore = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
      } catch { /* no snapshot on disk */ }
    }

    if (!toRestore.length) {
      this.log.warn('Hue: geen snapshot beschikbaar, kan verlichting niet herstellen');
      return;
    }

    try {
      await this.client.restore(toRestore);
      this.snapshot = [];
      fs.unlink(this.snapshotFile, () => {});
      this.log.info('Hue: verlichting hersteld');
    } catch (err) {
      this.log.error(`Hue: herstel mislukt — ${err}`);
    }
  }

  private async activateLight(cfg: LightSceneConfig): Promise<void> {
    const colorXy   = cfg.colorMode === 'color' && cfg.color
      ? (COLORS[cfg.color] ?? COLORS['red'])
      : undefined;
    const colorTemp = cfg.colorMode === 'colorTemp' && cfg.colorTemp
      ? kelvinToMirek(cfg.colorTemp)
      : undefined;

    // Bouw het setLight request op basis van wat de lamp ondersteunt
    const supportsColor   = !!(colorXy);
    const supportsTemp    = !!(colorTemp);
    // supportsDimming is opgeslagen in de scèneconfig vanuit de UI
    const supportsDimming = (cfg as LightSceneConfig & { supportsDimming?: boolean }).supportsDimming !== false;

    const setOpts: Parameters<typeof this.client.setLight>[1] = { on: true };
    if (supportsDimming)              setOpts.brightness = cfg.brightness;
    if (supportsColor && colorXy)     setOpts.colorXy    = colorXy;
    else if (supportsTemp && colorTemp) setOpts.colorTemp = colorTemp;

    await this.client.setLight(cfg.lightId, setOpts);

    // Software blink (native signaling heeft bugs in Hue firmware, altijd software)
    if (cfg.blink !== 'none') {
      this.startBlink(cfg, colorXy, colorTemp, supportsDimming);
    }
  }

  private startBlink(cfg: LightSceneConfig, colorXy?: { x: number; y: number }, colorTemp?: number, supportsDimming = true): void {
    const interval = BLINK_MS[cfg.blink];
    if (!interval) return;

    this.blinkState.set(cfg.lightId, true); // starts ON
    const timer = setInterval(async () => {
      const currentlyOn = this.blinkState.get(cfg.lightId) ?? true;
      this.blinkState.set(cfg.lightId, !currentlyOn);
      try {
        if (currentlyOn) {
          await this.client.setLight(cfg.lightId, { on: false });
        } else {
          const onOpts: Parameters<typeof this.client.setLight>[1] = { on: true };
          if (supportsDimming) onOpts.brightness = cfg.brightness;
          if (colorXy)         onOpts.colorXy    = colorXy;
          else if (colorTemp)  onOpts.colorTemp  = colorTemp;
          await this.client.setLight(cfg.lightId, onOpts);
        }
      } catch { /* bridge busy, skip this cycle */ }
    }, interval / 2);

    this.blinkTimers.set(cfg.lightId, timer);
    this.log.debug(`Hue: blink ${cfg.blink} gestart op ${cfg.lightName} (${interval / 2}ms interval)`);
  }

  private stopAllBlinks(): void {
    for (const [id, timer] of this.blinkTimers) {
      clearInterval(timer);
      // Stop any native signaling too
      this.client.stopSignal(id).catch(() => {});
    }
    this.blinkTimers.clear();
    this.blinkState.clear();
  }

  private cancelRestoreTimer(): void {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = undefined;
    }
  }
}
