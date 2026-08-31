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

// Controle-pas na herstel: snel genoeg dat niemand al handmatig lampen heeft
// bediend, laat genoeg dat alle nog onderweg zijnde bridge-commando's geland zijn.
const VERIFY_DELAY_MS = 15_000;

// Kelvin → mirek
function kelvinToMirek(k: number): number { return Math.round(1_000_000 / k); }

// Vergelijkt de gewenste (snapshot) staat met de actuele staat van een lamp.
// Bij een lamp die uit hoort te zijn is alleen aan/uit relevant.
function statesMatch(want: LightSnapshot, got: LightSnapshot): boolean {
  if (want.on !== got.on) return false;
  if (!want.on) return true;
  if (want.supportsDimming && Math.abs(want.brightness - got.brightness) > 5) return false;
  if (want.colorXy && got.colorXy) {
    if (Math.abs(want.colorXy.x - got.colorXy.x) > 0.05
     || Math.abs(want.colorXy.y - got.colorXy.y) > 0.05) return false;
  } else if (want.colorTemp !== undefined) {
    // Lamp hoorde in kleurtemperatuur-modus te staan; staat hij nu in
    // kleurmodus (mirek_valid=false) dan toont hij nog de alarmkleur.
    if (got.colorTemp === undefined) return false;
    if (Math.abs(want.colorTemp - got.colorTemp) > 25) return false;
  }
  return true;
}

export class AlarmLighting {
  private snapshot: LightSnapshot[] = [];
  private restoreTimer?: ReturnType<typeof setTimeout>;
  private verifyTimer?: ReturnType<typeof setTimeout>;
  private blinkTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private blinkState: Map<string, boolean> = new Map();
  private active = false;      // scène actief (of activatie bezig)
  private activating = false;  // activatieloop (snapshot + fase 1) draait nog
  // Elke alarm-start en elke reset verhoogt de generation. Lopende activaties,
  // blinktimers en herstel-acties dragen hun eigen generation mee en stoppen
  // zodra die niet meer actueel is — zo kunnen activatie en herstel nooit
  // tegelijk naar de bridge schrijven.
  private generation = 0;

  constructor(
    private readonly log: Logger,
    private readonly client: HueClient,
    private readonly config: AlarmLightingConfig,
    private readonly snapshotFile: string,
  ) {}

  private isStale(gen: number): boolean { return gen !== this.generation; }

  async onAlarm(type: 'fire' | 'intrusion'): Promise<void> {
    const scene = this.config[type];
    if (!scene?.length) {
      this.log.debug(`Hue: geen scène geconfigureerd voor ${type}`);
      return;
    }

    // Al actief → niet opnieuw starten (debounce)
    if (this.active) {
      this.log.debug('Hue: scene al actief, sla nieuwe activering over');
      return;
    }

    const gen = ++this.generation;
    this.active     = true;
    this.activating = true;
    this.cancelRestoreTimer();
    this.cancelVerifyTimer();
    this.stopAllBlinks();

    this.log.info(`Hue: activeer ${type} scène (${scene.length} lamp${scene.length !== 1 ? 'en' : ''})`);

    // Snapshot van de oorspronkelijke staat. Ligt er nog een snapshot van een
    // niet-afgeronde herstel-cyclus (alarm → reset → alarm binnen de controle-
    // periode), dan is DIE de echte oorspronkelijke staat — niet overschrijven.
    if (this.snapshot.length === 0) {
      try {
        this.snapshot = await this.client.snapshot(scene.map(l => l.lightId));
        fs.writeFileSync(this.snapshotFile, JSON.stringify(this.snapshot, null, 2));
        this.log.debug(`Hue: snapshot opgeslagen (${this.snapshot.length} lampen)`);
      } catch (err) {
        this.log.warn(`Hue: snapshot mislukt — ${err}`);
      }
    } else {
      this.log.info('Hue: bestaande snapshot hergebruikt (vorig herstel nog niet afgerond)');
    }

    // Reset binnengekomen terwijl de snapshot liep → niets activeren, herstellen
    if (this.isStale(gen)) {
      this.log.info('Hue: alarm gereset tijdens snapshot — herstel verlichting');
      this.activating = false;
      await this.restore('reset');
      return;
    }

    // Fase 1: activeer alle lampen (kleur + helderheid) — blinktimers nog NIET
    // starten (die eten bridge-quota op terwijl de activatieloop nog bezig is).
    // Na elke lamp checken of een reset ons heeft ingehaald: de loop duurt bij
    // veel lampen meerdere seconden en een snelle reset (per ongeluk alarm)
    // valt daar precies in.
    type BlinkParam = { cfg: LightSceneConfig; colorXy?: { x: number; y: number }; colorTemp?: number; supportsDimming: boolean };
    const blinkQueue: BlinkParam[] = [];

    for (const cfg of scene) {
      if (this.isStale(gen)) {
        this.log.info('Hue: activatie afgebroken door reset — herstel verlichting');
        this.activating = false;
        await this.restore('reset');
        return;
      }
      const bp = await this.activateLight(cfg);
      if (bp) blinkQueue.push({ cfg, ...bp });
      await new Promise(r => setTimeout(r, 100)); // 100ms = max 10/sec, gelijk aan bridge limiet
    }

    this.activating = false;
    if (this.isStale(gen)) {
      this.log.info('Hue: activatie afgebroken door reset — herstel verlichting');
      await this.restore('reset');
      return;
    }

    // Fase 2: start blinktimers pas als alle lampen actief zijn
    for (const bp of blinkQueue) {
      this.startBlink(bp.cfg, gen, bp.colorXy, bp.colorTemp, bp.supportsDimming);
    }

    // Auto-restore timer
    const minutes = this.config.restoreAfterMinutes ?? 15;
    this.restoreTimer = setTimeout(() => this.restore('timer'), minutes * 60 * 1000);
    this.log.info(`Hue: automatisch herstel over ${minutes} minuten`);
  }

  async onReset(): Promise<void> {
    if (!this.active) return;
    this.generation++;
    if (this.activating) {
      // De activatieloop merkt de nieuwe generation op en voert daarna ZELF het
      // herstel uit. Hier zelf herstellen zou betekenen dat herstel en activatie
      // tegelijk naar de bridge schrijven — precies de bug van 31/8.
      this.log.info('Hue: reset tijdens activatie — herstel start zodra activatie gestopt is');
      return;
    }
    await this.restore('reset');
  }

  private async restore(reason: 'reset' | 'timer'): Promise<void> {
    this.log.info(`Hue: herstel verlichting (reden: ${reason})`);
    const gen = this.generation; // nieuw alarm tijdens herstel → stoppen
    this.cancelRestoreTimer();
    this.cancelVerifyTimer();
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
    this.snapshot = toRestore; // ook beschikbaar voor de controle-pas

    try {
      await this.client.restore(toRestore, () => this.isStale(gen));
      if (this.isStale(gen)) {
        this.log.info('Hue: herstel onderbroken door nieuw alarm');
        return;
      }
      this.log.info(`Hue: verlichting hersteld — controle over ${VERIFY_DELAY_MS / 1000}s`);
    } catch (err) {
      this.log.error(`Hue: herstel mislukt — ${err}`);
      if (this.isStale(gen)) return;
      // controle-pas hieronder krijgt de kans het alsnog recht te zetten
    }

    // Controle-pas: check na korte tijd of alle lampen echt zijn hersteld en
    // corrigeer alleen de afwijkende. De snapshot blijft bewaard tot de
    // controle is afgerond.
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = undefined;
      this.verifyRestore(gen).catch(err => this.log.warn(`Hue: herstel-controle mislukt — ${err}`));
    }, VERIFY_DELAY_MS);
  }

  private async verifyRestore(gen: number): Promise<void> {
    if (this.isStale(gen) || !this.snapshot.length) return;

    const current = await this.client.snapshot(this.snapshot.map(s => s.id));
    if (this.isStale(gen)) return;

    const byId  = new Map(current.map(c => [c.id, c]));
    const wrong = this.snapshot.filter(s => {
      const c = byId.get(s.id);
      return c ? !statesMatch(s, c) : false;
    });

    if (wrong.length) {
      this.log.warn(`Hue: controle — ${wrong.length} lamp${wrong.length !== 1 ? 'en' : ''} niet correct hersteld (${wrong.map(w => w.name).join(', ')}), opnieuw herstellen`);
      await this.client.restore(wrong, () => this.isStale(gen));
      if (this.isStale(gen)) return;
    } else {
      this.log.info('Hue: controle — alle lampen correct hersteld');
    }

    // Cyclus afgerond → snapshot opruimen
    this.snapshot = [];
    fs.unlink(this.snapshotFile, () => {});
  }

  // Activeert één lamp (on + kleur + helderheid). Geeft blink-parameters terug als de lamp
  // moet knipperen — de aanroeper start de blinktimers pas ná de volledige activatieloop.
  private async activateLight(cfg: LightSceneConfig): Promise<{ colorXy?: { x: number; y: number }; colorTemp?: number; supportsDimming: boolean } | null> {
    const colorXy   = cfg.colorMode === 'color' && cfg.color
      ? (COLORS[cfg.color] ?? COLORS['red'])
      : undefined;
    const colorTemp = cfg.colorMode === 'colorTemp' && cfg.colorTemp
      ? kelvinToMirek(cfg.colorTemp)
      : undefined;

    // Bouw het setLight request op basis van wat de lamp ondersteunt (opgeslagen bij configuratie)
    const ext             = cfg as LightSceneConfig & { supportsDimming?: boolean; supportsColor?: boolean; supportsColorTemp?: boolean };
    const supportsDimming = ext.supportsDimming !== false;
    const supportsColor   = ext.supportsColor   === true && !!(colorXy);
    const supportsTemp    = ext.supportsColorTemp === true && !!(colorTemp);

    const setOpts: Parameters<typeof this.client.setLight>[1] = { on: true };
    if (supportsDimming)   setOpts.brightness = cfg.brightness;
    if (supportsColor)     setOpts.colorXy    = colorXy;
    else if (supportsTemp) setOpts.colorTemp  = colorTemp;

    await this.client.setLight(cfg.lightId, setOpts);

    // Geef blink-parameters terug voor fase 2 (software blink, native signaling heeft firmwarebugs)
    return cfg.blink !== 'none' ? { colorXy, colorTemp, supportsDimming } : null;
  }

  private startBlink(cfg: LightSceneConfig, gen: number, colorXy?: { x: number; y: number }, colorTemp?: number, supportsDimming = true): void {
    const interval = BLINK_MS[cfg.blink];
    if (!interval) return;

    this.blinkState.set(cfg.lightId, true); // starts ON
    const timer = setInterval(async () => {
      // Reset of nieuw alarm → geen commando meer sturen, ook niet vanuit een
      // tick die al gepland stond toen stopAllBlinks liep.
      if (this.isStale(gen)) return;
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
    for (const timer of this.blinkTimers.values()) {
      clearInterval(timer);
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

  private cancelVerifyTimer(): void {
    if (this.verifyTimer) {
      clearTimeout(this.verifyTimer);
      this.verifyTimer = undefined;
    }
  }
}
