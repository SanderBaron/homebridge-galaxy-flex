import * as https from 'https';
import { Logger } from 'homebridge';

export interface HueLight {
  id: string;
  name: string;
  on: boolean;
  brightness: number;       // 0-100
  colorTemp?: number;       // mirek (153-500)
  colorXy?: { x: number; y: number };
  supportsDimming: boolean;
  supportsColor: boolean;
  supportsColorTemp: boolean;
  supportsSignaling: boolean;
}

export interface LightSnapshot {
  id: string;
  name: string;
  on: boolean;
  brightness: number;
  supportsDimming?: boolean;
  colorTemp?: number;
  colorXy?: { x: number; y: number };
}

// Named colors → CIE xy (Hue gamut C)
export const COLORS: Record<string, { x: number; y: number }> = {
  red:    { x: 0.675, y: 0.322 },
  orange: { x: 0.600, y: 0.375 },
  yellow: { x: 0.450, y: 0.450 },
  green:  { x: 0.170, y: 0.700 },
  blue:   { x: 0.167, y: 0.040 },
  purple: { x: 0.270, y: 0.100 },
  pink:   { x: 0.400, y: 0.200 },
};

export class HueClient {
  private readonly agent: https.Agent;

  constructor(
    private readonly log: Logger,
    private readonly bridgeIp: string,
    private readonly apiKey: string,
  ) {
    // Hue bridge uses self-signed TLS cert
    this.agent = new https.Agent({ rejectUnauthorized: false });
  }

  // ── Pairing ─────────────────────────────────────────────────────────────────

  static async createApiKey(bridgeIp: string): Promise<string> {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const body  = JSON.stringify({ devicetype: 'homebridge-galaxy-flex#homebridge', generateclientkey: true });
    const data  = await request(`https://${bridgeIp}/api`, { method: 'POST', body, agent });
    const arr   = JSON.parse(data) as Array<{ success?: { username: string } }>;
    const key   = arr[0]?.success?.username;
    if (!key) throw new Error('Druk eerst op de knop op de Hue Bridge en probeer opnieuw.');
    return key;
  }

  // ── Light discovery ──────────────────────────────────────────────────────────

  async getLights(): Promise<HueLight[]> {
    const data  = await this.get('/clip/v2/resource/light');
    const items = (JSON.parse(data).data ?? []) as Record<string, unknown>[];
    return items.map(l => this.parseLight(l));
  }

  // ── State snapshot ───────────────────────────────────────────────────────────

  async snapshot(lightIds: string[]): Promise<LightSnapshot[]> {
    const all = await this.getLights();
    return all
      .filter(l => lightIds.includes(l.id))
      .map(l => ({
        id:        l.id,
        name:      l.name,
        on:        l.on,
        brightness: l.brightness,
        supportsDimming: l.supportsDimming,
        colorTemp: l.colorTemp,
        colorXy:   l.colorXy,
      }));
  }

  async restore(snapshots: LightSnapshot[]): Promise<void> {
    // Sequentieel om de Hue bridge niet te overbelasten bij veel lampen
    for (const s of snapshots) {
      try {
        await this.setLight(s.id, {
          on:         s.on,
          // brightness alleen sturen naar lampen die dimmen ondersteunen;
          // anders weigert de Hue API met "(.dimming.brightness) is not supported".
          // (supportsDimming kan ontbreken in oude on-disk snapshots → dan overslaan)
          brightness: s.supportsDimming ? s.brightness : undefined,
          colorTemp:  s.colorTemp,
          colorXy:    s.colorXy,
        });
        // 100ms pauze = max 10 req/sec, gelijk aan Hue bridge limiet
        await new Promise(r => setTimeout(r, 100));
      } catch { /* ga door met de rest */ }
    }
  }

  // ── Light control ────────────────────────────────────────────────────────────

  async setLight(id: string, opts: {
    on?: boolean;
    brightness?: number;
    colorTemp?: number;
    colorXy?: { x: number; y: number };
    signal?: 'none' | 'alternating';
    signalColors?: Array<{ x: number; y: number }>;
    signalDurationMs?: number;
  }): Promise<void> {
    const body: Record<string, unknown> = {};

    if (opts.on !== undefined)        body['on']       = { on: opts.on };
    if (opts.brightness !== undefined) body['dimming'] = { brightness: Math.max(1, opts.brightness) };
    if (opts.colorTemp !== undefined)  body['color_temperature'] = { mirek: opts.colorTemp };
    if (opts.colorXy !== undefined)    body['color']   = { xy: opts.colorXy };

    if (opts.signal && opts.signal !== 'none' && opts.signalColors?.length) {
      body['signaling'] = {
        signal:   opts.signal,
        duration: opts.signalDurationMs ?? 900000, // 15 min
        colors:   opts.signalColors.map(xy => ({ color: { xy } })),
      };
    }

    await this.put(`/clip/v2/resource/light/${id}`, body);
  }

  async stopSignal(id: string): Promise<void> {
    await this.put(`/clip/v2/resource/light/${id}`, { signaling: { signal: 'no_signal' } });
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  private async get(path: string): Promise<string> {
    return request(`https://${this.bridgeIp}${path}`, {
      method: 'GET',
      headers: { 'hue-application-key': this.apiKey },
      agent: this.agent,
    });
  }

  private async put(path: string, body: unknown): Promise<void> {
    const res = await request(`https://${this.bridgeIp}${path}`, {
      method: 'PUT',
      headers: { 'hue-application-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      agent: this.agent,
    });
    const json = JSON.parse(res);
    if (json.errors?.length) {
      this.log.warn(`Hue PUT ${path}: ${JSON.stringify(json.errors)}`);
    }
  }

  private parseLight(l: Record<string, unknown>): HueLight {
    const metadata = l['metadata'] as Record<string, unknown> | undefined;
    const on       = (l['on']      as { on: boolean } | undefined)?.on ?? false;
    const dimObj   = l['dimming']  as { brightness: number } | undefined;
    const dim      = dimObj?.brightness ?? 100;
    const ct       = (l['color_temperature'] as { mirek: number; mirek_valid: boolean } | undefined);
    const col      = (l['color']   as { xy: { x: number; y: number } } | undefined);
    const sig      = (l['signaling'] as { status?: { signal_values?: string[] } } | undefined);

    return {
      id:                  l['id'] as string,
      name:                (metadata?.['name'] as string) ?? 'Onbekend',
      on,
      brightness:          Math.round(dim),
      colorTemp:           ct?.mirek_valid ? ct.mirek : undefined,
      colorXy:             col?.xy,
      supportsDimming:     !!dimObj,
      supportsColor:       !!col,
      supportsColorTemp:   !!ct,
      supportsSignaling:   !!(sig?.status?.signal_values?.includes('alternating')),
    };
  }
}

// ── Low-level HTTP ───────────────────────────────────────────────────────────

function request(url: string, opts: {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  agent: https.Agent;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port:     u.port || 443,
      path:     u.pathname + u.search,
      method:   opts.method,
      headers:  opts.headers ?? {},
      agent:    opts.agent,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
