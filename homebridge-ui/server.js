const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

class GalaxyFlexUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this._testSnapshot   = null;
    this._testBlinkTimers = new Map(); // lightId → intervalId

    this.onRequest('/state', async () => {
      const stateFile = path.join(this.homebridgeStoragePath, 'galaxy-flex-state.json');
      try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
      catch { return null; }
    });

    this.onRequest('/module-status', async () => {
      const cfg = this.readPluginConfig();
      const result = {
        configured:         !!cfg.seasoftEnabled,
        seasoftIp:          cfg.seasoftIp || '',
        seasoftEnabled:     !!cfg.seasoftEnabled,
        mqttPort:           cfg.mqttPort || 1883,
        mqttExternalBroker: !!cfg.mqttExternalBroker,
        mqttBrokerUrl:      cfg.mqttBrokerUrl || '',
        siaPort:            cfg.port || 52000,
        hostIp:             this.getHostIp(),
        seasoftStatus:      null,
        seasoftSettings:    null,
        mqttBrokerDisplay:  '',
      };

      if (cfg.seasoftIp) {
        const [statusRes, settingsRes] = await Promise.all([
          fetchJson(`http://${cfg.seasoftIp}/data/status.json`),
          fetchJson(`http://${cfg.seasoftIp}/data/settings.json`),
        ]);
        result.seasoftStatus   = statusRes;
        result.seasoftSettings = settingsRes;
      }

      if (cfg.mqttExternalBroker && cfg.mqttBrokerUrl) {
        result.mqttBrokerDisplay = cfg.mqttBrokerUrl.replace(/^mqtt:\/\//, '');
      } else {
        const brokerFromSeasoft = result.seasoftSettings?.mqtt?.server;
        const port = cfg.mqttPort || 1883;
        result.mqttBrokerDisplay = brokerFromSeasoft
          ? `${brokerFromSeasoft}:${port}`
          : `${result.hostIp}:${port}`;
      }

      return result;
    });

    // Preview what auto-configure will change — no side effects
    this.onRequest('/configure-preview', async () => {
      const cfg = this.readPluginConfig();
      if (!cfg.seasoftIp) return { ok: false, error: 'Geen Seasoft IP ingesteld.' };

      const [current, status] = await Promise.all([
        fetchJson(`http://${cfg.seasoftIp}/data/settings.json`),
        fetchJson(`http://${cfg.seasoftIp}/data/status.json`),
      ]);
      if (!current) return { ok: false, error: `Seasoft module niet bereikbaar op ${cfg.seasoftIp}` };

      const hostIp   = this.getHostIp();
      const mqttPort = cfg.mqttPort || 1883;

      const changes = [];
      if (!current.mqtt.enabled)
        changes.push({ key: 'MQTT inschakelen', from: 'Uit', to: 'Aan' });
      if (current.mqtt.server !== hostIp)
        changes.push({ key: 'Broker IP', from: current.mqtt.server || '(leeg)', to: hostIp });
      if (current.mqtt.port !== mqttPort)
        changes.push({ key: 'Broker poort', from: String(current.mqtt.port), to: String(mqttPort) });
      if (!current.mqtt.autoenabled)
        changes.push({ key: 'Autodiscovery', from: 'Uit', to: 'Aan (homeassistant)' });

      return {
        ok: true,
        changes,
        noChangesNeeded: changes.length === 0,
        panel: status ? `${status.type} ${status.size}` : '?',
        currentSettings: {
          server: current.mqtt.server,
          port:   current.mqtt.port,
          enabled: current.mqtt.enabled,
        },
        willApply: {
          server:     hostIp,
          port:       mqttPort,
          enabled:    true,
          autoenabled: true,
          autotopic:  'homeassistant',
          basetopic:  cfg.seasoftBaseTopic || 'galaxy',
          clientname: 'galaxygateway',
        },
      };
    });

    // Actually apply the auto-configuration to the Seasoft module
    this.onRequest('/configure-apply', async () => {
      const cfg = this.readPluginConfig();
      if (!cfg.seasoftIp) return { ok: false, error: 'Geen Seasoft IP ingesteld.' };

      const current = await fetchJson(`http://${cfg.seasoftIp}/data/settings.json`);
      if (!current) return { ok: false, error: `Seasoft module niet bereikbaar op ${cfg.seasoftIp}` };

      const hostIp   = this.getHostIp();
      const mqttPort = cfg.mqttPort || 1883;

      current.mqtt.enabled    = true;
      current.mqtt.server     = hostIp;
      current.mqtt.port       = mqttPort;
      current.mqtt.clientname = 'galaxygateway';
      current.mqtt.basetopic  = cfg.seasoftBaseTopic || 'galaxy';
      current.mqtt.autoenabled = true;
      current.mqtt.autotopic  = 'homeassistant';

      try {
        const json = JSON.stringify(current);
        const blob = new Blob([json], { type: 'text/json' });
        const form = new FormData();
        form.append('file', blob, 'settings.json');
        const r = await fetch(`http://${cfg.seasoftIp}/data/settings.json`, { method: 'POST', body: form });
        if (!r.ok) return { ok: false, error: `Opslaan mislukt: HTTP ${r.status}` };
        return { ok: true, brokerIp: hostIp, brokerPort: mqttPort };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    // ── Hue endpoints ─────────────────────────────────────────────────────────

    // Discover Hue bridges: mDNS first, cloud fallback
    this.onRequest('/hue/discover', async () => {
      const candidates = new Map();

      // 1. mDNS via bonjour-service (_hue._tcp)
      try {
        const { Bonjour } = require('bonjour-service');
        const bonjour = new Bonjour();
        await new Promise(resolve => {
          const browser = bonjour.find({ type: 'hue' });
          browser.on('up', svc => {
            const ip = (svc.addresses || []).find(a => /^(\d{1,3}\.){3}\d{1,3}$/.test(a));
            if (ip) {
              const id = (svc.txt?.bridgeid || svc.host || ip).toUpperCase();
              candidates.set(id, { id, ip, source: 'mdns' });
            }
          });
          setTimeout(() => { browser.stop(); bonjour.destroy(); resolve(); }, 4000);
        });
      } catch (e) { /* mDNS not available, continue */ }

      // 2. Cloud fallback if mDNS found nothing
      if (candidates.size === 0) {
        try {
          const https = require('https');
          const agent = new https.Agent({ rejectUnauthorized: true });
          const data  = await nodeRequest('https://discovery.meethue.com', 'GET', null, {}, agent);
          const list  = JSON.parse(data);
          if (Array.isArray(list)) {
            for (const b of list) {
              if (b.id && b.internalipaddress) {
                candidates.set(b.id.toUpperCase(), { id: b.id.toUpperCase(), ip: b.internalipaddress, source: 'cloud' });
              }
            }
          }
        } catch (e) { /* cloud unavailable */ }
      }

      if (candidates.size === 0) return { ok: false, error: 'Geen Hue Bridge gevonden. Vul het IP handmatig in.' };
      return { ok: true, bridges: [...candidates.values()] };
    });

    // Read saved Hue scenes from disk (bypasses HomeBridge's stale in-memory cache)
    this.onRequest('/hue/get-scenes', async () => {
      const cfg = this.readPluginConfig();
      return {
        fireScene:           cfg.hueFireScene           || [],
        intrusionScene:      cfg.hueIntrusionScene      || [],
        restoreAfterMinutes: cfg.hueRestoreAfterMinutes || 15,
      };
    });

    // Activate a scene for testing (takes snapshot first)
    // Accepts scene directly in body so unsaved UI state works too
    this.onRequest('/hue/test-scene', async (body) => {
      const cfg = this.readPluginConfig();
      if (!cfg.hueBridgeIp || !cfg.hueApiKey) return { ok: false, error: 'Hue Bridge niet geconfigureerd.' };
      const type = body?.type;
      // Prefer scene passed from UI (current state), fall back to saved config
      const scene = body?.scene?.length
        ? body.scene
        : (type === 'fire' ? (cfg.hueFireScene || []) : (cfg.hueIntrusionScene || []));
      if (!scene.length) return { ok: false, error: `Geen lampen geconfigureerd voor ${type}.` };

      const agent  = new (require('https').Agent)({ rejectUnauthorized: false });
      const getAll = async () => {
        const d = await nodeRequest(`https://${cfg.hueBridgeIp}/clip/v2/resource/light`, 'GET', null, { 'hue-application-key': cfg.hueApiKey }, agent);
        return JSON.parse(d).data || [];
      };
      const put = (id, b) => nodeRequest(`https://${cfg.hueBridgeIp}/clip/v2/resource/light/${id}`, 'PUT', JSON.stringify(b), { 'hue-application-key': cfg.hueApiKey, 'Content-Type': 'application/json' }, agent);

      try {
        // Snapshot
        const all = await getAll();
        this._testSnapshot = scene.map(s => {
          const l = all.find(x => x.id === s.lightId);
          if (!l) return null;
          return {
            id: s.lightId, on: l.on?.on ?? false,
            brightness: l.dimming?.brightness ?? 100,
            colorTemp: l.color_temperature?.mirek,
            colorXy: l.color?.xy,
          };
        }).filter(Boolean);

        // Stop any running blink timers
        for (const timer of this._testBlinkTimers.values()) clearInterval(timer);
        this._testBlinkTimers.clear();

        const COLORS   = { red:{x:0.675,y:0.322}, orange:{x:0.600,y:0.375}, yellow:{x:0.450,y:0.450}, green:{x:0.170,y:0.700}, blue:{x:0.167,y:0.040}, purple:{x:0.270,y:0.100}, pink:{x:0.400,y:0.200} };
        const BLINK_MS = { slow: 2000, fast: 800 };

        // Fase 1: activeer alle lampen sequentieel (geen blink nog)
        // Blinktimers starten pas nadat ALLE lampen aan zijn — anders eten ze bridge-quota
        // op terwijl de activatieloop nog bezig is en vallen lampen achteraan af.
        const blinkQueue = [];
        for (const lc of scene) {
          const lightBody = { on: { on: true } };
          if (lc.supportsDimming !== false && lc.brightness) lightBody.dimming = { brightness: Math.max(1, lc.brightness) };
          if (lc.supportsColor && lc.colorMode === 'color' && lc.color)                   lightBody.color = { xy: COLORS[lc.color] || COLORS.red };
          else if (lc.supportsColorTemp && lc.colorMode === 'colorTemp' && lc.colorTemp)  lightBody.color_temperature = { mirek: Math.round(1000000 / lc.colorTemp) };
          await put(lc.lightId, lightBody);
          if (lc.blink && lc.blink !== 'none' && BLINK_MS[lc.blink]) {
            blinkQueue.push({ lc, colorBody: { ...lightBody } });
          }
          await new Promise(r => setTimeout(r, 100)); // 100ms = max 10/sec
        }

        // Fase 2: start blinktimers pas als alle lampen aan zijn
        for (const { lc, colorBody } of blinkQueue) {
          const halfInterval = BLINK_MS[lc.blink] / 2;
          let blinkOn = true;
          const timer = setInterval(async () => {
            blinkOn = !blinkOn;
            try { await put(lc.lightId, blinkOn ? colorBody : { on: { on: false } }); } catch { /* bridge busy */ }
          }, halfInterval);
          this._testBlinkTimers.set(lc.lightId, timer);
        }

        return { ok: true, snapshotCount: this._testSnapshot.length };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    // Restore lights after test
    this.onRequest('/hue/restore-test', async () => {
      const cfg = this.readPluginConfig();
      if (!cfg.hueBridgeIp || !cfg.hueApiKey) return { ok: false, error: 'Hue Bridge niet geconfigureerd.' };
      if (!this._testSnapshot?.length) return { ok: false, error: 'Geen snapshot beschikbaar.' };

      const agent = new (require('https').Agent)({ rejectUnauthorized: false });
      const put = (id, b) => nodeRequest(`https://${cfg.hueBridgeIp}/clip/v2/resource/light/${id}`, 'PUT', JSON.stringify(b), { 'hue-application-key': cfg.hueApiKey, 'Content-Type': 'application/json' }, agent);

      try {
        // Stop blinks eerst — anders blijven ze bridge-quota eten tijdens het herstellen
        for (const timer of this._testBlinkTimers.values()) clearInterval(timer);
        this._testBlinkTimers.clear();

        // Herstel sequentieel met 100ms pauze (zelfde limiet als activatie)
        for (const s of this._testSnapshot) {
          const body = { on: { on: s.on } };
          if (s.on) {
            body.dimming = { brightness: Math.max(1, s.brightness) };
            if (s.colorTemp) body.color_temperature = { mirek: s.colorTemp };
            else if (s.colorXy) body.color = { xy: s.colorXy };
          }
          await put(s.id, body);
          await new Promise(r => setTimeout(r, 100));
        }
        this._testSnapshot = null;
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    // Single pairing attempt — returns ok/link-not-pressed/error
    // The UI polls this every few seconds while showing "wacht op knop..."
    this.onRequest('/hue/pair-attempt', async (body) => {
      const ip = body?.ip || this.readPluginConfig().hueBridgeIp;
      if (!ip) return { ok: false, kind: 'error', error: 'Geen Hue Bridge IP.' };

      const payload = JSON.stringify({ devicetype: 'homebridge-galaxy-flex#homebridge', generateclientkey: true });
      const headers = { 'Content-Type': 'application/json' };

      // Try HTTP (port 80) first — supported by all bridge generations for pairing
      // Fall back to HTTPS (port 443) for newer bridges
      const attempts = [
        { url: `http://${ip}/api`,  agent: null },
        { url: `https://${ip}/api`, agent: new (require('https').Agent)({ rejectUnauthorized: false }) },
      ];

      let lastError = '';
      for (const { url, agent } of attempts) {
        try {
          const data  = await nodeRequestAny(url, 'POST', payload, headers, agent);
          const arr   = JSON.parse(data);
          const first = arr[0];
          if (first?.success?.username) return { ok: true, apiKey: first.success.username };
          if (first?.error?.type === 101) return { ok: false, kind: 'link-not-pressed' };
          return { ok: false, kind: 'error', error: first?.error?.description || JSON.stringify(first) };
        } catch (e) {
          lastError = e.message;
          // Try next protocol
        }
      }
      return { ok: false, kind: 'error', error: `Bridge niet bereikbaar: ${lastError}` };
    });

    // Get all lights from Hue bridge
    this.onRequest('/hue/lights', async () => {
      const cfg = this.readPluginConfig();
      if (!cfg.hueBridgeIp || !cfg.hueApiKey) return { ok: false, error: 'Hue Bridge niet geconfigureerd.' };
      try {
        const agent = new (require('https').Agent)({ rejectUnauthorized: false });
        const data  = await nodeRequest(
          `https://${cfg.hueBridgeIp}/clip/v2/resource/light`, 'GET', null,
          { 'hue-application-key': cfg.hueApiKey }, agent,
        );
        const json   = JSON.parse(data);
        const lights = (json.data || []).map(l => ({
          id:   l.id,
          name: l.metadata?.name || 'Onbekend',
          on:   l.on?.on ?? false,
          brightness:        Math.round(l.dimming?.brightness ?? 100),
          supportsColor:     !!l.color,
          supportsColorTemp: !!l.color_temperature,
          supportsDimming:   !!l.dimming,
          supportsSignaling: !!(l.signaling?.status?.signal_values?.includes('alternating')),
        }));
        lights.sort((a, b) => a.name.localeCompare(b.name));
        return { ok: true, lights };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    // Test a single light (brief flash to identify it)
    this.onRequest('/hue/test-light', async (body) => {
      const cfg = this.readPluginConfig();
      if (!cfg.hueBridgeIp || !cfg.hueApiKey) return { ok: false, error: 'Hue Bridge niet geconfigureerd.' };
      const { lightId } = body || {};
      if (!lightId) return { ok: false, error: 'Geen lightId opgegeven.' };
      try {
        const agent = new (require('https').Agent)({ rejectUnauthorized: false });
        const put = (b) => nodeRequest(
          `https://${cfg.hueBridgeIp}/clip/v2/resource/light/${lightId}`, 'PUT',
          JSON.stringify(b), { 'hue-application-key': cfg.hueApiKey, 'Content-Type': 'application/json' }, agent,
        );
        // Flash: off → on → original
        await put({ on: { on: false } });
        await new Promise(r => setTimeout(r, 400));
        await put({ on: { on: true }, dimming: { brightness: 100 }, color_temperature: { mirek: 153 } });
        await new Promise(r => setTimeout(r, 600));
        await put({ dimming: { brightness: 50 } });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    // Save Hue scene config back to HomeBridge config.json
    this.onRequest('/hue/save-scenes', async (body) => {
      const { fireScene, intrusionScene, restoreAfterMinutes } = body || {};
      try {
        const cfgFile = path.join(this.homebridgeStoragePath, 'config.json');
        const full    = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        const platform = (full.platforms || []).find(p => p.platform === 'GalaxyFlex');
        if (!platform) return { ok: false, error: 'GalaxyFlex platform niet gevonden in config.' };
        if (fireScene !== undefined)       platform.hueFireScene = fireScene;
        if (intrusionScene !== undefined)  platform.hueIntrusionScene = intrusionScene;
        if (restoreAfterMinutes !== undefined) platform.hueRestoreAfterMinutes = restoreAfterMinutes;
        fs.writeFileSync(cfgFile, JSON.stringify(full, null, 4));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    this.onRequest('/test-connection', async () => {
      const cfg = this.readPluginConfig();
      if (!cfg.seasoftIp) return { ok: false, error: 'Geen Seasoft IP ingesteld in de config.' };
      const data = await fetchJson(`http://${cfg.seasoftIp}/data/status.json`);
      if (!data) return { ok: false, error: `Module niet bereikbaar op ${cfg.seasoftIp}` };
      return {
        ok:       true,
        uniqueId: (data.moduniqueid || '').toUpperCase(),
        version:  data.modversion || '',
        panel:    `${data.type} ${data.size}`,
      };
    });

    this.ready();
  }

  readPluginConfig() {
    try {
      const cfgFile = path.join(this.homebridgeStoragePath, 'config.json');
      const full    = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      return (full.platforms || []).find(p => p.platform === 'GalaxyFlex') || {};
    } catch { return {}; }
  }

  // Returns the best non-loopback IPv4 address of this machine
  getHostIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return '127.0.0.1';
  }
}

// HTTPS-only helper (for Hue v2 API calls with self-signed cert)
function nodeRequest(url, method, body, headers, agent) {
  return nodeRequestAny(url, method, body, headers, agent);
}

// HTTP + HTTPS helper — picks the right module based on URL protocol
function nodeRequestAny(url, method, body, headers, agent) {
  const u    = new URL(url);
  const mod  = u.protocol === 'https:' ? require('https') : require('http');
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: u.hostname, port,
      path: u.pathname + u.search, method,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      ...(agent ? { agent } : {}),
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

(() => new GalaxyFlexUiServer())();
